#!/usr/bin/env node
// Regression set for the go-ahead on Engineer sub-tasks (D-24, readApproval in src/intake.mjs): real
// comments on a parent task, each with the reading it must get, run through the real call. Run before
// every change to the go-ahead prompt or its inputs:
//
//   npm run eval:intake                 all go-ahead cases (config/intake-cases.yaml, else the example set)
//   npm run eval:intake -- skip         only cases whose id contains "skip"
//   EVAL_REPEAT=5 npm run eval:intake   runs per case (default 3)
//
// The call doesn't answer the same way every time, so each case runs several times and passes only
// if every run does. Requests to Engineers are no longer read by the runner (they go to the Engineer,
// docs/design/conversational-engineers.md): other cases in the file are skipped. Their GitHub writes
// have their own set, eval:authorize.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { stripHidden } from "../src/commands.mjs";
import { loadConfig, REPO_ROOT } from "../src/config.mjs";
import { readApproval } from "../src/intake.mjs";

/** Compare one reading with the expectation: a value, or a list of acceptable values. */
export function mismatches(read, expect) {
  const out = [];
  for (const [field, want] of Object.entries(expect ?? {})) {
    const got = read[field];
    if (!(Array.isArray(want) ? want.includes(got) : got === want)) out.push(`${field}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const real = join(REPO_ROOT, "config/intake-cases.yaml");
  const file = existsSync(real) ? real : join(REPO_ROOT, "config/intake-cases.example.yaml");
  const filter = process.argv[2];
  const all = parseYaml(readFileSync(file, "utf8"));
  const cases = all.filter((c) => c.kind === "go-ahead" && (!filter || c.id.includes(filter)));
  console.log(`${cases.length} go-ahead case(s) from ${file} (${all.length - all.filter((c) => c.kind === "go-ahead").length} request cases skipped: requests now go to the Engineer)\n`);

  const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 3));
  const results = [];
  const pending = cases.flatMap((c) => Array.from({ length: repeat }, () => c));
  const worker = async () => {
    for (let c; (c = pending.shift()); ) {
      const ctx = c.context ?? {};
      const waiting = (ctx.waiting ?? ["PEN-1: Engineer task"]).map((w, n) => ({ identifier: String(w).split(":")[0] || `PEN-${n}`, title: String(w).split(":").slice(1).join(":").trim() || String(w) }));
      try {
        const decision = await readApproval({ cfg, user: cfg.selfName, title: c.title ?? "", waiting, comment: stripHidden(c.comment ?? "").trim() });
        results.push({ c, decision, bad: mismatches({ decision }, c.expect) });
      } catch (err) {
        results.push({ c, bad: [`call failed: ${String(err.message ?? err).slice(0, 200)}`] });
      }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.EVAL_CONCURRENCY ?? 4) }, worker));

  let failed = 0;
  for (const c of cases) {
    const runs = results.filter((r) => r.c === c);
    const bad = runs.filter((r) => r.bad.length);
    if (bad.length) failed++;
    console.log(`${bad.length ? "✗" : "✓"} ${c.id.padEnd(34)} ${runs.length - bad.length}/${runs.length}  ${[...new Set(runs.map((r) => r.decision ?? "-"))].join(" | ")}`);
    for (const b of [...new Set(bad.flatMap((r) => r.bad))]) console.log(`    ${b}`);
    if (bad.length && c.why) console.log(`    why: ${c.why}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} cases read as expected on every run (${repeat} runs each)`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
