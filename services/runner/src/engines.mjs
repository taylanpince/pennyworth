import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Wrap a command in the requested devshells: nix develop A --command nix develop B --command … */
export function inDevshells(flake, shells, argv) {
  return shells.reduceRight((inner, shell) => ["nix", "develop", `${flake}#${shell}`, "--command", ...inner], argv);
}

function sandboxConfig(cfg, worktree) {
  const roots = [worktree, ...(cfg.sandbox?.extra_writable_roots ?? []).map(expand)].filter((p) => existsSync(p) || p === worktree);
  return [
    "-c", 'sandbox_mode="workspace-write"',
    "-c", `sandbox_workspace_write.network_access=${cfg.sandbox?.network === false ? "false" : "true"}`,
    "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    "-c", 'approval_policy="never"',
  ];
}

/** Command line for one engine run. Codex sandboxes its own tool calls; opencode runs inside `codex sandbox`. */
export function buildCommand({ cfg, engine, worktree, sessionId, lastMessageFile }) {
  if (engine.kind === "codex") {
    const base = sessionId ? ["codex", "exec", "resume", sessionId] : ["codex", "exec"];
    const args = [...base, "--json", "-o", lastMessageFile, ...sandboxConfig(cfg, worktree)];
    if (engine.model) args.push("-m", engine.model);
    args.push("-");
    return { argv: args, env: {} };
  }
  if (engine.kind === "openrouter") {
    const key = readFileSync(cfg.openrouterKeyFile, "utf8").trim();
    const opencode = ["opencode", "run", "--format", "json", "--model", `openrouter/${engine.model}`];
    if (sessionId) opencode.push("--session", sessionId);
    // OS-level confinement for opencode's tools: Codex's sandbox around the whole process.
    const stateRoots = ["~/.local/share/opencode", "~/.local/state/opencode", "~/.cache/opencode", "~/.config/opencode"].map(expand);
    const sandboxed = [
      "codex", "sandbox",
      "-c", 'sandbox_mode="workspace-write"',
      "-c", "sandbox_workspace_write.network_access=true",
      "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([worktree, ...stateRoots, ...(cfg.sandbox?.extra_writable_roots ?? []).map(expand)])}`,
      "--", ...opencode,
    ];
    return {
      argv: sandboxed,
      env: {
        OPENROUTER_API_KEY: key,
        // Non-interactive: opencode must not stop to ask for permission (the sandbox is the boundary).
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: "allow", bash: "allow", webfetch: "allow" }, autoupdate: false, share: "disabled" }),
      },
      promptAsArg: true,
    };
  }
  throw new Error(`unsupported engine ${engine.kind}`);
}

/**
 * Run the agent; resolves with { code, sessionId, lastMessage, timedOut, cancelled }.
 * The agent's environment: no SSH agent (fetch only via the runner), read-only gh first on PATH,
 * and a git ssh wrapper that refuses pushes.
 */
export function runAgent({ cfg, engine, shells, worktree, prompt, sessionId, logPath, signal }) {
  const lastMessageFile = `${logPath}.last.md`;
  const { argv, env, promptAsArg } = buildCommand({ cfg, engine, worktree, sessionId, lastMessageFile });
  const full = inDevshells(cfg.devshells.flake, shells, promptAsArg ? [...argv, prompt] : argv);
  const agentEnv = {
    ...process.env,
    ...env,
    PATH: `${cfg.ghWrapperDir}:${process.env.PATH}`,
    GIT_SSH_COMMAND: join(cfg.ghWrapperDir, "git-ssh-no-push"),
    GIT_TERMINAL_PROMPT: "0",
    PENNYWORTH_TASK_WORKTREE: worktree,
  };
  delete agentEnv.SSH_AUTH_SOCK;

  return new Promise((resolve) => {
    const log = createWriteStream(logPath, { flags: "a" });
    log.write(`# ${new Date().toISOString()} ${engine.kind}${engine.model ? ` (${engine.model})` : ""} in ${worktree}\n# shells: ${shells.join(", ")}\n`);
    const child = spawn(full[0], full.slice(1), { cwd: worktree, env: agentEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let found = sessionId;
    let opencodeText = "";
    let buffer = "";
    const onLine = (line) => {
      try {
        const e = JSON.parse(line);
        if (e.type === "thread.started" && e.thread_id) found = e.thread_id; // codex
        if (e.sessionID && !found) found = e.sessionID; // opencode
        if (e.type === "text" && e.part?.text) opencodeText = e.part.text; // opencode: keep last text part
      } catch {
        /* non-JSON output */
      }
    };
    child.stdout.on("data", (d) => {
      log.write(d);
      buffer += d.toString();
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        onLine(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    child.stderr.on("data", (d) => log.write(d));
    if (!promptAsArg) child.stdin.end(prompt);
    else child.stdin.end();

    let timedOut = false;
    let cancelled = false;
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 10_000).unref();
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, (cfg.timeout_minutes ?? 60) * 60_000);
    signal?.addEventListener("abort", () => {
      cancelled = true;
      kill();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      log.end();
      let lastMessage = existsSync(lastMessageFile) ? readFileSync(lastMessageFile, "utf8").trim() : opencodeText.trim();
      if (!lastMessage && engine.kind === "openrouter") lastMessage = opencodeText.trim();
      if (lastMessage) writeFileSync(lastMessageFile, lastMessage);
      resolve({ code, sessionId: found, lastMessage, timedOut, cancelled });
    });
  });
}
