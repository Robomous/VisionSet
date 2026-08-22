# The dev stack's api image, CPU-inference variant; used only by
# docker/compose.cpu-inference.yaml. Dev only.
#
# docker/api.Dockerfile's layering plus one install step: the local-inference extra with
# the CPU build of torch (~250 MB instead of the CUDA base the GPU variant starts from).
# A divergence from that file is a bug here, not a variant.
FROM ghcr.io/astral-sh/uv:python3.12-trixie-slim

# ffmpeg, for the reason docker/api.Dockerfile gives.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Same venv path as docker/api.Dockerfile, so the two images are interchangeable.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PATH=/opt/venv/bin:$PATH

WORKDIR /workspace

COPY pyproject.toml uv.lock ./

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project

# The install below must stay after `uv sync`, which prunes anything the lockfile does not
# name — and the extra is not in the lock.
#
# Two interpreters live here and only /opt/venv/bin/python ever serves a request (uvicorn's
# shebang). `uv pip install --system` and a bare `pip` both land in /usr/local, loudly
# successful and invisible to the server. So assert the target before installing.
RUN set -eu; \
    interpreter="$(sed -n '1s|^#!||p' "$(command -v uvicorn)")"; \
    echo "api-cpu-inference: the server's interpreter is ${interpreter}"; \
    [ "${interpreter}" = "/opt/venv/bin/python" ]

# From the CPU index, not the lockfile: PyPI's linux torch is the CUDA build. The versions
# restate uv.lock's and must stay in step with it; torchvision pins torch exactly, so those
# two move as a pair.
#
# `unsafe-best-match` because `first-index` takes every package the CPU index mirrors
# (numpy, tqdm, …) at whatever copy it holds, silently off the lock's versions. The CPU
# torch still wins: `2.13.0+cpu` sorts above PyPI's `2.13.0`, and the check below proves it.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      --index-strategy unsafe-best-match \
      "torch==2.13.0" \
      "torchvision==0.28.0" \
      "transformers==5.14.1" \
      "accelerate==1.14.0" \
      "huggingface-hub==1.26.0"

# Resolved off PATH, the way the server's boot resolves uvicorn.
RUN python -c "import sys, torch, torchvision, transformers, accelerate, huggingface_hub; \
print('api-cpu-inference:', sys.executable, 'torch', torch.__version__); \
assert sys.executable == '/opt/venv/bin/python', sys.executable; \
assert torch.__version__.endswith('+cpu'), torch.__version__"

# Code from the mount, metadata from an editable install — see docker/api.Dockerfile.
ENV PYTHONPATH=/workspace/src

COPY VERSION README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --no-deps -e .

# Same identity block as docker/api.Dockerfile; last, so the assertions above ran as root
# against an unmodified environment.
ARG VISIONSET_UID=1000
ARG VISIONSET_GID=1000
RUN groupadd -o -g "${VISIONSET_GID}" visionset \
    && useradd -o -u "${VISIONSET_UID}" -g "${VISIONSET_GID}" \
         -m -d /home/visionset -s /bin/sh visionset \
    && chown -R "${VISIONSET_UID}:${VISIONSET_GID}" /workspace

ENV HOME=/home/visionset

USER visionset

CMD ["sh", "/workspace/docker/api-dev.sh"]
