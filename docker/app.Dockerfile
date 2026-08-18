# The dev stack's Node image. Every npm package is resolved, downloaded and linked
# here, so `docker compose up` starts vite instead of installing 357 packages first.
#
# Dev only. The frontend's release artifact is the compiled bundle inside the Python
# wheel (`pnpm bundle:static`), which this file has nothing to do with.
FROM node:24-bookworm-slim

# pnpm comes from corepack, pinned by the root package.json's `packageManager`
# field — so the version is decided by the repository, not by this file, and the
# two cannot drift.
# Corepack records the package manager it activates under COREPACK_HOME, which
# defaults to `$HOME/.cache/node/corepack` — root's, since that is who builds. This
# container no longer runs as root, so leaving the record there hides pnpm from the
# uid that actually starts the dev server: the global shim resolves, finds no
# activated version under its own home, and reaches for the network at container
# start. Nothing in this stack installs at run time and a boot that fetched a
# package manager would be the first thing that did. Somewhere shared and
# world-readable makes the record independent of which uid reads it.
ENV COREPACK_HOME=/opt/corepack

COPY package.json /tmp/packageManager/package.json
RUN corepack enable && corepack prepare --activate \
      "$(node -p "require('/tmp//packageManager/package.json').packageManager")" \
    && rm -rf /tmp/packageManager \
    && chmod -R a+rX "$COREPACK_HOME"

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
# Ownership joins this RUN rather than following it, and that is the whole reason
# the two node images differ in shape from the three Python ones. What the dev
# server writes at run time lands *inside* the install this step just made — the two
# `tsc --watch` builds write each package's `dist/` and its `.tsbuildinfo`, vite
# writes its dependency-optimizer cache under `node_modules/` — so a container
# running as anyone but root needs to own them. A `chown -R` in a layer of its own
# would record all 357 packages a second time; folded in here it costs nothing.
ARG VISIONSET_UID=1000
ARG VISIONSET_GID=1000
RUN --mount=type=cache,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store --global \
    && pnpm install --frozen-lockfile \
    && chown -R "${VISIONSET_UID}:${VISIONSET_GID}" /workspace

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

# The identity the container runs as. docker/api.Dockerfile carries the reasoning
# for all five images, including why ownership is the *last* thing it does and the
# middle thing here: this image's install is what the run-time process writes into,
# so the chown had to join it above rather than repeat the tree in a layer of its
# own.
#
# `node` is reused rather than a second user created. This base already ships it at
# uid 1000 with a home directory and a passwd entry, which is the common case
# arriving for free; inventing another name for the same id would leave two names
# for one identity. When the host is not 1000, remap the user that is here instead
# of adding one beside it — `usermod -u` moves the home directory's ownership along
# with it.
#
# `-o` on both is what survives a collision, and the collision is not exotic: a
# macOS account is usually gid 20, which is `dialout` in a Debian image. Without it
# the build stops at `GID '20' already exists`, which reads as a broken Dockerfile
# rather than as a host whose gid is already spoken for.
RUN if [ "${VISIONSET_UID}:${VISIONSET_GID}" != "1000:1000" ]; then \
      groupmod -o -g "${VISIONSET_GID}" node \
      && usermod -o -u "${VISIONSET_UID}" -g "${VISIONSET_GID}" node; \
    fi

ENV HOME=/home/node

USER node

CMD ["sh", "/workspace/docker/app-dev.sh"]
