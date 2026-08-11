#!/bin/sh
# Start the Astro dev server for the compose dev stack.
#
# No install. Every npm package was resolved, downloaded and linked into the image
# by docker/docs.Dockerfile; if this script ever grows a `pnpm install`, the build
# has stopped doing its job.
#
# There is no build step to do first either, which is the one way this is simpler
# than docker/app-dev.sh: nothing here is consumed through a `dist/`. The projection
# of `docs/` into the content collection happens inside Astro, in the `docsSource()`
# integration, on every start and on every change — so `astro dev` is the whole
# command and the site is current the moment it answers.
#
# Dev-only scaffolding. The documentation's deployment artifact is the static output
# of `pnpm --dir docs-site build`; see amplify.yml.
set -eu

# `--host 0.0.0.0` so the published port reaches it from outside the container. The
# port is published on 127.0.0.1 only — see docker/compose.yaml.
#
# `exec` rather than the background-and-trap dance docker/app-dev.sh needs: that
# script supervises three processes and has to stop two of them itself. This one is
# a single process, so handing it PID 1 is both correct and the fastest way for
# `docker compose down` to end it.
exec pnpm --dir /workspace/docs-site dev --host 0.0.0.0
