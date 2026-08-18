# The dev stack's api image, CPU-inference variant. Used only by
# docker/compose.cpu-inference.yaml.
#
# Dev only, and never the release artifact — that is
# `pip install "visionset[local-inference]"`, built by scripts/build_dist.sh, and it
# does not involve this file or any other file under docker/.
#
# **What this image is, in one line.** The `local-inference` runtime with no CUDA in
# it. The default dev image (docker/api.Dockerfile) does not carry that runtime at
# all, so asking it for a suggestion answers LOCAL_INFERENCE_UNAVAILABLE — which is
# correct there and must keep working. docker/api-gpu.Dockerfile carries it built
# against CUDA and needs an NVIDIA card and the container toolkit under it. This is
# the third point: the same feature, on any host Docker runs on, at seconds per
# suggestion instead of milliseconds.
#
# **The same base as docker/api.Dockerfile, deliberately, and not the CUDA one.**
# The GPU variant starts from `pytorch/pytorch` because ~4 GB of `nvidia-*` wheels
# is most of an image rather than a package added to one, and a pinned base already
# holds them. Here the whole point is not paying that: the CPU build of torch is
# ~250 MB and installs into the image this repo already builds. So this file is
# docker/api.Dockerfile's layering with one install step added, and it stays that
# way — a divergence between the two is a bug in this file, not a variant.
FROM ghcr.io/astral-sh/uv:python3.12-trixie-slim

# ffmpeg, for the reason docker/api.Dockerfile states at length: it is a binary
# rather than a Python dependency, so no `pip install` here can bring it, and an
# image without it serves and ingests stills perfectly well right up until somebody
# uploads a clip and gets 500 MEDIA_TOOL_UNAVAILABLE. Same base as that file, so the
# same trixie ffmpeg 7.1 — no version caveat applies to this variant, unlike the GPU
# one, which is on Ubuntu 24.04 and its 6.1.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# The venv lives outside /workspace, which the bind mount replaces wholesale at run
# time. docker/api.Dockerfile explains it; the same reasoning, unchanged, and the
# same path — the two images are interchangeable from the outside precisely because
# `/opt/venv/bin` is what PATH names in both.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PATH=/opt/venv/bin:$PATH

WORKDIR /workspace

# Only the two files that decide what gets installed, so that editing the source
# does not invalidate the expensive layers below.
COPY pyproject.toml uv.lock ./

# The base environment, from the lockfile, exactly as docker/api.Dockerfile builds
# it: `--frozen` so this does not disagree with CI, `--no-install-project` because
# visionset itself is not a dependency, the dev group included because this is the
# image `docker compose exec api pytest` runs in.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project

# **This step must stay below `uv sync`, and the reason is that `uv sync` prunes.**
# It makes the environment *match* the lockfile, which means uninstalling anything
# the lockfile does not name — and the lockfile does not name the five packages
# below, because `local-inference` is an optional extra a plain sync does not
# install. Installed above this line they would be silently removed again, leaving
# an image that builds clean and refuses at run time.
#
# **The dual-Python trap, which is why the next step asserts before it installs.**
# There are two interpreters in this image: `/usr/local/bin/python`, the base
# image's own, and `/opt/venv/bin/python`, the venv the ENV block above puts first
# on PATH. docker/api-dev.sh boots the server with `exec uvicorn`, resolved from
# PATH, whose shebang is `#!/opt/venv/bin/python` — so the venv is the only
# interpreter that ever runs a request, and an install landing anywhere else
# succeeds loudly and changes nothing the server can see.
#
# The two most natural ways to type it land exactly there. `uv pip install --system`
# means the non-venv interpreter by definition. And **the venv has no `pip` of its
# own** — `uv sync` installs none — so `pip` inside a running container resolves to
# `/usr/local/bin/pip` and installs into the base image's interpreter, while
# `python` two words later is still the venv's and still cannot see it. The stack
# goes on answering LOCAL_INFERENCE_UNAVAILABLE with a gigabyte of torch sitting in
# the image, which is a confusing place to debug from. That is not hypothetical: it
# is what happened in manual testing, and it is the time this file exists to stop
# costing.
#
# So: read the interpreter out of uvicorn's own shebang and fail the build if it is
# not the one the install below targets. The day the venv moves, this line breaks
# rather than the stack going quiet.
RUN set -eu; \
    interpreter="$(sed -n '1s|^#!||p' "$(command -v uvicorn)")"; \
    echo "api-cpu-inference: the server's interpreter is ${interpreter}"; \
    [ "${interpreter}" = "/opt/venv/bin/python" ]

# The `local-inference` extra, from the CPU wheel index, into that interpreter.
#
# **Why an index rather than the lockfile.** `torch` as PyPI publishes it for linux
# x86_64 *is* the CUDA build — roughly two gigabytes once its fifteen `nvidia-*`
# dependencies are unpacked, every byte of it unreachable on a host with no card.
# download.pytorch.org's `cpu` index publishes the same versions built without any
# of it, at ~250 MB.
#
# **`unsafe-best-match` rather than uv's default `first-index`, and the name is
# scarier than the situation.** `first-index` takes every candidate for a package
# from the first index that answers for it at all — and that index answers for far
# more than torch: it mirrors numpy, jinja2, setuptools, sympy and others, at
# whatever copy it happens to hold. Measured here, the default silently pinned numpy
# to 2.4.4 and tqdm to 4.66.5 while uv.lock resolves 2.5.1 and 4.70.0, which is a
# CPU-inference image quietly running a *different base environment* than every other
# image in this repo. `unsafe-best-match` considers both indexes and takes the
# highest compatible version, which puts those back on the lock's numbers. What it
# does not do is let PyPI's CUDA torch back in: `2.13.0+cpu` sorts *above* the plain
# `2.13.0` PyPI publishes, so the CPU wheel wins the comparison — and the assertion
# below fails the build if it ever stops winning.
#
# **The versions are uv.lock's, restated, and have to stay in step with it.** They
# cannot be read from the lock: the lock pins torch and its CUDA wheels as ordinary
# packages, so exporting from it is the thing this step exists to avoid. Naming the
# resolved versions keeps this image on the same torch as the wheel a developer
# would `pip install` on the host, `+cpu` aside. `torchvision` pins `torch`
# *exactly* (0.28.0 requires torch 2.13.0), so those two move as a pair or the
# resolver is handed something it cannot satisfy — pyproject.toml's extra says the
# same thing about their floors.
#
# `--python` names the target rather than trusting discovery, per the trap above.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      --index-strategy unsafe-best-match \
      "torch==2.13.0" \
      "torchvision==0.28.0" \
      "transformers==5.14.1" \
      "accelerate==1.14.0" \
      "huggingface-hub==1.26.0"

# And prove the result from the outside: resolve `python` the way the server's own
# boot resolves `uvicorn` — off PATH — and import all five. An assertion here is
# worth a build failure because the alternative is a stack that starts, serves,
# and refuses one feature.
RUN python -c "import sys, torch, torchvision, transformers, accelerate, huggingface_hub; \
print('api-cpu-inference:', sys.executable, 'torch', torch.__version__); \
assert sys.executable == '/opt/venv/bin/python', sys.executable; \
assert torch.__version__.endswith('+cpu'), torch.__version__"

# Which *code* runs, and which *metadata* describes it — two separate things, and
# docker/api.Dockerfile explains at length what breaks when they are conflated (an
# empty `GET /formats` and a `0.0.0` version written into published releases). The
# same two lines, for the same reasons.
ENV PYTHONPATH=/workspace/src

COPY VERSION README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --no-deps -e .

# The identity the container runs as, character for character what
# docker/api.Dockerfile ends with — which is the rule this whole file follows, and
# the reason it is repeated rather than shared. That file carries the reasoning:
# why it is last, why /opt/venv stays root-owned, and why `-o`.
#
# Last is also what keeps this file's two build-time assertions honest. Both read
# and import from /opt/venv as root, against an environment nothing has modified,
# before any of this runs.
ARG VISIONSET_UID=1000
ARG VISIONSET_GID=1000
RUN groupadd -o -g "${VISIONSET_GID}" visionset \
    && useradd -o -u "${VISIONSET_UID}" -g "${VISIONSET_GID}" \
         -m -d /home/visionset -s /bin/sh visionset \
    && chown -R "${VISIONSET_UID}:${VISIONSET_GID}" /workspace

ENV HOME=/home/visionset

USER visionset

CMD ["sh", "/workspace/docker/api-dev.sh"]
