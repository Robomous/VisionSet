# The dev stack's documentation image: Astro + Starlight over `docs/`.
#
# Dev only, and doubly so — the documentation's *deployment* artifact is the static
# output of `pnpm --dir docs-site build`, which AWS Amplify builds from the
# repository (see `amplify.yml`). This image exists so that a reader can edit
# `docs/api.md` and watch the page change, with nothing installed on the host.
#
# It follows `docker/app.Dockerfile`'s shape: every npm package is resolved,
# downloaded and linked here, so `docker compose up` starts a dev server instead of
# installing first. Where it differs is the install's *scope*, and that is the whole
# reason there are two images rather than one — `docs-site/` is its own pnpm
# workspace root (see `docs-site/pnpm-workspace.yaml`), so Astro never enters the
# application's image and a documentation dependency cannot move it.
FROM node:24-bookworm-slim

# pnpm from corepack, pinned by the *root* package.json's `packageManager` field —
# the same one `docker/app.Dockerfile` reads, so the two images cannot drift onto
# different pnpm versions.
COPY package.json /tmp/packageManager/package.json
RUN corepack enable && corepack prepare --activate \
      "$(node -p "require('/tmp/packageManager/package.json').packageManager")" \
    && rm -rf /tmp/packageManager

WORKDIR /workspace/docs-site

# The manifest, the lockfile and the workspace file, and nothing else yet — the
# layer that has to survive an edit to a document. `pnpm-workspace.yaml` is required
# here and not merely tidy: it is what makes this directory its own workspace root,
# and it carries the three-day cool-down.
COPY docs-site/package.json docs-site/pnpm-lock.yaml docs-site/pnpm-workspace.yaml ./

# `--frozen-lockfile` so the build fails rather than silently resolving something
# the lockfile does not name — the check CI runs, applied where the packages are
# actually fetched.
RUN --mount=type=cache,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store --global \
    && pnpm install --frozen-lockfile

# The site's own build inputs: its config, its integrations, its scripts and its
# components. These are baked in for the reason `docker/app.Dockerfile` states about
# vite's config — they are read once, at start, and none of them changes in an
# ordinary editing session. `docs/`, `docs-site/src` and `docs-site/public` — the
# three trees a person actually edits — arrive on bind mounts; see
# `docker/compose.yaml`, which is also where the reason `public/` is a mount rather
# than a `COPY` is written down.
#
# `src/content/docs/` is deliberately absent: it is generated from `docs/` at every
# start by the `docsSource()` integration, and copying a stale projection into the
# image would be a second source of truth with a build date on it.
COPY docs-site/astro.config.mjs docs-site/tsconfig.json ./
COPY docs-site/scripts ./scripts
COPY docs-site/integrations ./integrations

CMD ["sh", "/workspace/docker/docs-dev.sh"]
