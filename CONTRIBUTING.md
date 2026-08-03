# Contributing to VisionSet

## Dev setup

```bash
uv sync            # Python 3.12+, installs the package editable + dev tools
pnpm install       # pnpm workspace under frontend/
```

Or skip all three and run the stack in containers — `docker compose -f docker/compose.yaml up`
needs nothing installed on the host and no build of any kind.

| | |
| --- | --- |
| The app | **http://localhost:8080** — nginx, the only port you need |
| Storage | `workspace-data/` (git-ignored): `visionset.db` + `blobs/`. Move it with `VISIONSET_DATA=/path` |
| Token | minted on first boot, printed in the `api` logs |
| Behind the proxy | API on :8000 and vite on :5173 are published too, for curl and for reading a vite error without nginx in the way |
| After a dependency change | `build`, then `down -v` before `up` — node_modules lives in volumes seeded from the image, and Docker seeds a volume only when it is new |

Every dependency is installed at **image build** (`docker/api.Dockerfile`,
`docker/app.Dockerfile`), both honouring their lockfiles, so starting a container downloads
nothing — the stack comes up offline. What is left at start is compiling the repository's own two
TypeScript libraries, which no image can hold because the source does not exist until you write it.

Dev only; the release artifact is always the pip package, and these images are never it. Running
it on the host stays faster, because a bind mount has to poll for file changes rather than being
told about them.

## Checks that must stay green

| Check | Command |
| --- | --- |
| Python tests | `uv run pytest` |
| Import contracts | `uv run lint-imports` |
| Kernel type-safety (strict) | `uv run mypy src/visionset/kernel` |
| Lint/format | `uv run ruff check .` / `uv run ruff format .` |
| Frontend build + tests | `pnpm -r build && pnpm test` |
| Frontend lint | `pnpm -r lint` — **after** a build: `frontend/app` resolves `@visionset/annotator` through its `dist/`, so its typecheck has no declarations until the engine is built |
| Annotator headless boundary | `pnpm --filter @visionset/annotator lint` |
| Annotator end-to-end (chromium) | `pnpm --filter @visionset/app e2e` (needs `playwright install chromium` once) |
| Browser cycle (chromium) | `pnpm --filter @visionset/app cycle` — the whole product against a real `visionset ui`; needs `uv sync` and `playwright install chromium` |
| Annotator benchmark (manual) | `pnpm --filter @visionset/app bench` — frame times, recorded not gated |
| Browser client | part of `pnpm test` — `ui-core`'s `data/` suite drives the 401 flow, the token form and the error envelope with a stubbed `fetch`, no server |
| Design tokens | part of `pnpm test` — `tests/scripts/design_tokens.test.mjs` refuses a colour inside a class name, and `ui-core`'s `tokens.test.ts` gates the stylesheet against its TypeScript mirror |
| Format smoke (ultralytics, pycocotools) | `uv sync --group yolo --group coco && uv run pytest tests/formats/test_*_smoke.py` — their own groups because ultralytics brings torch **and its wheel ships a top-level `tests` package that shadows this repo's**, so run only those files and `uv sync` again afterwards; skips without them, and CI sets `VISIONSET_REQUIRE_ULTRALYTICS=1` / `VISIONSET_REQUIRE_PYCOCOTOOLS=1` so a broken install goes red |
| Wheel (build, install, serve) | `bash scripts/build_dist.sh && VISIONSET_REQUIRE_WHEEL=1 uv run pytest tests/packaging` — builds the UI into `_static/`, builds the wheel, installs it in a fresh venv and serves `/ui/` from it. Opt-in locally (it costs about a minute); CI's `wheel` job runs it and uploads the artifact |
| The 30-minute flow | `uv run python examples/thirty_minute_flow.py` — the vision document's success metric end to end. CI's `30-minute flow (wheel, end to end)` job runs it from the **installed wheel** in an empty venv, with `ultralytics` required there |
| Version sync | `pnpm version:check` |
| OpenAPI contract | `uv run python scripts/export_openapi.py` (commit the diff) |
| Generated API client | `pnpm generate:client` (commit the diff) — writes **two** artifacts under `frontend/ui-core/src/generated/`: `api.ts` (the types) and `checks.ts` (the runtime response checks `unwrap` takes). CI diffs the whole directory. |
| Annotator wire fixture | `uv run python scripts/export_wire_fixtures.py` (commit the diff) |
| MCP tool reference | `uv run python scripts/export_mcp_tools.py` (commit the diff) — `docs/mcp-tools.md` is generated from the server's own tool listing, because a tool description *is* the interface an agent reads |

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

## The visual contract

Any change to `@visionset/app` or `@visionset/ui-core` is governed by
[`DESIGN.md`](DESIGN.md) at the repository root — **read it before building or changing a
screen**, not after. It owns the tokens, the type scale, the navigation rules, the tab
shapes, the annotation workspace, and (since #206) the rules for project-level data
surfaces: what a header carries, how numbers are formatted, and why a disabled button with
no explanation is forbidden.

It is prose over running code, not decoration. `frontend/ui-core/src/styles.css` carries the
tokens and `tokens.ts` mirrors them, gated against each other in both directions by
`tokens.test.ts`; `tests/scripts/design_tokens.test.mjs` fails the build on a hardcoded
colour in any tracked frontend source. A screen that needs a value the file does not have
is a reason to amend the file, never to inline the value.

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
| `0.0.1b2` | `0.0.1-beta.2` | The beta corrected — defects found by testing the wheel |
| `0.0.1` | `0.0.1` | First stable release |

Never hand-edit a version anywhere else — change `VERSION`, then run `pnpm version:sync`.

### Building the distribution

```bash
bash scripts/build_dist.sh          # pnpm -r build → bundle:static → uv build
VISIONSET_REQUIRE_WHEEL=1 uv run pytest tests/packaging
```

**The order in that script is the whole point.** `uv build` copies
`src/visionset/_static/` as package data *at the moment it runs*, and a fresh checkout's
`_static/` holds only `README.md` and `.gitkeep` — so a wheel built before
`pnpm bundle:static` contains **no app at all**. It installs, `visionset ui` starts, and
`/ui/` answers a 404 naming a script the user does not have. There is no error and no
traceback anywhere in that sequence, which is why the script checks after each step and
why `tests/dist/` checks the artifact rather than the source tree.

The script also greps the built `index.html` for `/ui/assets/`. A bundle built with the
dev base references `/assets/…`, which the SPA fallback answers with `index.html` at
**200** — so the page loads blank rather than failing.

CI's `wheel` job runs both and uploads `dist/*` from every build, so there is always
something installable to hand somebody.

### The release gate

`30-minute flow (wheel, end to end)` is the check the beta cannot ship without: it builds the
wheel, installs it into an empty environment, and drives video → 50 boxes → release → YOLO export
→ a trainer loading the result. It runs on every push and pull request.

**Marking it a required status is a repository-admin action and is not in this repository**, since
branch protection lives in GitHub's settings rather than in the tree. Whoever owns the repository
turns it on once:

```bash
gh api -X PUT repos/<owner>/<repo>/branches/main/protection \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=30-minute flow (wheel, end to end)' \
  -f 'enforce_admins=false' -f 'required_pull_request_reviews=null' -f 'restrictions=null'
```

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
`pnpm version:sync`, tag `v0.0.1-beta.1`, and publish the wheel to PyPI as `0.0.1b1`.
`0.0.1-beta` is *lower* than `0.1.0` in both version orderings, which is why `VERSION`
sits at `0.0.1.dev0` rather than the `0.1.0.dev0` the repo was bootstrapped with.

**The beta ships to PyPI, and nothing ships to npm** — decided in #69, with the reasoning
and the whole runbook in [docs/releasing.md](docs/releasing.md). The short version: pip is
the vehicle the product is designed around, and a pre-release is invisible to a plain
`pip install`, so publishing one is safe rather than premature.

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
  which turns that skip into a hard failure so a broken install cannot pass unnoticed. The
  container route needs nothing on the host — `docker/api.Dockerfile` installs it into the image,
  and CI's `docker` job builds that image and runs the video tests inside it.
