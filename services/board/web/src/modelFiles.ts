import type { FileView } from "./types.js";

export function modelFiles(files: FileView[]) {
  const models = files.filter((f) => /\.glb$/i.test(f.name)).map((preview) => {
    const stem = preview.name.slice(0, -4);
    const revision = stem.match(/-v(\d+)$/i)?.[1];
    const title = stem.replace(/-v\d+$/i, "").replace(/[-_]+/g, " ").replace(/^./, (s) => s.toUpperCase());
    return {
      preview, title, revision,
      files: files.filter((f) => f.name.slice(0, f.name.lastIndexOf(".")) === stem && /\.(glb|step|stp|stl|py|json)$/i.test(f.name)),
    };
  });
  const grouped = new Set(models.flatMap((m) => m.files.map((f) => f.id)));
  return { models, other: files.filter((f) => !grouped.has(f.id)) };
}
