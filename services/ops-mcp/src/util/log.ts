import pino from "pino";

// Paths here are redacted wherever they appear in a log object.
const REDACT = [
  "authorization", "*.authorization", "headers.authorization", "apiKey", "*.apiKey",
  "token", "*.token", "secret", "*.secret", "content", "*.content", "text", "*.text",
];

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  return pino({ level, redact: { paths: REDACT, censor: "[redacted]" }, base: { svc: "ops-mcp" } });
}
