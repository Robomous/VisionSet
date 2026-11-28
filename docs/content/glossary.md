# Glossary

These terms describe how media becomes a curated dataset and a published release.

| Term | Means |
| --- | --- |
| **Workspace** | The directory holding everything VisionSet knows: the metadata database (`visionset.db`) and the content-addressed blobs. One server or CLI invocation works on one workspace. Created by `visionset init`. See [workspaces.md](workspaces.md). |
| **Project** | One dataset effort inside a workspace, such as `road-signs`. Has a unique name, a schema, sources, batches, a trunk and releases. Commands take its name or its id. See [projects.md](projects.md). |
| **Source** | Where assets came from: a directory of still images registered with the project, a directory of point-cloud scans registered with its frame, a video imported through the browser, or an image or point-cloud sequence recorded by an import. See [sources.md](sources.md). |
| **Asset** | One image or one point-cloud scan. Identical bytes identify the same asset within a project. The workspace can share the stored bytes across projects. See [ingest.md](ingest.md). |
| **Modality** | What an asset holds: `image` or `point_cloud`. A scan has no pixels, so the pixel-space geometries (`bbox`, `polygon`, `polyline`) are refused on one. See [media.md](media.md#point-cloud-scans). |
| **Scan** (point cloud) | One PCD or PLY file of 3D points, ingested as one `point_cloud` asset. Viewed and labeled in a 3D view in the browser. See [media.md](media.md#point-cloud-scans). |
| **Scan frame** | The axis convention a point-cloud source declares for its scans: `lidar_flu`, `camera_rdf` or `lidar_rfu`. A scan's coordinates and 3D labels are stored in it, never re-expressed. See [sources.md](sources.md#point-cloud-directories-and-their-frame). |
| **Calibration** | A camera's intrinsics, extrinsics and optional distortion, stated on an image source with an optional per-asset override. A 3D label on an image is read against it; a scan needs none. See [sources.md](sources.md#camera-calibration). |
| **Schema** | The versioned definition of what may be labeled: classes, the geometries each allows, and their attributes. A new version is published; versions are never edited. See [schemas.md](schemas.md). |
| **Schema draft** | A schema version still being written. It may be empty or incomplete; publishing is where the rules are enforced. See [schemas.md](schemas.md). |
| **Schema pin** | The schema version used to validate labels in a batch. Approval sets the pin. The pin can advance while the batch is open and is frozen on completion. See [batches.md](batches.md). |
| **Batch** | A unit of work: a set of assets somebody is going to label. Moves `draft`, `approved`, `in_annotation`, `completed`. See [batches.md](batches.md). |
| **Correction batch** | A batch cut from assets that already carry labels, to review or fix them. See [batches.md](batches.md). |
| **Job** | One segment of an approved batch, handed to one annotator (a person, or an agent). Moves `pending`, `in_progress`, `completed`. `--jobs-of N` on `batch approve` means N assets per job. Not the same as a background job. See [jobs.md](jobs.md). |
| **Background job** | A task the server runs for you, such as a model download or a thumbnail backfill. Unrelated to annotation jobs. See [background-jobs.md](background-jobs.md). |
| **Progress** | Where one asset has got to within a job: `unannotated`, `pre_labeled`, `annotated`, `skipped`, `review_pending`, `accepted`. A job can be completed only when every asset is `annotated`, `skipped` or `accepted`. See [jobs.md](jobs.md). |
| **Annotation** | One label on one asset: a class, a geometry and attributes, with provenance (`human`, `model`, or `import`). See [annotations.md](annotations.md). |
| **Track** | One object followed through one video, image-sequence or point-cloud-sequence source: a class and a set of observations, each naming a frame occurrence and an existing annotation drawn there. An annotation carries no track field. See [annotations.md](annotations.md#a-track-observes-annotations-an-annotation-knows-nothing-of-tracks). |
| **Pre-label** | A model's first pass over a batch. Its labels arrive `pre_labeled`, never `annotated`, because nobody has judged them. See [batches.md](batches.md). |
| **Connection** | A configured model for pre-labeling: either `local` (weights on this machine) or `http` (an endpoint). Nothing is downloaded until you ask. See [inference.md](inference.md). |
| **Promotion** | Moving the assets of a completed batch into the project's trunk. `skipped` assets stay out. See [datasets.md](datasets.md). |
| **Trunk** (the dataset) | The project's curated set of assets and their labels: the current answer to "what is in our dataset?". A release is a frozen copy of it. See [datasets.md](datasets.md). |
| **Release** | An immutable, hash-verified snapshot of the trunk under a tag such as `v1.0`, optionally with a seeded train/val/test split. See [releases.md](releases.md). |
| **Format** | A file layout for reading a labeled dataset or writing a release, such as `coco` or `ultralytics`. See [releases.md](releases.md). |
| **Target** | A trainer a release is exported for, such as `yolo11`. Each target resolves to exactly one format and may narrow what it carries. Use `--target` for a trainer and `--format` for a layout. See [releases.md](releases.md). |
| **Lossy export** | An export that cannot carry everything in the release. It is refused until you pass `--allow-lossy`; `--check` reports what would be lost without writing. See [releases.md](releases.md). |
| **Recipe** | A saved preprocessing spec applied at export: resize steps, augmentation, variants per image. Never changes the release. See [preprocessing.md](preprocessing.md). |
| **Token** | A named API credential for HTTP clients, shown once when created. The browser app normally signs in with a session cookie. The workspace-backed MCP server uses local access. See [auth.md](auth.md). |
| **Surface** | One way to drive VisionSet: the REST API, the CLI, MCP (for agents) or the browser app. All four are clients of the same SDK. See [surfaces.md](surfaces.md). |
