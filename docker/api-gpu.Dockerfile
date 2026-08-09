# The dev stack's api image, GPU variant. Used only by docker/compose.gpu.yaml.
#
# Dev only, and never the release artifact — that is
# `pip install "visionset[local-inference]"`, built by scripts/build_dist.sh, and it
# does not involve this file or any other file under docker/.
#
# **Why a separate Dockerfile rather than a flag on docker/api.Dockerfile.** The
# thing that makes a GPU useful here is torch built against CUDA, and that is not a
# package you add to an image — it is most of the image. Installing it from the
# lockfile means ~4 GB of `nvidia-*` wheels resolved, downloaded and unpacked on
# every cache miss. Starting from a base that already contains them is a pull, in
# parallel, of layers Docker then shares with every other image built on the same
# base. So this file changes the *base*, which a build argument cannot do, and
# docker/api.Dockerfile is left untouched — the default dev image is not merely
# unchanged in behaviour, it is unchanged.
#
# The tag is not arbitrary: uv.lock already resolves `torch==2.13.0` on the `cu13`
# wheels, so 2.13.0 / CUDA 13.0 is the version the lockfile would have installed
# anyway. Pinned rather than floating, for the reason every other image in this repo
# is pinned. Overridable for a host whose driver is too old for CUDA 13 — the
# pytorch/pytorch repository publishes the same torch against 12.6 as well:
#
#   docker compose -f docker/compose.yaml -f docker/compose.gpu.yaml build \
#     --build-arg TORCH_IMAGE=pytorch/pytorch:2.13.0-cuda12.6-cudnn9-runtime
ARG TORCH_IMAGE=pytorch/pytorch:2.13.0-cuda13.0-cudnn9-runtime
FROM ${TORCH_IMAGE}

# ffmpeg, for the reason docker/api.Dockerfile states at length: it is a binary
# rather than a Python dependency, so no `pip install` here can bring it, and an
# image without it serves and ingests stills perfectly well right up until somebody
# uploads a clip and gets 500 MEDIA_TOOL_UNAVAILABLE.
#
# **One version difference from the default image, stated rather than discovered.**
# This base is Ubuntu 24.04, whose ffmpeg is 6.1; docker/api.Dockerfile is on Debian
# trixie for 7.1. 6.1 is above every threshold that file names — `-display_rotation`
# arrived in 6.0, and a truncated clip is classified as corrupt rather than
# unsupported — and it is the same 6.1 the CI `python` job runs, so this variant
# decodes as CI does. Read that off `ffmpeg -version`, never off the package
# version: both distributions ship an epoch of 7 and the leading `7:` means nothing.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# uv, copied from its own published image rather than installed with pip. It is a
# static binary, so this is one layer and no dependency resolution. Pinned to the
# version `ghcr.io/astral-sh/uv:python3.12-trixie-slim` currently carries, so the
# two dev images read uv.lock with the same uv; that tag floats and this one does
# not, which is the trade this file wants — a base-image change here should be a
# diff, not a surprise.
COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /usr/local/bin/uv

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

WORKDIR /workspace

# Only the two files that decide what gets installed, so editing the source does not
# invalidate the layers below.
COPY pyproject.toml uv.lock ./

# **No venv here, and that is the whole design.** The torch that matters is the one
# the base image installed, in this interpreter's `dist-packages`. uv does not treat
# a virtualenv's inherited system site-packages as installed — a venv built with
# `--system-site-packages` still plans `torch` and fifteen `nvidia-*` wheels — so a
# venv would reinstall the several gigabytes this base exists to have already
# provided. Installing into the interpreter that owns torch is what makes it visible
# as satisfied.
#
# `--break-system-packages` is what PEP 668 requires to say that, Ubuntu having
# marked its system interpreter externally managed. In a container that is a
# throwaway root filesystem with one application in it, which is the case the marker
# is not aimed at; the base image's own torch was installed exactly this way.
#
# The lockfile is still the source of truth for everything it can be. `uv export
# --frozen` writes out the resolved base set — no network resolution, no
# disagreement with CI — and the project itself is excluded because it is the thing
# being edited and arrives by bind mount. The default groups come along, `dev`
# among them, matching docker/api.Dockerfile so that `exec api pytest` works here
# too.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv export --frozen --no-emit-project --no-hashes -o /tmp/requirements.txt \
    && uv pip install --system --break-system-packages -r /tmp/requirements.txt

# The local-inference runtime, minus torch, which is the base image.
#
# **These floors are copied from pyproject.toml's `local-inference` extra and must
# stay in step with it.** They are not read from uv.lock, and deliberately: the lock
# pins torch and its fifteen CUDA wheels as ordinary packages, so installing the
# extra from the lock would install a second copy of everything this base already
# has. Requesting the other three by floor lets the resolver see torch 2.13.0 as
# present and satisfying, and it leaves it alone.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --break-system-packages \
      "transformers>=4.44" \
      "accelerate>=0.33" \
      "huggingface-hub>=0.24"

# Which *code* runs, and which *metadata* describes it — two separate things, and
# docker/api.Dockerfile explains at length what breaks when they are conflated (an
# empty `GET /formats` and a `0.0.0` version written into published releases). The
# same two lines, for the same reasons; only the environment they land in differs.
ENV PYTHONPATH=/workspace/src

COPY VERSION README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --break-system-packages --no-deps -e .

CMD ["sh", "/workspace/docker/api-dev.sh"]
