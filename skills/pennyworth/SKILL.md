---
name: pennyworth
description: Use in a coding session the user started themselves (not a Pennyworth job) to read and update their Pennyworth task list with the todo CLI - when they ask what's on their list, to add or track a task, to note progress on a PEN-N task, or to close one when the work is done.
---

# Pennyworth task list

Pennyworth keeps the user's tasks in Paperclip. `scripts/todo.mjs` in the Pennyworth checkout reads and updates them as the user, with the board key from the secrets directory. Call it as `todo` if the user has that alias, otherwise `node <pennyworth checkout>/scripts/todo.mjs`.

This is for sessions the user runs by hand. A Pennyworth Engineer job already has its own `pennyworth` tool and never needs this.

## Commands

| When | Command |
|---|---|
| The user asks what's open | `todo`, `todo --all` (reviews and briefs too), `todo waiting` |
| Before working on a PEN-N task | `todo show PEN-12` |
| The user asks you to track something they will do | `todo add "what needs doing" -p high -n "details"` |
| The user changes a priority | `todo prio PEN-12 critical` (critical, high, medium, low) |
| A phase of the work finished, or you are blocked | `todo note PEN-12 "opened the draft PR: <link>"` |
| The work is done | `todo done PEN-12 "outcome in one line"` |

## Rules

- **Tasks are the user's own actions.** Add one only when the user asks, or for an action that is clearly theirs. Never for someone else's commitment, and never for your own sub-steps.
- **Progress goes in `todo note`, never in `done`'s note while the work is open.** A note carries the runner's marker, so Pennyworth never reads it as the user's words: it doesn't wake the Assistant or count as the user's go-ahead for anything. Any other comment written with the board key reads as the user typing it.
- **Note at phase boundaries only:** a PR opened, a decision needed, a blocker, the work finished. Not every command you run.
- **Close with the outcome,** such as the PR link or what changed, so the task reads as done without the session.
- **Nothing secret goes in a task:** no tokens, keys or credentials, and no private content the task doesn't need. Other Pennyworth agents read task text.
- **Pennyworth doesn't publish for you here.** Push, open PRs and merge with your own tools under the user's normal rules, then note the result.
