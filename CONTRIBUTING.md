# Contributing to VisionSet

## Dev setup

```bash
uv sync                        # Python 3.12+, installs the package editable + dev tools
pnpm install                   # pnpm workspace under frontend/
bash scripts/setup_agents.sh   # optional: expose .agents/skills/ to coding agents
```

Or skip all three and run the stack in containers — `docker compose -f docker/compose.yaml up`
needs nothing installed on the host and no build of any kind.

| | |
| --- | --- |
| The app | **http://localhost:8080** — nginx, the only port you need |
| Storage | `workspace-data/` (git-ignored): `visionset.db` + `blobs/`. Move it with `VISIONSET_DATA=/path` |
| Token | minted on first boot, printed in the `api` logs |
| Behind the proxy | API on :8000 and vite on :5173 are published too, for curl and for reading a vite error without nginx in the way |
| Live reload | every layer, with nothing restarted: `src/visionset/` through uvicorn `--reload`, `frontend/app/src/` through vite HMR, and `frontend/{ui-core,annotator}/src/` through a `tsc --watch` per package that rewrites the `dist/` vite resolves them from |
| After a dependency change | `build` — in either language, and nothing else. No `node_modules` is mounted from the host or from a volume, so a rebuilt image is what the containers get |
| After changing a `package.json`, a tsconfig, `vite.config.ts` or `index.html` | `build` — these are baked into the app image, beside the install they configure |
| After changing a Dockerfile or an entry script | `build` for the first, `restart api` / `restart app` for the second — an entry script is read once, at container start |

Every dependency is installed at **image build** (`docker/api.Dockerfile`,
`docker/app.Dockerfile`), both honouring their lockfiles, so starting a container downloads
nothing — the stack comes up offline. What is left at start is compiling the repository's own two
TypeScript libraries, which no image can hold because the source does not exist until you write it.

Only the directories a running service actually reads are mounted — `src/` into the api, the three
frontend `src/` directories plus `frontend/app/public` into the app, `docker/` into both, and the
storage directory. The whole checkout is not, so `tests/` is absent from the api container and
`docker compose exec api pytest` collects nothing: run the suite on the host with
`bash scripts/check.sh python`. The mount list is in `docker/compose.yaml`, next to the reasoning —
including why the app mounts source directories rather than package roots, which is what keeps a
`build` sufficient after a dependency change.

Dev only; the release artifact is always the pip package, and these images are never it. Running
it on the host stays faster, because a bind mount has to poll for file changes rather than being
told about them.

## Adding a dependency: the three-day cool-down

**This repository does not install a package version the ecosystem has not had three days to look
at.** A compromised release is most dangerous in the hours between publication and yanking, and
patience is the cheapest defence there is. The rule is the same everywhere; only the spelling
differs, because pnpm has a setting for it and uv does not.

| Adding to | Type | The rule reaches you through |
| --- | --- | --- |
| the pnpm workspace | `pnpm add <pkg>` | `minimumReleaseAge` in `pnpm-workspace.yaml` — automatic, nothing to type |
| the Python distribution | `bash scripts/cooldown.sh uv add <pkg>` | the wrapper; a bare `uv add` waits for nothing |
| a build backend | — | `scripts/build_dist.sh` already wraps `uv build` |
| GitHub Actions, Docker images | Dependabot | `cooldown.default-days` in `.github/dependabot.yml` |

Three days is **one number with four spellings**, and `tests/scripts/cooldown.test.mjs` holds them
to each other — `scripts/cooldown.sh` is the source, and moving it without moving the rest is a red
test rather than a quiet inconsistency.

**It is a resolution-time rule, and it is inert on every install path.** `pnpm install
--frozen-lockfile` and `uv sync --locked` install exactly what the lockfile names, cool-down or no
— that is the point, not a gap. The lockfile is the reviewed artifact; the cool-down polices what
gets into it. This is also why CI uses `--locked` rather than a bare `uv sync`: a plain `uv sync`
under a cutoff *discards the lockfile and re-resolves*, which would mean CI silently testing a set
nobody chose.

**`uv.lock` never carries a cutoff, and the wrapper is what keeps it out.** uv records a global
exclude-newer in the lockfile's `[options]` table, where `--locked` counts it as part of what the
lock must agree with — so an unscrubbed wrapped resolution commits a rolling timestamp that every
later `uv sync --locked` refuses. `scripts/cooldown.sh` removes the recorded line after the command
it wraps, leaving the resolved versions exactly as the cool-down chose them. Do not try to repair
such a lockfile by re-running a bare `uv lock`: uv throws away a lock whose recorded cutoff has
gone and resolves again, straight past the versions the cool-down excluded.

**When it fires.** `pnpm add <pkg>` with no version asks for `latest`, so a too-new release is
refused outright (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`) rather than silently downgraded. Wait, or
name an older version. To take a young version deliberately, add it to `minimumReleaseAgeExclude`
in the same commit — an exception in the diff is one somebody can review. On the Python side, run
the bare command or set `VISIONSET_COOLDOWN_DAYS=0` for a single invocation.

**Security fixes are never delayed.** Dependabot's security updates bypass its own cool-down by
design, and nothing here re-imposes one on them.

## Checks that must stay green

**Run them with `bash scripts/check.sh`** (or `pnpm check` — the same script). It is the
canonical invocation for humans and agents alike: it collects *every* failure rather than
stopping at the first, carries `set -euo pipefail`, and prints a per-step timing table.
Take a subset with `bash scripts/check.sh python`, `frontend`, `generated` or `browser`.

**It runs the browser suites, and that is the default.** Until #314 it ran no browser at
all while calling itself canonical — and during the 2026-08 remediation run the
real-server cycle suite was three separate times the *only* one to catch a regression
(#306, #308, #309), one of which shipped on a green run of this script and went red in CI.
`bash scripts/check.sh --fast` skips them for the inner loop; it says so in a banner rather
than quietly, because "All checks passed" has always meant "all the checks this invocation
ran".

**The last line on stdout says what the run covered**, so "all the checks this invocation
ran" is something a reader can check rather than infer (#336):

```
check.sh: PASSED  ran=python,frontend,generated,browser  skipped=none
```

`ran=` is what *completed* — never what was asked for — and the verdict is one of three:
`PASSED`, `FAILED` (a step reported a problem) or `INCOMPLETE` (the run left early, so
nothing was found wrong; the checks simply did not happen). It comes from a `trap … EXIT`,
so a missing `node_modules` three groups in cannot skip it. That matters because the abort
message goes to **stderr**: before this, a caller capturing stdout saw a partial run and a
full one as the same thing — some green pytest output and then silence — which is the
false-calm failure this file warns about for `| tail`, arriving from the other direction.
`tests/scripts/check_stages.test.mjs` holds it, including that every group the script knows
is still dispatched.

The script sets **`CI=1`** for the Playwright steps itself. It is load-bearing:
`playwright.config.ts` sets `reuseExistingServer: !process.env.CI`, so without it a stale
vite server left on this worktree's e2e port answers instead of the build under test, and
the failures that follow read as genuine code bugs in unrelated scenarios.

**The browser suites bind one port per worktree.** Several checkouts run their gates at
once here — that is exactly what `refactor-protocol`'s worktree rule produces — and three
fixed ports made those suites single-occupancy: the second run to reach the browser group
found 5273 held and died with `Port 5273 is already in use`, which reads as a broken dev
server rather than as contention (#346). So the number is derived from the worktree's own
absolute path. `frontend/app/e2e-ports.ts` hashes that path into one of 2048 slots and
gives each suite a port from a band of its own — **16384–18431** for the e2e suite,
**18432–20479** for the cycle server, **20480–22527** for the benchmark. The **main
checkout is exempt, and so is CI**, whose clone is a main checkout too: both keep 5273,
8123 and 5373, so nothing about a single-checkout workflow changes. Every run prints the
three numbers it resolved on stderr before it starts, and a port that is already taken is
a refusal naming the worktree it came from rather than four words from vite. Override one
suite with `VISIONSET_E2E_PORT`, `VISIONSET_CYCLE_PORT` or `VISIONSET_BENCH_PORT`.

**`VISIONSET_PW_WORKERS` sets how many workers the e2e suite runs.** `scripts/check.sh`
sets it to 10, because the machine you are sitting at is not a two-core runner; unset, the
count is what it always was — two under `CI`, Playwright's own choice otherwise. It is a
variable of its own rather than more meaning loaded onto `CI`, which the browser steps set
for `reuseExistingServer` and which used to decide the worker count as a side effect.
Actions sets nothing, so CI keeps the count its runners were measured at.

One caveat no exit code will tell you: several gates read `git ls-files`, which is the
**index** rather than the working tree. A new file you have not `git add`ed is invisible to
them, so it passes locally and fails in CI. Stage first, then run.

**Never pipe a test runner through `tail` or `head` when the exit code matters.** A
pipeline's status is the *last* command's, so `uv run pytest -q | tail -20` exits 0 while
the suite fails — `tail` succeeded at printing lines. That masked a real broken test
through two task cycles during the #229–#233 run. If you need less output, redirect to a
file and read it (`uv run pytest > /tmp/out.log 2>&1; echo $?`), or use the script
above. No `-q` on that command: `pyproject.toml` sets one already, and a second stacks
to `-qq`, which drops the very summary line you redirected the output to read.

The table below is the full list, and it is still wider than the script: the wheel build,
the 30-minute flow, the two smoke suites and the annotator benchmark are left to CI or to
a deliberate manual run, because each costs minutes or needs its own install.

| Check | Command | In `check.sh` |
| --- | --- | --- |
| Python tests | `uv run pytest` (the script adds `-n auto`) | `python` |
| Import contracts | `uv run lint-imports` | `python` |
| Kernel type-safety (strict) | `uv run mypy src/visionset/kernel` | `python` |
| Lint/format | `uv run ruff check .` / `uv run ruff format .` | `python` |
| Frontend build + tests | `pnpm -r build && pnpm test` | `frontend` |
| Frontend lint | `pnpm -r lint` — **after** a build: `frontend/app` resolves `@visionset/annotator` through its `dist/`, so its typecheck has no declarations until the engine is built | `frontend` |
| Annotator headless boundary | `pnpm --filter @visionset/annotator lint` | part of `frontend` (`pnpm -r lint`) |
| Annotator end-to-end (chromium) | `pnpm --filter @visionset/app e2e` (needs `playwright install chromium` once) | `browser` |
| Browser cycle (chromium) | `pnpm --filter @visionset/app cycle` — the whole product against a real `visionset server`; needs `uv sync` and `playwright install chromium`. Repeatable in one workspace: `--repeat-each=N` costs one build rather than N | `browser` |
| Annotator benchmark (manual) | `pnpm --filter @visionset/app bench` — frame times, recorded not gated | — manual |
| Browser client | part of `pnpm test` — `ui-core`'s `data/` suite drives the 401 flow, the token form and the error envelope with a stubbed `fetch`, no server | part of `frontend` |
| Design tokens | part of `pnpm test` — `tests/scripts/design_tokens.test.mjs` refuses a colour inside a class name, and `ui-core`'s `tokens.test.ts` gates the stylesheet against its TypeScript mirror | part of `frontend` |
| Wire action rosters | part of `pnpm test` — `tests/scripts/wire_rosters.test.mjs` compares the two transcriptions of `allowed_actions` (`ui-core`'s `testing/wire.fixtures.ts` and the e2e suite's `_wire.ts`) in both directions. Only the first is typed against the generated union, so the second can drift silently; when it did, the failure surfaced as every gallery spec timing out. It proves the two agree with each other, not that either agrees with the kernel — see #358 | part of `frontend` |
| Docs links | part of `pnpm test` — `tests/scripts/docs_links.test.mjs` resolves every internal link and every `#anchor` in every tracked Markdown file, naming the file, line and dead fragment. It reads `git ls-files`, so the set grows with the repository and no list is maintained by hand. External URLs are ignored on purpose: a gate that fails for somebody else's rate limit is one people re-run rather than read. Renaming a heading breaks inbound anchors *silently* — the link just lands at the top of the page — which was a near miss during the `visionset ui` → `visionset server` rename (#329) | part of `frontend` |
| Format smoke (ultralytics, pycocotools) | `uv sync --group yolo --group coco && uv run pytest tests/formats/test_*_smoke.py` — their own groups because ultralytics brings torch **and its wheel ships a top-level `tests` package that shadows this repo's**, so run only those files and `uv sync` again afterwards; skips without them, and CI sets `VISIONSET_REQUIRE_ULTRALYTICS=1` / `VISIONSET_REQUIRE_PYCOCOTOOLS=1` so a broken install goes red | — CI |
| Inference smoke (local-inference extra) | `uv sync --extra local-inference` then `VISIONSET_REQUIRE_LOCAL_INFERENCE=1 uv run pytest tests/inference tests/architecture/test_optional_runtime.py tests/server/test_inference.py tests/server/test_suggest.py tests/cli/test_inference_commands.py tests/jobs/test_weights_job.py -rs`, and `uv sync` again afterwards. The **with-runtime** half of the matrix — see [the two halves](#the-two-halves-of-the-inference-matrix) below. Roughly two gigabytes of CUDA wheels, which is why it is opt-in locally; CI's `inference-smoke` job runs it | — CI |
| Wheel (build, install, serve) | `bash scripts/build_dist.sh && VISIONSET_REQUIRE_WHEEL=1 uv run pytest tests/packaging` — builds the UI into `_static/`, builds the wheel, installs it in a fresh venv and serves `/app/` from it. Opt-in locally (it costs about a minute); CI's `wheel` job runs it and uploads the artifact | — CI |
| The 30-minute flow | `uv run python examples/thirty_minute_flow.py` — the vision document's success metric end to end. CI's `30-minute flow (wheel, end to end)` job runs it from the **installed wheel** in an empty venv, with `ultralytics` required there | — CI |
| Version sync | `pnpm version:check` | `generated` |
| OpenAPI contract | `uv run python scripts/export_openapi.py` (commit the diff) | `generated` |
| Generated API client | `pnpm generate:client` (commit the diff) — writes **two** artifacts under `frontend/ui-core/src/generated/`: `api.ts` (the types) and `checks.ts` (the runtime response checks `unwrap` takes). CI diffs the whole directory. | `generated` |
| Annotator wire fixture | `uv run python scripts/export_wire_fixtures.py` (commit the diff) | part of `python` |
| MCP tool reference | `uv run python scripts/export_mcp_tools.py` (commit the diff) — `docs/mcp-tools.md` is generated from the server's own tool listing, because a tool description *is* the interface an agent reads | `generated` |

**`scripts/check.sh` runs pytest under `pytest-xdist` with `-n auto`.** The suite is
roughly 3200 tests averaging 63 ms, with only eight over a second — there is no expensive
test to remove, so the only thing that makes it faster is running more than one at a time,
and doing so takes it from about 190 seconds to about 30. Plain `uv run pytest` still
works and is still what the table above names; the distribution is the script's, not the
configuration's, so a single test or a single module runs the ordinary way with ordinary
output.

`auto` rather than a fixed worker count, because a number picked for a twenty-core desktop
would make the gate *slower* on a four-core laptop. CI's `python` job calls pytest
directly and is deliberately untouched — what a GitHub runner should use is a separate
question from what the machine in front of you has.

## The two machine-enforced boundaries

1. **Kernel purity** — `visionset.kernel` never imports `visionset.server`, `visionset.cli`,
   `visionset.mcp`, `visionset.formats`, `visionset.wire`, `visionset.jobs` or
   `visionset.inference`, nor `fastapi`/`typer`/`mcp`/`uvicorn`. Enforced by
   `import-linter` (contracts in `pyproject.toml`) and a fresh-process pytest in
   `tests/architecture/`. The four packages that are not frameworks are on the list for
   one shared reason: each is where a decision about the outside world is taken — which
   plugin exists, what gets published, what runs in a worker, which model is loaded — and
   a kernel that could reach one could reach the thing behind it.
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
`pnpm bundle:static` contains **no app at all**. It installs, `visionset server` starts, and
`/app/` answers a 404 naming a script the user does not have. There is no error and no
traceback anywhere in that sequence, which is why the script checks after each step and
why `tests/dist/` checks the artifact rather than the source tree.

The script also greps the built `index.html` for `/app/assets/`. A bundle built with the
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

The road to the beta is cut into six internal milestones. The first five each end with a
**git tag only**, and the sixth is the beta itself:

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

## Merging

**Every merge is manual, and nothing is queued.** Auto-merge is disabled on this repository on
purpose, so `gh pr merge --auto` does not queue anything — it fails with `GraphQL: Auto merge is
not allowed for this repository`. Open the PR, watch the checks, and merge once **every** required
check is green:

```bash
gh pr checks <n> --watch
gh pr merge <n> --squash --delete-branch
```

Never merge on a partial pass, never merge to "unblock", and never disable or skip a failing check
to get there.

This applies to Dependabot too. A `dependabot-auto-merge.yml` workflow used to try to queue
patch and minor updates; it could never succeed, and every dependabot PR it ran on carried a red
`auto-merge` X beside twelve green required checks. It was deleted rather than rewritten, because
a workflow that merges on the repository's behalf is the thing the rule above declines to have.
Dependabot PRs are read and merged like any other — the [three-day
cool-down](#adding-a-dependency-the-three-day-cool-down) is what makes them cheap to read, not
automation.

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

### The two halves of the inference matrix

`visionset.inference` is tested twice, in two environments, and both halves are deliberate.

The **without-runtime** half is the ordinary `uv run pytest` and CI's `python` job: no
`local-inference` extra installed. It is what proves a base install is a working install —
that importing the server, the CLI, the job registry and `visionset.inference` pulls in none
of torch, torchvision, transformers, accelerate or huggingface_hub, and that a machine
without them refuses with the install command rather than an `ImportError` from a library the
caller never named. Do not "fix" those skips by installing the extra into the default
environment; they are the test.

The **with-runtime** half is the table row above and CI's `inference-smoke` job: the extra
installed from `uv.lock`, on a CPU-only runner. It is the only place the lazy-import contract
means anything — on a machine where torch is not installed, "importing the product did not
load torch" is true by construction — and the only place family resolution, capability
derivation, the download path and the tensor conversions meet the real libraries at their
locked versions.

`VISIONSET_REQUIRE_LOCAL_INFERENCE=1` turns a missing runtime from a skip into an error, so a
broken install goes red instead of quietly shrinking the suite. It says nothing about a
missing **GPU**: no runner has a CUDA device, so the one test that reproduces the
half-precision finding on real tensors asks for the runtime and the device separately and
keeps skipping on the second. Anything that needs a GPU must be written the same way —
`tests/fixtures/local_inference.py` says why.
