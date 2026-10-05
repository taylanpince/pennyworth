import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { PathRejectedError } from "./errors.js";

/** True when `child` equals `parent` or lies beneath it. Both must be absolute and normalized. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Realpath of every existing root. Missing roots are skipped (reported by health checks). */
export function realRoots(roots: string[]): string[] {
  return roots.filter((r) => existsSync(r)).map((r) => realpathSync(r));
}

/**
 * Resolve an absolute path (symlinks included) and require it to sit inside one of
 * `roots`. Used for transcript files found by directory walks.
 */
export function resolveAbsoluteWithin(path: string, roots: string[]): string {
  if (path.includes("\0")) throw new PathRejectedError("NUL byte");
  if (!isAbsolute(path)) throw new PathRejectedError("expected an absolute path");
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new PathRejectedError("does not exist");
  }
  if (!roots.some((root) => isWithin(root, real))) throw new PathRejectedError("outside configured roots");
  return real;
}

/**
 * Validate a vault-relative path supplied by a caller (possibly an LLM) and resolve
 * it against `vaultRoot`, requiring the result to be inside one of `allowedDirs`
 * (vault-relative). Works for files that do not exist yet: the nearest existing
 * ancestor is realpath'd, and the remaining segments are plain names.
 */
export function resolveVaultPath(vaultRoot: string, relPath: string, allowedDirs: string[]): { abs: string; rel: string } {
  if (typeof relPath !== "string" || relPath.length === 0) throw new PathRejectedError("empty path");
  if (relPath.length > 512) throw new PathRejectedError("path too long");
  if (relPath.includes("\0")) throw new PathRejectedError("NUL byte");
  if (isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) throw new PathRejectedError("absolute paths are not allowed");
  const segments = relPath.split(/[\\/]+/).filter((s) => s.length > 0);
  for (const s of segments) {
    if (s === "." || s === "..") throw new PathRejectedError("relative segments are not allowed");
    if (s.startsWith(".")) throw new PathRejectedError("hidden files and folders are not allowed");
  }
  const realVault = realpathSync(vaultRoot);
  const normalized = segments.join("/");
  const abs = join(realVault, ...segments);

  // Find the nearest existing ancestor and realpath it so symlinks cannot escape.
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) throw new PathRejectedError("no existing ancestor");
    probe = parent;
  }
  const realProbe = realpathSync(probe);
  const remainder = relative(probe, abs);
  const resolved = remainder ? join(realProbe, remainder) : realProbe;

  if (!isWithin(realVault, resolved)) throw new PathRejectedError("outside the vault");
  const allowed = allowedDirs.map((d) => {
    const candidate = join(realVault, ...d.split(/[\\/]+/).filter(Boolean));
    return existsSync(candidate) ? realpathSync(candidate) : candidate;
  });
  if (!allowed.some((dir) => isWithin(dir, resolved) && resolved !== dir)) {
    throw new PathRejectedError("outside the allowed vault folders");
  }
  return { abs: resolved, rel: relative(realVault, resolved).split(sep).join("/") || normalized };
}
