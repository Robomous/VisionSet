<img src="https://cdn.robomous.ai/public-images/robomous-banner.svg" alt="Robomous.ai" width=300 />

-----

# Robomous VisionSet

**VisionSet** is an open-source, local-first, SDK-first tool by [Robomous](https://robomous.ai)
for creating, curating, and versioning computer-vision training datasets. Today it targets 2D
image annotation; the domain model is built for a Physical AI roadmap — 3D point clouds, lane
labeling, and multimodal data land on the same foundations. Your data stays on your machines,
every surface (UI, CLI, MCP) is a thin client of the same SDK, and the release artifact is a
plain `pip` package.

## Quickstart

```bash
pip install visionset   # coming soon

visionset init          # a workspace here
visionset ui            # API at http://127.0.0.1:8000, app at /ui
```

`init` is the only command that creates a workspace, and it refuses a directory that already holds
something. `visionset ui` run outside one refuses with one sentence and exit 1; it never creates
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

Thirty-three tools, plus one that is offered only when the server is started with
`--allow-destructive`; see [docs/mcp.md](docs/mcp.md) for what each is for, or
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
visionset export --project road-signs --release v1.0 --format dummy --out ./out
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
real: [`examples/http_end_to_end.py`](examples/http_end_to_end.py) starts `visionset ui` on a free
port and drives the API with `urllib` and a bearer token — multipart upload, 202-and-poll ingest,
hash-checked manifest and a 401 it asserts — while
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
  formats/              Importer/exporter plugins (entry-point group `visionset.formats`)
  _static/              Compiled UI bundle lands here at build time (ships in the wheel)
frontend/
  annotator/            @visionset/annotator — headless annotation engine (no React in core/)
  ui-core/              @visionset/ui-core — domain components, tokens, generated API client
  app/                  @visionset/app — OSS product shell (Vite + React, never published)
tests/                  Python tests, incl. machine-enforced architecture contracts
docker/                 Dev-only compose environment (never the release artifact)
scripts/                Repo automation (OpenAPI export, version sync, static bundling)
```

## Development setup

```bash
uv sync                                   # Python env + dev tools
pnpm install                              # frontend workspace
docker compose -f docker/compose.yaml up  # optional dev services
```

Common checks: `uv run pytest`, `uv run lint-imports`, `uv run mypy src/visionset/kernel`,
`pnpm -r build`, `pnpm -r test`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 — copyright Robomous Inc. See [LICENSE](LICENSE).
