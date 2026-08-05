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
#   bash scripts/check.sh                 # everything: python, frontend,
#                                         #   generated, browser
#   bash scripts/check.sh --fast          # the same minus the browser suites
#   bash scripts/check.sh browser         # one group
#   bash scripts/check.sh python frontend # several
#   pnpm check                            # the same thing, from the other half
#
# **The three suites, because there are three and two of them used to be
# invisible here** (#314). Until that issue this script ran no browser at all,
# while calling itself the canonical "before you say it works" invocation:
#
#   python | frontend | generated   pytest, vitest, ruff, mypy, import-linter,
#                                   eslint, and the four drift gates
#   browser, part 1                 frontend/app's e2e — the annotator's
#                                   scenarios and the app's, all stubbed
#                                   (CI job: `annotator e2e (chromium)`)
#   browser, part 2                 the whole cycle against a **real server and
#                                   a real kernel**, from a pasted token to a
#                                   downloaded export
#                                   (CI job: `browser cycle (chromium)`)
#
# That second browser suite is not a luxury. During the 2026-08 remediation run
# it was three separate times the *only* suite to catch a regression: a job's
# stale capability declaration (#306), a promote button whose only feedback was
# its own label (#308), and a progress counter that ran backwards when a frame
# was accepted (#309). One of those shipped on a green run of this script and
# went red in CI.
#
# **`CI=1` is set here, for the Playwright steps, and it is load-bearing.**
# `playwright.config.ts` sets `reuseExistingServer: !process.env.CI`, so without
# it a stale vite server left on port 5273 answers instead of the build under
# test — which produces failures in unrelated scenarios that read as genuine
# code bugs. The lesson lived in a skill and in three people's memories; it
# lives in the script now.
#
# **Caveat that no exit code will tell you: several gates read `git ls-files`,
# which is the index rather than the working tree.** A new file you have not
# `git add`ed is invisible to them, so it passes here and fails in CI. Stage
# first, then run.
#
# Groups deliberately *not* here, because each costs minutes or needs an
# install, and CI is where they belong: the wheel build, the 30-minute flow, the
# format smoke tests (ultralytics brings torch), and Playwright's bench config —
# `annotator bench (chromium, manual)` is `workflow_dispatch`-only and must stay
# out of any default, here and in the branch ruleset alike.
# `CONTRIBUTING.md`'s table stays the full list; this is everything a pull
# request's own required checks will run.
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
# of the full gate is now minutes rather than seconds, so it is worth seeing
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

# Both suites are invoked from `frontend/app`, in a subshell so the `cd` cannot
# leak into a later group, and both build what they need themselves: each
# config's `webServer.command` compiles `@visionset/annotator` and
# `@visionset/ui-core` first, because `frontend/app` resolves them through their
# `dist/` and an unbuilt change is invisible in a browser rather than a compile
# error. So `check.sh browser` on its own is a complete run, not a half of one.
#
# No `require_playwright_browsers` to match `require_node_modules`: Playwright's
# own error already names `npx playwright install` as the remedy, and a check
# that restates a message which is already good is a second place to keep
# current.
browser_e2e() {
  ( cd "$root/frontend/app" && CI=1 npx playwright test )
}

browser_cycle() {
  ( cd "$root/frontend/app" && CI=1 npx playwright test -c playwright.cycle.config.ts )
}

run_browser() {
  require_node_modules
  step "annotator + app e2e (chromium)" browser_e2e
  step "browser cycle, real server (chromium)" browser_cycle
}

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

# The full run is the default and `--fast` is the exception, which is the whole
# point of #314: the previous default was silently the fast one.
if [[ ${#groups[@]} -eq 0 ]]; then
  groups=(python frontend generated)
  [[ $fast -eq 1 ]] || groups+=(browser)
elif [[ $fast -eq 1 && " ${groups[*]} " == *" browser "* ]]; then
  # Refused rather than resolved. Either answer would be a guess about which
  # half of a contradictory command line the caller meant.
  echo "error: --fast and an explicit 'browser' group contradict each other" >&2
  exit 2
fi

for group in "${groups[@]}"; do
  case "$group" in
    python) run_python ;;
    frontend) run_frontend ;;
    generated) run_generated ;;
    browser) run_browser ;;
    *)
      echo "error: unknown group '$group' (want: python, frontend, generated, browser)" >&2
      exit 2
      ;;
  esac
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

# Printed **after** the verdict, and that is the placement rather than an
# accident: the banner exists to qualify "All checks passed", so it has to be
# the thing still on screen once that line has scrolled into the backlog.
# Printed whenever the browser suites did not run, not only under `--fast` — a
# partial run is the same lie however it was asked for. ASCII rather than box
# drawing, so it survives every terminal it lands in.
if [[ " ${groups[*]} " != *" browser "* ]]; then
  echo
  echo "=============================================================================" >&2
  echo " !!  THE BROWSER SUITES DID NOT RUN  --  this is not what CI runs         !!" >&2
  echo "=============================================================================" >&2
  echo " skipped:  annotator + app e2e           CI job: annotator e2e (chromium)" >&2
  echo "           browser cycle, real server    CI job: browser cycle (chromium)" >&2
  echo "" >&2
  echo " The real-server cycle run was three separate times the ONLY suite to" >&2
  echo " catch a regression during the 2026-08 remediation run (#306, #308, #309)." >&2
  echo "" >&2
  echo " Run them:  bash scripts/check.sh browser" >&2
  echo "=============================================================================" >&2
fi

exit "$verdict"
