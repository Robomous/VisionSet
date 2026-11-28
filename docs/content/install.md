# Installing VisionSet

A VisionSet wheel includes the Python SDK, REST API, CLI, MCP server, and compiled browser app. The
base install needs Python 3.11 or newer and disk space for the workspace database and stored copies
of your assets. Use a browser to open the app or import video.

## Install

Install the published beta from [PyPI](https://pypi.org/project/visionset/):

```bash
uv tool install --prerelease allow visionset
```

To install into an active Python environment, use `python -m pip install --pre visionset`.

This documentation follows `main`, which includes changes after the published beta. To use the
features documented here, build the wheel from the current checkout. The source build also needs
`uv`, pnpm, and the Node version in [`.nvmrc`](../../.nvmrc).

```bash
git clone https://github.com/Robomous/VisionSet
cd VisionSet
uv sync --locked
pnpm install --frozen-lockfile
bash scripts/build_dist.sh
uv tool install --reinstall dist/visionset-*.whl
```

The [build script](../../scripts/build_dist.sh) compiles and bundles the browser app before building
the Python wheel. See the [distribution build guide](../../CONTRIBUTING.md#building-the-distribution).

## Check it

```bash
visionset --version
visionset format list
```

`format list` reads installed entry points, including any third-party formats you have installed.
To see the available training targets, run `visionset target list`.

## Video, and where it is decoded

Video import uses WebCodecs in the browser. VisionSet sends the selected frames and their
provenance to the server, while the original clip stays in the browser. Supported codecs depend
on the browser and platform. See [ingest](ingest.md#in-the-browser).

## Running a model on this machine

For a `local` inference connection, install the `local-inference` extra in the same environment
as VisionSet. For example, to install the published beta with local inference in an active Python
environment:

```bash
python -m pip install --pre 'visionset[local-inference]'
```

This installs the inference runtime, including PyTorch and Transformers. Use
`visionset inference download CONNECTION` to fetch the weights for a configured connection. VisionSet stores
those weights in the workspace's `models/` directory. See [inference](inference.md) for model
configuration, browser inference, and HTTP connections.

## Optional extras, for checking exports

Contributors can use the `yolo` and `coco` dependency groups to check exports with Ultralytics and
pycocotools. See the [format smoke tests](../../CONTRIBUTING.md#checks-that-must-stay-green) for the
locked commands and environment cleanup.

## Where your data goes

Create a workspace, then start the server from that directory:

```bash
visionset init ~/datasets/road-signs
cd ~/datasets/road-signs
visionset server
```

Open `http://127.0.0.1:8000/app`. The workspace holds `visionset.db` for metadata and `blobs/` for
content-addressed media. VisionSet creates additional directories for uploads, exports, and model
weights as needed. See [workspaces](workspaces.md) for the full layout and how VisionSet resolves
`--workspace`, `VISIONSET_WORKSPACE`, and the working directory.

## Next

- [Create your first dataset](tutorial.md).
- [Use the command line](cli.md).
- [Configure an MCP client](mcp.md).
