#!/usr/bin/env bash
# Host-side installation only. Jobs never modify the shared CAD environment.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cad_root="$repo/data/cad"
python3 -m venv "$cad_root/venv"
"$cad_root/venv/bin/python" -m pip install -r "$repo/scripts/cad-poc/requirements.txt"
"$repo/scripts/cad/python" -c 'from build123d import Box; assert Box(1, 2, 3).is_valid; print("CAD Python is ready")'
