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

If `postgres` exits 1 before printing a single server line, and the message names
`pg_ctlcluster` and a major-version directory, the volume was written by an older major
version. Postgres 18 keeps its cluster under `/var/lib/postgresql/18/` and will not adopt
one left by 16. `docker volume rm visionset_postgres-data` clears it; nothing reads this
service, so there is nothing in there to keep.

## The three ways to run it

The stack has three permanent, mutually compatible configurations. They differ in one
thing — which api image is built — and the difference is visible in exactly one
feature, the suggestion a click asks a model for:

```bash
docker compose -f docker/compose.yaml up                                                # 1. base
docker compose -f docker/compose.yaml -f docker/compose.gpu.yaml up --build             # 2. GPU inference
docker compose -f docker/compose.yaml -f docker/compose.cpu-inference.yaml up --build   # 3. CPU inference
```

| | api image | A suggestion | Needs on the host |
| --- | --- | --- | --- |
| **base** | `docker/api.Dockerfile` | refused, naming the install command | Docker |
| **GPU** | `docker/api-gpu.Dockerfile` | milliseconds | Docker, an NVIDIA card, the Container Toolkit |
| **CPU inference** | `docker/api-cpu-inference.Dockerfile` | seconds | Docker |

**Which to use.** The base stack does everything VisionSet does except propose a shape
from a click: its image does not carry the `local-inference` runtime, so a suggestion is
refused with the command that would install it. That refusal is correct there and is
worth keeping intact — it is the behaviour every base install has. Reach for the **GPU**
stack when the suggestion loop is what you are working on and you want it to feel
instant. Reach for **CPU inference** when the host has no NVIDIA card, or has one that is
not usable today, and you want to try or demonstrate the flow anyway: same models, same
code path, seconds per click instead of milliseconds.

**They are compatible, and switching between them costs nothing but a build.** All three
mount the same `workspace-data/`, so projects, connections and already-downloaded weights
are still there afterwards. Only the api image changes; no state is converted and nothing
is re-fetched.

**`--build` on every switch, in both directions, between any two of the three.** Each
mode is a different api image built from a different Dockerfile, and without `--build`
Compose reuses whichever image it already has under that name. The symptom is a stack
behaving like the mode you just left: suggestions refused in a mode that has the runtime,
or a device reservation held over an image that cannot use it.

**A hand-installed package inside a running container is not a fourth mode.** Installing
torch with `pip` in a live `api` container appears to work and does not survive: the next
`build` replaces the image and the install is gone, with no trace of why. These two
overlay files are the durable path — and see the dual-Python trap below, which is the
other half of why the hand-typed version so often does not work even before the rebuild.

### Why an override file rather than a profile

A second `-f`, not `--profile gpu` or `--profile inference`, and the distinction is worth
holding on to when adding the next optional thing. **`profiles:` selects whole services**
— a profiled service joins the run or is absent from it. It cannot amend a service that is
already present, so the nearest profile-shaped attempt (an `api-gpu` beside `api`) starts
*both* and they collide on 127.0.0.1:8000. `postgres` and `minio` are profiles because
they are genuinely extra services; a GPU, or a runtime inside an image, is a property of a
service that already exists, and merging a second file is Compose's mechanism for that.

### What each inference image does, and the traps in them

- **The GPU stack needs the NVIDIA Container Toolkit on the host** — that is what teaches
  Docker the `nvidia` device driver and injects the driver libraries and `nvidia-smi` into
  the container. Install it from
  [NVIDIA's instructions](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html);
  the steps are per-distribution and are not worth a stale copy here.
  `docker info --format '{{json .Runtimes}}'` naming an `nvidia` runtime is the check.
  Without it, `up` fails at container creation with `could not select device driver
  "nvidia" with capabilities: [[gpu]]` — and the other two configurations still work.
- **A GPU stack that worked yesterday and today dies at container creation with
  `failed to fulfil mount request: open /usr/lib/x86_64-linux-gnu/libnvidia-*.so.<version>:
  no such file or directory` is a host whose NVIDIA driver was updated under it.** The
  toolkit is still injecting the file list it discovered before the update, and some of
  those files are gone. `nvidia-smi` on the host answers perfectly while this is true, so
  it is not the check that catches it. Reboot the host. Nothing in this stack is involved,
  nothing here fixes it, and the other two configurations are unaffected.
- **The GPU image starts from `pytorch/pytorch`, and does not install torch from the
  lockfile.** Installing the `local-inference` extra from `uv.lock` means ~4 GB of
  `nvidia-*` wheels resolved and unpacked on every cache miss; the pinned base
  already contains them, and its `torch==2.13.0` on cu13 is the version uv.lock
  resolves to anyway. Two consequences: the three remaining packages are requested by
  the floors written in `pyproject.toml`'s extra rather than read from the lock, **so
  those floors have to stay in step with it**; and the image has no venv, because uv
  does not count a venv's inherited system site-packages as installed and would
  reinstall torch and every CUDA wheel beside it.
- **The CPU-inference image is `docker/api.Dockerfile` with one install step added**, on
  the same trixie base, so it inherits the same venv at `/opt/venv` and the same ffmpeg
  7.1. The five packages come from `https://download.pytorch.org/whl/cpu` at the versions
  `uv.lock` resolves — that index publishes torch built without CUDA, ~250 MB instead of
  ~2 GB — and **those pins have to stay in step with the lock**, exactly as the GPU
  image's floors do.
- **The dual-Python trap, which is why that install names an interpreter.** Both api
  images built on the trixie base hold two interpreters: `/usr/local/bin/python`, the base
  image's own, and `/opt/venv/bin/python`, which is what PATH resolves and therefore the
  only one that ever serves a request — `docker/api-dev.sh` boots the server with `exec
  uvicorn`, whose shebang is `#!/opt/venv/bin/python`. An install landing in `/usr/local`
  succeeds loudly and changes nothing the server can see. Both natural spellings land
  there: `uv pip install --system` means that interpreter by definition, and the venv has
  no `pip` of its own, so a hand-typed `pip install` in a running container resolves to
  `/usr/local/bin/pip` while `python` on the next line is still the venv's and still
  cannot see the result. `docker/api-cpu-inference.Dockerfile` reads the interpreter out
  of uvicorn's shebang and fails the build if it is not the one it installs into; when
  checking by hand, `python -c "import sys, torch; print(sys.executable, …)"` is the
  spelling that cannot lie to you.

Verify inside the running container — the interpreter first, because it is the one that
answers:

```bash
# CPU inference: the server's own python, and a version ending in +cpu
docker compose -f docker/compose.yaml -f docker/compose.cpu-inference.yaml exec api \
  python -c "import sys, torch; print(sys.executable, torch.__version__)"

# GPU: the card, then the runtime that can reach it
docker compose -f docker/compose.yaml -f docker/compose.gpu.yaml exec api nvidia-smi
docker compose -f docker/compose.yaml -f docker/compose.gpu.yaml exec api \
  python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Dev only, like the rest of this file. Nothing here reaches the wheel: the release
artifact is `pip install "visionset[local-inference]"` and it involves no Docker.

## What is mounted, and what reloads

**Only what a running service reads is mounted.** The checkout as a whole is not; a path missing
from this table does not exist inside these containers, and adding one is a line in
`docker/compose.yaml`.

| Service | Mounts |
| --- | --- |
| `api` | `../src` → `/workspace/src`, `../docker` → `/workspace/docker` (ro), `${VISIONSET_DATA:-../workspace-data}` → `/data` |
| `app` | `../frontend/{annotator,ui-core,app}/src`, `../frontend/app/public`, `../docker` (ro) |
| `nginx` | `./nginx.conf` → `/etc/nginx/nginx.conf` (ro) |

Everything else the containers show under `/workspace` — `pyproject.toml`, `uv.lock`, `VERSION`,
`pnpm-lock.yaml`, every `package.json`, the tsconfigs, `vite.config.ts`, `index.html`, and **every
`node_modules/`** — is the **image's own copy**, put there at build time and not connected to the
host. Editing one of those on the host changes nothing until a `build`.

**The `app` service mounts source directories, never package roots, and that is load-bearing.**
pnpm puts a `node_modules/` inside every workspace package, so mounting `../frontend` buries all
three installs. That used to be patched with a named volume per package — the wrong tool, because
Docker seeds a named volume only when it is **new**, so the first `up` filled them and every later
`build` was invisible. Mounting `src/` means no `node_modules` comes from the host or from a
volume at all, so a `build` reaches every installed thing. See the gotchas.

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
| a dependency, either language | `build` |
| a `package.json`, a tsconfig, `vite.config.ts`, `index.html` | `build` — baked into the app image |
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
- **After changing a dependency in either language, plain `build` is enough.** No service keeps an
  installed thing in a volume, and no `node_modules` is mounted from anywhere.

  This is worth knowing because it was false twice, and the failure it produced reads as a broken
  checkout rather than a stale mount: **a compiler error naming a package that is plainly in
  `package.json`**, killing the `app` container at exit 2 and leaving nginx with no upstream and
  `localhost:8080` serving 502. It happened with `error TS2688: Cannot find type definition file
  for 'node'` (`@types/node`) and again with `error TS2307: Cannot find module
  'lucide-react'` (after a minor version bump of it). Both times the cause was the same: the
  per-package `node_modules` volumes still held symlinks into a virtual-store path — literally
  `../../../node_modules/.pnpm/lucide-react@1.28.0_react@19.2.8/…` — that the rebuilt image no
  longer had. `down -v` was the remedy; mounting `src/` instead of the package roots removed the
  cause.

  **CI structurally cannot catch this class**, which is why it kept reaching developers: every job
  installs `--frozen-lockfile` into an empty tree, so a stale install is a state CI never has. A
  host checkout has the same exposure by a different route — run `pnpm install` after pulling a
  dependency change.

  One-time cleanup on a machine that ran the old stack, since compose no longer declares them:

  ```bash
  docker volume rm visionset_app-annotator-modules visionset_app-ui-core-modules \
                   visionset_app-app-modules
  ```
- **`frontend/{annotator,ui-core}/dist` is built inside the container**, not into the checkout —
  the two `tsc --watch` builds write nowhere on the host. A `dist/` in your checkout came from a
  host-side `pnpm -r build`, and the two no longer interfere.
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
  editable install whose `.dist-info` lives in `/opt/venv`. Both are needed and they are
  different things: the first is what `--reload` makes meaningful, the second is what makes
  `GET /formats` list exporters and `/health` report the real version rather than the `0.0.0`
  sentinel. `curl localhost:8080/api/health` is the one-second check that the second half is
  intact.
- Compose is not required for development: `uv run uvicorn ...` and
  `pnpm --filter @visionset/app dev` on the host work fine and are still faster — the mounts poll
  for changes rather than being told about them.
