# An import is a labeled batch

An imported dataset enters a project through the same lifecycle as any other work: its labels
exist before the batch is approved, and the batch is approved, not bypassed. There is no
import-only path into the trunk.

## The rule

An import creates assets, a schema version, annotations and a batch, in that order, and then
approves the batch. Annotations are written with `provenance="import"` and `job_id=NULL`,
stamped with the schema version the import published. `BatchService.approve` already seeds an
asset that carries labels as `annotated`, so the imported assets arrive in the state a person
would otherwise have produced by labeling them.

The import stops there. It does not complete the batch and it does not promote it. A person
reviews the labels and promotes them through the normal flow, because a label from outside is
third-party truth and the `import` provenance exists so that stays visible.

The `Importer` port yields an `ImportedDataset`: the classes, the images it refers to by path
relative to the source, the labels keyed by that path, and a report of everything it could not
represent. It never yields `Annotation` rows, because an importer cannot know an `asset_id`
before the assets exist.

**Amended for [#1168](https://github.com/Robomous/VisionSet/issues/1168) on 2026-11-27.** A
TensorFlow Object Detection TFRecord holds its pictures inside its records, not beside them, so
an image path can name no file at all. An importer may also satisfy the optional
[`OpensPictures`](../../../../src/visionset/kernel/ports/importer.py) port: `open(src, path)`
answers a stream of the picture at a path the source holds no file for. `ImportService` asks it
only for such a path, in inspect and in commit alike, and an `OSError` from it is the `image` loss
a missing file is. The importer still touches no workspace, and nothing is written into the
source. An importer without `open` behaves exactly as before.

## Fidelity is computed per dataset

Whether an import is lossy depends on the file in hand, not on the format: a COCO file with
keypoints or RLE masks loses something, one with boxes does not. So the loss report is computed
from the content, and an import that would drop a class, a geometry or a label is refused
unless the caller passes explicit consent. An `inspect` step returns the same report without
writing anything. Nothing is dropped silently.

This mirrors `LossyExportNotConsented`, with one difference: an exporter declares `lossy` once
because its target format is fixed, and an importer cannot, because its source varies.

## What this forbids

- a service or route that writes annotations into a batch that is already `in_annotation` or
  `completed`, or into the trunk, to skip review;
- a synthesized job or round standing in for a labeling pass nobody ran;
- an importer that talks to the database, the blob store or a service - it reads a directory
  and returns a value;
- a silent drop of anything the kernel cannot represent, and a per-format `lossy` flag on an
  importer;
- auto-promotion of an import;
- re-sync. An import is one-shot; a second run of the same source adds nothing new because
  ingest deduplicates by content hash.

## What would go wrong without it

A direct-to-trunk write would be the first code path that moves membership without a batch,
and every invariant in the batch and job state machines would need an "unless imported"
clause. A synthesized job would put a round in the history that no one ran. A per-format flag
would tell a user a COCO import is safe right up to the file that is not.

See [Batches](../../batches.md) and [Datasets](../../datasets.md) for the lifecycle this rides on.
