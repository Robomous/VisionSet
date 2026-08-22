# The dev stack's Node image. Every package is installed here, so `docker compose up`
# starts vite instead of installing first. Dev only: the bundle that ships in the wheel
# is built elsewhere.
FROM node:24-bookworm-slim

# pnpm from corepack, pinned by the root package.json's `packageManager`. The record goes
# somewhere world-readable: the default is under root's HOME, and this container does not
# run as root — corepack would then reach for the network at start.
ENV COREPACK_HOME=/opt/corepack

COPY package.json /tmp/packageManager/package.json
RUN corepack enable && corepack prepare --activate \
      "$(node -p "require('/tmp//packageManager/package.json').packageManager")" \
    && rm -rf /tmp/packageManager \
    && chmod -R a+rX "$COREPACK_HOME"

WORKDIR /workspace

# Manifests and lockfile only, so a source edit does not re-run the install.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY frontend/annotator/package.json ./frontend/annotator/
COPY frontend/ui-core/package.json ./frontend/ui-core/
COPY frontend/app/package.json ./frontend/app/

# chown joins this RUN: the watch builds and vite's cache write into the install, and a
# separate `chown -R` layer would duplicate every package.
ARG VISIONSET_UID=1000
ARG VISIONSET_GID=1000
RUN --mount=type=cache,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store --global \
    && pnpm install --frozen-lockfile \
    && chown -R "${VISIONSET_UID}:${VISIONSET_GID}" /workspace

# Baked in rather than mounted: a bind mount over a package root would bury its
# node_modules. Editing one of these needs `build`. tsconfig.e2e.json is left out on
# purpose (Playwright, which this image never runs).
COPY frontend/annotator/tsconfig*.json ./frontend/annotator/
COPY frontend/ui-core/tsconfig*.json ./frontend/ui-core/
COPY frontend/app/tsconfig.json frontend/app/vite.config.ts frontend/app/index.html ./frontend/app/

# Reuse the base's `node` user (uid 1000) and remap it when the host differs. `-o` survives
# a collision: macOS accounts are usually gid 20, which is `dialout` here.
RUN if [ "${VISIONSET_UID}:${VISIONSET_GID}" != "1000:1000" ]; then \
      groupmod -o -g "${VISIONSET_GID}" node \
      && usermod -o -u "${VISIONSET_UID}" -g "${VISIONSET_GID}" node; \
    fi

ENV HOME=/home/node

USER node

CMD ["sh", "/workspace/docker/app-dev.sh"]
