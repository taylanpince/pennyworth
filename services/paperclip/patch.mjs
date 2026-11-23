// Pennyworth's patches to Paperclip 2026.1001.0 (D-79), applied at image build. Each edit names the exact text it
// replaces and how often it must appear: when an upgrade changes that code, the build stops here instead of
// shipping a patch that silently missed.
//
// Paperclip copies a task's whole comment history into every wake (`executionContinuation`), uncapped, and the
// Codex adapter hands all of it to the agent in one environment variable. Linux refuses to start a process with
// any one environment string over 128 KiB (MAX_ARG_STRLEN), so once a task's comments pass that, every wake fails
// with `spawn E2BIG` and the agent can never run on it again (PEN-5797, 2026-11-23; upstream
// paperclipai/paperclip#13959 and #13662, fix proposed in #16645).
import fs from "node:fs";

const edits = [
  {
    file: "/app/server/dist/services/execution-continuation.js",
    changes: [
      {
        find: 'const string = (v) => typeof v === "string" && v.length > 0 ? v : null;\n',
        replace: `const string = (v) => typeof v === "string" && v.length > 0 ? v : null;
// Pennyworth (D-79): keep the continuation well under one environment string (128 KiB). Long comments are cut
// and the oldest left out, both marked, so the agent knows to read the thread with its task tools.
const PENNYWORTH_BODY_CHARS = 8_000;
const PENNYWORTH_HISTORY_BYTES = 40_000;
const PENNYWORTH_DELTA_BYTES = 24_000;
const pennyworthCut = (text, limit) => typeof text === "string" && text.length > limit
    ? \`\${text.slice(0, limit)}\\n\\n[Cut at \${limit} of \${text.length} characters. Read the whole comment with your task tools.]\`
    : text;
// The origin comments, then the newest messages that fit, in their order.
function pennyworthKeep(messages, keepIds, budget) {
    const size = (m) => Buffer.byteLength(JSON.stringify(m));
    const keep = new Set();
    let used = 0;
    for (const m of messages)
        if (keepIds.includes(m.id)) {
            keep.add(m.id);
            used += size(m);
        }
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (keep.has(m.id))
            continue;
        if (used + size(m) > budget)
            break;
        keep.add(m.id);
        used += size(m);
    }
    const kept = messages.filter((m) => keep.has(m.id));
    return { kept, omitted: messages.length - kept.length };
}
`,
      },
      {
        find: 'body: row.deletedAt ? "" : safe.body,',
        replace: 'body: row.deletedAt ? "" : pennyworthCut(safe.body, PENNYWORTH_BODY_CHARS),',
      },
      {
        find: "export async function buildExecutionContinuation(input) {",
        replace: `export async function buildExecutionContinuation(input) {
    const envelope = await buildUnboundedExecutionContinuation(input);
    const origins = envelope.originCommentIds ?? [];
    const history = pennyworthKeep(envelope.messages, origins, PENNYWORTH_HISTORY_BYTES);
    const bounded = {
        ...envelope,
        objective: pennyworthCut(envelope.objective, PENNYWORTH_BODY_CHARS),
        completedWork: pennyworthCut(envelope.completedWork, 2 * PENNYWORTH_BODY_CHARS),
        messages: history.kept,
    };
    if (envelope.resumeDelta) {
        // Only what's in the window: a message left out here was in an earlier session or is too old to matter.
        const window = new Set(history.kept.map((m) => m.id));
        bounded.resumeDelta = {
            ...envelope.resumeDelta,
            messages: pennyworthKeep(envelope.resumeDelta.messages.filter((m) => window.has(m.id)), origins, PENNYWORTH_DELTA_BYTES).kept,
        };
    }
    if (history.omitted > 0)
        bounded.coverage = {
            ...envelope.coverage,
            kind: "truncated_task_history",
            omittedCount: history.omitted,
            oldestRetainedCommentId: history.kept[0]?.id ?? null,
        };
    return bounded;
}
async function buildUnboundedExecutionContinuation(input) {`,
      },
    ],
  },
  {
    file: "/app/packages/adapter-utils/src/server-utils.ts",
    changes: [
      {
        find: `        : "History is complete through the coverage cursor. Prefer source messages over summaries.",`,
        replace: `        : snapshot.coverage?.kind === "truncated_task_history"
          ? "History was cut to fit: older messages are left out and long ones are shortened. Read the whole thread with your task tools before relying on it. Prefer source messages over summaries."
          : "History is complete through the coverage cursor. Prefer source messages over summaries.",`,
      },
    ],
  },
  {
    file: "/app/packages/adapters/codex-local/src/server/execute.ts",
    changes: [
      {
        // The backstop: whatever else grows, an oversized copy is left out rather than stopping the run. Our agents
        // have no shell to read it; the prompt carries the same wake.
        find: "    if (wakePayloadJson) {\n      env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;",
        replace:
          "    if (wakePayloadJson && Buffer.byteLength(wakePayloadJson) < 120_000) {\n      env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;",
      },
    ],
  },
];

for (const { file, changes } of edits) {
  let text = fs.readFileSync(file, "utf8");
  for (const { find, replace } of changes) {
    const count = text.split(find).length - 1;
    if (count !== 1) {
      console.error(`pennyworth patch: expected the anchor once in ${file}, found it ${count} times:\n${find}`);
      process.exit(1);
    }
    text = text.replace(find, () => replace);
  }
  fs.writeFileSync(file, text);
  console.log(`pennyworth patch: ${file} (${changes.length})`);
}
