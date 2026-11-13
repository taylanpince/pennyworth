import { describe, expect, it } from "vitest";
import { BUDGETS, LIMITS, MemoryStore, normalizeText, secretIn, type NewMemory } from "../src/memory.js";
import { Store } from "../src/store.js";

const fresh = () => new Store(":memory:").memory;
const active = (m: MemoryStore, over: Partial<NewMemory>) => m.add({ scope: "global", kind: "rule", text: "x", status: "active", origin: "board", ...over }).memory;

describe("memory store (D-61)", () => {
  it("has FTS5 in the bundled SQLite", () => {
    expect(fresh().fts).toBe(true);
  });

  it("normalizes text: hidden comments, line ends, blank lines, spacing", () => {
    expect(normalizeText("  I always review on Primer directly. <!-- pennyworth-from:PEN-1 -->\r\n\r\n\r\n\r\nSecond line   \n")).toBe("I always review on Primer directly.\n\nSecond line");
  });

  it("keeps rules, facts and lessons to 600 characters and playbooks to 4000", () => {
    const m = fresh();
    expect(() => active(m, { kind: "lesson", text: "a".repeat(LIMITS.lesson + 1) })).toThrow(/at most 600/);
    expect(active(m, { kind: "fact", text: "b".repeat(600) }).text).toHaveLength(600);
    expect(() => active(m, { kind: "playbook", text: "c".repeat(4001) })).toThrow(/at most 4000/);
    expect(active(m, { kind: "playbook", text: "d".repeat(4000) }).kind).toBe("playbook");
    expect(() => active(m, { text: " <!-- only a marker --> " })).toThrow(/empty/);
  });

  it("refuses anything that looks like a credential", () => {
    const secrets = [
      "the deploy key is AKIAIOSFODNN7EXAMPLE",
      "use ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuv",
      // Built from parts, so the repository's own secret scan (verify-security.sh) doesn't flag the test.
      `slack bot ${"xox"}b-1234567890-abcdefghij`,
      "OpenAI sk-proj-abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "the staging api key: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "password = c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0",
    ];
    for (const s of secrets) expect(secretIn(s), s).toBeTruthy();
    const m = fresh();
    expect(() => active(m, { kind: "fact", text: secrets[0]! })).toThrow(/AWS access key.*never hold credentials/);
    // Ordinary technical text stays fine: a commit SHA isn't a credential, nor is talk about keys.
    for (const s of ["Rotate the API key through the console, never by hand.", "The fix landed in 3f786850e387550fdab836ed7e6dc881de23001b on main.", "`protocol-team` is the GitHub group for Agustin, Max and Carlos"]) expect(secretIn(s), s).toBeUndefined();
  });

  it("returns the existing row for the same text in the same scope, and the user's word reactivates it", () => {
    const m = fresh();
    const first = m.add({ scope: "reviewer", kind: "lesson", text: "Post findings in the task first, then on the PR.", status: "proposed", origin: "proposal", why: "corrected on PEN-4" });
    const again = m.add({ scope: "reviewer", kind: "lesson", text: "  post findings in the task first,   then on the PR ", status: "proposed", origin: "proposal" });
    expect(again).toMatchObject({ duplicate: true, memory: { id: first.memory.id, status: "proposed" } });
    const remembered = m.add({ scope: "reviewer", kind: "lesson", text: "Post findings in the task first, then on the PR.", status: "active", origin: "remember" });
    expect(remembered).toMatchObject({ duplicate: true, memory: { id: first.memory.id, status: "active" } });
    expect(m.add({ scope: "writer", kind: "lesson", text: "Post findings in the task first, then on the PR.", status: "active", origin: "board" }).duplicate).toBe(false);
  });

  it("recalls everyone's and the agent's own, pinned first, then rules, facts, lessons, playbooks, newest first", () => {
    const m = fresh();
    active(m, { scope: "global", kind: "fact", text: "`protocol-team` is Agustin, Max and Carlos; `agglayer-developers` is only the agglayer-node team." });
    active(m, { scope: "global", kind: "rule", text: "I always review on Primer directly." });
    const pinned = active(m, { scope: "global", kind: "lesson", text: "Remove any mention of Ada, Alfred or other agents in client-facing documents.", pinned: true });
    active(m, { scope: "sre", kind: "playbook", text: "Removing a network from Sequence infra\n1. devops PR for dev, then prod\n2. relayer\n3. indexer\n4. node-gateway\n5. sequence.js\n6. relayer-balance-status" });
    active(m, { scope: "writer", kind: "lesson", text: "Less marketing: this is a technical solution doc." });
    m.add({ scope: "sre", kind: "rule", text: "A proposal isn't recalled.", status: "proposed", origin: "proposal", why: "x" });
    const r = m.recall("sre");
    expect(r.count).toBe(4);
    expect(r.omitted).toBe(0);
    const lines = r.text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toBe(`- [${pinned.id}] Remove any mention of Ada, Alfred or other agents in client-facing documents.`);
    expect(lines[1]).toMatch(/I always review on Primer directly/);
    expect(lines[2]).toMatch(/protocol-team/);
    expect(lines[3]).toMatch(/^- \[\d+\] Playbook: Removing a network from Sequence infra \(its steps: search memory for #\d+\)$/);
    expect(r.text).toMatch(/^### For every agent\n\n[\s\S]*\n\n### Yours\n\n- \[\d+\] Playbook/);
    expect(r.text).not.toMatch(/technical solution|proposal isn't/);
    // Agents without a scope of their own (scouts) get the global rules only.
    expect(m.recall(null).text).not.toMatch(/### Yours/);
    expect(m.get(pinned.id)!.lastUsedAt).toBeTruthy();
  });

  it("leaves out what doesn't fit the budget, and counts it", () => {
    const m = fresh();
    for (let i = 0; i < 14; i++) active(m, { scope: "global", kind: "lesson", text: `${i} ${"long lesson ".repeat(45)}`.slice(0, 590) });
    const r = m.recall(null);
    expect(r.text.length).toBeLessThan(BUDGETS.global + 200);
    expect(r.count).toBe(10);
    expect(r.omitted).toBe(4);
    expect(r.text).toMatch(/\(\+4 more left out for length: search memory to find them\)/);
    expect(m.budgets([]).global).toMatchObject({ budget: BUDGETS.global, included: expect.any(Array), omitted: expect.any(Array) });
    expect(m.budgets([]).global!.omitted).toHaveLength(4);
  });

  it("keeps private memories away from OpenRouter, in recall and search", () => {
    const m = fresh();
    const priv = active(m, { scope: "global", kind: "fact", text: "The Horizon contract renewal is confidential until March.", sensitive: true });
    expect(m.recall("sre", { engine: "claude" }).text).toMatch(/Horizon/);
    expect(m.recall("sre", { engine: "openrouter" }).text).not.toMatch(/Horizon/);
    expect(m.search("sre", "Horizon renewal", { engine: "openrouter" }).memories).toEqual([]);
    expect(m.search("sre", `#${priv.id}`, { engine: "openrouter" }).memories).toEqual([]);
    expect(m.search("sre", "Horizon renewal").memories.map((x) => x.id)).toEqual([priv.id]);
  });

  it("searches active memories (everyone's and its own) and every agent's past tasks; a hit counts as a use", () => {
    const m = fresh();
    const play = active(m, { scope: "sre", kind: "playbook", text: "Removing a network from Sequence infra\n1. devops PRs, dev then prod\n2. relayer" });
    active(m, { scope: "writer", kind: "lesson", text: "Networks pages are technical, not marketing." });
    m.addEpisode({ issueId: "e1", identifier: "PEN-40", title: "Remove Telos network from the relayer", scope: "sre", summary: "Opened the devops and relayer PRs.", links: ["https://github.com/acme/devops/pull/7"], closedAt: "2026-11-01T10:00:00Z" });
    m.addEpisode({ issueId: "e2", identifier: "PEN-41", title: "Banner copy", scope: "writer", summary: "Wrote it.", links: [], closedAt: "2026-11-02T10:00:00Z" });
    const r = m.search("sre", "remove network");
    expect(r.memories.map((x) => x.id)).toEqual([play.id]);
    expect(r.episodes.map((e) => e.identifier)).toEqual(["PEN-40"]);
    expect(r.episodes[0]!.links).toEqual(["https://github.com/acme/devops/pull/7"]);
    expect(m.get(play.id)!.uses).toBe(1);
    expect(m.search("sre", `#${play.id}`).memories[0]!.text).toMatch(/2\. relayer/);
    expect(m.search("sre", "\"); DROP TABLE memories; --").memories).toEqual([]);
    expect(m.episodes().map((e) => e.identifier)).toEqual(["PEN-41", "PEN-40"]);
  });

  it("records an episode once, with its summary cut", () => {
    const m = fresh();
    const e = { issueId: "e1", identifier: "PEN-40", title: "T", scope: "sre", summary: "s".repeat(2000), links: [], closedAt: "2026-11-01T10:00:00Z" };
    expect(m.addEpisode(e)).toBe(true);
    expect(m.addEpisode({ ...e, summary: "other" })).toBe(false);
    expect(m.episode("e1")!.summary).toHaveLength(1200);
  });

  it("updates text, kind, scope, pin and status; a decision is timed", () => {
    const m = fresh();
    const p = m.add({ scope: "writer", kind: "lesson", text: "Shorter intros.", status: "proposed", origin: "proposal", why: "PEN-9" }).memory;
    const accepted = m.update(p.id, { status: "active", text: "Keep intros to two sentences.", scope: "global", pinned: true });
    expect(accepted).toMatchObject({ status: "active", scope: "global", pinned: true, text: "Keep intros to two sentences." });
    expect(accepted.decidedAt).toBeTruthy();
    expect(() => m.update(p.id, { kind: "rule", text: "a".repeat(700) })).toThrow(/at most 600/);
    expect(m.search(null, "intros").memories).toHaveLength(1);
    expect(m.remove(p.id)).toBe(true);
    expect(m.search(null, "intros").memories).toHaveLength(0);
  });
});
