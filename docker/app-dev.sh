#!/bin/sh
# Start the Vite dev server for the compose dev stack.
#
# No install. Every npm package was resolved, downloaded and linked into the image
# by docker/app.Dockerfile; if this script ever grows a `pnpm install`, the build
# has stopped doing its job.
#
# This is dev-only scaffolding. Nothing here ships in the wheel, and the release
# artifact is still `pip install visionset` — see docker/compose.yaml.
set -eu

# The one piece of work that cannot move into the image — and it is not dependency
# work. It compiles the repository's *own* two libraries from the source that
# arrived on the bind mount a moment ago; an image cannot hold a build of code
# nobody has written yet, and a stale one would be worse than none.
#
# It is needed at all because `@visionset/annotator` and `@visionset/ui-core` are
# consumed through their `dist/` (both declare `"main": "./dist/index.js"`), so
# vite cannot resolve either from source and a clean checkout fails with
#   Failed to resolve entry for package "@visionset/annotator"
# before it serves a byte.
#
# The app itself is deliberately NOT built: `@visionset/app`'s build is
# `tsc --noEmit && vite build`, which produces the production bundle that ships
# inside the wheel. Nothing in development reads it, and requiring it is the
# thing this stack exists to avoid.
pnpm --filter @visionset/annotator --filter @visionset/ui-core build

# `--host 0.0.0.0` so the published port reaches it from outside the container.
exec pnpm --filter @visionset/app dev --host 0.0.0.0
