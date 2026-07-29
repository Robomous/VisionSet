# VisionSet documentation

Product and architecture docs land here. Start with the repo-root
[README](../README.md) and [CONTRIBUTING](../CONTRIBUTING.md); the architecture
contracts (kernel purity, headless annotator) are described there and enforced in CI.

| Doc | Covers |
| --- | --- |
| [workspaces.md](workspaces.md) | The workspace on disk: layout, `init`/`open`, which workspace a surface resolves to, project-name uniqueness, and how services are composed |
| [projects.md](projects.md) | The project lifecycle: the 1:1 dataset, renaming, and what deletion does and does not destroy |
| [sources.md](sources.md) | Where raw data comes from: the two registration methods, what a video source records from the probe, why decomposition parameters live on the source, and the idempotency rule and its named uniqueness gap |
| [ingest.md](ingest.md) | Turning a source into rows: content identity versus recorded origin, the two source paths, why the decode happens outside a transaction, the run's lifecycle and pollable progress, and the per-file report |
| [schemas.md](schemas.md) | The annotation schema: immutable monotonic versions, additive vs destructive change, and the two gates on narrowing |
| [batches.md](batches.md) | The unit of annotation work: the state machine, membership frozen at approval, the schema pin, and the exact partition into jobs |
| [jobs.md](jobs.md) | Annotation jobs: the job and per-asset progress machines, what counts as settled, ordered `next_pending`, and derived progress |
| [annotations.md](annotations.md) | The labels themselves: the one door, the batch's pinned version, the five hard rejects, attribute values, and progress derived from the annotations |
| [media.md](media.md) | Decoding raw media: the two processor ports, the accepted image formats, the orientation policy for stills and clips, pinned thumbnails and seek-free frame extraction, and what their determinism does and does not promise |
| [datasets.md](datasets.md) | The curated trunk: promotion from a completed batch, what `skipped` keeps out, curation without a `confirm=`, and the append-only change log |
| [releases.md](releases.md) | The immutable artifact: what a manifest is and is not, why two publishes agree byte for byte, hash verification, and the seeded split recipe |
| [events.md](events.md) | Domain events: subscribing by type, why emission follows the commit, at-most-once delivery, and what an isolated subscriber failure does |
| [persistence.md](persistence.md) | The metadata store: repositories, unit of work, table layout, migrations and `format_version` |
| [examples.md](examples.md) | The two runnable examples: the whole cycle in one pass, ingest on its own, and what each is built to demonstrate |
| [api.md](api.md) | The REST surface: the conventions every endpoint follows (paths, UUID ids, the list envelope, gates as query parameters), the one error body, why clients branch on `code` and not on the status, what decides 404 / 409 / 422, what a 5xx does and does not tell you, and which codes are worth retrying |
| [auth.md](auth.md) | Who may call it: per-workspace API tokens, why only a digest is stored, why every refusal is one identical 401, immediate revocation, the `visionset token` commands, and how a protected route is built |
| [mcp.md](mcp.md) | The agent surface: the thirty-three tools and what each is for, why fifty candidates became thirty-three, how a client is configured, the coordinate-frame rule that makes `get_asset_image` safe to annotate from, the error envelope and its `retry_with` field, the three gate words, and the stated limits (synchronous ingest and export, local paths, one workspace per server) |
| [cli.md](cli.md) | The command line: the whole cycle as a script, the three exit codes (and why one of them also means "no"), why stdout is data and stderr is prose, what `--json` promises and how it stays the API's shape, why `--workspace` follows the subcommand, and what `visionset init` and `visionset ui` each do |
