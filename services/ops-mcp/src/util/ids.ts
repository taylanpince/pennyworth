import { createHash, randomUUID } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export const shortHash = (data: string): string => sha256(data).slice(0, 12);

export const nowIso = (): string => new Date().toISOString();
