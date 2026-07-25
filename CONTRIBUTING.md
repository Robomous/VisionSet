# Contributing to VisionSet

## Dev setup

```bash
uv sync            # Python 3.12+, installs the package editable + dev tools
pnpm install       # pnpm workspace under frontend/
```

Optional services: `docker compose -f docker/compose.yaml up` (dev only — the release
artifact is always the pip package).

## Checks that must stay green

| Check | Command |
| --- | --- |
| Python tests | `uv run pytest` |
| Import contracts | `uv run lint-imports` |
| Kernel type-safety (strict) | `uv run mypy src/visionset/kernel` |
| Lint/format | `uv run ruff check .` / `uv run ruff format .` |
| Frontend build + tests | `pnpm -r build && pnpm -r test` |
| Frontend lint | `pnpm -r lint` |
| OpenAPI contract | `uv run python scripts/export_openapi.py` (commit the diff) |

## The two machine-enforced boundaries

1. **Kernel purity** — `visionset.kernel` never imports `visionset.server`, `visionset.cli`,
   `visionset.mcp`, `visionset.formats`, nor `fastapi`/`typer`/`mcp`/`uvicorn`. Enforced by
   `import-linter` (contracts in `pyproject.toml`) and a fresh-process pytest in
   `tests/architecture/`.
2. **Headless annotator** — `frontend/annotator/src/core/` never imports React. Enforced by
   an ESLint `no-restricted-imports` rule scoped to `src/core/`.

If a change fights either boundary, the change is wrong — not the boundary.

## Versioning

The repo-root `VERSION` file is the single source of truth (`0.1.0.dev0` style).

- **Python**: `pyproject.toml` reads it dynamically via hatchling's regex version source.
- **npm**: `pnpm version:sync` (root script) rewrites the `version` field of every
  `frontend/*` package.json, converting to npm semver (`0.1.0.dev0` → `0.1.0-dev.0`).

Never hand-edit a version anywhere else.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`,
`docs:`, `test:` … with optional scope, e.g. `feat(kernel): …`). Keep commits as logical
increments; every commit should leave the checks above green.

## Tests

- New kernel behavior ships with tests under `tests/kernel/`.
- Anything touching the plugin surface proves discoverability via `importlib.metadata`.
- Frontend logic in `annotator/src/core/` is unit-tested with vitest (it is pure TS — no DOM
  needed).
- Never commit fixture media. `**/workspace-data/` is git-ignored for a reason (v1 shipped
  929 MB of images into git history; we do not repeat that).
