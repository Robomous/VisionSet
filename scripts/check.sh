#!/usr/bin/env bash
# Comprehensive local validation, on demand. CI runs the exhaustive matrix on
# every pull request; this script exists for the moments a developer deliberately
# wants the whole thing locally — reproducing a CI failure, debugging an
# integration problem, validating a high-risk change. It is not a routine step
# before a commit, push, or pull request.
#
# It exists because `uv run pytest -q | tail -20` reports exit 0 while the suite
# fails — a pipeline's status is the last command's — and that once hid a real
# broken test through two full task cycles. `set -euo pipefail` below makes that
# impossible here, so nobody has to remember the rule at the call site.
#
# Usage:
#   bash scripts/check.sh                 # python, frontend, generated, browser
#   bash scripts/check.sh --fast          # the same minus the browser suites
#   bash scripts/check.sh browser         # one group (or several, space-separated)
#   bash scripts/check.sh docs            # the documentation site (opt-in)
#   pnpm check                            # the same thing, from the other half
#
# `docs` is the one group the default run does not include, and the verdict line
# says so (`skipped=docs`): it needs its own pnpm install and reaches nothing the
# other suites cover, so it belongs to a change that touches `docs/`. CI runs it
# on every pull request either way.
#
# The browser group is two suites and neither is a luxury: frontend/app's e2e
# (stubbed API, CI job `annotator e2e (chromium)`) and the whole cycle against a
# real server and a real kernel (CI job `browser cycle (chromium)`). The cycle
# suite has repeatedly been the only check to catch a regression — including one
# that shipped on a green run of this script back when it ran no browser at all.
#
# `CI=1` is set here for the Playwright steps, and it is load-bearing:
# `playwright.config.ts` sets `reuseExistingServer: !process.env.CI`, so without
# it a stale vite server on this worktree's derived e2e port answers instead of
# the build under test, and the failures read as genuine code bugs.
#
# Caveat no exit code will tell you: several gates read `git ls-files` — the
# index, not the working tree — so a new file you have not `git add`ed passes
# here and fails in CI. Stage first, then run.
#
# Deliberately not here, because each costs minutes or needs an install and CI
# is where they belong: the wheel build, the 30-minute flow, the format smoke
# tests, and the bench config (`workflow_dispatch`-only; keep it out of any
# default, here and in the branch ruleset alike). `CONTRIBUTING.md`'s table
# stays the full list.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Every failure is collected rather than exiting at the first one. `set -e` alone
# would stop at the earliest problem, which is the wrong trade for a check
# script: knowing that lint *and* a test are broken is one round trip, learning
# it twice is two. `|| status=$?` is what disarms errexit for the step itself —
# the pipefail above still applies inside whatever the step runs.
declare -a failed=()
# One `<seconds> <name>` line per step, printed as a table at the end. The cost
# of the full run is minutes rather than seconds, so it is worth seeing
# where they go — both to choose `--fast` knowingly and to notice the day a step
# quietly doubles.
declare -a timings=()

step() {
  local name="$1"
  shift
  echo
  echo "==> $name"
  echo "    \$ $*"
  local start=$SECONDS
  local status=0
  "$@" || status=$?
  timings+=("$(printf '%5ds  %s' "$((SECONDS - start))" "$name")")
  if [[ $status -ne 0 ]]; then
    echo "    FAILED ($name, exit $status)" >&2
    failed+=("$name")
  fi
}

run_python() {
  # No `-q`: `pyproject.toml` already sets it in `addopts`, verbosity is a
  # counter, and a second one stacks to `-qq` — dropping the count and summary
  # line that make a run auditable.
  #
  # `-n auto` distributes across this machine's cores; the suite has no fat tail
  # to cut, so parallelism is the only thing that makes it faster. `auto` rather
  # than a number, because a number chosen for a twenty-core desktop would slow
  # the gate on a four-core laptop. CI's `python` job passes `-n auto` too.
  step "python tests" uv run pytest -n auto
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

# `.nvmrc` is the single source of truth for the Node version, read here and by
# every `actions/setup-node` through `node-version-file`. It is checked because
# the failure a wrong major produces does not look like a version problem: a
# newer Node declares `localStorage` as a global `undefined`, jsdom's never
# arrives, and `ui-core` tests fail with a `TypeError` on storage they never
# touched. Only the major is compared, so a future `.nvmrc` naming a full
# version still works here.
require_node_version() {
  local want found found_major
  # Named rather than left to `set -e`, which would abort on `sed`'s own error and
  # print a message about a file the reader has no reason to connect to Node.
  if [[ ! -f $root/.nvmrc ]]; then
    echo "error: .nvmrc is missing — it is what pins this repository's Node version" >&2
    exit 2
  fi
  want="$(sed -e 's/^v//' -e 's/[^0-9].*$//' "$root/.nvmrc" | head -n 1)"
  if ! command -v node >/dev/null 2>&1; then
    echo "error: no node on PATH — this repository is pinned to Node $want by .nvmrc" >&2
    exit 2
  fi
  found="$(node --version)"
  found_major="${found#v}"
  found_major="${found_major%%.*}"
  if [[ $found_major != "$want" ]]; then
    echo "error: node is $found but this repository is pinned to Node $want by .nvmrc — run 'nvm use', which reads it" >&2
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
  step "export target catalog drift" uv run python scripts/export_target_catalog.py --check
  step "version sync" pnpm version:check
  # `tests/fixtures/wire_annotations.json` is deliberately absent: its gate is
  # `tests/server/test_wire_fixtures.py`, so the `python` group already runs it.
}

# Both suites run from `frontend/app` in a subshell (the `cd` cannot leak), and
# both build what they need themselves — each config's `webServer.command`
# compiles the workspace packages first, so `check.sh browser` alone is a
# complete run. No `require_playwright_browsers` check: Playwright's own error
# already names the remedy, and a check restating a good message is a second
# place to keep current. `pnpm exec`, never `npx` — `npx` fetches and runs what
# no lockfile names and no cool-down covers.
# `VISIONSET_PW_WORKERS` is separate from `CI` on purpose: `CI=1` exists for
# `reuseExistingServer`, and letting it also mean the worker count once handed a
# local run a number sized for a two-core runner. Ten is for a developer's
# machine; CI sets its own.
browser_e2e() {
  ( cd "$root/frontend/app" && CI=1 VISIONSET_PW_WORKERS=10 pnpm exec playwright test )
}

browser_cycle() {
  ( cd "$root/frontend/app" && CI=1 pnpm exec playwright test -c playwright.cycle.config.ts )
}

run_browser() {
  require_node_modules
  step "annotator + app e2e (chromium)" browser_e2e
  step "browser cycle, real server (chromium)" browser_cycle
}

# The documentation site — not in the default set (see the header). It is a
# separate workspace root with its own install, so `require_node_modules` says
# nothing about it and this has to check for itself.
require_docs_site_modules() {
  if [[ ! -d docs/node_modules ]]; then
    echo "error: docs/node_modules is missing — run 'pnpm --dir docs install' first" >&2
    exit 2
  fi
}

docs_build() {
  ( cd "$root/docs" && pnpm build )
}

# After the build, never before it: `docs/src/content/docs/` is generated
# and git-ignored, so a `sync:check` first would report every page stale on a
# fresh clone. Run here it asserts determinism — the projection just produced is
# byte-for-byte what a fresh one produces, which catches a transform that grew a
# timestamp or a filesystem-dependent ordering.
docs_projection_is_deterministic() {
  ( cd "$root/docs" && pnpm sync:check )
}

# Also after the build, and only meaningful after it: this reads `dist/`. The
# Markdown gate in `tests/scripts/docs_links.test.mjs` checks `docs/content/` *before* the
# projection rewrites its links, so neither covers the other — this is what a reader
# actually clicks.
docs_links() {
  ( cd "$root/docs" && node scripts/check-links.mjs )
}

run_docs() {
  require_docs_site_modules
  step "docs site build" docs_build
  step "docs projection is deterministic" docs_projection_is_deterministic
  step "docs site internal links" docs_links
}

# Every group this script knows, in the order they run. Also the roster the
# verdict line below measures coverage against, and what
# `tests/scripts/check_stages.test.mjs` holds the dispatch `case` to — a group
# that loses its arm, or an arm with no group, is a silently shortened run.
declare -a ALL_GROUPS=(python frontend generated browser docs)

# What actually *completed*, comma-joined — never what was asked for. A string
# rather than an array because macOS still ships bash **3.2**, where an empty
# array under `set -u` is an unbound variable; the timing table below is
# length-checked for the same reason, and this way there is nothing to forget.
ran=""

# The last line on stdout, on every exit path — aborts announce themselves on
# stderr only, so a caller capturing stdout would otherwise see a partial run
# and a full one as the same thing. Printed from a `trap … EXIT` so no way out
# of this script can skip it. Three outcomes, because "did not run" and "ran and
# was wrong" are different news: PASSED, FAILED (a step reported a problem),
# INCOMPLETE (the run left early; the checks simply did not happen).
summary() {
  local status=$?
  local outcome skipped=""
  if [[ ${#failed[@]} -gt 0 ]]; then
    outcome=FAILED
  elif [[ $status -ne 0 ]]; then
    outcome=INCOMPLETE
  else
    outcome=PASSED
  fi
  local group
  for group in "${ALL_GROUPS[@]}"; do
    case ",$ran," in
      *",$group,"*) ;;
      *) skipped="${skipped:+$skipped,}$group" ;;
    esac
  done
  echo
  printf 'check.sh: %s  ran=%s  skipped=%s\n' "$outcome" "${ran:-none}" "${skipped:-none}"

  # The banner comes after the line it qualifies (it must be what is still on
  # screen), is keyed on what *ran* rather than what was asked for, and stays
  # quiet when nothing ran at all — a usage error is not a partial run somebody
  # might mistake for a complete one. ASCII so it survives every terminal.
  if [[ -z $ran ]]; then return; fi
  case ",$ran," in
    *",browser,"*) return ;;
  esac
  echo "=============================================================================" >&2
  echo " !!  THE BROWSER SUITES DID NOT RUN  --  this is not what CI runs         !!" >&2
  echo "=============================================================================" >&2
  echo " skipped:  annotator + app e2e           CI job: annotator e2e (chromium)" >&2
  echo "           browser cycle, real server    CI job: browser cycle (chromium)" >&2
  echo "" >&2
  echo " The real-server cycle run was three separate times the ONLY suite to" >&2
  echo " catch a regression that every other suite reported green." >&2
  echo "" >&2
  echo " Run them:  bash scripts/check.sh browser" >&2
  echo "=============================================================================" >&2
}
trap summary EXIT

declare -a groups=()
fast=0
for arg in "$@"; do
  case "$arg" in
    --fast) fast=1 ;;
    -*)
      echo "error: unknown flag '$arg' (want: --fast)" >&2
      exit 2
      ;;
    *) groups+=("$arg") ;;
  esac
done

# The full run is the default and `--fast` is the exception. A default that is
# silently the fast one is how a browser suite stops being run at all.
if [[ ${#groups[@]} -eq 0 ]]; then
  groups=(python frontend generated)
  [[ $fast -eq 1 ]] || groups+=(browser)
elif [[ $fast -eq 1 && " ${groups[*]} " == *" browser "* ]]; then
  # Refused rather than resolved. Either answer would be a guess about which
  # half of a contradictory command line the caller meant.
  echo "error: --fast and an explicit 'browser' group contradict each other" >&2
  exit 2
fi

# Verified here rather than inside the groups that need it, and that placement is
# the point: `python` runs first and takes minutes, so a check living beside
# `require_node_modules` would let a wrong-version run reach the frontend suites
# several minutes in and fail there, looking like a code defect. `python` is the
# one group that needs no Node, so a run asking only for it is left alone.
for group in "${groups[@]}"; do
  case "$group" in
    frontend | generated | browser | docs)
      require_node_version
      break
      ;;
  esac
done

for group in "${groups[@]}"; do
  case "$group" in
    python) run_python ;;
    frontend) run_frontend ;;
    generated) run_generated ;;
    browser) run_browser ;;
    docs) run_docs ;;
    *)
      echo "error: unknown group '$group' (want: python, frontend, generated, browser, docs)" >&2
      exit 2
      ;;
  esac
  # Recorded *after* the group returns, so a group that aborted partway through —
  # `require_node_modules`, which exits — is never counted as covered.
  ran="${ran:+$ran,}$group"
done

echo
echo "Timing"
# Length-checked before expanding, which looks like belt and braces and is not:
# macOS still ships bash **3.2**, where `"${arr[@]}"` on an empty array is an
# unbound variable under `set -u` and kills the script. The `failed` block below
# has always been written this way for the same reason.
if [[ ${#timings[@]} -gt 0 ]]; then
  for line in "${timings[@]}"; do
    echo "  $line"
  done
fi
printf '  %5ds  total\n' "$SECONDS"

echo
verdict=0
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "FAILED: ${failed[*]}" >&2
  verdict=1
else
  echo "All checks passed."
fi

# The machine-readable line and the browser banner both come from `summary`, on
# the way out. Nothing more to print here.
exit "$verdict"
