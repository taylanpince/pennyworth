// What a job shows on the board while it works: the agent's latest words and its own task list,
// read from the engine's event stream (Claude Code, Codex, opencode). Kept in memory and sent with
// the activity report; it never reaches Paperclip, and the reply is still the job's final comment.

const SAID_MAX = 600;
const PLAN_MAX = 20;
const ITEM_MAX = 200;

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const STATE = { completed: "done", in_progress: "doing", pending: "todo" };

/** A tracker for one run: `take(event)` returns true when what the board would show changed. */
export function progressTracker() {
  let said = "";
  let saidAt = "";
  let plan = []; // [{ id?, text, state: "todo" | "doing" | "done" }]
  const creating = new Map(); // Claude Code: TaskCreate tool_use id → subject, until its result names the task
  const setSaid = (text) => {
    const t = clip(text, SAID_MAX);
    if (!t || t === said || t === "NO_REPLY") return false;
    said = t;
    saidAt = new Date().toISOString();
    return true;
  };
  const setPlan = (items) => {
    const next = items.filter((i) => i.text).slice(0, PLAN_MAX);
    if (JSON.stringify(next) === JSON.stringify(plan)) return false;
    plan = next;
    return true;
  };
  const todos = (list) => setPlan((Array.isArray(list) ? list : []).map((t) => ({ text: clip(t.activeForm && t.status === "in_progress" ? t.activeForm : t.content, ITEM_MAX), state: STATE[t.status] ?? "todo" })));

  function take(e) {
    if (!e || typeof e !== "object") return false;
    let changed = false;
    // Claude Code: text between tool calls, and its task tools (TaskCreate/TaskUpdate; TodoWrite in older versions).
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === "text") changed = setSaid(c.text) || changed;
        if (c.type !== "tool_use") continue;
        if (c.name === "TodoWrite") changed = todos(c.input?.todos) || changed;
        if (c.name === "TaskCreate" && c.input?.subject) creating.set(c.id, c.input.subject);
        if (c.name === "TaskUpdate" && c.input?.taskId) {
          const id = String(c.input.taskId);
          const { status, subject } = c.input;
          if (status === "deleted") changed = setPlan(plan.filter((i) => i.id !== id)) || changed;
          else changed = setPlan(plan.map((i) => (i.id === id ? { ...i, ...(subject ? { text: clip(subject, ITEM_MAX) } : {}), ...(STATE[status] ? { state: STATE[status] } : {}) } : i))) || changed;
        }
      }
    }
    if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        const subject = c.type === "tool_result" && creating.get(c.tool_use_id);
        if (!subject) continue;
        creating.delete(c.tool_use_id);
        const id = e.tool_use_result?.task?.id ?? /#(\d+)/.exec(JSON.stringify(c.content))?.[1];
        if (id && !c.is_error) changed = setPlan([...plan.filter((i) => i.id !== String(id)), { id: String(id), text: clip(subject, ITEM_MAX), state: "todo" }]) || changed;
      }
    }
    // Codex: its messages, and the plan tool's list (no "in progress": the first open item is it).
    if (/^item\.(started|updated|completed)$/.test(e.type ?? "") && e.item) {
      if (e.item.type === "agent_message" && e.type === "item.completed") changed = setSaid(e.item.text) || changed;
      if (e.item.type === "todo_list" && Array.isArray(e.item.items)) {
        const open = e.item.items.findIndex((t) => !t.completed);
        changed = setPlan(e.item.items.map((t, i) => ({ text: clip(t.text, ITEM_MAX), state: t.completed ? "done" : i === open ? "doing" : "todo" }))) || changed;
      }
    }
    // opencode
    if (e.type === "text" && e.part?.text) changed = setSaid(e.part.text) || changed;
    if (e.type === "tool_use" && e.part?.tool === "todowrite") changed = todos(e.part.state?.input?.todos) || changed;
    return changed;
  }

  return { take, current: () => ({ ...(said ? { said, saidAt } : {}), ...(plan.length ? { plan: plan.map(({ text, state }) => ({ text, state })) } : {}) }) };
}
