import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** `codex sandbox` around a whole process: writes only in the worktree, the given state dirs and the build caches. */
function codexSandbox(cfg, worktree, stateRoots, argv) {
  return [
    "codex", "sandbox",
    "-c", 'sandbox_mode="workspace-write"',
    "-c", "sandbox_workspace_write.network_access=true", // the engine itself talks to its model API
    "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([worktree, ...stateRoots, ...(cfg.sandbox?.extra_writable_roots ?? []).map(expand)])}`,
    "--", ...argv,
  ];
}

// Claude Code's built-in tools for coding jobs. Everything else (scheduling, remote triggers,
// notifications, messaging, workflows) is left out; MCP servers, plugins and claude.ai connectors
// are off entirely.
const CLAUDE_TOOLS = "Bash,Read,Edit,Write,NotebookEdit,Task,TaskStop,WebFetch,WebSearch";

/** Command line for one engine run. Codex sandboxes its own tool calls; opencode and Claude Code run inside `codex sandbox`. */
export function buildCommand({ cfg, engine, worktree, sessionId, lastMessageFile }) {
  if (engine.kind === "codex") {
    const base = sessionId ? ["codex", "exec", "resume", sessionId] : ["codex", "exec"];
    const args = [...base, "--json", "-o", lastMessageFile, ...sandboxConfig(cfg, worktree)];
    if (engine.model) args.push("-m", engine.model);
    if (engine.effort) args.push("-c", `model_reasoning_effort="${engine.effort}"`);
    args.push("-");
    return { argv: args, env: {} };
  }
  if (engine.kind === "openrouter") {
    const key = readFileSync(cfg.openrouterKeyFile, "utf8").trim();
    const opencode = ["opencode", "run", "--format", "json", "--model", `openrouter/${engine.model}`];
    if (sessionId) opencode.push("--session", sessionId);
    // OS-level confinement for opencode's tools: Codex's sandbox around the whole process.
    const stateRoots = ["~/.local/share/opencode", "~/.local/state/opencode", "~/.cache/opencode", "~/.config/opencode"].map(expand);
    return {
      argv: codexSandbox(cfg, worktree, stateRoots, opencode),
      env: {
        OPENROUTER_API_KEY: key,
        // Non-interactive: opencode must not stop to ask for permission, because an unanswered prompt
        // is auto-rejected and ends the run. Reading outside the worktree (reference repos) is
        // fine: the codex sandbox around opencode still limits writes to the worktree.
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow", doom_loop: "allow" },
          autoupdate: false,
          share: "disabled",
        }),
      },
      promptAsArg: true,
    };
  }
  if (engine.kind === "claude") {
    if (!existsSync(cfg.claudeTokenFile)) throw new Error(`Claude Code isn't set up for the runner: run \`claude setup-token\` and save the token to \`${cfg.claudeTokenFile}\` (0600).`);
    const token = readFileSync(cfg.claudeTokenFile, "utf8").trim();
    mkdirSync(cfg.claudeConfigDir, { recursive: true, mode: 0o700 });
    // Headless, no prompts (the codex sandbox is the write boundary), and nothing from your own
    // Claude setup: a runner-owned config dir, no settings files (yours or the repo's: no hooks),
    // no MCP servers and no claude.ai connectors.
    const claude = [
      "claude", "-p", "--output-format", "stream-json", "--verbose",
      "--permission-mode", "bypassPermissions",
      "--setting-sources", "",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--tools", CLAUDE_TOOLS,
    ];
    if (engine.model) claude.push("--model", engine.model);
    if (engine.effort) claude.push("--effort", engine.effort === "minimal" ? "low" : engine.effort);
    if (sessionId) claude.push("--resume", sessionId);
    return {
      argv: codexSandbox(cfg, worktree, [cfg.claudeConfigDir], claude),
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: token,
        CLAUDE_CONFIG_DIR: cfg.claudeConfigDir,
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        DISABLE_AUTOUPDATER: "1",
      },
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
  if (engine.kind === "claude") delete agentEnv.ANTHROPIC_API_KEY; // the subscription token, never an API key

  return new Promise((resolve) => {
    const log = createWriteStream(logPath, { flags: "a" });
    log.write(`# ${new Date().toISOString()} ${engine.kind}${engine.model ? ` (${engine.model})` : ""} in ${worktree}\n# shells: ${shells.join(", ")}\n`);
    const child = spawn(full[0], full.slice(1), { cwd: worktree, env: agentEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let found = sessionId;
    let finalText = "";
    let buffer = "";
    const onLine = (line) => {
      try {
        const e = JSON.parse(line);
        if (e.type === "thread.started" && e.thread_id) found = e.thread_id; // codex
        if (e.sessionID && !found) found = e.sessionID; // opencode
        if (e.type === "text" && e.part?.text) finalText = e.part.text; // opencode: keep last text part
        if (e.type === "system" && e.subtype === "init" && e.session_id && !found) found = e.session_id; // claude
        if (e.type === "result" && typeof e.result === "string") finalText = e.result; // claude: the final message
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
      let lastMessage = existsSync(lastMessageFile) ? readFileSync(lastMessageFile, "utf8").trim() : finalText.trim();
      if (!lastMessage && engine.kind !== "codex") lastMessage = finalText.trim();
      if (lastMessage) writeFileSync(lastMessageFile, lastMessage);
      resolve({ code, sessionId: found, lastMessage, timedOut, cancelled });
    });
  });
}
