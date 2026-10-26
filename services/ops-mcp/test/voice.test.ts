import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UserFacingError } from "../src/util/errors.js";
import { makeEnv } from "./helpers.js";

const voiceEnv = (voice_note?: string) =>
  makeEnv({ cfg: { vault: { root: "", read_roots: ["Projects", "Meetings"], write_roots: ["Projects", "Meetings"], voice_note } } });

function env(voice_note = "Projects/Writing Voice.md") {
  const e = voiceEnv(voice_note);
  // makeEnv's cfg override replaces the vault section; point it back at the test vault.
  e.cfg.vault.root = e.vault;
  return e;
}

describe("voice guide", () => {
  it("creates the note on the first lesson and quotes the user's example", () => {
    const e = env();
    expect(e.app.voice.read()).toEqual({ path: "Projects/Writing Voice.md", exists: false, content: "" });
    const r = e.app.voice.add({
      lesson: "Lead with a conviction, then the risk, then our solution.",
      example: "Agents combined with wallets is the future of finance.\n\nWith OMS Wallets this is a solved problem.",
      context: "X and LinkedIn posts",
      task: "PEN-2551",
    });
    expect(r).toEqual({ path: "Projects/Writing Voice.md", status: "written" });
    const note = readFileSync(join(e.vault, "Projects", "Writing Voice.md"), "utf8");
    expect(note).toContain("## Lessons\n\n### 2026-10-04 · X and LinkedIn posts · (PEN-2551)\n\nLead with a conviction");
    expect(note).toContain("> Agents combined with wallets is the future of finance.\n>\n> With OMS Wallets this is a solved problem.");
    expect(e.app.voice.read().content).toBe(note);
  });

  it("appends under Lessons without touching the user's own text, and never twice", () => {
    const e = env();
    const path = join(e.vault, "Projects", "Writing Voice.md");
    const mine = "# Voice\n\nShort sentences. No hype.\n\n## Lessons\n\n### earlier\n\nBe direct.\n\n## Banned words\n\n- leverage\n";
    writeFileSync(path, mine);
    expect(e.app.voice.add({ lesson: "Speak as a builder: our smart wallets." }).status).toBe("written");
    expect(e.app.voice.add({ lesson: "Speak as a builder: our smart wallets." }).status).toBe("exists");
    const note = readFileSync(path, "utf8");
    expect(note.indexOf("Speak as a builder")).toBeGreaterThan(note.indexOf("Be direct."));
    expect(note.indexOf("Speak as a builder")).toBeLessThan(note.indexOf("## Banned words"));
    expect(note.match(/Speak as a builder/g)).toHaveLength(1);
    expect(note.replace(/\n### 2026-10-04\n\nSpeak as a builder: our smart wallets\.\n<!-- pennyworth-voice:[0-9a-f]+ -->\n/, "")).toBe(mine);
  });

  it("refuses when no note is configured or the note is outside the write roots", () => {
    const none = voiceEnv();
    expect(() => none.app.voice.read()).toThrow(UserFacingError);
    const outside = env("Personal/Voice.md");
    expect(() => outside.app.voice.add({ lesson: "x" })).toThrow(/Path rejected/);
  });
});
