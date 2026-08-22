# The dev stack's documentation image: Astro + Starlight over `docs/content/`. Dev only;
# the site deploys from `pnpm --dir docs build` (see amplify.yml). `docs/` is its own pnpm
# workspace, so none of this reaches the application image.
FROM node:24-bookworm-slim

# pnpm from corepack, pinned by the root package.json's `packageManager`; see
# docker/app.Dockerfile for why the record lives here. This image has no other source for
# the version: docs/package.json declares no `packageManager`.
ENV COREPACK_HOME=/opt/corepack

COPY package.json /tmp/packageManager/package.json
RUN corepack enable && corepack prepare --activate \
      "$(node -p "require('/tmp/packageManager/package.json').packageManager")" \
    && rm -rf /tmp/packageManager \
    && chmod -R a+rX "$COREPACK_HOME"

WORKDIR /workspace/docs

# `pnpm-workspace.yaml` is what makes this directory its own workspace root.
COPY docs/package.json docs/pnpm-lock.yaml docs/pnpm-workspace.yaml ./

# chown joins this RUN for the reason docker/app.Dockerfile gives: Astro and Vite write
# their caches into the install.
ARG VISIONSET_UID=1000
ARG VISIONSET_GID=1000
RUN --mount=type=cache,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store --global \
    && pnpm install --frozen-lockfile \
    && chown -R "${VISIONSET_UID}:${VISIONSET_GID}" /workspace

# Build inputs, baked in; `content`, `src` and `public` arrive on bind mounts.
# `src/content/docs/` is generated from `content/` at every start and deliberately absent.
COPY docs/astro.config.mjs docs/tsconfig.json ./
COPY docs/scripts ./scripts
COPY docs/integrations ./integrations

# Same identity handling as docker/app.Dockerfile.
RUN if [ "${VISIONSET_UID}:${VISIONSET_GID}" != "1000:1000" ]; then \
      groupmod -o -g "${VISIONSET_GID}" node \
      && usermod -o -u "${VISIONSET_UID}" -g "${VISIONSET_GID}" node; \
    fi

ENV HOME=/home/node

USER node

CMD ["sh", "/workspace/docker/docs-dev.sh"]
