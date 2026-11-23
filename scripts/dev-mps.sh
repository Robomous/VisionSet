#!/usr/bin/env bash
# Native dev server for Apple Silicon (Metal / `mps` inference), outside Docker.
#
# The same stack docker/compose.yaml runs, minus the containers: the same workspace
# (./workspace-data/dev, or $VISIONSET_DATA/dev), the same uvicorn --reload on src/, the
# same vite dev server with its /api proxy. Docker Desktop cannot hand the Mac's GPU to a
# container, so the API runs here instead.
#
#   scripts/dev-mps.sh                 set everything up, then serve
#   scripts/dev-mps.sh --setup-only    set everything up and stop (CI-style check)
#   scripts/dev-mps.sh --help
#
#   API http://127.0.0.1:8000    app http://localhost:5173
#
# Idempotent: every step checks before it acts, so it is the one command to run each time.
#   1. host      Apple Silicon macOS, with uv, pnpm and node on PATH
#   2. python    a uv env outside the repo (Python 3.12 like the api image), `uv sync --locked
#                --extra local-inference` — the lockfile decides, so the dependency cool-down holds
#   3. metal     torch must report `mps` available; without it nothing below is worth starting
#   4. frontend  `pnpm install --frozen-lockfile`
#   5. docker    refuses while the compose api runs: both would write the same SQLite file
#   6. workspace created on first boot, like docker/api-dev.sh
#   7. mps       a local connection on `mps`, created and its weights set up if missing
#
# Environment (all optional):
#   VISIONSET_MPS_VENV          env location                     ~/.venvs/visionset-mps
#   VISIONSET_DATA              data root, as in compose         ./workspace-data
#   VISIONSET_API_PORT          API port                         8000
#   VISIONSET_MPS_CONNECTION    connection name                  sam-mps
#   VISIONSET_MPS_MODEL         its model                        facebook/sam2.1-hiera-base-plus
#   VISIONSET_MPS_REVISION      its pinned revision              (SAM 2.1 base+, as in `sam`)
#   VISIONSET_MPS_CONNECTION=-  skip the connection step
#   HF_TOKEN                    for gated model weights
set -euo pipefail

setup_only=0
case "${1:-}" in
  "") ;;
  --setup-only) setup_only=1 ;;
  -h | --help)
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "dev-mps: unknown option '$1' (see --help)" >&2
    exit 2
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
venv="${VISIONSET_MPS_VENV:-$HOME/.venvs/visionset-mps}"
api_port="${VISIONSET_API_PORT:-8000}"
connection="${VISIONSET_MPS_CONNECTION:-sam-mps}"
model="${VISIONSET_MPS_MODEL:-facebook/sam2.1-hiera-base-plus}"
revision="${VISIONSET_MPS_REVISION:-b7320756a13354e7530a63935656d35b2f91a290}"

say() { echo "dev-mps: $*"; }
die() {
  echo "dev-mps: $*" >&2
  exit 1
}

cd "$root"

# 1. host ---------------------------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] \
  || die "this is for Apple Silicon macOS; elsewhere use docker/compose.cpu-inference.yaml or compose.gpu.yaml"
for tool in uv pnpm node; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not on PATH"
done

# 2. python -------------------------------------------------------------------------------
say "python environment ($venv)"
UV_PROJECT_ENVIRONMENT="$venv" uv sync --locked --python 3.12 --extra local-inference --quiet \
  || die "uv sync --locked failed (a stale uv.lock is fixed with scripts/cooldown.sh, never by dropping --locked)"
export PATH="$venv/bin:$PATH"

# 3. metal --------------------------------------------------------------------------------
if python -c 'import sys, torch; sys.exit(0 if torch.backends.mps.is_available() else 1)' 2>/dev/null; then
  say "metal: torch $(python -c 'import torch; print(torch.__version__)') reports mps available"
else
  die "torch does not see Metal (mps) in $venv — a connection on 'mps' would fall back to the CPU"
fi

# 4. frontend -----------------------------------------------------------------------------
say "frontend dependencies"
pnpm install --frozen-lockfile --reporter=silent

# 5. docker -------------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 \
  && [ -n "$(docker ps -q --filter name=visionset-api 2>/dev/null || true)" ]; then
  die "the docker api is running and holds the same workspace — stop it: docker compose -f docker/compose.yaml down"
fi

# 6. workspace ----------------------------------------------------------------------------
export VISIONSET_WORKSPACE="${VISIONSET_DATA:-$root/workspace-data}/dev"
# Same as compose: sign the browser in without a token.
export VISIONSET_UI_SESSION=always
export VISIONSET_API="http://127.0.0.1:$api_port"
export HF_TOKEN="${HF_TOKEN:-}"

if [ ! -f "$VISIONSET_WORKSPACE/visionset.db" ]; then
  say "no workspace at $VISIONSET_WORKSPACE — creating one"
  visionset init "$VISIONSET_WORKSPACE"
  say "minting a token named 'dev' (shown once)"
  visionset token create --name dev --workspace "$VISIONSET_WORKSPACE"
fi

# 7. mps connection -----------------------------------------------------------------------
if [ "$connection" != "-" ]; then
  if ! visionset inference show "$connection" --workspace "$VISIONSET_WORKSPACE" >/dev/null 2>&1; then
    say "creating connection '$connection' on mps ($model)"
    # `--precision` is required for a local connection; mps runs fp32 only.
    visionset inference create "$connection" --type local --device mps --precision fp32 \
      --model "$model" --revision "$revision" --workspace "$VISIONSET_WORKSPACE"
  fi
  # `show` prints the SETUP column; `not_set_up` is not the word `ready`. A cache hit when
  # another connection already fetched the same revision, a real download otherwise.
  if ! visionset inference show "$connection" --workspace "$VISIONSET_WORKSPACE" 2>/dev/null | grep -qw ready; then
    say "setting up '$connection' (downloads the weights unless the workspace already has them)"
    visionset inference download "$connection" --workspace "$VISIONSET_WORKSPACE"
  fi
  say "connection '$connection' is ready"
fi

if [ "$setup_only" = 1 ]; then
  say "setup complete — run scripts/dev-mps.sh to serve"
  exit 0
fi

# Serve -----------------------------------------------------------------------------------
if lsof -nP -iTCP:"$api_port" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $api_port is already taken (a previous run? VISIONSET_API_PORT picks another)"
fi

say "building the frontend libraries"
pnpm --filter @visionset/browser-inference --filter @visionset/annotator \
  --filter @visionset/media --filter @visionset/ui-core build

pids=()

# `pnpm exec` and `pnpm dev` leave node grandchildren behind when only the wrapper is
# signalled, so walk the tree: children first, then the process itself.
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$1" 2>/dev/null || true
}

shutdown() {
  trap - INT TERM EXIT
  say "stopping"
  local pid
  for pid in "${pids[@]}"; do kill_tree "$pid"; done
  wait 2>/dev/null || true
}
trap 'shutdown; exit 0' INT TERM
trap shutdown EXIT

pnpm --filter @visionset/browser-inference --filter @visionset/annotator \
  --filter @visionset/media --filter @visionset/ui-core --parallel exec tsup --watch --clean=false &
pids+=($!)

uvicorn visionset.server.main:app --reload --reload-dir "$root/src" \
  --host 127.0.0.1 --port "$api_port" &
pids+=($!)

pnpm --filter @visionset/app dev &
pids+=($!)

say "API http://127.0.0.1:$api_port   app http://localhost:5173   (Ctrl+C stops everything)"
# Vite alone: the watchers are scaffolding around it (and macOS bash 3.2 has no `wait -n`).
wait "${pids[2]}"
