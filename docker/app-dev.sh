#!/bin/sh
# Start the Vite dev server for the compose dev stack, with browser-inference, annotator,
# media and ui-core rebuilding as they are edited. No install: docker/app.Dockerfile already
# did it.
set -eu

# All four libraries are consumed through their `dist/`, so vite cannot resolve them
# from source. A blocking build first, because a watcher's first pass is asynchronous and
# vite would race an empty `dist/`. Topological order matters here (unlike the watch
# below): ui-core imports @visionset/media, so media must build before ui-core does. The
# app itself is not built: nothing in dev reads it.
# browser-inference also has to build before Vite starts: its ORT artifact directory is
# served by frontend/app/vite.config.ts rather than being copied into this source tree.
echo "app-dev: building @visionset/browser-inference, @visionset/annotator, @visionset/media and @visionset/ui-core"
pnpm --filter @visionset/browser-inference --filter @visionset/annotator --filter @visionset/media --filter @visionset/ui-core build

# tsup's watcher is chokidar underneath, so it already honours CHOKIDAR_USEPOLLING from
# compose.yaml — no polling flags to pass here, unlike tsc before #839. Every package's
# regular build uses `clean: true`, which is correct for the blocking build above but
# wrong for a long-lived watcher: Vite may resolve a library between its clean and emit,
# or read browser-inference's ORT directory before its copy script restores it. Watch
# tsup directly with cleaning disabled. The blocking build provides a clean output and
# browser-inference's immutable ORT assets only change when its configuration is rebuilt.
echo "app-dev: starting watch builds for browser-inference + annotator + media + ui-core"
pnpm --filter @visionset/browser-inference --filter @visionset/annotator --filter @visionset/media --filter @visionset/ui-core --parallel exec tsup --watch --clean=false &
WATCH_PID=$!

# Backgrounded rather than `exec`, so this shell stays PID 1 and keeps the trap.
pnpm --filter @visionset/app dev --host 0.0.0.0 &
VITE_PID=$!

# Every live process in the container except this shell. /proc because the image has
# no `ps`; the `State:` read because `kill -0` answers yes for a zombie too.
live_pids() {
  LIVE=""
  for entry in /proc/[0-9]*; do
    pid=${entry#/proc/}
    [ "$pid" != "$$" ] || continue
    [ -r "$entry/status" ] || continue
    state=""
    while read -r key value _rest; do
      if [ "$key" = "State:" ]; then
        state=$value
        break
      fi
    done <"$entry/status"
    [ "$state" != "Z" ] || continue
    [ -n "$state" ] || continue
    LIVE="${LIVE:+$LIVE }$pid"
  done
}

shutdown() {
  trap - INT TERM
  echo "app-dev: stopping vite ($VITE_PID) and the watch builds ($WATCH_PID)"

  # Signal every process, not just the two pids held: `pnpm --parallel run` ignores
  # SIGTERM, while the tsup watchers under it exit on it at once.
  live_pids
  if [ -n "$LIVE" ]; then
    kill $LIVE || echo "app-dev: SIGTERM reported a failure above" >&2
  fi

  i=0
  while [ "$i" -lt 50 ]; do
    live_pids
    [ -n "$LIVE" ] || break
    i=$((i + 1))
    sleep 0.1
  done
  if [ -n "$LIVE" ]; then
    echo "app-dev: still alive after SIGTERM: $LIVE — sending SIGKILL" >&2
    kill -9 $LIVE || echo "app-dev: SIGKILL reported a failure above" >&2
  fi

  # A signalled child exits non-zero; `set -e` must not abandon the shutdown on it.
  wait || true
  live_pids
  if [ -n "$LIVE" ]; then
    echo "app-dev: WARNING — these survived everything: $LIVE" >&2
  else
    echo "app-dev: vite and both watch builds are gone"
  fi
}
trap 'shutdown; exit 0' INT TERM

# Wait on vite alone: the watchers are scaffolding around it.
status=0
wait "$VITE_PID" || status=$?
shutdown
exit "$status"
