# Installing VisionSet

One wheel contains the API, CLI, MCP server, and compiled browser application. Nothing else must
be downloaded afterward, and there is no separate frontend to serve.

## Requirements

| | |
| --- | --- |
| **Python** | 3.12 or newer |
| Disk | your images, plus a copy: assets are content-addressed into the workspace |

Nothing else. No database server, no Node, no Docker, and no media binary — not even for
video; see below. The metadata lives in one SQLite file inside the workspace, and the pixels
live beside it.

## Install

VisionSet is not on PyPI yet - that lands with the first beta. Until then, install from a built
wheel or straight from the repository:

```bash
# from the repository, into an isolated environment (recommended)
uv tool install "git+https://github.com/Robomous/VisionSet"

# or into the current environment
pip install "git+https://github.com/Robomous/VisionSet"
```

To build the wheel yourself - which is what CI does, and what publishing will ship:

```bash
git clone https://github.com/Robomous/VisionSet && cd VisionSet
uv sync && pnpm install
bash scripts/build_dist.sh          # pnpm -r build → bundle:static → uv build
pip install dist/visionset-*.whl
```

That order matters and the script enforces it: the compiled UI is copied into the package
immediately before the wheel is built, so a wheel built out of order installs cleanly and then
serves nothing. See [CONTRIBUTING.md](../../CONTRIBUTING.md#building-the-distribution).

## Check it

```bash
visionset --version         # the version, and nothing else
visionset format list       # the formats this installation can write
```

`format list` is the more useful of the two: it reads *installed* entry-point metadata, so a
non-empty answer proves the wheel is properly installed rather than merely importable. Run it
for the current set rather than trusting a list written down somewhere - third-party
distributions register into the same entry-point group, so what a given installation can write
is a property of that installation.

## Video, and where it is decoded

VisionSet needs no media binary at all, for images or for video. There is nothing to install and
nothing this page can tell you to run.

Importing a video is a **browser** capability: the browser demuxes and decodes it with its own
built-in `WebCodecs` support and turns it into the image assets a project is made of before the
server ever hears about it. There is no server-side decoder behind that, and no fallback - a
browser that cannot decode a given codec says so, in the browser, rather than quietly handing the
file to a server that would have decoded it instead. See [ingest.md](ingest.md).

## Running a model on this machine

**Only for `local` inference connections**, and only when you have made one. VisionSet's
auto-labeling feature is always present; what is optional is the runtime that executes a model
*here*:

```bash
pip install "visionset[local-inference]"
```

That brings torch, torchvision, transformers, accelerate and huggingface_hub - roughly two
gigabytes, most of it CUDA - which is exactly why it is not in the base install. It is the same
command on every platform: the macOS wheels it installs carry Apple Silicon GPU support already,
so a Mac needs no second index and no build flag to run a connection on `mps`. Without it you can still create a
local connection, list it, and see what it is configured for; what you cannot do is fetch its
weights or ask it to predict. Both refusals name the command above rather than simply saying
"unavailable".

**Installing it downloads no model.** Weights arrive when you run `visionset inference download`,
never at install time, never at startup, and never on the way to anything else. They land inside
the workspace, under `models/`, so a workspace you copy to another machine takes its model with
it. See [inference.md](inference.md).

## Optional extras, for checking exports

Neither is needed to *use* VisionSet; both are what the project's own tests use to prove an export
is loadable by the tool it is aimed at.

```bash
uv sync --group yolo    # ultralytics — brings torch, roughly two gigabytes
uv sync --group coco    # pycocotools
```

The `yolo` group has a wart worth knowing before you install it into a checkout: the
`ultralytics` wheel ships a **top-level `tests` package**, which shadows this repository's own
`tests/` directory. Run the format smoke tests and then `uv sync` again; see
[CONTRIBUTING.md](../../CONTRIBUTING.md#checks-that-must-stay-green).

## Where your data goes

Nowhere you did not name. A workspace is a directory you create:

```bash
visionset init ~/datasets/road-signs
```

Inside it: `visionset.db` (metadata) and `blobs/` (content-addressed pixels), plus three
directories that appear only once something puts them there — `uploads/` for bytes sent to the
REST API, `exports/` for what an export wrote, and `models/` for weights you fetched. Nothing is
uploaded, nothing phones home, and no path outside that directory is written except where you
point an export. [workspaces.md](workspaces.md) has the whole layout.

`init` is the only command that creates a workspace, and it refuses a directory that already holds
something. Every other command *finds* one - `--workspace`, then `$VISIONSET_WORKSPACE`, then the
nearest workspace at or above the working directory. The full precedence, and why only the last of
those searches upward, is in [workspaces.md](workspaces.md).

## Next

- [tutorial.md](tutorial.md) - a first dataset, end to end, in about half an hour.
- [cli.md](cli.md) - the whole cycle from a terminal.
- [mcp.md](mcp.md) - pointing an agent at a workspace.
