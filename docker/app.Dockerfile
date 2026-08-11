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

# The manifests and the lockfile, and nothing else *yet*. This is the layer that
# has to survive a source edit — copying the workspace in would rebuild it on every
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

# The build inputs that are neither a dependency nor a source file: the tsconfigs
# the two `tsc` builds read, vite's config, and the app's HTML entry. They are here
# rather than on a bind mount because of where `node_modules` lives.
#
# pnpm puts a `node_modules/` inside every workspace package, so a bind mount over
# a package *directory* buries the install this layer just made — which used to be
# answered with a named volume per package, and named volumes are seeded only when
# new, so a rebuilt image could never reach one. Mounting the `src/` directories
# instead leaves every `node_modules/` the image's own, and that is what makes
# `build` sufficient on its own. See docker/compose.yaml.
#
# The cost is stated rather than hidden: these seven files are baked in, so editing
# one needs a `build` — the same rule a dependency change already had, and none of
# them changes in an ordinary editing session. They are copied *after* the install
# so that editing one invalidates a layer holding seven small files rather than the
# one that fetches 357 packages.
#
# `frontend/app/tsconfig.e2e.json` is deliberately not among them: it compiles the
# Playwright suite, which this image has no sources for and never runs.
COPY frontend/annotator/tsconfig*.json ./frontend/annotator/
COPY frontend/ui-core/tsconfig*.json ./frontend/ui-core/
COPY frontend/app/tsconfig.json frontend/app/vite.config.ts frontend/app/index.html ./frontend/app/

CMD ["sh", "/workspace/docker/app-dev.sh"]
