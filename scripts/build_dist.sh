#!/usr/bin/env bash
# Build the one artifact VisionSet ships: a wheel with the compiled UI inside it.
#
# The delivery thesis in three commands, and the **order is the whole point**.
# `uv build` copies `src/visionset/_static/` as package data at the moment it runs,
# so a wheel built before `bundle:static` contains the two placeholder files and
# nothing else — and it installs, and it starts, and `/app/` answers 404 naming a
# script the user cannot run. That failure has no error and no traceback, which is
# why this is a script with a check after each step rather than a `&&` chain in a
# CI file.
#
# `set -euo pipefail`, and every step says what it is doing, because the useful
# output of a release build is knowing which stage was reached.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

echo "==> pnpm -r build"
pnpm -r build

echo "==> pnpm bundle:static"
pnpm bundle:static

# The check that makes the ordering above enforced rather than documented. A
# `_static/` holding only its two tracked files is exactly what a fresh checkout
# has, so this distinguishes "the bundle was copied" from "the copy was skipped".
index="src/visionset/_static/index.html"
if [[ ! -f "$index" ]]; then
  echo "error: $index is missing — the bundle did not reach the package" >&2
  exit 1
fi

# The #33 trap, checked here because it is invisible in a built wheel: a bundle
# built without `base: "/app/"` references `/assets/...`, which the SPA fallback
# answers with `index.html` at **200**, so the page loads blank rather than
# failing. Cheap to check, impossible to notice later.
if ! grep -q '"/app/assets/' "$index" && ! grep -q "'/app/assets/" "$index"; then
  echo "error: $index does not reference /app/assets — was it built with the dev base?" >&2
  exit 1
fi

echo "==> uv build"
rm -rf dist
uv build

echo
echo "built:"
ls -la dist
