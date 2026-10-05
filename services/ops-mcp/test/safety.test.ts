import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PathRejectedError } from "../src/util/errors.js";
import { resolveAbsoluteWithin, resolveVaultPath } from "../src/util/paths.js";
import { insertUnderHeading, Vault } from "../src/vault/vault.js";
import { makeEnv, writeAt } from "./helpers.js";

describe("transcript path safety", () => {
  it("rejects ../ traversal and symlinks outside the transcript root", async () => {
    const env = makeEnv();
    const secret = join(env.dir, "secret.txt");
    writeFileSync(secret, "top secret");
    expect(() => resolveAbsoluteWithin(join(env.transcripts, "../../secret.txt"), [env.transcripts])).toThrow(PathRejectedError);
    expect(() => resolveAbsoluteWithin(join(env.transcripts, "../secret.txt"), [env.transcripts])).toThrow(PathRejectedError);

    symlinkSync(secret, join(env.transcripts, "evil.txt"));
    const report = await env.app.meetings.scan();
    expect(report.new_sources).toBe(0);
    expect(report.rejected).toEqual([{ file: "evil.txt", reason: "Path rejected: outside configured roots" }]);
  });

  it("accepts symlinks that stay inside the root", async () => {
    const env = makeEnv();
    writeAt(join(env.transcripts, "real", "Kira-2026-09-21.txt"), "[Me] hi");
    symlinkSync(join(env.transcripts, "real", "Kira-2026-09-21.txt"), join(env.transcripts, "link.txt"));
    const report = await env.app.meetings.scan();
    // Both paths resolve to the same canonical file: one source.
    expect(report.new_sources).toBe(1);
  });

  it("waits for files to settle before registering them", async () => {
    const env = makeEnv();
    writeAt(join(env.transcripts, "2026-10-04_1401.md"), "partial", env.now.ms - 3000);
    let report = await env.app.meetings.scan();
    expect(report.settling).toBe(1);
    expect(report.new_sources).toBe(0);
    env.now.ms += 15_000;
    report = await env.app.meetings.scan();
    expect(report.new_sources).toBe(1);
  });
});

describe("vault path safety", () => {
  it("rejects traversal, absolute, hidden and out-of-scope paths", () => {
    const env = makeEnv();
    writeFileSync(join(env.vault, "Personal", "diary.md"), "private");
    const roots = ["Projects", "Meetings"];
    for (const bad of ["../secret.md", "Projects/../../x.md", "/etc/passwd", ".obsidian/app.json", "Personal/diary.md", "Projects/../Personal/diary.md"]) {
      expect(() => resolveVaultPath(env.vault, bad, roots), bad).toThrow(PathRejectedError);
    }
    expect(resolveVaultPath(env.vault, "Projects/New Note.md", roots).rel).toBe("Projects/New Note.md");
  });

  it("rejects a symlinked folder that escapes the allowed roots", () => {
    const env = makeEnv();
    symlinkSync(join(env.vault, "Personal"), join(env.vault, "Projects", "sneaky"));
    const vault = new Vault(env.cfg.vault);
    expect(() => vault.createNote("Projects/sneaky/x.md", "hi")).toThrow(PathRejectedError);
    expect(() => vault.read("Projects/sneaky/x.md")).toThrow(PathRejectedError);
  });

  it("never overwrites an existing note on create", () => {
    const env = makeEnv();
    const vault = new Vault(env.cfg.vault);
    writeFileSync(join(env.vault, "Projects", "A.md"), "human content");
    expect(() => vault.createNote("Projects/A.md", "machine")).toThrow(/EEXIST/);
    expect(readFileSync(join(env.vault, "Projects", "A.md"), "utf8")).toBe("human content");
  });
});

describe("Meeting Log insertion", () => {
  it("inserts at the end of the section, before the next heading", () => {
    const before = "# Project\n\nIntro\n\n## Meeting Log\n\n### old entry\ntext\n\n## Other\n\nkeep me\n";
    const { content, createdHeading } = insertUnderHeading(before, "Meeting Log", "### new entry\nbody");
    expect(createdHeading).toBe(false);
    expect(content).toBe("# Project\n\nIntro\n\n## Meeting Log\n\n### old entry\ntext\n\n### new entry\nbody\n\n## Other\n\nkeep me\n");
  });

  it("creates the heading at the end when missing", () => {
    const { content, createdHeading } = insertUnderHeading("# Note\n\nbody\n", "Meeting Log", "### e");
    expect(createdHeading).toBe(true);
    expect(content).toBe("# Note\n\nbody\n\n## Meeting Log\n\n### e\n");
  });

  it("ignores headings inside code fences and frontmatter", () => {
    const before = "---\ntitle: x\n---\n```\n## Meeting Log\n```\n\n## Meeting Log\n\nexisting\n";
    const { content } = insertUnderHeading(before, "Meeting Log", "### e");
    expect(content).toBe(before + "\n### e\n");
  });
});

describe("Obsidian concurrency", () => {
  it("detects a change between read and write, refetches, retries and keeps human edits", () => {
    const env = makeEnv();
    const vault = new Vault(env.cfg.vault);
    const path = join(env.vault, "Projects", "P.md");
    writeFileSync(path, "# P\n\n## Meeting Log\n\n");
    let calls = 0;
    vault.beforeCommit = (abs, attempt) => {
      calls++;
      if (attempt === 1) writeFileSync(abs, readFileSync(abs, "utf8") + "human line added mid-write\n");
    };
    const r = vault.appendUnderHeading("Projects/P.md", "Meeting Log", "### entry\n<!-- paperclip-meeting:e1 -->", "<!-- paperclip-meeting:e1 -->");
    expect(r).toMatchObject({ status: "written", attempts: 2 });
    expect(calls).toBe(2);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("human line added mid-write");
    expect(after).toContain("paperclip-meeting:e1");
  });

  it("gives up after the second conflict without writing", () => {
    const env = makeEnv();
    const vault = new Vault(env.cfg.vault);
    const path = join(env.vault, "Projects", "P.md");
    writeFileSync(path, "# P\n");
    let n = 0;
    vault.beforeCommit = (abs) => writeFileSync(abs, `# P\nedit ${++n}\n`);
    expect(() => vault.appendUnderHeading("Projects/P.md", "Meeting Log", "### entry", "<!-- m -->")).toThrow(/changed while writing/);
    expect(readFileSync(path, "utf8")).toBe("# P\nedit 2\n");
  });

  it("is idempotent via the marker", () => {
    const env = makeEnv();
    const vault = new Vault(env.cfg.vault);
    mkdirSync(join(env.vault, "Projects"), { recursive: true });
    writeFileSync(join(env.vault, "Projects", "P.md"), "# P\n");
    const entry = "### e\n<!-- paperclip-meeting:x -->";
    expect(vault.appendUnderHeading("Projects/P.md", "Meeting Log", entry, "<!-- paperclip-meeting:x -->").status).toBe("written");
    expect(vault.appendUnderHeading("Projects/P.md", "Meeting Log", entry, "<!-- paperclip-meeting:x -->").status).toBe("exists");
  });
});
