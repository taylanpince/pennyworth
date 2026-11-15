"""Run a trusted local model script defining `result`, validate it, and export a revision."""
import argparse
import importlib.metadata
import json
import math
import re
import runpy
import shutil
import tempfile
from pathlib import Path

from build123d import Shape, export_gltf, export_step, export_stl, import_step

MAX_BYTES = 10 * 1024 * 1024


def export_model(source, name, out):
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,59}", name):
        raise ValueError("Use a short lowercase part name with letters, digits and hyphens")
    source = Path(source).resolve(strict=True)
    out = Path(out).resolve()
    namespace = runpy.run_path(str(source), run_name="__cad_export__")
    shape = namespace.get("result")
    if not isinstance(shape, Shape):
        raise ValueError("The model must define result as a build123d Shape or Compound")
    solids = list(shape.solids())
    if not solids or not shape.is_valid or not all(s.is_valid and s.volume > 0 for s in solids):
        raise ValueError("Expected valid, nonempty solids; fix the geometry before exporting")
    bounds = tuple(shape.bounding_box().size)
    volume = shape.volume
    if not all(math.isfinite(x) and x > 0 for x in (*bounds, volume)):
        raise ValueError("Model bounds and volume must be finite and positive")
    out.mkdir(parents=True, exist_ok=True)
    revision = 1
    # Reserve a name even if two export commands start together. Existing revisions are immutable.
    while True:
        stem = f"{name}-v{revision:03d}"
        lock = out / f".{stem}.lock"
        if list(out.glob(f"{stem}.*")):
            revision += 1
            continue
        try:
            lock.touch(exist_ok=False)
            break
        except FileExistsError:
            revision += 1
    try:
        with tempfile.TemporaryDirectory(prefix=".cad-", dir=out) as temporary:
            stage = Path(temporary)
            step, stl, glb = [stage / f"{stem}.{ext}" for ext in ("step", "stl", "glb")]
            if not export_step(shape, step):
                raise ValueError("STEP export failed")
            if not export_stl(shape, stl, tolerance=0.05, angular_tolerance=0.1):
                raise ValueError("STL export failed")
            if not export_gltf(shape, glb, binary=True, linear_deflection=0.1, angular_deflection=0.2):
                raise ValueError("GLB export failed")
            restored = import_step(step)
            if not restored.is_valid or len(restored.solids()) != len(solids):
                raise ValueError("STEP round-trip changed solid validity or count")
            if not math.isclose(restored.volume, volume, rel_tol=1e-7, abs_tol=1e-4):
                raise ValueError("STEP round-trip changed volume")
            if not all(math.isclose(a, b, rel_tol=1e-7, abs_tol=1e-5)
                       for a, b in zip(restored.bounding_box().size, bounds)):
                raise ValueError("STEP round-trip changed dimensions")
            report = {
                "revision": revision, "units": "mm", "name": name,
                "build123d": importlib.metadata.version("build123d"),
                "parameters": namespace.get("parameters", {}),
                "checks": {"valid": True, "solids": len(solids), "bounds_mm": bounds,
                           "volume_mm3": volume, "step_round_trip": True},
                "files": [f"{stem}.{ext}" for ext in ("glb", "step", "stl", "py", "json")],
            }
            (stage / f"{stem}.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
            shutil.copyfile(source, stage / f"{stem}.py")
            for file in stage.iterdir():
                if not 0 < file.stat().st_size <= MAX_BYTES:
                    raise ValueError(f"{file.name} is empty or exceeds the 10 MB attachment limit")
            for file in stage.iterdir():
                file.rename(out / file.name)
            return report
    finally:
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--out", type=Path, default=Path(".pennyworth/out"))
    args = parser.parse_args()
    print(json.dumps(export_model(args.source, args.name, args.out), indent=2))
