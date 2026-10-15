import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { KnowledgeBases } from "../src/knowledge/knowledge.js";
import { UserFacingError } from "../src/util/errors.js";

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function makeBases() {
  const dir = mkdtempSync(join(tmpdir(), "ops-mcp-knowledge-"));
  const root = join(dir, "knowledge");
  const agg = join(root, "aggbrain");
  put(join(agg, "README.md"), "# AggBrain\nStart here.");
  put(join(agg, "glossary.md"), "Global Exit Root: the root of exit roots.");
  put(
    join(agg, "agglayer", "pessimistic-proof.md"),
    "---\ntitle: Pessimistic Proof\nstatus: stable\nsummary: >\n  The financial firewall.\n---\nThe pessimistic proof checks balances.\nProof proof proof.\n",
  );
  put(join(agg, ".agents", "skills", "aggbrain", "SKILL.md"), "---\nname: aggbrain\ndescription: Use for AggLayer and CDK.\n---\n\n# AggBrain\n\nRead README.md first.\n");
  put(join(agg, ".git", "HEAD.md"), "pessimistic secret");
  put(join(root, "wallet-brain", "v3", "sessions.md"), "---\ntitle: Sessions\n---\nSession keys and the pessimistic word once.\n");
  writeFileSync(join(dir, "outside.md"), "outside the base");
  return { dir, root, agg, kb: new KnowledgeBases({ root, max_search_results: 15 }) };
}

describe("knowledge bases", () => {
  it("lists bases with the skill's description and guide", () => {
    const { kb } = makeBases();
    const list = kb.list();
    expect(list.map((b) => b.name)).toEqual(["aggbrain", "wallet-brain"]);
    expect(list[0]).toMatchObject({ description: "Use for AggLayer and CDK.", documents: 3 });
    expect(list[0]!.guide).toContain("Read README.md first.");
    expect(list[1]!.description).toBeUndefined();
  });

  it("indexes documents with their frontmatter, skipping hidden folders", () => {
    const { kb } = makeBases();
    const idx = kb.index("aggbrain");
    expect(idx.readme).toContain("Start here.");
    expect(idx.documents.map((d) => d.path)).toEqual(["README.md", "agglayer/pessimistic-proof.md", "glossary.md"]);
    expect(idx.documents[1]).toMatchObject({ title: "Pessimistic Proof", status: "stable", summary: "The financial firewall." });
  });

  it("searches every word across bases, best match first", () => {
    const { kb } = makeBases();
    const hits = kb.search("pessimistic proof");
    expect(hits.map((h) => `${h.base}/${h.path}`)).toEqual(["aggbrain/agglayer/pessimistic-proof.md"]);
    expect(hits[0]!.matches[0]).toEqual({ line: 2, text: "title: Pessimistic Proof" });
    expect(kb.search("pessimistic").map((h) => h.base)).toEqual(["aggbrain", "wallet-brain"]);
    expect(kb.search("pessimistic", "wallet-brain").map((h) => h.path)).toEqual(["v3/sessions.md"]);
  });

  it("reads only .md documents inside the base", () => {
    const { kb, agg, dir } = makeBases();
    expect(kb.read("aggbrain", "agglayer/pessimistic-proof.md").content).toContain("checks balances");
    expect(() => kb.read("aggbrain", "../outside.md")).toThrow(UserFacingError);
    expect(() => kb.read("aggbrain", "../wallet-brain/v3/sessions.md")).toThrow(UserFacingError);
    expect(() => kb.read("aggbrain", ".agents/skills/aggbrain/SKILL.md")).toThrow(UserFacingError);
    expect(() => kb.read("aggbrain", "/etc/passwd")).toThrow(UserFacingError);
    expect(() => kb.read("aggbrain", "agglayer")).toThrow(UserFacingError);
    symlinkSync(join(dir, "outside.md"), join(agg, "escape.md"));
    expect(() => kb.read("aggbrain", "escape.md")).toThrow(UserFacingError);
  });

  it("refuses unknown bases and works with none mounted", () => {
    const { kb, root } = makeBases();
    expect(() => kb.index("nope")).toThrow(/Unknown knowledge base "nope" \(available: aggbrain, wallet-brain\)/);
    expect(() => kb.read("..", "README.md")).toThrow(UserFacingError);
    const empty = new KnowledgeBases({ root: join(root, "missing"), max_search_results: 15 });
    expect(empty.list()).toEqual([]);
    expect(empty.search("exit root")).toEqual([]);
  });
});
