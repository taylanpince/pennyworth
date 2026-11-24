import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverySweep } from "./recovery-sweep.mjs";

test("slow scans never overlap; cooldown starts at completion and does not replay changes", async () => {
  let now = 0;
  let calls = 0;
  let finish;
  const scan = recoverySweep(() => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  }, { intervalMs: 300_000, now: () => now });
  const first = scan();
  now = 900_000;
  assert.deepEqual(await scan(), {});
  assert.equal(calls, 1);
  finish({ assignmentDispatched: 3 });
  assert.deepEqual(await first, { assignmentDispatched: 3 });
  now += 299_999;
  assert.deepEqual(await scan(), {});
  assert.equal(calls, 1);
  now++;
  const second = scan();
  assert.equal(calls, 2);
  finish({ assignmentDispatched: 0 });
  await second;
});

test("failed scans release the guard and can retry on the next scheduler tick", async () => {
  let calls = 0;
  const scan = recoverySweep(async (value) => {
    if (++calls === 1) throw new Error("database unavailable");
    return value;
  }, { now: () => 1 });
  await assert.rejects(scan(), /database unavailable/);
  assert.deepEqual(await scan({ skipped: 1 }), { skipped: 1 });
  assert.equal(calls, 2);
});
