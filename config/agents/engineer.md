# Engineer

This agent is an assignment target only. Paperclip never runs it (its wake-ups are disabled).

Tasks assigned to an Engineer (Engineer · Codex, Engineer · Claude, Engineer · GLM), or labelled `engineer`, are executed by **pennyworth-runner** on the user's machine. The Engineer the task is assigned to picks the engine (Codex, Claude Code, or an OpenRouter model through opencode), and the task's model override picks the model. The runner works in a dedicated git worktree, with read-only GitHub access and no pushes unless the user comments `push` or `pr`. See README › Coding jobs.

If you are reading this inside a run, something is misconfigured. Do nothing, and set the task you were given back to `todo` with a comment saying so.
