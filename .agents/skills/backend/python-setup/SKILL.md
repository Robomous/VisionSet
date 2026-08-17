---
name: python-setup
description: >
  Python environment and conventions for VisionSet. uv workspace, ruff (lint + format),
  mypy (strict on the kernel), import-linter, pytest.
  Trigger: When running Python scripts, formatting/linting Python code, adding dependencies,
  or setting up the backend environment.
license: Apache-2.0
metadata:
  author: robomous
  version: "1.0"
  scope: [root, backend]
  auto_invoke: "Running Python scripts or setting up the Python environment"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, WebFetch, WebSearch, Task
---

## Environment

- One Python distribution: `visionset`, living in `src/visionset/`. There is no `backend/`
  folder and no `visionset_*` sibling packages.
- Requires **Python 3.12+**. Package manager: **uv** (never pip, never poetry).
- All commands run from the **repo root** — there is no per-component venv.

```bash
uv sync                      # create/refresh .venv with the package (editable) + dev group
uv run python -c "..."       # run anything inside the env
uv run pytest                # tests

# Adding a dependency goes through the cool-down wrapper — see below.
bash scripts/cooldown.sh uv add <pkg>          # runtime -> [project].dependencies
bash scripts/cooldown.sh uv add --dev <pkg>    # dev     -> [dependency-groups].dev
```

Never edit `uv.lock` by hand; never `pip install` into `.venv`.

**The three-day cool-down.** This repository does not take a package version the ecosystem has not
had three days to look at. uv has no rolling setting for it — `--exclude-newer` accepts absolute
dates only — so `scripts/cooldown.sh` computes the cutoff at the moment of the call and exports
`UV_EXCLUDE_NEWER`. Use it for anything that **resolves**: `uv add`, `uv lock`, `uv pip install`.

Do **not** put it in front of `uv sync`. A cutoff on a plain sync makes uv discard the lockfile and
re-resolve (`Ignoring existing lockfile due to addition of timestamp cutoff`), which is the opposite
of what a sync is for; CI uses `uv sync --locked` so it cannot happen there. The cool-down governs
what gets *into* uv.lock, and the lockfile governs everything after. Full rules and the escape
hatches are in CONTRIBUTING.md.

## Checks that must stay green

| Check | Command |
| --- | --- |
| Tests | `uv run pytest` |
| Import contracts (architecture) | `uv run lint-imports` |
| Kernel type-safety (strict) | `uv run mypy src/visionset/kernel` |
| Lint | `uv run ruff check .` |
| Format | `uv run ruff format .` |
| OpenAPI contract | `uv run python scripts/export_openapi.py` (commit the diff) |

Run at minimum `ruff check`, `ruff format`, `pytest`, and `lint-imports` after any Python
change. If you touched the kernel, add `mypy`. If you touched FastAPI routes or response
models, re-export `openapi.json` — it is a committed contract, a stale one is a bug.

**Never pass `-q` to pytest.** `pyproject.toml` already sets `addopts = "-q"`, and verbosity is a
counter, so a second one stacks to `-qq` — which drops the test count and the summary line and
leaves the exit code as the only signal, on a log that ends mid-progress and reads as truncated.
Plain `uv run pytest` already prints the count; where a wrapper you cannot edit has added a `-q`,
one `-v` cancels it.

## Formatting and lint

**ruff is both the formatter and the linter** — do not introduce black, isort, flake8, or
autopep8. Line length is 100. Rule set: `E, F, I, UP, B, SIM` (configured in `pyproject.toml`;
change it there, never with scattered `# noqa`).

```bash
uv run ruff format <path>    # format
uv run ruff check --fix <path>
```

## Imports (REQUIRED)

- Imports go at the top of the file. `ruff`'s `I` rules own the ordering — let the tool sort;
  do not hand-order.
- Import inside a function **only** to break a genuine cycle or to keep an optional dependency
  optional, and say why in a one-line comment.
- Nothing in `visionset.kernel` may import a framework or a delivery module — see the
  `kernel-architecture` skill. That rule beats convenience, always.

## Typing

- The kernel is under strict mypy (`disallow_untyped_defs`, `disallow_any_generics`,
  `warn_return_any`, …). Every kernel function is fully annotated; no bare `Any`.
- Outside the kernel, follow the local style — annotate new public functions.
- Domain invariants belong in the pydantic v2 models, not in ad-hoc `assert`s at call sites.
- **A method named after a builtin shadows it for every annotation declared after it.** A class
  with `def list(...)` makes a later `-> list[Batch]` resolve to *the method*, and mypy reports
  `"..." is not valid as a type` — which reads as a mystery until you notice the name. Declare
  annotated members above such a method, put helpers that need the builtin at module level, or
  rename. The same applies to `dict`, `set` and `type`.

## Versioning

The repo-root `VERSION` file is the single source of truth. `pyproject.toml` reads it via
hatchling's regex version source; `pnpm version:sync` propagates it to the npm packages.
Never hand-edit a version anywhere else.

## Dependency rules

- A new runtime dependency in `[project].dependencies` ships to every user of the wheel —
  justify it. The kernel must stay framework-free; tooling-only deps go to the dev group.
- Importer/exporter plugins register under the `visionset.formats` entry-point group instead
  of being imported directly.
