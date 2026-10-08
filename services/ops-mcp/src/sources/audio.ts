import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/** The audio file recorded next to a transcript (same directory and stem), if any. */
export function siblingAudio(transcriptPath: string, extensions: string[]): string | undefined {
  const stem = basename(transcriptPath, extname(transcriptPath));
  for (const ext of extensions) {
    const candidate = join(dirname(transcriptPath), `${stem}${ext}`);
    // lstat: a symlink is never treated as the recording (it would be deleted later).
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Length of a PCM WAV recording in ms, from its header's byte rate and the file size.
 * The header's own data size is not trusted: a recorder that died mid-meeting leaves it
 * unfinalized. Returns undefined for anything that isn't a readable WAV.
 */
export function wavDurationMs(path: string): number | undefined {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(4096);
    const n = readSync(fd, header, 0, header.length, 0);
    if (n < 44 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") return undefined;
    const size = lstatSync(path).size;
    let byteRate: number | undefined;
    for (let off = 12; off + 8 <= n; ) {
      const id = header.toString("ascii", off, off + 4);
      const len = header.readUInt32LE(off + 4);
      if (id === "fmt " && off + 20 <= n) byteRate = header.readUInt32LE(off + 16);
      if (id === "data") return byteRate ? Math.round(((size - off - 8) / byteRate) * 1000) : undefined;
      off += 8 + len + (len % 2);
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}
