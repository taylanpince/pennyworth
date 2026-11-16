import { expect, it } from "vitest";
import { modelFiles } from "../web/src/modelFiles.js";
import type { FileView } from "../web/src/types.js";

it("groups only matching model revisions and leaves unrelated attachments accessible", () => {
  const files = ["card-grid-v001.glb", "card-grid-v001.step", "card-grid-v001.py", "card-grid-v002.glb", "card-grid-v002.stl", "reference.png", "other.json"].map((name, i): FileView => ({ id: String(i), name, type: "", size: 10, createdAt: "", by: "agent", textOf: null }));
  const { models, other } = modelFiles(files);
  expect(models.map((m) => [m.title, m.revision, m.files.map((f) => f.name)])).toEqual([
    ["Card grid", "001", ["card-grid-v001.glb", "card-grid-v001.step", "card-grid-v001.py"]],
    ["Card grid", "002", ["card-grid-v002.glb", "card-grid-v002.stl"]],
  ]);
  expect(other.map((f) => f.name)).toEqual(["reference.png", "other.json"]);
});
