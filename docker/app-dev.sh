#!/bin/sh
# Bring up the Vite dev server for the compose dev stack.
#
# This is dev-only scaffolding. Nothing here ships in the wheel, and the release
# artifact is still `pip install visionset` — see docker/compose.yaml.
set -eu

corepack enable
pnpm install

# `@visionset/annotator` and `@visionset/ui-core` are consumed through their
# `dist/` (both declare `"main": "./dist/index.js"`), so vite cannot resolve
# either from source and a clean checkout fails with
#   Failed to resolve entry for package "@visionset/annotator"
# before it serves a byte. Building the two libraries is therefore part of
# starting the dev server, not a separate step somebody has to know about.
#
# The app itself is deliberately NOT built: `@visionset/app`'s build is
# `tsc --noEmit && vite build`, which produces the production bundle that ships
# inside the wheel. Nothing in development reads it, and requiring it is the
# thing this stack exists to avoid.
pnpm --filter @visionset/annotator --filter @visionset/ui-core build

# `--host 0.0.0.0` so the published port reaches it from outside the container.
exec pnpm --filter @visionset/app dev --host 0.0.0.0
