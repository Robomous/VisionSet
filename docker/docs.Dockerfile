# The dev stack's documentation image: Astro + Starlight over `docs/content/`.
#
# Dev only, and doubly so — the documentation's *deployment* artifact is the static
# output of `pnpm --dir docs build`, which AWS Amplify builds from the
# repository (see `amplify.yml`). This image exists so that a reader can edit
# `docs/content/api.md` and watch the page change, with nothing installed on the host.
#
# It follows `docker/app.Dockerfile`'s shape: every npm package is resolved,
# downloaded and linked here, so `docker compose up` starts a dev server instead of
# installing first. Where it differs is the install's *scope*, and that is the whole
# reason there are two images rather than one — `docs/` is its own pnpm
# workspace root (see `docs/pnpm-workspace.yaml`), so Astro never enters the
# application's image and a documentation dependency cannot move it.
FROM node:24-bookworm-slim

# pnpm from corepack, pinned by the *root* package.json's `packageManager` field —
# the same one `docker/app.Dockerfile` reads, so the two images cannot drift onto
# different pnpm versions.
# Corepack records the package manager it activates under COREPACK_HOME, which
# defaults to `$HOME/.cache/node/corepack` — root's, since that is who builds. This
# container no longer runs as root, so leaving the record there hides pnpm from the
# uid that actually starts the dev server: the global shim resolves, finds no
# activated version under its own home, and reaches for the network at container
# start. Nothing in this stack installs at run time and a boot that fetched a
# package manager would be the first thing that did. Somewhere shared and
# world-readable makes the record independent of which uid reads it.
#
# This image depends on that record more completely than the application one
# does. `docs/package.json` declares no `packageManager` field and the root
# manifest is never copied in, so corepack has nothing to re-derive the version
# from: the failure here is not a wrong pnpm, it is no pnpm at all.
ENV COREPACK_HOME=/opt/corepack

COPY package.json /tmp/packageManager/package.json
RUN corepack enable && corepack prepare --activate \
      "$(node -p "require('/tmp/packageManager/package.json').packageManager")" \
    && rm -rf /tmp/packageManager \
    && chmod -R a+rX "$COREPACK_HOME"

WORKDIR /workspace/docs

# The manifest, the lockfile and the workspace file, and nothing else yet — the
# layer that has to survive an edit to a document. `pnpm-workspace.yaml` is required
# here and not merely tidy: it is what makes this directory its own workspace root,
# and it carries the three-day cool-down.
COPY docs/package.json docs/pnpm-lock.yaml docs/pnpm-workspace.yaml ./

# `--frozen-lockfile` so the build fails rather than silently resolving something
# the lockfile does not name — the check CI runs, applied where the packages are
# actually fetched.
# Ownership joins this RUN rather than following it, and that is the whole reason
# the two node images differ in shape from the three Python ones. What the dev
# server writes at run time lands *inside* the install this step just made — Astro writes
# its own `.astro/` and a second one under `node_modules/`, and Vite writes the
# dependency-optimizer cache beside it — so a container
# running as anyone but root needs to own them. A `chown -R` in a layer of its own
# would record all 357 packages a second time; folded in here it costs nothing.
ARG VISIONSET_UID=1000
ARG VISIONSET_GID=1000
RUN --mount=type=cache,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store --global \
    && pnpm install --frozen-lockfile \
    && chown -R "${VISIONSET_UID}:${VISIONSET_GID}" /workspace

# The site's own build inputs: its config, its integrations, its scripts and its
# components. These are baked in for the reason `docker/app.Dockerfile` states about
# vite's config — they are read once, at start, and none of them changes in an
# ordinary editing session. `docs/content`, `docs/src` and `docs/public` — the
# three trees a person actually edits — arrive on bind mounts; see
# `docker/compose.yaml`, which is also where the reason `public/` is a mount rather
# than a `COPY` is written down.
#
# `src/content/docs/` is deliberately absent: it is generated from `content/` at every
# start by the `docsSource()` integration, and copying a stale projection into the
# image would be a second source of truth with a build date on it.
COPY docs/astro.config.mjs docs/tsconfig.json ./
COPY docs/scripts ./scripts
COPY docs/integrations ./integrations

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

CMD ["sh", "/workspace/docker/docs-dev.sh"]
