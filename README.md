<img src="https://cdn.robomous.ai/public-images/robomous-banner.svg" alt="Robomous.ai" width=300 />

-----

# Robomous VisionSet

[![CI](https://github.com/robomous/visionset/actions/workflows/ci.yml/badge.svg)](https://github.com/robomous/visionset/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**VisionSet** is an open-source, local-first, SDK-first tool by [Robomous](https://robomous.ai)
for creating, curating, and versioning computer-vision training datasets. Today it targets 2D
image annotation; the domain model is built for a Physical AI roadmap — 3D point clouds, lane
labeling, and multimodal data land on the same foundations. Your data stays on your machines,
every surface (UI, CLI, MCP) is a thin client of the same SDK, and the release artifact is a
plain `pip` package.

## What it does

Point it at a folder of images or a clip of video, label them, and hand a trainer a dataset —
without a server, an account, or your pixels leaving the machine.

| | |
| --- | --- |
| **Ingest** | folders and video. Frames are cut, hashed and stored by content, so the same file twice is one asset and a re-run costs nothing. |
| **Annotate** | boxes, polygons and classification tags in the browser, with undo/redo, keyboard-first tools, and a headless engine underneath that the UI is only one renderer of. |
| **Version** | schema versions are immutable and every label records the one it was judged against. A release freezes the whole thing into a manifest; publish twice from unchanged data and the bytes are identical. |
| **Split** | a stored recipe rather than a materialised assignment, keyed on **content hash** — so two copies of one image cannot straddle a train/test boundary. |
| **Export** | YOLO, COCO and Pascal VOC, each declaring what it can carry. VisionSet works out exactly what a format would drop *before* writing anything, and refuses to drop it silently. |
| **Automate** | one SDK under everything, reachable as a Python API, a REST API, a CLI, and 33 MCP tools an agent can drive. |

## Quickstart

```bash
uv tool install "git+https://github.com/Robomous/VisionSet"   # PyPI lands with the beta

visionset init ~/datasets/road-signs     # a workspace, here and nowhere else
cd ~/datasets/road-signs
visionset server                         # API at http://127.0.0.1:8000, app at /app
```

Then follow [the tutorial](docs/tutorial.md): a clip of video to a YOLO dataset in about half an
hour. Full prerequisites — Python 3.12, and ffmpeg only if you are starting from video — are in
[docs/install.md](docs/install.md).

`init` is the only command that creates a workspace, and it refuses a directory that already holds
something. `visionset server` run outside one refuses with one sentence and exit 1; it never creates
one, because a command that silently made a workspace out of whatever directory you were standing
in is how data ends up somewhere nobody chose.

Or hand the workspace to an agent — the same cycle, over
[MCP](https://modelcontextprotocol.io), with the tools an agent needs to *look* at what it is
labelling:

```json
{ "mcpServers": { "visionset": {
    "command": "visionset", "args": ["mcp"],
    "env": { "VISIONSET_WORKSPACE": "/path/to/workspace" } } } }
```

The whole cycle as tools, plus one that is offered only when the server is started with
`--allow-destructive` — because a `confirm` parameter is documented in the same listing an agent
reads before choosing, and four of four measured runs sent it on the first call. See
[docs/mcp.md](docs/mcp.md) for how a client is configured and why each tool exists,
[docs/mcp-tools.md](docs/mcp-tools.md) for the generated reference, or
[docs/mcp-walkthrough.md](docs/mcp-walkthrough.md) for a session start to finish — including what
twelve real agent runs actually did with it.

Or drive the whole cycle from the terminal, without a server:

```bash
visionset project create road-signs
visionset schema apply schema.json --project road-signs
BATCH=$(visionset ingest ./incoming --project road-signs)
visionset batch approve "$BATCH" --jobs-of 100 && visionset batch start "$BATCH"
# …annotate, then…
visionset batch complete "$BATCH" && visionset batch promote "$BATCH"
visionset release publish --tag v1.0 --project road-signs --split 0.7,0.15,0.15
visionset export --project road-signs --release v1.0 --format yolo --out ./out --allow-lossy
```

Every command takes `--json` for scripting, and the shapes are the REST API's. See
[docs/cli.md](docs/cli.md), or [`examples/cli_end_to_end.sh`](examples/cli_end_to_end.sh) for that
walk with its assertions still in it.

Prefer to see the SDK first? [`examples/sdk_end_to_end.py`](examples/sdk_end_to_end.py) drives an
empty directory to a hash-verified release in one pass, generating its own images — no server,
no CLI, nothing to download. Run it with `uv run python examples/sdk_end_to_end.py`; the
walkthrough is in [docs/examples.md](docs/examples.md).

For where the assets themselves come from,
[`examples/ingest_end_to_end.py`](examples/ingest_end_to_end.py) turns a generated ten-second clip
into 50 deduplicated assets in an approved batch, then shows a re-run creating nothing. It needs
ffmpeg.

The same cycle runs over each of the other two surfaces, and both start the shipped command for
real: [`examples/http_end_to_end.py`](examples/http_end_to_end.py) starts `visionset server` on a
free port and drives the API with `urllib` and a bearer token — multipart upload, 202-and-poll
ingest, hash-checked manifest and a 401 it asserts — while
[`examples/mcp_end_to_end.py`](examples/mcp_end_to_end.py) spawns `visionset mcp` and talks
JSON-RPC down its pipe, scaling every box out of the preview it saw and into the asset's own
pixels.

## Monorepo map

```
src/visionset/          Single Python distribution (one wheel, one import namespace)
  kernel/               Hexagonal core: domain + ports + default adapters (framework-free)
  wire/                 The JSON shapes the CLI and MCP publish (gated against the REST models)
  server/               FastAPI — exposes the SDK via REST; openapi.json is a committed contract
  cli/                  Typer CLI (`visionset` console script)
  mcp/                  MCP server (stdio) — 33 agent tools over the same SDK
  formats/              Exporter plugins: yolo, coco, voc (entry-point group `visionset.formats`)
  _static/              Compiled UI bundle lands here at build time (ships in the wheel)
frontend/
  annotator/            @visionset/annotator — headless annotation engine (no React in core/)
  ui-core/              @visionset/ui-core — domain components, tokens, generated API client
  app/                  @visionset/app — OSS product shell (Vite + React, never published)
tests/                  Python tests, incl. machine-enforced architecture contracts
examples/               Six runnable end-to-end scripts, all exercised in CI
docs/                   User and contributor documentation (planning lives in GitHub issues)
docker/                 Dev-only compose environment (never the release artifact)
scripts/                Repo automation (OpenAPI export, version sync, bundling, dist build)
.agents/skills/         Coding-agent skills, tool-agnostic (see AGENTS.md)
```

## Documentation

Start with [docs/install.md](docs/install.md) and [docs/tutorial.md](docs/tutorial.md).
[docs/README.md](docs/README.md) indexes the rest — one page per subsystem, each written to
explain the decisions rather than restate the code.

## Development setup

```bash
uv sync         # Python env + dev tools
pnpm install    # frontend workspace
```

Then `uv run visionset server` and `pnpm --filter @visionset/app dev`. Or run the whole thing in
containers instead, with nothing installed on the host and nothing built.

### Run it with Docker, and sign in with nothing

```bash
docker compose -f docker/compose.yaml up
```

**Open http://localhost:8080. There is no token to find and nothing to paste** — the app opens on
the project list. The server signs in the browser it served itself, over an `HttpOnly` cookie it
sets on the first request the page makes; [docs/auth.md](docs/auth.md#the-browser-session) has the
mechanism and the reasoning.

One port, nginx in front of both services. The first run builds two images, every later one just
starts them; dependencies are installed at build time, so starting the stack downloads nothing.

A token is still minted on first boot and printed in the `api` logs, because `curl`, the SDK and
MCP clients have no session and never will:

```bash
docker compose -f docker/compose.yaml logs api | grep vst_    # if you scrolled past it
docker compose -f docker/compose.yaml exec api \
  visionset token create --name <name>                        # or mint another
```

The browser never needs either. If the page *does* ask for a token, the stack is not the one this
README describes — check that `VISIONSET_UI_SESSION: always` is set on the `api` service and that
you are reaching it through port 8080.

> **Why `always` here, and why every port is published on `127.0.0.1`.** The default,
> `VISIONSET_UI_SESSION=auto`, issues a session only to a client on this machine — and behind a
> proxy no request ever looks like one, because the peer is nginx. So the compose stack says
> `always` and pays for it by binding all three ports to loopback. The two lines belong together:
> `always` on a port open to every interface would hand the workspace to the local network. Set
> `VISIONSET_UI_SESSION: never` to turn the whole thing off and go back to typing a token.

Everything it stores lands in **`workspace-data/`** (git-ignored): SQLite for metadata, a local
directory for the files, one workspace holding both — the shape MLflow's default mode has, and the
only shape VisionSet has. Put it elsewhere with `VISIONSET_DATA=/path docker compose …`; it is a
bind mount, so `down -v` does not take your data with it.

Dev only — the release artifact is always the pip package.

Common checks: `uv run pytest`, `uv run lint-imports`, `uv run mypy src/visionset/kernel`,
`pnpm -r build`, `pnpm test`. The full list — including the wheel build and the thirty-minute
flow gate — is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Releases

[CHANGELOG.md](CHANGELOG.md) — what each version added, and the six milestones that got here.
[docs/releasing.md](docs/releasing.md) is the runbook for cutting one.

## License

Apache-2.0 — copyright Robomous Inc. See [LICENSE](LICENSE).
