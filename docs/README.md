# VisionSet documentation

Product and architecture docs land here. Start with the repo-root
[README](../README.md) and [CONTRIBUTING](../CONTRIBUTING.md); the architecture
contracts (kernel purity, headless annotator) are described there and enforced in CI.

| Doc | Covers |
| --- | --- |
| [workspaces.md](workspaces.md) | The workspace on disk: layout, `init`/`open`, project-name uniqueness, and how services are composed |
| [projects.md](projects.md) | The project lifecycle: the 1:1 dataset, renaming, and what deletion does and does not destroy |
| [schemas.md](schemas.md) | The annotation schema: immutable monotonic versions, additive vs destructive change, and the two gates on narrowing |
| [batches.md](batches.md) | The unit of annotation work: the state machine, membership frozen at approval, the schema pin, and the exact partition into jobs |
| [jobs.md](jobs.md) | Annotation jobs: the job and per-asset progress machines, what counts as settled, ordered `next_pending`, and derived progress |
| [annotations.md](annotations.md) | The labels themselves: the one door, the batch's pinned version, the five hard rejects, attribute values, and progress derived from the annotations |
| [media.md](media.md) | Decoding raw media: the two processor ports, the accepted formats, the orientation policy, pinned thumbnails and what their determinism does and does not promise |
| [datasets.md](datasets.md) | The curated trunk: promotion from a completed batch, what `skipped` keeps out, curation without a `confirm=`, and the append-only change log |
| [releases.md](releases.md) | The immutable artifact: what a manifest is and is not, why two publishes agree byte for byte, hash verification, and the seeded split recipe |
| [events.md](events.md) | Domain events: subscribing by type, why emission follows the commit, at-most-once delivery, and what an isolated subscriber failure does |
| [persistence.md](persistence.md) | The metadata store: repositories, unit of work, table layout, migrations and `format_version` |
| [examples.md](examples.md) | The runnable end-to-end example: the whole cycle in one pass, what it is built to demonstrate, and the one step that has no service yet |
