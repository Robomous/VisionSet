# The dev stack's Python image. Everything third-party is resolved, downloaded and
# installed here, so `docker compose up` starts a server instead of building one.
#
# Dev only, and never the release artifact — that is `pip install visionset`, built
# by scripts/build_dist.sh, and it does not involve this file. Nothing here is a
# deployment image: the source arrives by bind mount at run time and uvicorn runs
# with --reload.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

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

# Only the two files that decide what gets installed. Copying the source instead
# would invalidate this layer on every edit, which is the cost being removed — the
# source arrives by bind mount, not by COPY.
COPY pyproject.toml uv.lock ./

# `--frozen` so the lockfile is honoured rather than re-resolved: a build that
# quietly picks up something uv.lock does not name is a build that disagrees with
# CI. `--no-install-project` because visionset itself is not a dependency — it is
# the thing being edited, and it is mounted rather than installed.
#
# The dev group is included on purpose: this is the image
# `docker compose exec api pytest` runs in.
#
# The cache mount keeps uv's downloads between builds, so changing one dependency
# re-downloads one dependency.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project

# The project is reached through PYTHONPATH rather than an editable install. An
# editable install records where the source was *at build time* — a stub here, the
# real checkout at run time — so it is correct only by the two paths coincidentally
# matching. Naming the directory is honest, and it also lets the image be used with
# the source mounted somewhere else.
ENV PYTHONPATH=/workspace/src

# `[project.scripts]` is not installed either, for the same reason, so the console
# script is recreated here against the same target the packaging metadata names.
# Without this `visionset init` in the entrypoint would have nothing to call.
RUN printf '#!/bin/sh\nexec python -c "from visionset.cli.main import app; app()" "$@"\n' \
      > /usr/local/bin/visionset \
    && chmod +x /usr/local/bin/visionset

CMD ["sh", "/workspace/docker/api-dev.sh"]
