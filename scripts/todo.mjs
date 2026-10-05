#!/usr/bin/env node
// Your todo list, kept in Paperclip. Acts as you (board API key from the secrets dir).
//
//   todo                                  list open todos, meeting actions and Slack replies, by priority
//   todo add "Draft OMS roadmap" [-p high] [-n "details"]
//   todo prio PEN-12 high                 critical | high | medium | low
//   todo done PEN-12 ["optional note"]
//   todo show PEN-12
//   todo waiting                          things other people owe you
//   todo brief                            print today's daily brief
//   todo --all                            include every open task (reviews, briefs, …)
//
// Env: PAPERCLIP_URL (default http://localhost:3100), PENNYWORTH_ENV_FILE.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.PENNYWORTH_ENV_FILE ?? join(repo, ".env");
const dotenv = Object.fromEntries(
  (existsSync(envFile) ? readFileSync(envFile, "utf8") : "")
    .split("\n")
    .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);
const base = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const secrets = process.env.PENNYWORTH_SECRETS_DIR ?? dotenv.PENNYWORTH_SECRETS_DIR;
const keyFile = secrets && join(secrets, "paperclip_board_key");
if (!keyFile || !existsSync(keyFile)) die("no Paperclip board key; run scripts/paperclip-setup.mjs first");
const key = readFileSync(keyFile, "utf8").trim();
const sys = readFileSync(join(repo, dotenv.PENNYWORTH_CONFIG_DIR ?? "config", "system.yaml"), "utf8");
const company = /^\s*company_id:\s*"?([0-9a-f-]{36})"?/m.exec(sys)?.[1];
if (!company) die("paperclip.company_id missing in config/system.yaml");

const PRIORITIES = ["critical", "high", "medium", "low"];
const OPEN = "backlog,todo,in_progress,in_review,blocked";
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const prioColor = { critical: "1;31", high: "31", medium: "33", low: "2" };

function die(msg) {
  console.error(`todo: ${msg}`);
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => die(`Paperclip unreachable at ${base} (${e.message})`));
  const text = await res.text();
  if (!res.ok) die(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

let labels;
async function label(name) {
  labels ??= new Map((await api("GET", `/api/companies/${company}/labels`)).map((l) => [l.name, l.id]));
  const id = labels.get(name);
  if (!id) die(`label "${name}" missing; run scripts/paperclip-setup.mjs`);
  return id;
}

async function list({ labelNames, status = OPEN }) {
  const out = [];
  for (const name of labelNames) {
    const q = new URLSearchParams({ status, labelId: await label(name), limit: "500", excludeRoutineExecutions: "true" });
    out.push(...(await api("GET", `/api/companies/${company}/issues?${q}`)));
  }
  const seen = new Set();
  return out
    .filter((i) => !seen.has(i.id) && seen.add(i.id))
    .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || a.createdAt.localeCompare(b.createdAt));
}

const age = (iso) => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d === 0 ? "today" : `${d}d`;
};

function print(issues, empty) {
  if (!issues.length) return console.log(empty);
  const tag = (i) => {
    const names = (i.labels ?? []).map((l) => l.name);
    if (names.includes("needs-response")) return c("31", "reply");
    if (names.includes("meeting-action")) return c("36", "meeting");
    if (names.includes("waiting-on")) return c("35", "waiting");
    if (names.includes("needs-review")) return c("33", "review");
    if (names.includes("daily-brief")) return c("32", "brief");
    return c("2", "todo");
  };
  for (const i of issues) {
    const p = (i.priority ?? "medium").padEnd(8);
    const status = i.status === "todo" ? "" : c("2", ` [${i.status}]`);
    console.log(`${c("1", i.identifier.padEnd(8))} ${c(prioColor[i.priority] ?? "0", p)} ${age(i.createdAt).padStart(5)}  ${tag(i).padEnd(tty ? 16 : 7)} ${i.title}${status}`);
  }
}

function flag(args, ...names) {
  const i = args.findIndex((a) => names.includes(a));
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
}

const ref = (s) => (/^[A-Za-z]+-\d+$/.test(s ?? "") ? s.toUpperCase() : die(`expected a task id like PEN-12, got "${s ?? ""}"`));

const [cmd = "list", ...args] = process.argv.slice(2);
switch (cmd) {
  case "list":
  case "ls":
  case "--all": {
    const all = cmd === "--all" || args.includes("--all");
    print(await list({ labelNames: all ? ["todo", "meeting-action", "needs-response", "needs-review", "waiting-on", "daily-brief"] : ["todo", "meeting-action", "needs-response"] }), "Nothing on your list.");
    break;
  }
  case "add": {
    const priority = flag(args, "-p", "--priority") ?? "medium";
    const note = flag(args, "-n", "--note");
    if (!PRIORITIES.includes(priority)) die(`priority must be one of ${PRIORITIES.join(", ")}`);
    const title = args.join(" ").trim();
    if (!title) die('usage: todo add "what needs doing" [-p high] [-n "details"]');
    const i = await api("POST", `/api/companies/${company}/issues`, {
      title: title.slice(0, 200),
      description: `${note ? `${note}\n\n` : ""}## Source\n\nType: Manual todo (todo CLI)\nAdded: ${new Date().toISOString()}`,
      status: "todo",
      priority,
      labelIds: [await label("todo")],
      assigneeUserId: (await api("GET", "/api/cli-auth/me")).userId,
      allowDuplicate: true,
    });
    console.log(`Added ${c("1", i.identifier)} (${priority}): ${i.title}`);
    break;
  }
  case "prio":
  case "priority": {
    const [id, priority] = args;
    if (!PRIORITIES.includes(priority)) die(`usage: todo prio PEN-12 <${PRIORITIES.join("|")}>`);
    const i = await api("PATCH", `/api/issues/${ref(id)}`, { priority });
    console.log(`${i.identifier ?? id} → ${priority}`);
    break;
  }
  case "done": {
    const [id, ...note] = args;
    const body = { status: "done" };
    if (note.length) body.comment = note.join(" ");
    await api("PATCH", `/api/issues/${ref(id)}`, body);
    console.log(`${ref(id)} done`);
    break;
  }
  case "show": {
    const i = await api("GET", `/api/issues/${ref(args[0])}`);
    console.log(`${c("1", i.identifier)} ${i.title}\n${i.status} · ${i.priority} · ${(i.labels ?? []).map((l) => l.name).join(", ")} · created ${age(i.createdAt) === "today" ? "today" : `${age(i.createdAt)} ago`}\n`);
    console.log((i.description ?? "").replace(/<!--[\s\S]*?-->/g, "").trim());
    console.log(`\n${base}/issues/${i.identifier}`);
    break;
  }
  case "waiting":
    print(await list({ labelNames: ["waiting-on"] }), "Nobody owes you anything right now.");
    break;
  case "brief": {
    const [latest] = (await list({ labelNames: ["daily-brief"], status: `${OPEN},done` })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!latest) die("no daily brief yet");
    const i = await api("GET", `/api/issues/${latest.identifier}`);
    console.log((i.description ?? "").replace(/<!--[\s\S]*?-->/g, "").trim());
    break;
  }
  case "help":
  case "-h":
  case "--help":
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    break;
  default:
    die(`unknown command "${cmd}" (try: todo help)`);
}
