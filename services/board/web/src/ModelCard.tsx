import { CadPreview } from "./CadPreview";
import type { modelFiles } from "./modelFiles";

const formats: Record<string, string> = { step: "STEP · Edit in CAD", stp: "STEP · Edit in CAD", stl: "STL · 3D printing", glb: "GLB · 3D viewing", py: "Python · Editable source", json: "JSON · Validation report" };

export function ModelCard({ model, issueId }: { model: ReturnType<typeof modelFiles>["models"][number]; issueId: string }) {
  const url = (id: string) => `/api/issues/${encodeURIComponent(issueId)}/files/${encodeURIComponent(id)}`;
  const label = `${model.title}${model.revision ? ` · v${model.revision}` : ""}`;
  return (
    <article className="model-card" aria-label={label}>
      <header className="model-card-head">
        <div><h4>{model.title}</h4><span className="muted small">{model.revision ? `Revision ${Number(model.revision)}` : "3D model"}</span></div>
        <details className="model-download">
          <summary className="btn">Download…</summary>
          <div className="model-formats">
            <p className="muted small">Choose a file type</p>
            {[...model.files].sort((a, b) => Object.keys(formats).indexOf(a.name.split(".").at(-1)!.toLowerCase()) - Object.keys(formats).indexOf(b.name.split(".").at(-1)!.toLowerCase())).map((f) => (
              <a key={f.id} href={url(f.id)} download={f.name} onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}>
                {formats[f.name.split(".").at(-1)!.toLowerCase()]}
              </a>
            ))}
          </div>
        </details>
      </header>
      <CadPreview url={url(model.preview.id)} name={label} />
    </article>
  );
}
