#!/bin/sh
# Start the Astro dev server for the compose dev stack. No install: docker/docs.Dockerfile
# already did it.
set -eu

# Astro records its pid in this lock and does not remove it on SIGTERM, so it survives a
# container restart — and the restarted tree reuses the same pids, so astro then refuses to
# start (and `--force` would kill itself). Nothing else runs in this container at boot.
rm -f /workspace/docs/.astro/dev.json

exec pnpm --dir /workspace/docs dev --host 0.0.0.0
