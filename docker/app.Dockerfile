# The dev stack's Node image. Every npm package is resolved, downloaded and linked
# here, so `docker compose up` starts vite instead of installing 357 packages first.
#
# Dev only. The frontend's release artifact is the compiled bundle inside the Python
# wheel (`pnpm bundle:static`), which this file has nothing to do with.
FROM node:24-bookworm-slim

# pnpm comes from corepack, pinned by the root package.json's `packageManager`
# field — so the version is decided by the repository, not by this file, and the
# two cannot drift.
COPY package.json /tmp/packageManager/package.json
RUN corepack enable && corepack prepare --activate \
      "$(node -p "require('/tmp//packageManager/package.json').packageManager")" \
    && rm -rf /tmp/packageManager

WORKDIR /workspace

# The manifests and the lockfile, and nothing else. This is the layer that has to
# survive a source edit — copying the workspace in would rebuild it on every
# keystroke, and the source arrives by bind mount anyway.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY frontend/annotator/package.json ./frontend/annotator/
COPY frontend/ui-core/package.json ./frontend/ui-core/
COPY frontend/app/package.json ./frontend/app/

# `--frozen-lockfile` so the build fails rather than silently resolving something
# pnpm-lock.yaml does not name — the check CI runs, applied at the moment the
# packages are actually fetched.
#
# The store is a cache mount rather than a layer: it is pnpm's download cache, and
# baking it into the image would double the size for no gain, since node_modules
# already holds what was linked out of it.
RUN --mount=type=cache,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store --global \
    && pnpm install --frozen-lockfile

CMD ["sh", "/workspace/docker/app-dev.sh"]
