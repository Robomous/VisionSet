# Glossary

The words this documentation and the tools use, in the order a dataset meets them. Each links to
the page that owns the rule.

| Term | Means |
| --- | --- |
| **Workspace** | The directory holding everything VisionSet knows: the metadata database (`visionset.db`) and the content-addressed blobs. One server or CLI invocation works on one workspace. Created by `visionset init`. See [workspaces.md](workspaces.md). |
| **Project** | One dataset effort inside a workspace, such as `road-signs`. Has a unique name, a schema, sources, batches, a trunk and releases. Commands take its name or its id. See [projects.md](projects.md). |
| **Source** | Where assets came from: a directory of still images registered with the project, or a video imported through the browser. See [sources.md](sources.md). |
| **Asset** | One image. Stored once by content hash, so identical bytes are one asset however often they are ingested. See [ingest.md](ingest.md). |
| **Schema** | The versioned definition of what may be labeled: classes, the geometries each allows, and their attributes. A new version is published; versions are never edited. See [schemas.md](schemas.md). |
| **Schema draft** | A schema version still being written. It may be empty or incomplete; publishing is where the rules are enforced. See [schemas.md](schemas.md). |
| **Schema pin** | The schema version a batch was approved under. Every label in that batch is judged against that version, whatever is published later. See [batches.md](batches.md). |
| **Batch** | A unit of work: a set of assets somebody is going to label. Moves `draft`, `approved`, `in_annotation`, `completed`. See [batches.md](batches.md). |
| **Correction batch** | A batch cut from assets that already carry labels, to review or fix them. See [batches.md](batches.md). |
| **Job** | One segment of an approved batch, handed to one annotator (a person, or an agent). Moves `pending`, `in_progress`, `completed`. `--jobs-of N` on `batch approve` means N assets per job. Not the same as a background job. See [jobs.md](jobs.md). |
| **Background job** | A task the server runs for you, such as a model download or a thumbnail backfill. Unrelated to annotation jobs. See [background-jobs.md](background-jobs.md). |
| **Progress** | Where one asset has got to within a job: `unannotated`, `pre_labeled`, `annotated`, `skipped`, `review_pending`, `accepted`. A job can be completed only when every asset is `annotated`, `skipped` or `accepted`. See [jobs.md](jobs.md). |
| **Annotation** | One label on one asset: a class, a geometry and attributes, with provenance (`human` or `model`). See [annotations.md](annotations.md). |
| **Pre-label** | A model's first pass over a batch. Its labels arrive `pre_labeled`, never `annotated`, because nobody has judged them. See [batches.md](batches.md). |
| **Connection** | A configured model for pre-labeling: either `local` (weights on this machine) or `http` (an endpoint). Nothing is downloaded until you ask. See [inference.md](inference.md). |
| **Promotion** | Moving the assets of a completed batch into the project's trunk. `skipped` assets stay out. See [datasets.md](datasets.md). |
| **Trunk** (the dataset) | The project's curated set of assets and their labels: the current answer to "what is in our dataset?". A release is a frozen copy of it. See [datasets.md](datasets.md). |
| **Release** | An immutable, hash-verified snapshot of the trunk under a tag such as `v1.0`, optionally with a seeded train/val/test split. See [releases.md](releases.md). |
| **Format** | A file layout a release can be written in, such as `coco` or `yolo`. See [releases.md](releases.md). |
| **Target** | A trainer a release is exported for, such as `yolo11`. Each target resolves to exactly one format and may narrow what it carries. Use `--target` for a trainer and `--format` for a layout. See [releases.md](releases.md). |
| **Lossy export** | An export that cannot carry everything in the release. It is refused until you pass `--allow-lossy`; `--check` reports what would be lost without writing. See [releases.md](releases.md). |
| **Recipe** | A saved preprocessing spec applied at export: resize steps, augmentation, variants per image. Never changes the release. See [preprocessing.md](preprocessing.md). |
| **Token** | A named API credential for HTTP clients, shown once when created. The browser and MCP need none. See [auth.md](auth.md). |
| **Surface** | One way to drive VisionSet: the REST API, the CLI, MCP (for agents) or the browser app. All four are clients of the same SDK. See [surfaces.md](surfaces.md). |
