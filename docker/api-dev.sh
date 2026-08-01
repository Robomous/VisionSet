#!/bin/sh
# Bring up the API for the compose dev stack: make a workspace if there is none,
# mint the token the browser will ask for, then start uvicorn.
#
# This is dev-only scaffolding. Nothing here ships in the wheel, and the release
# artifact is still `pip install visionset` — see docker/compose.yaml.
set -eu

WORKSPACE="${VISIONSET_WORKSPACE:?VISIONSET_WORKSPACE must be set}"

# `visionset init` refuses a directory that already holds something, which is the
# right behaviour for a command a person types and the wrong one for a container
# that restarts. So the guard is the database file itself — the same thing
# `resolve_workspace_root` looks for — rather than `|| true`, which would swallow
# a genuine refusal (a corrupt workspace, an unwritable mount) and leave uvicorn
# to report it much later as a 500 with an incident id.
if [ ! -f "$WORKSPACE/visionset.db" ]; then
  echo "compose: no workspace at $WORKSPACE — creating one"
  uv run visionset init "$WORKSPACE"

  # Only on the run that created it. A token secret is shown exactly once by
  # design (`IssuedToken.secret` carries `repr=False`), so there is nothing to
  # re-print on a later boot and pretending otherwise would be a lie.
  echo "compose: minting a token named 'dev' for the browser"
  SECRET="$(uv run visionset token create --name dev --workspace "$WORKSPACE")"
  echo "compose: ----------------------------------------------------------------"
  echo "compose: sign in at http://localhost:8080 with this token:"
  echo "compose:   $SECRET"
  echo "compose: shown once. For another:"
  echo "compose:   docker compose -f docker/compose.yaml exec api \\"
  echo "compose:     uv run visionset token create --name <name>"
  echo "compose: ----------------------------------------------------------------"
fi

# `--reload-dir` is not tidiness. uvicorn's default watch list is the working
# directory, which here is the whole bind-mounted repository: `node_modules/`,
# the `.venv` volume mountpoint, and `workspace-data/` — so every SQLite write
# during an ingest would restart the server mid-run. `visionset ui` scopes its
# own `reload_dirs` to the package for exactly this reason; raw uvicorn does not
# inherit that, so the scope is stated here instead.
exec uv run uvicorn visionset.server.main:app \
  --reload \
  --reload-dir /workspace/src \
  --host 0.0.0.0 \
  --port 8000
