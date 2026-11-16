# CAD Designer

Charles is a runner role (`workflow: cad`) with its own memory and the normal
engine/model picker. Its default is Codex with high reasoning effort. Assign a new
task to Charles, add him to an existing task, or mention him in a chat. Describe the
part, dimensions, intended fit and use; attach references as needed. Alfred can pass
CAD requests to him. Subsequent comments revise the same workspace.

## Host setup

Run `scripts/cad/setup.sh` to install the pinned Python dependencies in
`data/cad/venv`. The lock is shared with the successful trial at
`scripts/cad-poc/requirements.txt`. Set `cad.python` in `config/runner.yaml` to a
different interpreter or wrapper if needed; relative paths resolve from this repo.
The default is `scripts/cad/python`. Jobs never install or update the shared runtime.

Open Cascade needs native OpenGL libraries for headless exports. This Ubuntu host
uses the tested `libgl1`, `libglx0` and `libglvnd0` libraries extracted under
`data/cad/system-libs`; the wrapper adds their directory to the library search path.
For NixOS use an interpreter wrapper/devshell providing these dependencies instead.
No system packages are installed by setup. Test with:

```sh
scripts/cad/python -m unittest discover -s services/runner/cad -p 'test_*.py'
```

## Delivery

The runner supplies the role instructions on every turn and exposes `CAD_PYTHON`
and `CAD_EXPORT`. Models define `result` (a build123d Shape or Compound), optionally
`parameters` (JSON data). For example:

```python
from build123d import Box
parameters = {"length": 80, "width": 50, "height": 25}
result = Box(**parameters)
```

Run from the task workspace:

```sh
"$CAD_PYTHON" "$CAD_EXPORT" model.py --name enclosure
```

Each successful export writes a new `enclosure-v001` etc. set under
`.pennyworth/out/`: GLB for the board, STEP for CAD, STL for a slicer (millimetres),
Python source and JSON checks. Existing revisions stay intact. The exporter checks
solid validity, nonempty finite bounds/volume, STEP round-trip solid count, bounds
and volume, and the 10 MB per-file limit before exposing the files for attachment.
Failed validation leaves no new deliverable set. The board previews untextured GLB
models, and Save image downloads the current view as PNG. Manufacturing exports
are unchanged by the viewer's matte lighting.

CAD jobs receive no runner-provided Primer, Slack, Glean, Grafana, ClickHouse, GCP
or AWS connections. The job's helper refuses repository cloning/publishing, merges,
Primer and AWS writes. Workspace restrictions and credential hiding still apply;
this is not a separate container or a blanket ban on reading host files. Engine
selection does not change the CAD workflow. Source content remains untrusted.

Personal instances also set `primer.enabled: false` in `config/runner.yaml` to
disable Primer for every runner role: connection injection, publishing commands,
after-run publication and prompt guidance. Manor's Paperclip agents have no Primer
tools and their personal instruction files prohibit its use. Do not disable absent
Codex servers with `mcp_servers.<name>.enabled=false`: that creates an incomplete
server entry and prevents Codex from starting.

The agent adds design-specific checks; kernel validity is not a guarantee of fit,
strength, or printability. Approval identifies an existing revision rather than
silently replacing it. No printer connection or automatic fabrication is provided.
