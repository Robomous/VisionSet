# docs

The documentation, and the Astro + [Starlight](https://starlight.astro.build) site that renders it.

**`content/` is the documentation. The rest of this directory is one way of looking at it.**
Everything in `content/` is plain Markdown that renders on GitHub and reads correctly with nothing
installed — that is a requirement, not a happy accident, because tools and agents read it that way.
Start at [`content/README.md`](content/README.md). The site never becomes a second copy.

One folder rather than two, so AWS Amplify can deploy it as a monorepo app rooted here and rebuild
only when something under `docs/` changes — see `../amplify.yml`.

## Running it

```bash
pnpm install                    # from this directory — it is its own pnpm workspace root
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

`scripts/sync-docs.mjs` projects `content/**/*.md` into `src/content/docs/`, which is
**generated and git-ignored** — a different directory from `content/`, despite the name. The
`docsSource()` integration runs it before every `dev`, `build` and `preview`, and re-runs it on
every change while the dev server is up — so there is no sync step to remember and no way to
build a stale site.

The projection does two things and nothing else:

- **The first `# H1` becomes the frontmatter `title` and is removed from the body.** Starlight
  requires a title and renders it as the page's `<h1>`; leaving the document's own H1 in place
  would put two titles on every page. Doing it here rather than in `content/` keeps the documents
  readable on GitHub, with no YAML block at the top of each one.
- **Links that would break are rewritten.** A link to another document becomes a path on this
  site (`install.md` → `/install/`); a link out of `content/` into the repository becomes a GitHub
  URL (`../../src/visionset/` → `.../tree/main/src/visionset`). Nothing inside a code fence or an
  inline code span is touched.

No prose is rewritten. Feed the script a document and the output is a function of that document
alone — `pnpm sync:check` fails if what is on disk disagrees.

Read the header of `scripts/sync-docs.mjs` for why this is a projection rather than a loader
pointed at `content/`.

## Markdown or MDX

**Markdown, by default and almost always.** `content/` is `.md` and stays that way: it is the
canonical source, it has to render on GitHub, and `.mdx` does not.

Reach for `.mdx` only when a page genuinely needs a Starlight or Astro component — a tabbed
install matrix, a card grid, a live example. Such a page is a *site* page and belongs outside
`content/`; put it under `src/pages/` or add it to the collection deliberately, and say in the
file why it could not be Markdown. A `.mdx` file placed in `content/` breaks the promise that the
documentation reads without a toolchain.

`tests/scripts/docs_links.test.mjs` checks `.md` **and** `.mdx`, so an MDX page is held to the
same link rules as everything else.

## Checks

```bash
pnpm sync:check                 # the projection on disk matches content/
pnpm build                      # Starlight builds every page
node scripts/check-links.mjs    # every internal link in dist/ resolves, anchors included
```

`bash ../scripts/check.sh docs` runs all three, and the `docs site` CI job runs the same. It is
not in `check.sh`'s default set: it costs about ten seconds and reaches nothing the application
suites cover, so it is opt-in for a documentation change rather than a tax on every Python one.

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
