#!/bin/sh
# Start the API for the compose dev stack: make a workspace if there is none, mint
# a token for the clients that need one, then start uvicorn.
#
# The browser is not one of them any more (#179). It is signed in by the server
# itself — see VISIONSET_UI_SESSION in docker/compose.yaml — so nobody has to find
# a secret in a log to open the app. The token is still minted, because `curl` and
# an MCP client have no session and never will.
#
# No `uv run`, and that is the point: every dependency is already installed in the
# image's venv, which is on PATH, so these are plain calls that touch no network
# and resolve nothing. `uv run` would re-check the environment on every boot, which
# is the work docker/api.Dockerfile exists to have already done.
#
# This is dev-only scaffolding. Nothing here ships in the wheel, and the release
# artifact is still `pip install visionset` — see docker/compose.yaml.
set -eu

WORKSPACE="${VISIONSET_WORKSPACE:?VISIONSET_WORKSPACE must be set}"

# The storage mount, checked before anything tries to write it. This container runs
# as the developer rather than as root (see `user:` in docker/compose.yaml), and the
# one thing that arrangement cannot fix by itself is a host directory that is
# already somebody else's: Docker creates a missing bind-mount source as root,
# before any container starts, so no line in this script can get ahead of it. That
# is why the repository tracks `workspace-data/` as an empty directory — a checkout
# that already carries it is one the daemon never has to invent — but a
# VISIONSET_DATA pointing somewhere new, or a directory left behind by a stack that
# ran as root, both land here.
#
# Said now, naming the remedy, rather than left to surface as a traceback out of
# `visionset init` or later as a 500 with an incident id. A refusal whose reader
# cannot act on it is the failure this file's guard below already argues against.
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

# `visionset init` refuses a directory that already holds something, which is the
# right behaviour for a command a person types and the wrong one for a container
# that restarts. So the guard is the database file itself — the same thing
# `resolve_workspace_root` looks for — rather than `|| true`, which would swallow
# a genuine refusal (a corrupt workspace, an unwritable mount) and leave uvicorn
# to report it much later as a 500 with an incident id.
if [ ! -f "$WORKSPACE/visionset.db" ]; then
  echo "compose: no workspace at $WORKSPACE — creating one"
  visionset init "$WORKSPACE"

  # Only on the run that created it. A token secret is shown exactly once by
  # design (`IssuedToken.secret` carries `repr=False`), so there is nothing to
  # re-print on a later boot and pretending otherwise would be a lie.
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

# `--reload-dir` is not tidiness, and it is not made redundant by the mounts
# either. uvicorn's default watch list is the working directory, which used to be
# the whole bind-mounted repository — `node_modules/` and `workspace-data/` among
# the rest, so every SQLite write during an ingest would restart the server
# mid-run. docker/compose.yaml now mounts only `src` and `docker` here, which
# removes that particular hazard, but the scope still belongs in writing: it says
# *which* directory is the source of truth rather than leaving it to be inferred
# from what happens to be mounted, and it keeps an edit to this very script from
# bouncing a server that would not re-read it anyway. `visionset server` scopes
# its own `reload_dirs` to the package for the same reason; raw uvicorn does not
# inherit that, so the scope is stated here instead.
exec uvicorn visionset.server.main:app \
  --reload \
  --reload-dir /workspace/src \
  --host 0.0.0.0 \
  --port 8000
