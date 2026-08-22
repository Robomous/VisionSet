# The dev stack's Python image. Every dependency is installed here, so `docker compose up`
# starts a server instead of building one. Dev only: the source arrives by bind mount and
# uvicorn runs with --reload.
#
# Trixie, not bookworm: bookworm's ffmpeg is 5.1, which lacks `-display_rotation` and
# misclassifies a truncated clip. Read versions off `ffmpeg -version`, not the package
# version, whose leading `7:` is a Debian epoch.
FROM ghcr.io/astral-sh/uv:python3.12-trixie-slim

# ffmpeg is a binary, not a Python dependency, so `uv sync` cannot bring it. Without it the
# image serves stills fine and answers MEDIA_TOOL_UNAVAILABLE on the first video.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# The venv lives outside /workspace, which the bind mount shadows at run time.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PATH=/opt/venv/bin:$PATH

WORKDIR /workspace

COPY pyproject.toml uv.lock ./

# `--frozen` so the build cannot disagree with CI; `--no-install-project` because the
# project is installed below, in a layer a source edit may invalidate.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project

# The bind-mounted source is what runs.
ENV PYTHONPATH=/workspace/src

# Metadata, not code: without a `.dist-info` the entry points are invisible (an empty
# `GET /formats`) and the version falls back to 0.0.0. `-e` so the record points at
# /workspace/src, which is where the mount puts the checkout.
COPY VERSION README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --no-deps -e .

# Run as the developer, not root, or the bind mounts fill with root-owned files. Last,
# because nothing in this image is written at run time. `-o` allows a duplicate id, since
# a host uid may collide with one the base ships. /opt/venv stays root-owned on purpose.
ARG VISIONSET_UID=1000
ARG VISIONSET_GID=1000
RUN groupadd -o -g "${VISIONSET_GID}" visionset \
    && useradd -o -u "${VISIONSET_UID}" -g "${VISIONSET_GID}" \
         -m -d /home/visionset -s /bin/sh visionset \
    && chown -R "${VISIONSET_UID}:${VISIONSET_GID}" /workspace

ENV HOME=/home/visionset

USER visionset

CMD ["sh", "/workspace/docker/api-dev.sh"]
