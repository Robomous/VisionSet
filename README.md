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
visionset ui
```

## Monorepo map

```
src/visionset/          Single Python distribution (one wheel, one import namespace)
  kernel/               Hexagonal core: domain + ports + default adapters (framework-free)
  server/               FastAPI — exposes the SDK via REST; openapi.json is a committed contract
  cli/                  Typer CLI (`visionset` console script)
  mcp/                  MCP server (stdio) — thin mapping of tools to SDK calls
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
