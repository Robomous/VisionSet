#!/usr/bin/env bash
# The canonical way to run VisionSet's checks. Humans and agents use this one.
#
# **Why this exists.** During the #229–#233 run, two background invocations of
# `uv run pytest -q | tail -20` reported exit 0 while the suite was failing: a
# pipeline's status is the *last* command's, so `tail` succeeding at printing
# lines masked pytest failing at running them. That hid a real broken test
# through two full task cycles. `set -euo pipefail` below makes that impossible
# here, and `docs`/`CONTRIBUTING.md` point everything at this script so nobody
# has to remember the rule at the call site.
#
# It is a script rather than a Makefile because this repository has never had
# `make`, and `scripts/build_dist.sh` and `scripts/cycle_server.sh` are the
# established shape for "several commands whose order or failure handling
# matters".
#
# Usage:
#   bash scripts/check.sh                 # python + frontend + generated
#   bash scripts/check.sh python          # one group
#   bash scripts/check.sh python frontend # several
#   pnpm check                            # the same thing, from the other half
#
# Groups deliberately *not* here, because each costs minutes or needs an
# install, and CI is where they belong: the wheel build, the 30-minute flow, the
# format smoke tests (ultralytics brings torch), Playwright's e2e/cycle/bench.
# `CONTRIBUTING.md`'s table stays the full list; this is the inner loop.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Every failure is collected rather than exiting at the first one. `set -e` alone
# would stop at the earliest problem, which is the wrong trade for a check
# script: knowing that lint *and* a test are broken is one round trip, learning
# it twice is two. `|| status=$?` is what disarms errexit for the step itself —
# the pipefail above still applies inside whatever the step runs.
declare -a failed=()

step() {
  local name="$1"
  shift
  echo
  echo "==> $name"
  echo "    \$ $*"
  local status=0
  "$@" || status=$?
  if [[ $status -ne 0 ]]; then
    echo "    FAILED ($name, exit $status)" >&2
    failed+=("$name")
  fi
}

run_python() {
  step "python tests" uv run pytest -q
  step "ruff (lint)" uv run ruff check .
  step "ruff (format)" uv run ruff format --check .
  # `src/visionset` here, `src/visionset/kernel` under strict settings — the
  # narrower one is a subset, so running the wider one covers both.
  step "mypy" uv run mypy src/visionset
  step "import contracts" uv run lint-imports
}

# A precondition rather than a step, because the failure it prevents does not
# look like one. Without `node_modules`, `pnpm generate:client:check` dies with
# `ERR_MODULE_NOT_FOUND: openapi-typescript` and a nine-line node stack — which
# reads as "the generated client is broken" rather than "nothing is installed".
# A fresh worktree is exactly where somebody runs this first.
require_node_modules() {
  if [[ ! -d node_modules ]]; then
    echo "error: node_modules is missing — run 'pnpm install' first" >&2
    exit 2
  fi
}

run_frontend() {
  require_node_modules
  # Build first, and it is not merely an optimisation: `frontend/app` resolves
  # `@visionset/annotator` through its `dist/`, so a typecheck before a build
  # reports TS2307 on a clean checkout. CI orders these the same way.
  step "frontend build" pnpm -r build
  step "frontend tests" pnpm test
  step "frontend lint" pnpm -r lint
}

# The committed artifacts do not all gate the same way, and this mirrors each
# one's real mechanism rather than inventing a uniform `--check` they do not have.
openapi_is_current() {
  uv run python scripts/export_openapi.py
  git diff --exit-code openapi.json
}

run_generated() {
  require_node_modules
  # `openapi.json` has no `--check` mode: CI regenerates and diffs, so this does
  # the same. The write is a side effect worth knowing about — a stale spec is
  # left *corrected* in the working tree, ready to commit.
  step "openapi drift" openapi_is_current
  step "generated client drift" pnpm generate:client:check
  step "mcp tool reference drift" uv run python scripts/export_mcp_tools.py --check
  step "version sync" pnpm version:check
  # `tests/fixtures/wire_annotations.json` is deliberately absent: its gate is
  # `tests/server/test_wire_fixtures.py`, so the `python` group already runs it.
}

groups=("$@")
if [[ ${#groups[@]} -eq 0 ]]; then
  groups=(python frontend generated)
fi

for group in "${groups[@]}"; do
  case "$group" in
    python) run_python ;;
    frontend) run_frontend ;;
    generated) run_generated ;;
    *)
      echo "error: unknown group '$group' (want: python, frontend, generated)" >&2
      exit 2
      ;;
  esac
done

echo
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "FAILED: ${failed[*]}" >&2
  exit 1
fi
echo "All checks passed."
