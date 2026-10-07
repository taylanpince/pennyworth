import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const SystemSchema = z.object({
  timezone: z.string().default("UTC"),
  paperclip: z.object({ company_id: z.string().uuid() }),
});

export interface Config {
  paperclipUrl: string;
  companyId: string;
  boardKey: string;
  timezone: string;
  dbPath: string;
  port: number;
  /** Host headers the board answers to (DNS-rebinding guard), e.g. localhost:3120. */
  allowedHosts: string[];
  staticDir: string;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const system = SystemSchema.parse(parseYaml(readFileSync(env.BOARD_SYSTEM_CONFIG ?? "/config/system.yaml", "utf8")));
  const port = Number(env.BOARD_PORT ?? 3120);
  const hosts = (env.BOARD_ALLOWED_HOSTS ?? `localhost:${port},127.0.0.1:${port}`).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return {
    paperclipUrl: env.PAPERCLIP_URL ?? "http://paperclip:3100",
    companyId: system.paperclip.company_id,
    boardKey: readFileSync(env.BOARD_KEY_FILE ?? "/run/secrets/paperclip_board_key", "utf8").trim(),
    timezone: system.timezone,
    dbPath: env.BOARD_DB ?? "/data/board/board.sqlite",
    port,
    allowedHosts: hosts,
    staticDir: env.BOARD_STATIC_DIR ?? new URL("../web", import.meta.url).pathname,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
