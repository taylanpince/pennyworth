# Local CAD trial

This is a build123d proof of concept, before adding a permanent CAD crew role.
The board previews self-contained, untextured GLB attachments with locally bundled
Three.js. Drag to orbit, scroll/pinch to zoom, reset the camera, or save a PNG.
STEP/STL/source files still use the existing authenticated attachment downloads.
The viewer is loaded only when opened and makes no external resource requests.
The board's content security policy is unchanged. Compressed models, textures,
external resources and glTF extensions are deliberately unsupported in this trial.

## Reproduce

Tested with Python 3.14 on Ubuntu, build123d 0.13.0 and Open Cascade 8.0.1.
Use an isolated environment; do not install into system Python:

```sh
python3 -m venv data/cad-poc/venv
data/cad-poc/venv/bin/python -m pip install -r scripts/cad-poc/requirements.txt
scripts/cad-poc/python scripts/cad-poc/model.py --revision v1 --length 80
scripts/cad-poc/python scripts/cad-poc/model.py --revision v2 --length 90
```

The Open Cascade wheel needs `libGL.so.1` even for headless exports. On this host,
the Ubuntu `libgl1`, `libglx0` and `libglvnd0` packages were downloaded and extracted
with `dpkg-deb -x` into `data/cad-poc/system-libs/`, without installing system
packages. The interpreter wrapper adds that directory to the library search path
when it exists. On NixOS, supply native libraries through the CAD devshell instead;
that environment has not been tested by this trial.

The locked Python dependency versions reflect the tested environment. Generated
models, environment, native libraries and local task IDs live under ignored `data/`.

## What is being tested

- v1: 80 × 50 × 25 mm open enclosure, 2 mm wall/floor, 4 mm outside corner radius.
- Four Ø3.2 mm holes through the floor, centres 8 mm from adjacent outer edges.
- v2: increase the length to 90 mm, keeping every other parameter unchanged.
- Each revision exports GLB, STEP, STL and a JSON parameter/check report. It must
  be one valid solid with the expected bounds and analytically calculated volume.
  Re-importing STEP must preserve solid validity and volume.
- Outputs are revision-named so the attachment replacement mechanism preserves
  both versions. The current attachment limit is 10 MB per file.

These are generated and verified models, not physical print/fit tests. The source
and parameter report preserve the design; STEP does not preserve a feature tree.
STL is exported using millimetres; GLB converts to metres and uses Y up for viewing.

## Conversational follow-up

For this trial an existing runner role can use the absolute path to
`scripts/cad-poc/python` as its interpreter. Give it the model source and the desired
change, have it work in its task workspace, then write revision-named outputs to
`.pennyworth/out/`. No repository is needed. Source/checks can be attached alongside
the exports. Do not write into this repository from a task's job.

The initial two versions were generated during setup, not by an autonomous runner
job. A new dedicated role, CAD toolchain selection, automated rendered-image
feedback to the agent, and approved-version management remain separate work after
the user has tried this workflow.
