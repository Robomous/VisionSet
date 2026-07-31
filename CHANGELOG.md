# Changelog

All notable changes to VisionSet. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[PEP 440](https://peps.python.org/pep-0440/) for the Python distribution and the equivalent npm
semver for the frontend packages, both derived from the repository-root `VERSION`.

Six internal milestones (M1–M6) got here. The first five ended in a **git tag only** —
`v0.0.1-alpha.1` … `v0.0.1-alpha.5`, with `VERSION` sitting at `0.0.1.dev0` throughout, because
nothing was being distributed. This is the first version that is.

## [Unreleased]

### Fixed

- **The export report said polygons were not carried while YOLO and VOC wrote them as bounding
  boxes** (#158). `Exporter.supported_geometries` carried one meaning and was read with two
  intents: the compatibility report treated an unsupported geometry as absent from the output,
  while both lossy exporters converted it and wrote it. A user was told three annotations would be
  lost, consented, and received two of them back as boxes under the polygon's own class name — well
  formed in every way a validator can check, and not what the report promised.

  `Exporter` gained **`degraded_geometries`** (`{polygon}` for `yolo` and `voc`, empty for `coco`
  and `dummy`), and `ClassCompatibility.supported: bool` became **`status`**, one of `supported` /
  `degraded` / `dropped`. `excluded_annotations` and `excluded_assets` now count **dropped only**,
  with `degraded_annotations` / `degraded_assets` beside them; every `reason` says what actually
  happens to that class. `compatible` is still false for either, so the `allow_lossy` gate did not
  move — only the accounting became true. `GET /formats` publishes `degraded_geometries`, and
  `visionset export` prints the two outcomes on separate lines.

  Shipped with the guard that was missing: `tests/formats/test_report_agreement.py` exports one
  release through **every installed format** and counts the annotations in the artifacts on disk,
  so a report that disagrees with its own output fails — and a fourth exporter either lands a
  counter there or is declared non-writing.

  **Breaking for API clients**: `ClassCompatibilityOut.supported` is replaced by `status`, and
  `ExportCompatibilityOut` gains two fields. Regenerate any generated client.

## [0.0.1b1] — 2026-07-31

The first published artifact: video in, a training dataset out, and nothing to install but a
wheel.

### Added

**Export formats.** Three real exporters, each declaring what it can carry.

- **YOLO** detection — `data.yaml`, one label file per image, images laid out per split. Classes
  come from the release's frozen schema rather than from the annotations present, so a class
  nobody has used yet keeps its index and a new one cannot renumber the others.
- **COCO** instances — boxes *and* polygon segmentation in one document, per split. Lossless:
  everything COCO has no field for (attributes, confidence, provenance) rides in a `visionset`
  object per annotation, so a release of boxes and polygons exports with no consent at all.
- **Pascal VOC** — one XML per image, folds as `ImageSets/Main/*.txt` listings. Coordinates are
  1-based and inclusive, which is what the format means.

**Export validation.** Before anything is written, VisionSet works out exactly what a format would
drop from a release — per class, with annotation and asset counts — and refuses to drop it
silently. The report travels three ways: attached to the refusal, carried on the result, and
written into the export directory as `visionset-export-report.json`. `check_export` /
`GET /releases/{id}/export-compatibility` ask the same question without writing.

**One wheel, with the app inside it.** `scripts/build_dist.sh` builds the frontend, copies it into
the package, and builds the distribution — in that order, which is enforced rather than
documented. `tests/packaging/` then checks the artifact rather than the source tree: the bundle is
in it, built for the right base, the entry points ship, the version metadata agrees, nothing
enormous came along, and a clean-venv install serves `/ui` for real.

**The thirty-minute flow, as a CI gate.** `examples/thirty_minute_flow.py` drives project → clip →
50 frames → 50 boxes → verified release → YOLO export → `ultralytics` loading the result. CI runs
it from the installed wheel in an empty environment, with every stage named and timed.

**Documentation for people who have not seen the repository.** A real quickstart, an
[install guide](docs/install.md), a [first-dataset tutorial](docs/tutorial.md), a
[release runbook](docs/releasing.md), and an MCP tool reference generated from the server's own
listing so it cannot drift from what an agent is told.

### Changed

- **The MCP server no longer advertises `delete_project` unless it was started with
  `--allow-destructive`.** Four measured agent runs sent `confirm: true` on the *first* call,
  having read the parameter in the tool description — so `confirm` is an instruction rather than a
  gate when the caller is a model. `confirm` itself is unchanged and still correct for every other
  surface; the change is only whether an agent is shown the tool. **33 tools by default.**
- `Exporter` gained `supported_geometries` / `supported_modalities`, and `export` takes a
  read-only content reader — a manifest's `uri` is where bytes were first *seen*, not a file
  anything can open.

### Fixed

- **A classification tag is now unique per `(asset, class)`**, enforced by a partial index
  (migration 12, `FORMAT_VERSION` 12). Nothing had enforced it: the service judged against the
  pinned schema alone and never read the store.
- A release naming bytes that are gone or will not decode now fails the export by name
  (`EXPORT_SOURCE_UNREADABLE`) instead of producing a training set quietly missing an image.

### Known limits

- Ingest and export are **synchronous** — there is no job to poll, and a long video is a long call.
- Video-derived asset identity is reproducible within one ffmpeg build, not across versions.
- `mask`, `polyline`, keypoints and 3D geometries are named in the domain and not implemented.
- A zoom in the annotator is O(annotations) — pan and drag hold 60fps over 220 shapes, a zoom does
  not (#131).

---

## Milestones

Each alpha is a git tag, never published. They are listed because the tree is bisectable across
them and the numbers say what each one cost.

| | | | |
| --- | --- | --- | --- |
| **M1** — the SDK | `v0.0.1-alpha.1` | 2026-07-27 | The kernel: workspaces, projects, schemas, batches, jobs, annotations, datasets, releases, events — hexagonal, framework-free, 13 issues |
| **M2** — ingest | `v0.0.1-alpha.2` | 2026-07-27 | Where assets come from: image and video sources, decomposition, content-addressed storage, thumbnails, 8 issues |
| **M3** — surfaces | `v0.0.1-alpha.3` | 2026-07-29 | The same kernel three ways: a 53-operation REST API with a committed OpenAPI contract, a full CLI, 33 MCP tools, 15 issues |
| **M4** — the annotator | `v0.0.1-alpha.4` | 2026-07-31 | A headless annotation engine and a React renderer over it: command store, geometry, interaction machine, bbox/polygon/tag tools, 14 issues |
| **M5** — the browser client | `v0.0.1-alpha.5` | 2026-07-31 | The product shell: design system, data layer, every screen, and a browser cycle test that drives a real server, 12 issues |
| **M6** — the beta | `v0.0.1-beta.1` | 2026-07-31 | Exporters, the wheel, and the thirty-minute flow as a gate, 11 issues |

[0.0.1b1]: https://github.com/Robomous/VisionSet/releases/tag/v0.0.1-beta.1
