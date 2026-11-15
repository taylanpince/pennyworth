import { describe, expect, it } from "vitest";
import { checkCadModel } from "../web/src/cad.js";

function glb(model: object): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, ...model }));
  const length = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(20 + length);
  const view = new DataView(bytes);
  [0x46546c67, 2, bytes.byteLength, length, 0x4e4f534a].forEach((n, i) => view.setUint32(i * 4, n, true));
  new Uint8Array(bytes, 20).fill(32);
  new Uint8Array(bytes, 20).set(json);
  return bytes;
}

describe("CAD attachment preview", () => {
  it("accepts self-contained CAD geometry", () => {
    expect(() => checkCadModel(glb({ buffers: [{ byteLength: 100 }], meshes: [] }))).not.toThrow();
  });
  it.each(["https://example.com/track", "/api/board", "data:image/png;base64,AA", "file:///tmp/model"])("refuses external resources: %s", (uri) => {
    expect(() => checkCadModel(glb({ buffers: [{ uri }] }))).toThrow(/embedded/);
    expect(() => checkCadModel(glb({ images: [{ uri }] }))).toThrow(/embedded/);
  });
  it("refuses decoder extensions and textures", () => {
    expect(() => checkCadModel(glb({ extensionsUsed: ["KHR_draco_mesh_compression"] }))).toThrow(/extensions/);
    expect(() => checkCadModel(glb({ meshes: [{ extensions: { KHR_draco_mesh_compression: {} } }] }))).toThrow(/extensions/);
    expect(() => checkCadModel(glb({ images: [{ bufferView: 0 }] }))).toThrow(/untextured/);
  });
  it("rejects malformed and oversized files", () => {
    expect(() => checkCadModel(new ArrayBuffer(10))).toThrow();
    expect(() => checkCadModel(new ArrayBuffer(10 * 1024 * 1024 + 1))).toThrow();
    const bytes = glb({});
    new DataView(bytes).setUint32(12, bytes.byteLength, true);
    expect(() => checkCadModel(bytes)).toThrow(/header/);
  });
});
