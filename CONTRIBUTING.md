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
| Frontend build + tests | `pnpm -r build && pnpm test` |
| Frontend lint | `pnpm -r lint` |
| Annotator headless boundary | `pnpm --filter @visionset/annotator lint` |
| Version sync | `pnpm version:check` |
| OpenAPI contract | `uv run python scripts/export_openapi.py` (commit the diff) |
| Generated API client | `pnpm generate:client` (commit the diff) |
| Annotator wire fixture | `uv run python scripts/export_wire_fixtures.py` (commit the diff) |

## The two machine-enforced boundaries

1. **Kernel purity** — `visionset.kernel` never imports `visionset.server`, `visionset.cli`,
   `visionset.mcp`, `visionset.formats`, nor `fastapi`/`typer`/`mcp`/`uvicorn`. Enforced by
   `import-linter` (contracts in `pyproject.toml`) and a fresh-process pytest in
   `tests/architecture/`.
2. **Headless annotator** — `frontend/annotator/src/core/` never imports React and never reaches
   the DOM. Enforced by three gates, all run by `pnpm --filter @visionset/annotator lint`:
   an ESLint `no-restricted-imports` rule and an ESLint `no-restricted-globals` rule, both scoped
   to `src/core/`, plus `tsconfig.core.json` — a `noEmit` pass that compiles the shipped engine
   with **no `DOM` lib and no ambient `@types`**, which is the only one of the three that can see a
   DOM type in a *signature*. `tests/scripts/annotator_boundary.test.mjs` proves each of them
   fires.

If a change fights either boundary, the change is wrong — not the boundary.

## Versioning

The repo-root `VERSION` file is the single source of truth, in PEP 440 form. Everything
else derives from it, in lockstep across the monorepo — the Python distribution and every
`frontend/*` package always carry the same version.

- **Python**: `pyproject.toml` reads `VERSION` dynamically via hatchling's regex version
  source; `visionset --version` prints it.
- **npm**: `pnpm version:sync` rewrites the `version` field of every `frontend/*`
  package.json, translating PEP 440 to npm semver. `pnpm version:check` is the CI drift
  gate — it fails if a package.json has fallen out of step with `VERSION`.

| PEP 440 (`VERSION`, PyPI) | npm semver | Used for |
| --- | --- | --- |
| `0.0.1.dev0` | `0.0.1-dev.0` | Ongoing development on `main` |
| `0.0.1a1` | `0.0.1-alpha.1` | Reserved; the alpha milestones are tags, not releases |
| `0.0.1b1` | `0.0.1-beta.1` | The first published beta |
| `0.0.1` | `0.0.1` | First stable release |

Never hand-edit a version anywhere else — change `VERSION`, then run `pnpm version:sync`.

### Tags and publishing

The road to the beta is cut into six internal milestones. Each one ends with a **git tag
only**:

```
v0.0.1-alpha.1 … v0.0.1-alpha.5     git tags, never published to PyPI or npm
```

These mark milestone completion so the tree can be checked out and bisected. `VERSION`
stays at `0.0.1.dev0` throughout — the alpha tags do not bump it, because nothing is
being distributed.

The first artifact anyone installs is the beta: bump `VERSION` to `0.0.1b1`, run
`pnpm version:sync`, tag `v0.0.1-beta.1`, and publish the wheel to PyPI (`0.0.1b1`) and,
if the packages are published at all, the frontend packages to npm (`0.0.1-beta.1`).
`0.0.1-beta` is *lower* than `0.1.0` in both version orderings, which is why `VERSION`
sits at `0.0.1.dev0` rather than the `0.1.0.dev0` the repo was bootstrapped with.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`,
`docs:`, `test:` … with optional scope, e.g. `feat(kernel): …`). Keep commits as logical
increments; every commit should leave the checks above green.

## Tests

- New kernel behavior ships with tests under `tests/kernel/`.
- Anything touching the plugin surface proves discoverability via `importlib.metadata`.
- Frontend logic in `annotator/src/core/` is unit-tested with vitest. It needs no DOM because it
  cannot have one: see boundary 2 above. The test files themselves are the one part of `src/core/`
  the type gate excludes — they run under Node and read a kernel-written fixture through `node:fs`
  — so the ESLint half is what covers them.
- Never commit fixture media. `**/workspace-data/` is git-ignored for a reason (v1 shipped
  929 MB of images into git history; we do not repeat that).
- Generate media instead: `tests/fixtures/media.py` writes tiny images (Pillow) and tiny
  `testsrc` clips (ffmpeg) into a `tmp_path`. Equal arguments produce byte-identical output, so
  dedup and content-addressing tests can rely on it.
- `tests/architecture/test_tracked_file_sizes.py` enforces the rule: any tracked file over
  200 KB fails the build unless it is in that module's `ALLOWLIST`, which grants a *higher
  ceiling*, never an unbounded one. `git ls-files` reads the index, so a merely staged binary
  already trips it.
- Video tests need the **ffmpeg** binary (`brew install ffmpeg` / `sudo apt-get install
  ffmpeg`). Without it they skip locally; CI installs it and sets `VISIONSET_REQUIRE_FFMPEG=1`,
  which turns that skip into a hard failure so a broken install cannot pass unnoticed.
