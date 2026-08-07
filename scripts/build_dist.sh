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

# Under the cool-down, and this is the sharpest place in the repository for it.
# `[build-system] requires = ["hatchling"]` is not in uv.lock — build backends are
# resolved fresh, from PyPI, on every build — and a build backend is *executed*,
# so a compromised release of one runs arbitrary code with the credentials of
# whatever is building. Three days of patience costs a release nothing and is the
# only thing standing between that and here. See scripts/cooldown.sh.
#
# Wrapping it here rather than in the three callers is what makes it true for all
# of them at once: the `wheel` and `30-minute flow` CI jobs and the PyPI publish
# workflow all reach `uv build` through this script and nothing else does.
echo "==> uv build (dependency cool-down applied to the build backend)"
rm -rf dist
bash "$root/scripts/cooldown.sh" uv build

echo
echo "built:"
ls -la dist
