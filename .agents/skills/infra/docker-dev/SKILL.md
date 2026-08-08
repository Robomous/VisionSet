---
name: docker-dev
description: >
  Docker Compose local development environment (dev-only — the release artifact is always the
  pip package). Start services, read logs, use optional profiles, troubleshoot.
  Trigger: When starting, stopping, or debugging the Docker development environment.
license: Apache-2.0
metadata:
  author: robomous
  version: "1.0"
  scope: [root, infra]
  auto_invoke: "Starting or debugging the Docker development environment"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, WebFetch, WebSearch, Task
---

## Dev-only, by design

`docker/compose.yaml` exists to run the stack locally. It is **never** the release artifact —
VisionSet ships as `pip install visionset`. Do not add production concerns (multi-stage release
images, registries, orchestration manifests) to it, and never make the Python package depend on
Docker being present.

## Start services

```bash
docker compose -f docker/compose.yaml up --remove-orphans
```

The app is at **http://localhost:8080**. That is the only address anyone needs, and it needs no
token — the server signs the browser in itself (`VISIONSET_UI_SESSION: always`).

Default services:

| Service | What | Port |
| --- | --- | --- |
| `nginx` | The front door: `/api/` → api, everything else → vite | **8080** |
| `api` | `docker/api-dev.sh` — creates the workspace on first boot, then uvicorn `--reload` | 8000 |
| `app` | `docker/app-dev.sh` — builds annotator + ui-core, watches both, then vite | 5173 |

All three publish on **127.0.0.1 only**, because the API signs in whoever asks. 8000 and 5173 are
debugging doors, not the front one.

Optional profiles (off unless requested):

```bash
docker compose -f docker/compose.yaml --profile postgres up
docker compose -f docker/compose.yaml --profile minio up      # console on 9001
```

## What is mounted, and what reloads

**Only what a running service reads is mounted.** The checkout as a whole is not; a path missing
from this table does not exist inside these containers, and adding one is a line in
`docker/compose.yaml`.

| Service | Mounts |
| --- | --- |
| `api` | `../src` → `/workspace/src`, `../docker` → `/workspace/docker` (ro), `${VISIONSET_DATA:-../workspace-data}` → `/data` |
| `app` | `../frontend` → `/workspace/frontend`, `../package.json`, `../pnpm-workspace.yaml`, `../docker` (ro), plus a named volume per `frontend/*/node_modules` |
| `nginx` | `./nginx.conf` → `/etc/nginx/nginx.conf` (ro) |

Everything else the containers show under `/workspace` — `pyproject.toml`, `uv.lock`, `VERSION`,
`pnpm-lock.yaml`, the root `node_modules/` — is the **image's own copy**, put there at build time
and not connected to the host. Editing one of those on the host changes nothing until a `build`.

**Every layer of source reloads in a running stack.** No restart, no rebuild:

| Edit under | Reaches the browser by |
| --- | --- |
| `src/visionset/` | uvicorn `--reload`, scoped to `/workspace/src` |
| `frontend/app/src/` | vite HMR |
| `frontend/ui-core/src/` | `tsc --watch` rewrites `dist/`, vite picks it up |
| `frontend/annotator/src/` | the same, its own watcher |

The two watchers are `pnpm --filter … --parallel run build --watch` in `docker/app-dev.sh`,
started after a blocking one-shot build — the one-shot is what guarantees `dist/` exists before
vite resolves either package, since a watcher's first pass is asynchronous and vite would
otherwise sometimes lose the race with `Failed to resolve entry for package`. Their output is
prefixed `frontend/annotator build:` and `frontend/ui-core build:` in `logs app`.

**The residual cases that still need a restart or a rebuild**, all of them changes to how a
container is *built* rather than to what it runs:

| Changed | Needed |
| --- | --- |
| a Python dependency | `build` |
| a frontend dependency | `build`, then `down -v` (see the gotcha below) |
| `api.Dockerfile` / `app.Dockerfile` | `build` |
| `docker/nginx.conf` | `up --force-recreate nginx` — read once at start |
| `api-dev.sh` / `app-dev.sh` | `restart api` / `restart app` — read once at start |

## After starting

1. Read the logs and confirm there are no errors.
2. If there is an error, stop the services and investigate before continuing.
3. Summarize the error — do not report the stack as "up" while a service is crash-looping.

## Common commands

```bash
docker compose -f docker/compose.yaml up -d --remove-orphans   # background
docker compose -f docker/compose.yaml down                     # stop
docker compose -f docker/compose.yaml down -v                  # stop + drop volumes
docker compose -f docker/compose.yaml logs -f                  # all logs
docker compose -f docker/compose.yaml logs -f api              # one service
docker compose -f docker/compose.yaml up --build api           # rebuild one service
docker compose -f docker/compose.yaml restart app              # after editing an entry script
```

No `uv run` inside the container: the venv is already on `PATH`, and `uv run` would re-check the
environment on every call — the work the image build exists to have already done.

**`docker compose exec api pytest` no longer runs anything, and says so quietly.** `tests/` is not
one of the things a running API reads, so it is not mounted; pytest finds no `testpaths`, collects
nothing and exits **5**, which scrolls past looking like a pass. Run the suite on the host —
`bash scripts/check.sh python` — or, to run it *inside the image*, mount the tree explicitly, which
is exactly what CI's `dev image` job does:

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace visionset-api \
  pytest tests/kernel/test_video_processor.py -q
```

## Gotchas

- **Nothing installs at run time.** Every Python and npm package is installed at *build* time by
  `docker/api.Dockerfile` and `docker/app.Dockerfile`; both entrypoints deliberately contain no
  `pnpm install` and no `uv sync`. If one ever grows an install, the build has stopped doing its
  job. A slow first `up` is a build, not a hang.
- **After changing a frontend dependency, `build` alone is not enough — you also need `down -v`.**
  `frontend/*/node_modules` lives in named volumes (`app-annotator-modules`, `app-ui-core-modules`,
  `app-app-modules`), and Docker seeds a volume only when it is **new**, so a rebuilt image cannot
  reach one that already has contents. The *root* `node_modules/` needs no volume any more — it is
  no longer under a bind mount, so it is simply the image's own directory and a `build` refreshes
  it. That is why the two states can disagree, and why `down -v` is the answer rather than a
  puzzle.

  ```bash
  docker compose -f docker/compose.yaml build
  docker compose -f docker/compose.yaml down -v
  docker compose -f docker/compose.yaml up
  ```

  The symptom is a compiler error naming a package that *is* in `package.json` — e.g.
  `error TS2688: Cannot find type definition file for 'node'`, which kills the `app` container at
  exit 2 and leaves nginx with no upstream. CI cannot catch this class of failure: it always
  installs `--frozen-lockfile` into an empty tree. Run `pnpm install` on the host too, because the
  same staleness hits a developer checkout.
- After changing a *Python* dependency, plain `build` is enough — the api service has no volume
  holding an installed thing.
- **`frontend/*/dist` is written by root**, because the `app` container runs as root and `dist/`
  is inside a bind mount. The stack has always done this; the watch builds only make it happen
  more often. The symptom is a host-side `pnpm -r build` failing with a wall of
  `error TS5033: … EACCES: permission denied`. Hand ownership back without needing `sudo`:

  ```bash
  docker run --rm -v "$PWD/frontend:/f" alpine:3 \
    chown -R "$(id -u):$(id -g)" /f/annotator/dist /f/ui-core/dist
  ```
- The api venv is baked into the image at `/opt/venv`, deliberately outside `/workspace`, so the
  host `.venv` neither clobbers it nor is clobbered by it — and the host `.venv` is not mounted at
  all any more.
- `api` reaches the *code* through `PYTHONPATH=/workspace/src` and its *metadata* through an
  editable install whose `.dist-info` lives in `/opt/venv` (#437). Both are needed and they are
  different things: the first is what `--reload` makes meaningful, the second is what makes
  `GET /formats` list exporters and `/health` report the real version rather than the `0.0.0`
  sentinel. `curl localhost:8080/api/health` is the one-second check that the second half is
  intact.
- Compose is not required for development: `uv run uvicorn ...` and
  `pnpm --filter @visionset/app dev` on the host work fine and are still faster — the mounts poll
  for changes rather than being told about them.
