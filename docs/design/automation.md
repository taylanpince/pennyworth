# Design: agents that keep going (follow-ups, cross-model review, idle work, check-ins)

Status: decided, 2026-11-20 (decisions at the end); nothing built yet. Becomes **D-71** once stage 1 ships. Builds on D-25 (schedules in the board), D-45 (crew parts), D-50 (every comment is a turn), D-54 (passing work on), D-60 (roles, engine a setting) and D-70 (draft PRs need no go-ahead). Every write gate in AGENTS.md stays.

## Why

Today every turn an agent takes starts with a comment from the user. The agents stop when they reply, and the user is the scheduler: they notice a review arrived, a Slack thread moved or a task is next, and type the comment that starts the next turn.

| What the user does by hand (last 30 days, Paperclip comments) | How often |
|---|---|
| "Review comments from Tolga", "Review and action the PR comment", "Review the security comment on the PR and apply if appropriate" | ~30 comments |
| Pointing an agent at a Slack thread or new replies in one | ~18 |
| "Check again", "follow up on", "keep an eye on" | ~13 |
| Starting work on the next task in Today | every task |

The runner has opened 198 PRs on 47 tasks; 107 are merged. Reviews on them come from colleagues, Copilot and CodeRabbit, and each round waits for the user to notice.

## Principles

1. **Events start turns, in code.** What the runner watches, when it checks and whether something counts as new are code and SQLite, never a prompt. The agent decides what to do with the news.
2. **An event is not the user's word.** A turn started by a review comment or a Slack reply runs with the same tools as any turn, but `authorize()` still sees only the user's own comments. Nothing an event brings in can pass a gate (D-50 principle 3).
3. **Bounded.** Every automatic loop has a round cap, a daily cost cap, and a way to switch it off per task and globally.
4. **Visible.** Every automatic turn says on the task what started it, and the board shows it like any other turn. The user never has to wonder why an agent woke up.

## Shape

```text
watches (runner SQLite)                         checks, in code, on the runner's poll
  pr:<url>         own PRs                ──►  GitHub GraphQL: new reviews, review threads, comments, failed checks
  slack:<ch>:<ts>  the task's Slack source ──►  slack-mcp /mcp/read: replies after the cursor, from others
  primer:<doc>     own Primer documents    ──►  primer-mcp /mcp/read: new comments
  at:<time>        a follow-up an agent set ──►  the clock
                │
                └─ something new ──► event comment on the agent's part (runner-marked, content fenced)
                                       │
                                       ├─ the part's agent idle   → start a turn ("what changed; decide")
                                       ├─ a turn running          → into the session (Claude Code) or next turn (D-50)
                                       └─ the part is waiting on the user (a check-in) → hold until they answer
```

### 1. Watches and follow-ups

A `watches` table in the runner's state: `issue_id, kind, target, cursor, next_check, until, rounds, paused`.

**Made in code, without asking:**

- **Own PRs.** Every PR in `own-pr:` (D-70) gets a watch when the runner opens it. It ends when the PR is merged or closed.
- **The task's Slack thread.** A task (or its parent) with a `source:slack:<channel>:<ts>` marker gets a watch while any agent part on it is open or finished in the last 7 days. `slackSources` already parses these (PEN-2799).
- **Own Primer documents.** The document a task published (D-44) gets a watch for comments; "Review Jeremy's comments on the Primer doc and update accordingly" is in the list above.

**Made by agents:** `pennyworth later <when> "<why>"` for Engineers and `task_follow_up` for Alfred and Ursula. The time is parsed in code (the board's `recurrence.ts` parser), at most 30 days ahead, at most 5 open per part. When it fires, the agent gets its own note back as the turn's reason. Recurring checks are the D-25 recurring task, made on the user's word as today, so an agent can't create unbounded work for itself.

**What counts as new, in code:**

| Watch | New | Ignored |
|---|---|---|
| PR | a review or review comment after the cursor; a top-level comment; a required check that turned red on the PR's head | the user's own and the runner's; bots outside an allow list; reviewers outside the repo (`authorAssociation` not MEMBER/COLLABORATOR/OWNER) are shown but don't start a turn |
| Slack | a reply after the cursor from anyone but the user and bots | edits, reactions |
| Primer | a comment after the cursor | the user's own (they talk on the task) |

Checks run on the runner's poll: PRs every 2 minutes (one batched GraphQL query for all open watches), Slack and Primer every 10, debounced 3 minutes after the last new item so a reviewer's ten comments are one turn.

**The event turn.** The runner posts one comment on the agent's part: what arrived, with links, and the content fenced as untrusted (`<!-- pennyworth-event:pr:… -->`). The turn's instructions are fixed text from the runner, per kind:

- PR review: "New review activity on your PR. Address what you agree with in the branch and update the PR with `pennyworth pr`. For each thread, draft your reply on the task (what you changed, or why not); don't reply on GitHub yourself."
- Failed checks: "A required check failed on your PR. Find out why; fix it if the cause is in your change."
- Slack: "The Slack thread this task came from has new replies. Update your work or report if they change anything; otherwise reply `NO_REPLY`."
- Follow-up: "You asked to check back: <note>."

`NO_REPLY` keeps quiet turns quiet (D-50). Updating an own PR is already ungated (D-70).

**Bounds:** at most 5 automatic rounds per PR per day and 3 per Slack thread; two rounds in a row that change nothing stop the watch until the user comments. A per-task **Hands off** switch in Details pauses every watch on the task; Settings has one per kind.

### 2. Cross-model review of the crew's own PRs

When an Engineer opens a PR, or pushes to one after a review round, the runner asks **Linus** for a review of it, on a model from a **different family** than the one that wrote it. The pairing is config, not prompt:

```yaml
# config/runner.yaml
cross_review:
  enabled: true
  rounds: 3                      # author ↔ reviewer rounds per PR before it stops and tells the user
  chains:                        # the author's engine → the reviewers to try, in order
    claude:     [codex:gpt-6-astra, openrouter:deepseek/deepseek-v4.1-flash, openrouter:moonshotai/kimi-k3]
    codex:      [claude:claude-opus-5-5, openrouter:deepseek/deepseek-v4.1-flash]
    openrouter: [claude:claude-opus-5-5, codex:gpt-6-astra]
```

- **Where it runs:** Linus's part of the same task (made by the runner like "+ Add agent", or reused), with the engine override set per round. The review reads the diff, the task and the author's report (D-45 context). It's Linus's normal job; only the trigger and the engine are automatic.
- **Refusals fall back, in code.** A round counts as refused when the engine refuses (Codex's policy refusal, an empty reply, or the model saying it won't review security-sensitive code; the exact signals get a regression set like `eval:busy`). The runner then tries the next reviewer in the chain and says so on the part ("Codex Astra declined; DeepSeek Flash reviewed instead").
- **The loop:** Linus's findings go to the author's part as an event (fenced, like D-54's pass-on but from an agent, so they're context, not instructions). The author fixes what it agrees with and updates the PR; that push triggers the next review round. It stops when Linus reports no blocking findings, after `rounds`, or when the user comments.
- **Nothing reaches GitHub by itself.** Linus's findings stay on the task; posting them as a GitHub review stays on the user's word (D-60: "findings here first"). The PR stays a draft.

### 3. Check-ins: where agents stop and wait for the user

Agents already ask in their replies. What's missing is a way for code to know an agent is waiting, so automation doesn't run past the question.

- **`pennyworth ask` / `task_ask`:** a question with options and the agent's recommendation. The part shows **Needs you** with the question as a decision card (one-click options, or a reply). Until the user answers, no event or idle turn starts on that part; events pile up and arrive together with the answer.
- **The prompt says when to ask:** a choice between approaches with real trade-offs, anything outside what the task asked for, a change to someone else's work, or a reviewer's comment it disagrees with. Not for draft PRs, own branches, or anything D-70 already lets through.
- **Gates that stay, in code (unchanged):** pushes to anything not the task's own, merges (D-46), AWS changes (D-59), GitHub comments/issues/reviews/CI re-runs (D-39, D-42, D-46), Jira writes (D-69), Slack drafts, Primer versions of others' documents, and the D-24 go-ahead on agent-proposed work.
- **No gate on draft PRs** (D-70, and now also when the turn was started by an event).

### 4. Idle work in priority order

When the runner has a free slot (fewer than `max_concurrent - 1` jobs running and nothing queued, so the user's own requests always find a slot) and the daily idle budget isn't spent, it takes the next task, top down: Today, then Tomorrow, by the board's rank.

**Skipped:** tasks with any agent part (they're being worked on), recurring, `needs-review`, snoozed, Backlog and Later, subtasks whose task has a part, tasks the user marked **Hands off**, and tasks already picked once (`idle:<task>` in the state).

**What happens to a picked task depends on whose words it is (decision 2):**

- **The user's own task** (created on the board or by the user's comment, no scout/inbox `source:` marker, description written by the user): Alfred gets it with "Route this task," and picks the role (D-60's routing, done by Alfred as when asked). The part he makes for that role starts at once, as if the user had added it: an Engineer can work and open draft PRs (D-70). Alfred's routing reads only the user's own text, so the instruction the Engineer runs is still the user's.
- **A task made from someone else's words** (Slack Scout, Telegram Scout, Inbox Agent, Meeting Librarian, an agent's `task_create`): Alfred gets it with "Prepare this task for the user." He reads it and its sources, does what is read-only (research, a summary, a draft), and routes code or production work by proposing a part, which waits for **Approve** (the D-24/D-45 *proposed* state). D-24's go-ahead exists because running someone else's text as code changes on this machine, unseen, is the one thing the security posture is built to stop.

Who wrote a task is decided in code from its markers and author, never by Alfred. Either way the board shows Alfred's portrait and "Needs you" when there's something to look at.

**Budget:** `idle.daily_usd` (default $20, from the D-62 usage numbers) and `idle.hours` (default 08:00–20:00 weekdays, so nothing starts while the user isn't around to answer).

## What changes where

| Piece | Change |
|---|---|
| `services/runner/src/watches.mjs` (new) | the table, the checks per kind, "what counts as new", debounce and caps; pure functions unit-tested like `reviews.mjs` |
| `services/runner/src/main.mjs` | `poll()` gets `advanceWatches()` and `startIdleWork()`; event turns go through the same `handleRequest` path as comments, marked as events |
| `services/runner/src/thread.mjs` | labels event comments (`pennyworth-event`) as untrusted, never as the user |
| `services/runner/src/authorize.mjs` | unchanged inputs; a regression case that an event comment can't authorize a push to someone else's branch |
| `services/runner/src/crossreview.mjs` (new) | chains, refusal detection, round counting |
| `bin/pennyworth` | `later`, `ask` |
| tasks bridge | `task_follow_up`, `task_ask` (Alfred, Ursula; checked by setup key) |
| board | Hands off switch, decision cards, the idle "picked" mark, Settings toggles |
| `config/runner.example.yaml` | `watches`, `cross_review`, `idle` |
| `verify-security.sh` | no job gets a write token for Slack or Primer; watch checks use the read tokens |

## Stages

1. **Watches on own PRs** (reviews and failed checks) and **check-ins**. The biggest manual load, and the decision card is what makes the rest safe.
2. **Cross-model review**, on top of the PR watch.
3. **Slack and Primer watches, and agent follow-ups.**
4. **Idle work.**

Each stage extends `test/flow.test.mjs` (fake GitHub reviews, a fake Slack reply, a refused review round) and ships behind its config switch.

## Risks

- **Prompt injection through reviews.** A review comment can now start a turn that pushes to an own draft PR without the user. That is D-70's accepted risk with one more way in. CI on a pushed branch can run with the repository's secrets; restricting triggers to org members and allowed bots keeps outsiders from steering it.
- **Cost.** Every review round is two agent turns (reviewer and author). Caps above; the Stats view gets an "automatic" column so the cost is visible.
- **Noise.** Bots that comment on every push (coverage, preview links) would start turns; the allow list is of reviewers, not of all bots.

## Decisions (the user, 2026-11-20)

1. **Replies to reviewers:** the agent fixes and updates the PR unasked, and drafts its replies to the review threads on the task; posting and resolving them on GitHub waits for the user's word (they appear under the user's name).
2. **Idle work, split by author:** tasks the user wrote start the routed role's work; tasks from other people's words get Alfred's preparation and a proposed part that waits for Approve.
3. **Failed CI on own PRs:** fixed automatically, like a review round, and counted in the same per-PR cap.
4. **A converged review loop** leaves the PR a draft and marks the task Needs you with the summary; the user marks it ready.
