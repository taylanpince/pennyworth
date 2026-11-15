"""A dimensioned open enclosure. All dimensions are millimetres; no GUI required."""
import argparse
import json
import math
from pathlib import Path

from build123d import (
    Align, Axis, Box, Color, Cylinder, Pos,
    export_gltf, export_step, export_stl, fillet, import_step,
)


def enclosure(length=80.0, width=50.0, height=25.0, wall=2.0, radius=4.0,
              hole_diameter=3.2, hole_inset=8.0):
    """Rounded box, open top, four through holes in its floor (no lid)."""
    values = (length, width, height, wall, radius, hole_diameter, hole_inset)
    if not all(math.isfinite(v) and v > 0 for v in values):
        raise ValueError("Dimensions must be finite and positive")
    if not wall < radius < min(length, width) / 2 or height <= wall:
        raise ValueError("Wall/radius/height would leave no cavity")
    if not radius + hole_diameter / 2 < hole_inset < min(length, width) / 2 - hole_diameter / 2:
        raise ValueError("Floor holes must clear the curved walls and each other")
    align = (Align.CENTER, Align.CENTER, Align.MIN)
    outer = Box(length, width, height, align=align)
    outer = fillet(outer.edges().filter_by(Axis.Z), radius)
    cavity = Box(length - 2 * wall, width - 2 * wall, height, align=align)
    cavity = fillet(cavity.edges().filter_by(Axis.Z), radius - wall)
    part = outer - Pos(0, 0, wall) * cavity
    centers = [(sx * (length / 2 - hole_inset), sy * (width / 2 - hole_inset))
               for sx in (-1, 1) for sy in (-1, 1)]
    for x, y in centers:
        part -= Pos(x, y, -1) * Cylinder(hole_diameter / 2, wall + 2, align=align)
    part.label = "Open enclosure"
    part.color = Color(0.18, 0.48, 0.68)

    # Verify the actual BREP, including an independently calculated volume. A render alone cannot
    # prove floor thickness, hole diameter or cavity depth.
    area = lambda l, w, r: l * w - (4 - math.pi) * r * r
    expected_volume = (area(length, width, radius) * height
                       - area(length - 2 * wall, width - 2 * wall, radius - wall) * (height - wall)
                       - 4 * math.pi * (hole_diameter / 2) ** 2 * wall)
    assert part.is_valid and len(part.solids()) == 1, "Expected one valid solid"
    bounds = tuple(part.bounding_box().size)
    assert all(abs(a - b) < 1e-5 for a, b in zip(bounds, (length, width, height))), bounds
    assert abs(part.volume - expected_volume) < 1e-4, (part.volume, expected_volume)
    return part, {"bounds_mm": bounds, "volume_mm3": part.volume, "valid": True,
                  "solids": 1, "hole_centers_mm": centers}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--length", type=float, default=80)
    parser.add_argument("--revision", default="v1", choices=("v1", "v2"))
    parser.add_argument("--out", type=Path, default=Path("data/cad-poc/out"))
    args = parser.parse_args()
    params = dict(length=args.length, width=50.0, height=25.0, wall=2.0,
                  radius=4.0, hole_diameter=3.2, hole_inset=8.0)
    part, checks = enclosure(**params)
    args.out.mkdir(parents=True, exist_ok=True)
    stem = args.out / f"enclosure-{args.revision}"
    assert export_step(part, str(stem) + ".step")
    assert export_stl(part, str(stem) + ".stl", tolerance=0.05, angular_tolerance=0.1)
    assert export_gltf(part, str(stem) + ".glb", binary=True, linear_deflection=0.1, angular_deflection=0.2)
    round_trip = import_step(str(stem) + ".step")
    assert round_trip.is_valid and len(round_trip.solids()) == 1
    assert abs(round_trip.volume - part.volume) < 1e-4
    checks["step_round_trip"] = True
    report = {"revision": args.revision, "units": "mm", "parameters": params, "checks": checks}
    Path(str(stem) + ".json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
