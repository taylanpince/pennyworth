/** The first CAD preview supports self-contained, uncompressed GLB files only. */
export function checkCadModel(bytes: ArrayBuffer): void {
  if (bytes.byteLength < 20 || bytes.byteLength > 10 * 1024 * 1024) throw new Error("The model is empty or exceeds 10 MB.");
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error("This file is not a GLB 2.0 model.");
  }
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || length % 4 || length > bytes.byteLength - 20) throw new Error("The model header is invalid.");
  const model = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
  if (model?.asset?.version !== "2.0") throw new Error("The model version is unsupported.");
  // GLB can still reference remote buffers/textures or request decoder downloads. Never let an
  // attachment make those requests, including authenticated requests elsewhere on the board.
  function inspect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "uri") throw new Error("Preview requires a model with all resources embedded.");
      if (["extensions", "extensionsUsed", "extensionsRequired"].includes(key) && child && Object.keys(child).length) {
        throw new Error("Preview does not support model extensions or compression yet.");
      }
      inspect(child);
    }
  }
  inspect(model);
  // Textures aren't needed for the CAD trial; this also avoids blob image URLs under our CSP.
  if (model.images?.length || model.textures?.length) throw new Error("Preview currently supports untextured CAD models only.");
}
