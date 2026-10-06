import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import { normalizeTokens, tokensMatch } from "../matching/text.js";
import type { Vault } from "../vault/vault.js";

const RoutingFileSchema = z.object({
  routes: z
    .array(
      z.object({
        calendar_title_regex: z.string().optional(),
        attendee_email_regex: z.string().optional(),
        target: z.string(),
      }),
    )
    .default([]),
  topics: z
    .array(
      z.object({
        keywords: z.array(z.string()).min(1),
        target: z.string(),
      }),
    )
    .default([]),
  // Meetings whose title matches are never routed to a project note (canonical note only).
  skip_title_regex: z.array(z.string()).default([]),
});
export type RoutingFile = z.infer<typeof RoutingFileSchema>;

export type RoutingMethod = "rule" | "memory_series" | "memory_title" | "topic" | "manual" | "guess";

export interface RouteTarget {
  path: string;
  method: RoutingMethod;
  confidence: number;
  reason: string;
}

export interface RoutingResult {
  targets: RouteTarget[]; // confident targets to write
  candidates: { path: string; reason: string }[]; // low-confidence targets that were not written
  skipped: boolean; // skip rule matched or user said "no target"
  missing: string[]; // configured targets that do not exist
}

export interface RoutingInput {
  title: string;
  series_id?: string | null;
  attendee_emails: string[];
  topics: string[];
}

/** Supports the `(?i)` inline flag used in the spec's YAML examples. */
export function compileRegex(pattern: string): RegExp {
  let flags = "";
  let src = pattern;
  if (src.startsWith("(?i)")) {
    flags = "i";
    src = src.slice(4);
  }
  return new RegExp(src, flags);
}

export const titleKey = (title: string): string =>
  title
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export class Router {
  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    private readonly vault: Vault,
  ) {}

  loadFile(): RoutingFile {
    const path = this.cfg.routing.config_path;
    if (!existsSync(path)) return RoutingFileSchema.parse({});
    return RoutingFileSchema.parse(parseYaml(readFileSync(path, "utf8")) ?? {});
  }

  route(input: RoutingInput): RoutingResult {
    const file = this.loadFile();
    const result: RoutingResult = { targets: [], candidates: [], skipped: false, missing: [] };
    const add = (t: RouteTarget): void => {
      if (result.targets.some((x) => x.path === t.path)) return;
      if (!this.targetExists(t.path)) {
        result.missing.push(t.path);
        return;
      }
      result.targets.push(t);
    };

    if (file.skip_title_regex.some((r) => compileRegex(r).test(input.title))) {
      return { ...result, skipped: true };
    }

    // 1. Explicit rules.
    for (const r of file.routes) {
      const titleOk = r.calendar_title_regex ? compileRegex(r.calendar_title_regex).test(input.title) : undefined;
      const emailOk = r.attendee_email_regex
        ? input.attendee_emails.some((e) => compileRegex(r.attendee_email_regex!).test(e))
        : undefined;
      const conds = [titleOk, emailOk].filter((c) => c !== undefined);
      if (conds.length && conds.every(Boolean)) add({ path: r.target, method: "rule", confidence: 1, reason: "routing rule" });
    }

    // 2. Previously confirmed mappings.
    if (!result.targets.length) {
      const memory = this.recall(input);
      if (memory.noTarget) return { ...result, skipped: true };
      for (const t of memory.targets) add(t);
    }

    // 3. Strong topic match (configured keywords vs title + extracted topics).
    if (!result.targets.length) {
      const haystack = normalizeTokens([input.title, ...input.topics].join(" "), new Set());
      for (const t of file.topics) {
        const kw = t.keywords.map((k) => k.toLowerCase());
        const hits = kw.filter((k) => (k.includes(" ") ? [input.title, ...input.topics].join(" ").toLowerCase().includes(k) : haystack.some((h) => tokensMatch(h, k))));
        if (hits.length) add({ path: t.target, method: "topic", confidence: 0.8, reason: `topic keywords: ${hits.join(", ")}` });
      }
    }

    // Multiple targets only when every one is high confidence.
    const minMulti = this.cfg.routing.multi_target_confidence;
    if (result.targets.length > 1 && result.targets.some((t) => t.confidence < minMulti)) {
      const best = [...result.targets].sort((a, b) => b.confidence - a.confidence)[0]!;
      result.candidates.push(...result.targets.filter((t) => t !== best).map((t) => ({ path: t.path, reason: t.reason })));
      result.targets = [best];
    }
    return result;
  }

  private recall(input: RoutingInput): { targets: RouteTarget[]; noTarget: boolean } {
    const q = this.db.prepare("SELECT target FROM routing_memory WHERE key_type = ? AND key = ?");
    const fromSeries = input.series_id ? (q.all("series", input.series_id) as { target: string }[]) : [];
    const rows = fromSeries.length ? fromSeries : (q.all("title", titleKey(input.title)) as { target: string }[]);
    const method: RoutingMethod = fromSeries.length ? "memory_series" : "memory_title";
    const confidence = fromSeries.length ? 0.95 : 0.9;
    if (rows.length && rows.every((r) => r.target === "")) return { targets: [], noTarget: true };
    return {
      targets: rows.filter((r) => r.target).map((r) => ({ path: r.target, method, confidence, reason: "previously confirmed" })),
      noTarget: false,
    };
  }

  private targetExists(path: string): boolean {
    try {
      return this.vault.exists(path);
    } catch {
      return false;
    }
  }
}
