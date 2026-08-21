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

`docker/compose.yaml` runs the stack locally. It is **never** the release artifact — VisionSet
ships as `pip install visionset`. No production concerns (release images, registries,
orchestration), and the Python package never depends on Docker being present.

## Start services

```bash
docker compose -f docker/compose.yaml up --remove-orphans
```

The app is at **http://localhost:8080** — the only address anyone needs, no token: the server
signs the browser in itself (`VISIONSET_UI_SESSION: always`).

| Service | What | Port |
| --- | --- | --- |
| `nginx` | The front door: `/api/` → api, everything else → vite | **8080** |
| `api` | `docker/api-dev.sh` — creates the workspace on first boot, then uvicorn `--reload` | 8000 |
| `app` | `docker/app-dev.sh` — builds annotator + ui-core, watches both, then vite | 5173 |

All three publish on **127.0.0.1 only**, because the API signs in whoever asks.

Optional profiles (off unless requested): `--profile postgres`, `--profile minio` (console on
9001). A `postgres` that exits 1 naming `pg_ctlcluster` and a major-version directory found a
volume written by an older major; `docker volume rm visionset_postgres-data` clears it — nothing
reads this service.

## The three ways to run it

Three permanent, mutually compatible configurations, differing only in which api image is built
— visible in exactly one feature, the model suggestion a click asks for:

```bash
docker compose -f docker/compose.yaml up                                                # base
docker compose -f docker/compose.yaml -f docker/compose.gpu.yaml up --build             # GPU
docker compose -f docker/compose.yaml -f docker/compose.cpu-inference.yaml up --build   # CPU inference
```

| | api image | A suggestion | Needs on the host |
| --- | --- | --- | --- |
| **base** | `docker/api.Dockerfile` | refused, naming the install command | Docker |
| **GPU** | `docker/api-gpu.Dockerfile` | milliseconds | Docker, NVIDIA card, Container Toolkit |
| **CPU inference** | `docker/api-cpu-inference.Dockerfile` | seconds | Docker |

The base refusal is correct behavior — it is what every base install answers. All three mount
the same `workspace-data/`, so switching costs nothing but a build. **`--build` on every switch,
in both directions**: without it Compose reuses whichever image it has under that name, and the
stack behaves like the mode you just left. A hand-installed package inside a running container is
not a fourth mode — the next `build` erases it.

**Override files, not profiles, and the distinction matters for the next optional thing:**
`profiles:` selects whole services and cannot amend one that is already present (an `api-gpu`
beside `api` collides on 127.0.0.1:8000); a second `-f` merges properties into an existing
service. `postgres`/`minio` are profiles because they are genuinely extra services.

### Inference-image traps

- **GPU needs the NVIDIA Container Toolkit** — `docker info --format '{{json .Runtimes}}'`
  naming `nvidia` is the check; without it `up` fails at container creation on
  `could not select device driver "nvidia"`.
- **A GPU stack that dies at creation on `failed to fulfil mount request: open
  /usr/lib/.../libnvidia-*.so.<version>`** is a host whose NVIDIA driver updated underneath the
  toolkit's cached file list. Host `nvidia-smi` still answers fine. Reboot the host; nothing in
  this stack is involved.
- **The GPU image starts from `pytorch/pytorch` and does not install torch from the lockfile**
  (the base already carries the ~4 GB of CUDA wheels at the version uv.lock resolves). The
  remaining packages come from the floors in `pyproject.toml`'s extra, **which must stay in step
  with the lock** — and the image has no venv, since uv would not count inherited system
  site-packages and would reinstall everything.
- **The CPU-inference image** is `api.Dockerfile` plus one install from
  `https://download.pytorch.org/whl/cpu` at the versions `uv.lock` resolves (torch without CUDA,
  ~250 MB) — **those pins stay in step with the lock too**.
- **The dual-Python trap.** Both api images hold two interpreters; only `/opt/venv/bin/python`
  ever serves a request (uvicorn's shebang). `uv pip install --system` and a hand-typed
  `pip install` both land in `/usr/local` — loudly successful, invisible to the server. Checking
  by hand, `python -c "import sys, torch; print(sys.executable, torch.__version__)"` inside the
  container is the spelling that cannot lie (CPU inference prints a version ending `+cpu`; GPU:
  `nvidia-smi`, then `torch.cuda.is_available()`).

## What is mounted, and what reloads

**Only what a running service reads is mounted.** A path missing from this table does not exist
inside these containers.

| Service | Mounts |
| --- | --- |
| `api` | `../src` → `/workspace/src`, `../docker` (ro), `${VISIONSET_DATA:-../workspace-data}` → `/data` |
| `app` | `../frontend/{annotator,ui-core,app}/src`, `../frontend/app/public`, `../docker` (ro) |
| `docs` | `../docs/content` (ro), `../docs/src`, `../docs/public` (ro), `../docker` (ro) |
| `nginx` | `./nginx.conf` (ro) |

Everything else under `/workspace` — manifests, lockfiles, tsconfigs, **every `node_modules/`**
— is the image's own copy; editing it on the host changes nothing until a `build`. The `app`
service mounts **source directories, never package roots**, which is load-bearing: mounting a
package root would bury the image's `node_modules`, and the named-volume workaround that
preceded this seeded once and went stale on every later build.

Every layer of source reloads in a running stack (no restart, no rebuild): `src/visionset/` via
uvicorn `--reload`; `frontend/app/src/` via vite HMR; `frontend/{ui-core,annotator}/src/` via
`tsc --watch` rewriting `dist/` (a blocking one-shot build runs first so vite never races an
empty `dist/`). What still needs action: a dependency or manifest/tsconfig change → `build`;
`docker/nginx.conf` → `up --force-recreate nginx`; `api-dev.sh`/`app-dev.sh` → `restart`.

## After starting

Read the logs and confirm there are no errors; if a service is crash-looping, stop and
investigate — never report the stack as "up" while it is.

## Common commands

```bash
docker compose -f docker/compose.yaml up -d --remove-orphans   # background
docker compose -f docker/compose.yaml down                     # stop  (-v drops volumes)
docker compose -f docker/compose.yaml logs -f api              # one service's logs
docker compose -f docker/compose.yaml up --build api           # rebuild one service
docker compose -f docker/compose.yaml restart app              # after editing an entry script
```

No `uv run` inside the container — the venv is already on PATH.

**`docker compose exec api pytest` runs nothing and exits 5**, which scrolls past looking like a
pass: `tests/` is not mounted. Run the suite on the host, or mount the tree explicitly
(`docker run --rm -v "$PWD:/workspace" -w /workspace visionset-api pytest …`), which is what
CI's dev-image job does.

## Gotchas

- **Nothing installs at run time** — both entrypoints deliberately contain no `pnpm install` and
  no `uv sync`; a slow first `up` is a build, not a hang. After a dependency change, plain
  `build` is enough. A compiler error naming a package that is plainly in `package.json`
  (`TS2688` on `@types/node`, `TS2307` on a bumped package) is a stale install, not a broken
  checkout — `down -v` clears it. CI structurally cannot catch this class (every job installs
  into an empty tree), and a host checkout has the same exposure: run `pnpm install` after
  pulling a dependency change.
- **The built services run as you, not as root** — identity `VISIONSET_UID`/`VISIONSET_GID`,
  default 1000, baked into every image, so **changing it needs `--build`**. Not `${UID}`: no
  shell exports it, so the service would run as root while reading as configured. If 1000 is not
  yours: `printf 'VISIONSET_UID=%s\nVISIONSET_GID=%s\n' "$(id -u)" "$(id -g)" > docker/.env`.
  Under rootless Docker set both to `0`; on macOS/Windows leave the defaults. Root-owned files a
  root container leaves behind surface later as `pnpm -r build` dying on `EACCES`,
  `check.sh docs` failing on documents nobody edited, or `git worktree remove` refusing halfway
  through.
- **`workspace-data/` is tracked as an empty directory**, load-bearing: Docker creates a missing
  bind-mount source itself, as root, before any container starts. For the cases that cannot
  cover, `docker/api-dev.sh` refuses at boot and prints the fix.
- The api venv is baked at `/opt/venv`, outside `/workspace`, so the host `.venv` and the image
  never clobber each other. `api` reaches *code* through `PYTHONPATH=/workspace/src` and
  *metadata* through an editable install in `/opt/venv` — both needed: the first makes
  `--reload` meaningful, the second makes `GET /formats` list exporters and `/health` report a
  real version. `curl localhost:8080/api/health` is the one-second check.
- Compose is not required for development: `uv run uvicorn ...` and
  `pnpm --filter @visionset/app dev` on the host are still faster.
