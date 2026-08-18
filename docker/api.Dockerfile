# The dev stack's Python image. Everything third-party is resolved, downloaded and
# installed here, so `docker compose up` starts a server instead of building one.
#
# Dev only, and never the release artifact — that is `pip install visionset`, built
# by scripts/build_dist.sh, and it does not involve this file. Nothing here is a
# deployment image: the source arrives by bind mount at run time and uvicorn runs
# with --reload.
# Trixie rather than bookworm, and the reason is the apt line below: bookworm's
# ffmpeg is 5.1, which is old enough to decode this project's own test clips
# differently. Trixie's is 7.1, one major above the 6.1 that CI and an Ubuntu
# workstation run. Same Python 3.12, so nothing else about this image moves.
#
# Read those numbers off `ffmpeg -version`, never off the package version. Debian
# and Ubuntu both ship ffmpeg with an **epoch** of 7, so noble's `7:6.1.1-3ubuntu5`
# is 6.1.1 and trixie's `7:7.1.5-0+deb13u1` is 7.1.5 — the leading `7:` is the same
# number in both and means nothing about either. Misreading it is what had #444
# filed against an ffmpeg version difference that did not exist.
FROM ghcr.io/astral-sh/uv:python3.12-trixie-slim

# ffmpeg is a binary, not a Python dependency, so `uv sync` below structurally
# cannot bring it: pyproject.toml declares it nowhere and could not. The API
# decodes video out of process — `ffprobe` when a video source is registered,
# `ffmpeg` when frames are extracted — and `FfmpegVideoProcessor` looks for both
# per call rather than at import. That is why an image without them starts, serves
# and ingests stills perfectly well, and answers 500 MEDIA_TOOL_UNAVAILABLE the
# first time somebody uploads a clip.
#
# The Debian package ships `ffmpeg` and `ffprobe` together, and the flags match
# the CI `python` job and the adapter's own install hint, so there is one spelling
# of how ffmpeg is installed on Debian rather than three.
#
# The version is not incidental — see the FROM above. Measured on 5.1 (bookworm):
# `-display_rotation`, which the rotation fixtures use, does not exist before 6.0,
# and a truncated clip is reported as unsupported rather than corrupt, which is
# the distinction `IngestFailureKind` exists to make. The CI `docker` job runs
# tests/kernel/test_video_processor.py inside this image so that a base-image
# change cannot quietly reintroduce either.
#
# Ahead of the dependency manifests below on purpose: those change often, this
# does not, so a dependency edit re-runs `uv sync` and leaves apt alone.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# The venv lives outside /workspace, which the bind mount replaces wholesale at run
# time. A venv under the mount point would be shadowed by the host checkout and
# have to be rebuilt on every boot — which is the thing this file exists to stop.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PATH=/opt/venv/bin:$PATH

WORKDIR /workspace

# Only the two files that decide what gets installed, so that editing the source
# does not invalidate the expensive layer below. The project itself is installed
# afterwards, in its own cheap layer.
COPY pyproject.toml uv.lock ./

# `--frozen` so the lockfile is honoured rather than re-resolved: a build that
# quietly picks up something uv.lock does not name is a build that disagrees with
# CI. `--no-install-project` because visionset itself is not a dependency — it is
# the thing being edited. It gets installed on its own terms two layers down, and
# separately so that a source edit re-runs that step and not this one.
#
# The dev group is included on purpose: this is the image
# `docker compose exec api pytest` runs in.
#
# The cache mount keeps uv's downloads between builds, so changing one dependency
# re-downloads one dependency.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project

# Which *code* runs: the bind-mounted checkout, ahead of anything site-packages
# holds. This is the line that keeps --reload meaningful, and it is why the install
# below cannot bake a stale copy of the source into the image.
ENV PYTHONPATH=/workspace/src

# And which *metadata* describes it. These are two separate things, and treating
# them as one is what broke this image: PYTHONPATH alone makes `visionset`
# importable while installing no `.dist-info` at all, so `importlib.metadata` sees
# no distribution named visionset. Both of the things that live in that directory
# then vanish together, silently and with no error anywhere:
#
#   * `[project.entry-points."visionset.formats"]` — so `formats.registry`
#     discovers zero exporters and `GET /formats` answers an honest `{"items": []}`.
#     The export dialog's Format list is empty and nothing can be exported.
#   * the version — so `visionset.__version__` falls back to its "0.0.0" sentinel,
#     which `ReleaseService.publish` then *writes into* every release published
#     here.
#
# The fix is metadata, not source. `--no-deps` because `uv sync` above already
# installed every dependency from the lockfile and this must not re-resolve; `-e`
# so the record points at the source rather than copying it. Its recorded location
# is `/workspace/src`, which is exactly where docker/compose.yaml's `..:/workspace`
# puts the checkout — the earlier worry about a build-time path only "coincidentally"
# matching the run-time one is answered by that mount being the contract. And the
# metadata that actually matters here is path-independent regardless: the entry
# points and the version are read out of `.dist-info`, which lives in /opt/venv,
# outside the mount, so they survive being mounted somewhere else entirely.
#
# The source copied here is shadowed by the bind mount at run time and is never
# what executes; it exists so hatchling has something to build a record from.
# VERSION and README.md come along because pyproject.toml reads the version out of
# the first and declares the second as its readme.
COPY VERSION README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --no-deps -e .

# Who this container runs as, and it is whoever ran `docker compose` rather than
# root. Every path under /workspace arrives on a bind mount, so a root process here
# writes root-owned files into somebody's checkout — a `__pycache__` beside every
# module uvicorn imports, and the workspace under /data — which the person who
# started the stack then cannot rebuild over or delete without sudo.
#
# **Why this block is at the very end here and in the middle of the two node
# images.** Nothing in a Python image is written at run time: the venv is at
# /opt/venv, outside the mount, and UV_COMPILE_BYTECODE above has already written
# every .pyc there is. So ownership costs two cheap layers at the bottom, and
# changing the uid re-runs neither apt nor `uv sync`. The node images are the
# opposite case — their watch builds and their caches write *into* directories the
# install created — so there the chown has to join the install's own RUN or a
# second layer duplicates the whole tree. docker/app.Dockerfile says it from that
# side.
#
# /opt/venv is deliberately left root-owned. Nothing at run time writes to the
# environment, and leaving it unwritable is how this file says so.
#
# `-o` on both permits a duplicate id, because a host uid or gid may collide with
# one the base image already ships. Refusing to build over that would fail for the
# developer who has such an id while protecting nothing.
ARG VISIONSET_UID=1000
ARG VISIONSET_GID=1000
RUN groupadd -o -g "${VISIONSET_GID}" visionset \
    && useradd -o -u "${VISIONSET_UID}" -g "${VISIONSET_GID}" \
         -m -d /home/visionset -s /bin/sh visionset \
    && chown -R "${VISIONSET_UID}:${VISIONSET_GID}" /workspace

# A uid with no passwd entry is given HOME=/, which it cannot write, and what
# breaks then names a cache rather than a home directory. `useradd -m` above makes
# the entry; this makes the value independent of how it gets resolved.
ENV HOME=/home/visionset

USER visionset

CMD ["sh", "/workspace/docker/api-dev.sh"]
