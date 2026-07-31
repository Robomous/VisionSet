# Installing VisionSet

One wheel. The API, the CLI, the MCP server and the compiled browser app are all inside it, so
there is nothing to download afterwards and no separate front end to serve.

## Requirements

| | |
| --- | --- |
| **Python** | 3.12 or newer |
| **ffmpeg** | only for video — see below |
| Disk | your images, plus a copy: assets are content-addressed into the workspace |

Nothing else. No database server, no Node, no Docker. The metadata lives in one SQLite file
inside the workspace, and the pixels live beside it.

## Install

VisionSet is not on PyPI yet — that lands with the first beta. Until then, install from a built
wheel or straight from the repository:

```bash
# from the repository, into an isolated environment (recommended)
uv tool install "git+https://github.com/Robomous/VisionSet"

# or into the current environment
pip install "git+https://github.com/Robomous/VisionSet"
```

To build the wheel yourself — which is what CI does, and what publishing will ship:

```bash
git clone https://github.com/Robomous/VisionSet && cd VisionSet
uv sync && pnpm install
bash scripts/build_dist.sh          # pnpm -r build → bundle:static → uv build
pip install dist/visionset-*.whl
```

That order matters and the script enforces it: the compiled UI is copied into the package
immediately before the wheel is built, so a wheel built out of order installs cleanly and then
serves nothing. See [CONTRIBUTING.md](../CONTRIBUTING.md#building-the-distribution).

## Check it

```bash
visionset --version         # the version, and nothing else
visionset format list       # coco, dummy, voc, yolo
```

`format list` is the more useful of the two: it reads *installed* entry-point metadata, so a
non-empty answer proves the wheel is properly installed rather than merely importable.

## ffmpeg, and when you need it

**Only for video.** Images need nothing. VisionSet shells out to `ffmpeg` and `ffprobe` to read a
clip's metadata and to cut it into frames, so a source registered from a `.mp4` needs the binary
on the `PATH`:

```bash
brew install ffmpeg                     # macOS
sudo apt-get install -y ffmpeg          # Debian / Ubuntu
```

A missing binary is reported as `MediaToolUnavailable` with the same hint, at the moment a video
is registered rather than at import — so a machine without ffmpeg still opens workspaces, ingests
images, annotates, publishes and exports.

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
[CONTRIBUTING.md](../CONTRIBUTING.md#checks-that-must-stay-green).

## Where your data goes

Nowhere you did not name. A workspace is a directory you create:

```bash
visionset init ~/datasets/road-signs
```

Inside it: `visionset.db` (metadata) and `blobs/` (content-addressed pixels). Nothing is uploaded,
nothing phones home, and no path outside that directory is written except where you point an
export.

`init` is the only command that creates a workspace, and it refuses a directory that already holds
something. Every other command *finds* one — `--workspace`, then `$VISIONSET_WORKSPACE`, then the
nearest workspace at or above the working directory. The full precedence, and why only the last of
those searches upward, is in [workspaces.md](workspaces.md).

## Next

- [tutorial.md](tutorial.md) — a first dataset, end to end, in about half an hour.
- [cli.md](cli.md) — the whole cycle from a terminal.
- [mcp.md](mcp.md) — pointing an agent at a workspace.
