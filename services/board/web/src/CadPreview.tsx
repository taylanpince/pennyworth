import { useEffect, useRef, useState } from "react";
import { checkCadModel } from "./cad";
import type { renderCad } from "./cad-render";

export function CadPreview({ url, name }: { url: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Awaited<ReturnType<typeof renderCad>> | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoaded(false);
    setError("");
    void (async () => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error("Couldn't load the model.");
      const bytes = await response.arrayBuffer();
      checkCadModel(bytes);
      const { renderCad } = await import("./cad-render");
      if (controller.signal.aborted || !host.current) return;
      const rendered = await renderCad(host.current, bytes, name);
      if (controller.signal.aborted) rendered.dispose();
      else {
        viewer.current = rendered;
        setLoaded(true);
      }
    })().catch((e: Error) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => {
      controller.abort();
      viewer.current?.dispose();
      viewer.current = null;
    };
  }, [open, url, name]);

  return (
    <div className="cad-preview">
      <button className="btn subtle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close preview" : "Preview 3D"}</button>
      {open && (
        <div className="cad-preview-body">
          {error ? <p role="alert">{error}</p> : <>
            {!loaded && <p role="status">Loading model…</p>}
            <div className="cad-canvas" ref={host} aria-label={`Previewing ${name}`} />
            {loaded && <div className="row cad-controls">
              <button className="btn subtle" onClick={() => viewer.current?.reset()}>Reset view</button>
              <button className="btn subtle" onClick={() => viewer.current?.saveImage()}>Save image</button>
            </div>}
            <p className="muted small">Drag to rotate · Scroll or pinch to zoom.</p>
          </>}
        </div>
      )}
    </div>
  );
}
