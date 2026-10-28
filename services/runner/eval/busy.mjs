#!/usr/bin/env node
// Regression set for comments that arrive while a task's run or merges are in progress (readBusy in
// src/busy.mjs): each comment, the work it arrived during, and the decision it must get, run through
// the real call. Run before every change to that prompt or its inputs:
//
//   npm run eval:busy                 all cases (config/busy-cases.yaml, else the example set)
//   EVAL_REPEAT=5 npm run eval:busy   runs per case (default 3)
//
// A wrong "stop" throws work away and a wrong "later" ignores a stop: add every real misread.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readBusy } from "../src/busy.mjs";
import { loadConfig, REPO_ROOT } from "../src/config.mjs";

async function main() {
  const cfg = loadConfig();
  const real = join(REPO_ROOT, "config/busy-cases.yaml");
  const file = existsSync(real) ? real : join(REPO_ROOT, "config/busy-cases.example.yaml");
  const filter = process.argv[2];
  const cases = parseYaml(readFileSync(file, "utf8")).filter((c) => !filter || c.id.includes(filter));
  console.log(`${cases.length} case(s) from ${file}\n`);
  const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 3));
  const results = [];
  const pending = cases.flatMap((c) => Array.from({ length: repeat }, () => c));
  const worker = async () => {
    for (let c; (c = pending.shift()); ) {
      const read = await readBusy({ cfg, user: cfg.selfName, comment: c.comment, activity: c.activity ?? "" }).catch((err) => ({ decision: `error: ${String(err.message ?? err).slice(0, 100)}`, answer: "" }));
      results.push({ c, read, ok: read.decision === c.expect });
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.EVAL_CONCURRENCY ?? 4) }, worker));
  let failed = 0;
  for (const c of cases) {
    const runs = results.filter((r) => r.c === c);
    const bad = runs.filter((r) => !r.ok);
    if (bad.length) failed++;
    console.log(`${bad.length ? "✗" : "✓"} ${c.id.padEnd(40)} ${runs.length - bad.length}/${runs.length}  want ${c.expect}`);
    for (const b of bad) console.log(`    got ${b.read.decision}${b.read.answer ? `: ${b.read.answer.slice(0, 120)}` : ""}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} cases decided as expected on every run (${repeat} runs each)`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
