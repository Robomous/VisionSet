# VisionSet documentation

Product and architecture docs land here. Start with the repo-root
[README](../README.md) and [CONTRIBUTING](../CONTRIBUTING.md); the architecture
contracts (kernel purity, headless annotator) are described there and enforced in CI.

The **visual** contract is [DESIGN.md](../DESIGN.md), also at the repository root
rather than here — it is the file to read *before* building any screen, and the one
`frontend/ui-core/src/styles.css` implements. Read it beside
[annotations.md](annotations.md), which covers the annotator itself.

**New here?** [install.md](install.md), then [tutorial.md](tutorial.md).

| Doc | Covers |
| --- | --- |
| [install.md](install.md) | Getting it: requirements, the wheel, what `ffmpeg` is and is not needed for, the optional groups that check exports, and where your data goes |
| [tutorial.md](tutorial.md) | A first dataset end to end — clip to YOLO in about half an hour — with what each step actually freezes and why |
| [workspaces.md](workspaces.md) | The workspace on disk: layout, `init`/`open`, which workspace a surface resolves to, project-name uniqueness, and how services are composed |
| [projects.md](projects.md) | The project lifecycle: the 1:1 dataset, renaming, and what deletion does and does not destroy |
| [sources.md](sources.md) | Where raw data comes from: the two registration methods, what a video source records from the probe, why decomposition parameters live on the source, and the idempotency rule and its named uniqueness gap |
| [ingest.md](ingest.md) | Turning a source into rows: content identity versus recorded origin, the two source paths, why the decode happens outside a transaction, the run's lifecycle and pollable progress, and the per-file report |
| [schemas.md](schemas.md) | The annotation schema: immutable monotonic versions, additive vs destructive change, and the two gates on narrowing |
| [batches.md](batches.md) | The unit of annotation work: the state machine, membership frozen at approval, the schema pin, and the exact partition into jobs |
| [jobs.md](jobs.md) | Annotation jobs: the job and per-asset progress machines, what counts as settled, ordered `next_pending`, and derived progress |
| [annotations.md](annotations.md) | The labels themselves: the one door, the batch's pinned version, the five hard rejects, attribute values, progress derived from the annotations, and the editor's shortcut table |
| [media.md](media.md) | Decoding raw media: the two processor ports, the accepted image formats, the orientation policy for stills and clips, pinned thumbnails and seek-free frame extraction, and what their determinism does and does not promise |
| [datasets.md](datasets.md) | The curated trunk: promotion from a completed batch, what `skipped` keeps out, curation without a `confirm=`, and the append-only change log |
| [releases.md](releases.md) | The immutable artifact: what a manifest is and is not, why two publishes agree byte for byte, hash verification, and the seeded split recipe |
| [events.md](events.md) | Domain events: subscribing by type, why emission follows the commit, at-most-once delivery, and what an isolated subscriber failure does |
| [persistence.md](persistence.md) | The metadata store: repositories, unit of work, table layout, migrations and `format_version` |
| [examples.md](examples.md) | The five runnable examples: the whole cycle in one pass, ingest on its own, and the same cycle driven three ways — over HTTP, from a shell, and over MCP stdio — with what each is built to demonstrate |
| [api.md](api.md) | The REST surface: the conventions every endpoint follows (paths, UUID ids, the list envelope, gates as query parameters), the one error body, why clients branch on `code` and not on the status, what decides 404 / 409 / 422, what a 5xx does and does not tell you, and which codes are worth retrying |
| [auth.md](auth.md) | Who may call it: per-workspace API tokens, why only a digest is stored, why every refusal is one identical 401, immediate revocation, the `visionset token` commands, and how a protected route is built |
| [mcp.md](mcp.md) | The agent surface: the thirty-four tools and what each is for, why the one that destroys data is not advertised unless you ask, why fifty candidates became thirty-three (and what has been added since), how a client is configured, the coordinate-frame rule that makes `get_asset_image` safe to annotate from, the error envelope and its `retry_with` field, the three gate words, and the stated limits (synchronous ingest and export, local paths, one workspace per server) |
| [mcp-tools.md](mcp-tools.md) | The complete tool listing, **generated** from the server's own descriptions so it cannot drift from what an agent is told |
| [mcp-walkthrough.md](mcp-walkthrough.md) | A session over MCP, start to finish: the cycle in the order an agent meets it, and then what twelve real agent runs did with it — where the coordinate frame held, how refusals were read, and the two pieces of friction that changed the tools |
| [ui.md](ui.md) | The browser client: why no screen calls `fetch`, how a refusal is read (branch on `code`, and the two codes the client adds), where the token is kept and the three alternatives that were rejected, why a 401 is handled in one subscription, the loading/empty/error component, polling, and the dev proxy that keeps CORS out of production |
| [releasing.md](releasing.md) | Cutting a release: what ships, why the beta goes to PyPI as a pre-release, the npm scope, the order the steps have to happen in, and the one step that needs credentials this repository does not hold |
| [cli.md](cli.md) | The command line: the whole cycle as a script, the three exit codes (and why one of them also means "no"), why stdout is data and stderr is prose, what `--json` promises and how it stays the API's shape, why `--workspace` follows the subcommand, and what `visionset init` and `visionset ui` each do |
