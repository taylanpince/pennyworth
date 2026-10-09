import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { WEEKDAYS, type Weekday } from "./recurrence.js";

const SystemSchema = z.object({
  timezone: z.string().default("UTC"),
  /** The days Tomorrow rolls into Today (D-28). */
  workdays: z.array(z.enum(WEEKDAYS)).min(1).default(["monday", "tuesday", "wednesday", "thursday", "friday"]),
  paperclip: z.object({ company_id: z.string().uuid() }),
});

export interface Config {
  paperclipUrl: string;
  companyId: string;
  boardKey: string;
  timezone: string;
  workdays: Weekday[];
  dbPath: string;
  port: number;
  /** Host headers the board answers to (DNS-rebinding guard), e.g. localhost:3120. */
  allowedHosts: string[];
  staticDir: string;
  logLevel: string;
  /**
   * The second listener for phones on the home network (off unless BOARD_LAN_CLIENTS is set):
   * paired devices only, from these client networks, under these host names.
   */
  lan?: { port: number; hosts: string[]; clients: string[]; url: string };
  /**
   * The listener for the tasks bridge and the runner (D-25), with a bearer token: off unless the
   * token file exists.
   */
  internal?: { port: number; hosts: string[]; token: string };
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
    workdays: system.workdays,
    dbPath: env.BOARD_DB ?? "/data/board/board.sqlite",
    port,
    allowedHosts: hosts,
    staticDir: env.BOARD_STATIC_DIR ?? new URL("../web", import.meta.url).pathname,
    logLevel: env.LOG_LEVEL ?? "info",
    lan: lanConfig(env),
    internal: internalConfig(env),
  };
}

function internalConfig(env: NodeJS.ProcessEnv): Config["internal"] {
  const file = env.BOARD_INTERNAL_TOKEN_FILE ?? "/run/secrets/board_internal_token";
  if (!existsSync(file)) return undefined;
  const token = readFileSync(file, "utf8").trim();
  if (token.length < 32) throw new Error(`${file}: token too short`);
  const port = Number(env.BOARD_INTERNAL_PORT ?? 3122);
  const hosts = (env.BOARD_INTERNAL_HOSTS ?? `board:${port},localhost:${port},127.0.0.1:${port}`).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return { port, hosts, token };
}

function lanConfig(env: NodeJS.ProcessEnv): Config["lan"] {
  const clients = (env.BOARD_LAN_CLIENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!clients.length) return undefined;
  for (const c of clients) if (!parseCidr(c)) throw new Error(`BOARD_LAN_CLIENTS: not an IPv4 CIDR: ${c}`);
  const hosts = (env.BOARD_LAN_HOSTS ?? "pennyworth.local").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return { port: Number(env.BOARD_LAN_PORT ?? 3121), hosts, clients, url: env.BOARD_LAN_URL ?? `http://${hosts[0]}` };
}

/** "192.168.7.0/24" → network and mask as 32-bit numbers. */
export function parseCidr(cidr: string): { net: number; mask: number } | undefined {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim());
  const ip = m ? ipv4(m[1]!) : undefined;
  const bits = m ? Number(m[2]) : NaN;
  if (ip === undefined || !(bits >= 0 && bits <= 32)) return undefined;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { net: (ip & mask) >>> 0, mask };
}

export function ipv4(addr: string): number | undefined {
  const parts = addr.replace(/^::ffff:/, "").split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return undefined;
  return parts.reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0);
}

export function inNetworks(addr: string | undefined, cidrs: string[]): boolean {
  const ip = addr ? ipv4(addr) : undefined;
  if (ip === undefined) return false;
  return cidrs.some((c) => {
    const n = parseCidr(c);
    return !!n && ((ip & n.mask) >>> 0) === n.net;
  });
}
