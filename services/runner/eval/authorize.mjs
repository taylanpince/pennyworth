#!/usr/bin/env node
// Regression set for the check on the agent's GitHub writes (src/authorize.mjs): the user's words and
// an action, run through the real check call. Run before every change to the check's prompt or to what
// it is given:
//
//   npm run eval:authorize                 all cases (config/authorize-cases.yaml, else the example set)
//   npm run eval:authorize -- PEN-2714     only cases whose id contains "PEN-2714"
//   EVAL_REPEAT=5 npm run eval:authorize   runs per case (default 3)
//
// A case passes only if every run gives the expected answer. Wrong "yes" answers are the costly ones:
// add every real comment that was misread.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { authorize } from "../src/authorize.mjs";
import { loadConfig, REPO_ROOT } from "../src/config.mjs";

const comments = (list = []) => list.map((body, i) => ({ body, createdAt: `2026-10-27T20:${String(10 + i).padStart(2, "0")}:00.000Z` }));

async function main() {
  const cfg = loadConfig();
  const real = join(REPO_ROOT, "config/authorize-cases.yaml");
  const file = existsSync(real) ? real : join(REPO_ROOT, "config/authorize-cases.example.yaml");
  const filter = process.argv[2];
  const cases = parseYaml(readFileSync(file, "utf8")).filter((c) => !filter || c.id.includes(filter));
  console.log(`${cases.length} case(s) from ${file}\n`);

  const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 3));
  const results = [];
  const pending = cases.flatMap((c) => Array.from({ length: repeat }, () => c));
  const worker = async () => {
    for (let c; (c = pending.shift()); ) {
      const verdict = await authorize({
        cfg, user: cfg.selfName, action: c.action, targets: c.targets ?? [], gapMinutes: c.gap,
        words: { earlier: comments(c.earlier), recent: comments(c.recent), lastReply: c.last_reply ?? "" },
      });
      results.push({ c, verdict, ok: verdict.allowed === c.expect && verdict.how !== "error" });
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.EVAL_CONCURRENCY ?? 4) }, worker));

  let failed = 0;
  for (const c of cases) {
    const runs = results.filter((r) => r.c === c);
    const bad = runs.filter((r) => !r.ok);
    if (bad.length) failed++;
    console.log(`${bad.length ? "✗" : "✓"} ${c.id.padEnd(48)} ${runs.length - bad.length}/${runs.length}  want ${c.expect ? "allowed" : "refused"}`);
    for (const b of bad) console.log(`    got ${b.verdict.allowed ? "allowed" : "refused"} (${b.verdict.how}): ${b.verdict.reason}`);
    if (bad.length && c.why) console.log(`    why: ${c.why}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} cases answered as expected on every run (${repeat} runs each)`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
