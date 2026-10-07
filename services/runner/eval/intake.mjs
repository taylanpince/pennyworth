#!/usr/bin/env node
// Regression set for the intake: real comments, each with the reading it must get, run through
// the real intake call (a short Codex call per case). Run before every change to intake.mjs,
// the intake's call sites, or the runner's handling of its answers:
//
//   npm run eval:intake                 all cases (config/intake-cases.yaml, else the example set)
//   npm run eval:intake -- PEN-298      only cases whose id contains "PEN-298"
//   EVAL_REPEAT=5 npm run eval:intake   runs per case (default 3)
//
// The intake doesn't answer the same way every time (the old PEN-298 prompt misread the restated
// request 3 runs out of 4), so each case runs several times and passes only if every run does.
//
// Every misread found on a real task gets added to config/intake-cases.yaml, so it can't return.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { findRepos, stripHidden } from "../src/commands.mjs";
import { loadConfig, REPO_ROOT } from "../src/config.mjs";
import { readApproval, readRequest } from "../src/intake.mjs";

const FIELDS = ["action", "mode", "repo", "references", "engine", "model", "decision"];

/** The request text exactly as handleRequest builds it (title + own description on a first run). */
export function requestFor(c) {
  const comment = stripHidden(c.comment ?? "").trim();
  const own = c.own_description ? `${c.title}\n\n${stripHidden(c.description ?? "").trim()}` : "";
  return [own, comment].filter(Boolean).join("\n\n");
}

/** Compare one reading with the expectation: a value, a list of acceptable values, or null for "unset". */
export function mismatches(read, expect) {
  const out = [];
  for (const field of FIELDS) {
    if (!(field in expect)) continue;
    const want = expect[field];
    const got = read[field];
    const ok =
      field === "references"
        ? JSON.stringify([...(got ?? [])].sort()) === JSON.stringify([...(want ?? [])].sort())
        : want === null
          ? got === undefined
          : Array.isArray(want)
            ? want.includes(got)
            : got === want;
    if (!ok) out.push(`${field}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const real = join(REPO_ROOT, "config/intake-cases.yaml");
  const file = existsSync(real) ? real : join(REPO_ROOT, "config/intake-cases.example.yaml");
  const filter = process.argv[2];
  const cases = parseYaml(readFileSync(file, "utf8")).filter((c) => !filter || c.id.includes(filter));
  console.log(`${cases.length} case(s) from ${file}\n`);

  const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 3));
  const results = [];
  const pending = cases.flatMap((c) => Array.from({ length: repeat }, () => c));
  const worker = async () => {
    for (let c; (c = pending.shift()); ) {
      const instructions = requestFor(c);
      const candidates = findRepos(`${instructions}\n${c.title ?? ""}\n${c.description ?? ""}`, cfg.allowed_orgs).map((r) => r.slug);
      const ctx = c.context ?? {};
      try {
        // Go-ahead cases (D-24): a comment on a parent task with Engineer sub-tasks waiting.
        if (c.kind === "go-ahead") {
          const waiting = (ctx.waiting ?? ["PEN-1: Engineer task"]).map((w, n) => ({ identifier: String(w).split(":")[0] || `PEN-${n}`, title: String(w).split(":").slice(1).join(":").trim() || String(w) }));
          const decision = await readApproval({ cfg, user: cfg.selfName, title: c.title ?? "", waiting, comment: stripHidden(c.comment ?? "").trim() });
          results.push({ c, read: { decision }, bad: mismatches({ decision }, c.expect ?? {}) });
          continue;
        }
        const read = await readRequest({
          cfg, user: cfg.selfName, title: c.title ?? "", description: c.description ?? "", instructions,
          latest: stripHidden(c.comment ?? "").trim(), candidates,
          known: ctx.known_repo, previousMode: ctx.previous_mode, busy: Boolean(ctx.busy), hasWork: Boolean(ctx.has_work), lastResult: ctx.last_result,
        });
        results.push({ c, read, bad: mismatches(read, c.expect ?? {}) });
      } catch (err) {
        results.push({ c, bad: [`intake failed: ${String(err.message ?? err).slice(0, 200)}`] });
      }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.EVAL_CONCURRENCY ?? 4) }, worker));

  const summary = (read) => (read?.decision ? `go-ahead: ${read.decision}` : read ? `${read.action}/${read.mode ?? "-"}${read.repo ? ` ${read.repo}` : ""}${read.engine ? ` ${read.engine}` : ""}${read.model ? `:${read.model}` : ""}` : "no reading");
  let failed = 0;
  for (const c of cases) {
    const runs = results.filter((r) => r.c === c);
    const bad = runs.filter((r) => r.bad.length);
    if (bad.length) failed++;
    const readings = [...new Set(runs.map((r) => summary(r.read)))].join(" | ");
    console.log(`${bad.length ? "✗" : "✓"} ${c.id.padEnd(34)} ${runs.length - bad.length}/${runs.length}  ${readings}`);
    for (const b of [...new Set(bad.flatMap((r) => r.bad))]) console.log(`    ${b}`);
    if (bad.length && c.why) console.log(`    why: ${c.why}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} cases read as expected on every run (${repeat} runs each)`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
