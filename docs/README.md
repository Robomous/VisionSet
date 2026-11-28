# Documentation site

[Astro](https://astro.build) and [Starlight](https://starlight.astro.build) render the plain
Markdown in [`content/`](content/README.md). Edit those files to update the docs on GitHub
and the website. The site builds from its own pnpm workspace and lockfile inside the monorepo.

## Running it

```bash
pnpm install --frozen-lockfile  # from docs/ with the repository's Node and pnpm versions
pnpm dev                        # http://localhost:4321
pnpm build                      # static output in dist/
pnpm preview                    # serve what build produced
```

Or in the dev stack, with nothing installed on the host:

```bash
docker compose -f ../docker/compose.yaml up docs      # http://localhost:4321
```

Either way, editing a file under `content/` reloads the page.

## How `content/` reaches Starlight

The `docsSource()` integration runs [the projection script](scripts/sync-docs.mjs) before
`dev`, `build`, and `preview`. During development it re-runs when a source page changes.
The script writes the generated Starlight collection to `src/content/docs/`.

It uses the first level-one heading as Starlight's page title and adds an edit link to the
source page. Links between documents become site routes such as `/install/`. Links to other
repository files become GitHub URLs. Code spans and fenced examples keep their original text.

## Markdown or MDX

Use plain Markdown for pages in `content/` so they render on GitHub. Pages that need an Astro
or Starlight component belong in the site's `src/pages/` or a deliberately configured
collection. The repository link tests cover both Markdown and MDX.

## Checks

```bash
pnpm build                      # Starlight projects and renders every page
pnpm sync:check                 # the projection on disk matches content/
node scripts/check-links.mjs    # every internal link in dist/ resolves, anchors included
```

Run `bash ../scripts/check.sh docs` from this directory to run all three checks. The
`docs site` CI job runs them for documentation changes.

Two more gates live with the repository's others, because they read `content/` rather than the
site:

- `tests/scripts/docs_links.test.mjs` — every link in `content/` resolves, file and anchor.
- `tests/scripts/docs_sidebar.test.mjs` — every document appears in `src/sidebar.mjs` exactly
  once, so a new page cannot land with nothing navigating to it.

## Deployment

Static output, built by AWS Amplify Hosting from `../amplify.yml` as a monorepo app whose root is
this directory. There is no SSR and no adapter; `pnpm build` writes files and any static host
serves them.

`astro.config.mjs` deliberately sets no `site` option — this repository does not own the domain
yet, and a wrong canonical URL is worse than none. Setting it is what turns on canonical links
and the sitemap, and it is the one line to add once the domain is real.
