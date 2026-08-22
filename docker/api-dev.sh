#!/bin/sh
# Start the API for the compose dev stack: create the workspace if there is none, mint a
# token for curl/MCP clients, then run uvicorn. No `uv run`: the image's venv is on PATH.
set -eu

WORKSPACE="${VISIONSET_WORKSPACE:?VISIONSET_WORKSPACE must be set}"

# Docker creates a missing bind-mount source as root before any container starts, so a
# new VISIONSET_DATA or a directory left by an older root-running stack lands here.
DATA="$(dirname "$WORKSPACE")"
if [ ! -w "$DATA" ]; then
  echo "compose: $DATA is not writable by uid $(id -u):$(id -g)" >&2
  echo "compose: the host directory behind it belongs to somebody else, most likely" >&2
  echo "compose: root, from a stack that ran before this one had a user. Hand it back:" >&2
  echo "compose:   sudo chown -R \"\$(id -u):\$(id -g)\" workspace-data" >&2
  echo "compose: or, without sudo, through a container that is already root:" >&2
  echo "compose:   docker run --rm -v \"\$PWD:/w\" alpine:3 \\" >&2
  echo "compose:     chown -R $(id -u):$(id -g) /w/workspace-data" >&2
  echo "compose: if VISIONSET_DATA is set, that path rather than workspace-data." >&2
  exit 1
fi

# Guard on the database file rather than `init || true`, which would swallow a real
# refusal (corrupt workspace, unwritable mount) until it resurfaces as a 500.
if [ ! -f "$WORKSPACE/visionset.db" ]; then
  echo "compose: no workspace at $WORKSPACE — creating one"
  visionset init "$WORKSPACE"

  # The secret is shown once by design; nothing can re-print it on a later boot.
  echo "compose: minting a token named 'dev' for API clients"
  SECRET="$(visionset token create --name dev --workspace "$WORKSPACE")"
  echo "compose: ----------------------------------------------------------------"
  echo "compose: the app is at http://localhost:8080 and needs no token."
  echo "compose: for curl, the SDK or an MCP client, here is one:"
  echo "compose:   $SECRET"
  echo "compose: shown once. For another:"
  echo "compose:   docker compose -f docker/compose.yaml exec api \\"
  echo "compose:     visionset token create --name <name>"
  echo "compose: ----------------------------------------------------------------"
fi

# `--reload-dir` keeps the watch on the source, not on everything under /workspace.
exec uvicorn visionset.server.main:app \
  --reload \
  --reload-dir /workspace/src \
  --host 0.0.0.0 \
  --port 8000
