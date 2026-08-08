#!/bin/sh
# Start the Vite dev server for the compose dev stack, with the two libraries it
# consumes rebuilding as they are edited.
#
# No install. Every npm package was resolved, downloaded and linked into the image
# by docker/app.Dockerfile; if this script ever grows a `pnpm install`, the build
# has stopped doing its job. Compiling this repository's *own* packages is the one
# kind of work that is allowed to happen here.
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
# Kept as a blocking one-shot rather than folded into the watchers below, and that
# is the whole reason it is still here: a watcher's first pass is asynchronous, so
# handing vite the job of racing it would reintroduce exactly that error on a cold
# start, intermittently. This line is the guarantee that `dist/` exists — in both
# packages, in dependency order — before anything resolves them.
#
# The app itself is deliberately NOT built: `@visionset/app`'s build is
# `tsc --noEmit && vite build`, which produces the production bundle that ships
# inside the wheel. Nothing in development reads it, and requiring it is the
# thing this stack exists to avoid.
echo "app-dev: building @visionset/annotator and @visionset/ui-core"
pnpm --filter @visionset/annotator --filter @visionset/ui-core build

# And now the same two builds again, watching. Without this the stack has a hole
# a person falls into once and remembers forever: an edit under
# `frontend/ui-core/src` or `frontend/annotator/src` changes nothing in the
# browser, because vite resolves both packages through a `dist/` that was built
# once, above, and never again. Vite's own watcher then picks the rebuilt `dist/`
# up and reloads, so the chain from keystroke to browser closes without a restart.
#
# `--parallel` because the two are independent once their first build exists, and
# because pnpm prefixes each line with the package it came from — which is what
# makes the `app` service's log readable with three things writing to it.
#
# The polling flags are the tsc spelling of CHOKIDAR_USEPOLLING in
# docker/compose.yaml, and are there for the same reason: a bind mount delivers no
# inotify events across the host boundary on macOS or Windows, and a watcher that
# receives none is silent rather than broken-looking.
#
# `--preserveWatchOutput` because tsc's default is to clear the screen on every
# rebuild, which in `docker compose logs` deletes the api's output instead.
echo "app-dev: starting watch builds for annotator + ui-core"
pnpm --filter @visionset/annotator --filter @visionset/ui-core --parallel run build \
  --watch \
  --preserveWatchOutput \
  --watchFile dynamicPriorityPolling \
  --watchDirectory dynamicPriorityPolling &
WATCH_PID=$!

# vite in the background rather than `exec`, so that this shell stays PID 1 and
# keeps a signal handler. `exec` would replace it, discarding the trap below and
# leaving the watchers with nothing to stop them but the container's own teardown.
#
# `--host 0.0.0.0` so the published port reaches it from outside the container.
pnpm --filter @visionset/app dev --host 0.0.0.0 &
VITE_PID=$!

# Everything running in this container except this shell — which is exactly the
# set this script is answerable for, because a container starts with one process
# and everything else in this one descends from the two lines above. (A
# `docker compose exec` session would be caught too, and that is right: `down`
# ends it either way.) Sets `LIVE` rather than printing, because a command
# substitution would fork a subshell that then appears in its own answer, and the
# list could never come back empty.
#
# `/proc` rather than `ps`, which this image does not ship, and the `State:` read
# rather than `kill -0`, which a **zombie** also answers yes to: a killed child
# stays in the table until it is reaped, so a liveness check built on `kill -0`
# reports the dead as survivors and every stop would escalate to SIGKILL for
# nothing.
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

# Cleanup that can report its own failure. Nothing here is redirected to
# /dev/null: a `kill` that finds nothing, or is handed no argument at all, has to
# be able to say so — a silent one is indistinguishable from a successful one,
# and that is how a watcher survives a stop nobody notices.
shutdown() {
  trap - INT TERM
  echo "app-dev: stopping vite ($VITE_PID) and the watch builds ($WATCH_PID)"

  # SIGTERM to every process rather than to the two pids this script holds, and
  # that is not belt and braces. Measured in this image: `pnpm --parallel run`
  # **ignores SIGTERM outright** — still running thirty seconds later — while the
  # two `tsc --watch` processes underneath it exit on the same signal in under a
  # tenth of a second, and pnpm then leaves of its own accord once its children
  # have. Signalling only what `$!` gave us would therefore leave both watchers
  # compiling, which is the exact orphan this exists to prevent.
  live_pids
  if [ -n "$LIVE" ]; then
    kill $LIVE || echo "app-dev: SIGTERM reported a failure above" >&2
  fi

  # "I ran kill" is not "they are gone". Poll for up to five seconds, then name
  # whatever outlived SIGTERM and use the signal that cannot be ignored.
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

  # Reap, so the final count is about processes rather than about table entries,
  # and then say what is left. This line is the one worth reading in the log.
  # `|| true` because a child that was signalled exits non-zero by definition,
  # and `set -e` would take that as a reason to abandon the rest of the shutdown.
  wait || true
  live_pids
  if [ -n "$LIVE" ]; then
    echo "app-dev: WARNING — these survived everything: $LIVE" >&2
  else
    echo "app-dev: vite and both watch builds are gone"
  fi
}
trap 'shutdown; exit 0' INT TERM

# `wait` on vite alone, because vite is what this service *is*: the watchers are
# scaffolding around it. A trapped signal interrupts this wait, which is what
# gives `docker compose down` a fast, tidy exit instead of a ten-second timeout
# and a SIGKILL.
status=0
wait "$VITE_PID" || status=$?
shutdown
exit "$status"
