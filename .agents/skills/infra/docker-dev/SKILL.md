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
| `app` | `docker/app-dev.sh` — builds annotator + ui-core, then vite | 5173 |

All three publish on **127.0.0.1 only**, because the API signs in whoever asks. 8000 and 5173 are
debugging doors, not the front one.

Optional profiles (off unless requested):

```bash
docker compose -f docker/compose.yaml --profile postgres up
docker compose -f docker/compose.yaml --profile minio up      # console on 9001
```

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
docker compose -f docker/compose.yaml exec api pytest           # run a check inside
```

No `uv run` inside the container: the venv is already on `PATH`, and `uv run` would re-check the
environment on every call — the work the image build exists to have already done.

## Gotchas

- **Nothing installs at run time.** Every Python and npm package is installed at *build* time by
  `docker/api.Dockerfile` and `docker/app.Dockerfile`; both entrypoints deliberately contain no
  `pnpm install` and no `uv sync`. If one ever grows an install, the build has stopped doing its
  job. A slow first `up` is a build, not a hang.
- **After changing a frontend dependency, `build` alone is not enough — you also need `down -v`.**
  `node_modules` lives in named volumes (`app-node-modules`, `app-annotator-modules`,
  `app-ui-core-modules`, `app-app-modules`), and Docker seeds a volume only when it is **new**, so
  a rebuilt image cannot reach one that already has contents.

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
- The repo is bind-mounted at `/workspace`. The api venv is baked into the image at `/opt/venv`,
  deliberately outside the mount, so the host `.venv` neither clobbers it nor is clobbered by it.
- `api` reaches the code through `PYTHONPATH=/workspace/src` rather than an install, so `/health`
  reports `"version":"0.0.0"` — there is no dist-info to read. Expected, not a bug; a real install
  reports the `VERSION` file's value.
- Compose is not required for development: `uv run uvicorn ...` and
  `pnpm --filter @visionset/app dev` on the host work fine and are faster.
