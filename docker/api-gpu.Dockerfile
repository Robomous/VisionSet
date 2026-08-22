# The dev stack's api image, GPU variant; used only by docker/compose.gpu.yaml. Dev only.
#
# A separate Dockerfile because CUDA torch is most of an image, not a package added to one:
# starting from a base that already holds it is a shared pull instead of ~4 GB of wheels
# on every cache miss. The tag matches the torch/CUDA pair uv.lock resolves. For a host
# whose driver is too old for CUDA 13:
#
#   docker compose -f docker/compose.yaml -f docker/compose.gpu.yaml build \
#     --build-arg TORCH_IMAGE=pytorch/pytorch:2.13.0-cuda12.6-cudnn9-runtime
ARG TORCH_IMAGE=pytorch/pytorch:2.13.0-cuda13.0-cudnn9-runtime
FROM ${TORCH_IMAGE}

# ffmpeg, for the reason docker/api.Dockerfile gives. This base is Ubuntu 24.04 (ffmpeg
# 6.1, the same as CI) rather than trixie's 7.1; both are above every threshold that file
# names.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Pinned to the uv the default image currently carries, so both read uv.lock the same way.
COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /usr/local/bin/uv

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

WORKDIR /workspace

COPY pyproject.toml uv.lock ./

# No venv: uv does not count a venv's inherited system site-packages as installed, so it
# would reinstall the torch the base already has. `--break-system-packages` is what PEP 668
# requires to install into Ubuntu's interpreter. The lockfile still decides the base set.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv export --frozen --no-emit-project --no-hashes -o /tmp/requirements.txt \
    && uv pip install --system --break-system-packages -r /tmp/requirements.txt

# The local-inference extra minus torch. Floors copied from pyproject.toml's extra and
# kept in step with it — not from uv.lock, which would pull a second CUDA torch.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --break-system-packages \
      "transformers>=4.44" \
      "accelerate>=0.33" \
      "huggingface-hub>=0.24"

# Code from the mount, metadata from an editable install — see docker/api.Dockerfile.
ENV PYTHONPATH=/workspace/src

COPY VERSION README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --break-system-packages --no-deps -e .

# Same identity block as docker/api.Dockerfile. `-o` matters here: Ubuntu ships an
# `ubuntu` user at uid 1000.
ARG VISIONSET_UID=1000
ARG VISIONSET_GID=1000
RUN groupadd -o -g "${VISIONSET_GID}" visionset \
    && useradd -o -u "${VISIONSET_UID}" -g "${VISIONSET_GID}" \
         -m -d /home/visionset -s /bin/sh visionset \
    && chown -R "${VISIONSET_UID}:${VISIONSET_GID}" /workspace

ENV HOME=/home/visionset

USER visionset

CMD ["sh", "/workspace/docker/api-dev.sh"]
