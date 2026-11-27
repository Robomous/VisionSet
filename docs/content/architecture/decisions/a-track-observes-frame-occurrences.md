# A track observes frame occurrences

Status: **proposed** (#364). The direction was approved on 2026-11-26: keep content-addressed
media, model ordered frame occurrences separately, and give persistent sequence-scoped tracks
explicit observations. This page settles the details that approval left open. Slice 1, the
occurrence model, migration and importer writes, slice 2, the track and observation kernel
over REST, the CLI and MCP, and slice 4, tracks in the release manifest at version 7, are
implemented - see
[annotations](../../annotations.md#a-track-observes-annotations-an-annotation-knows-nothing-of-tracks)
and [releases](../../releases.md#the-manifests-own-format-version); the rest is not, and
[#1170](https://github.com/Robomous/VisionSet/issues/1170) and the video variant of
[#1171](https://github.com/Robomous/VisionSet/issues/1171) stay blocked until the slices below ship.

**Amended for slice 5 on 2026-11-26.** Neither imported identity had anything to land on: OpenLane
frames are stills with no source, and nuScenes keyframes are point-cloud scans with 3D boxes. The
amendment adds an ordered image-sequence source that an importer writes, so OpenLane's `track_id`
lands as a track, and keeps tracking 2D: nuScenes' `instance_token` stays a declared import loss.

## The rule

**An asset is bytes. A frame occurrence is a position in a source. A track is a set of
observations, each naming an occurrence and an existing annotation.** The three never
substitute for one another.

- **Occurrence.** A `FrameOccurrence` is `(source_id, position, timestamp, asset_id)`, unique on
  `(source_id, position)`. `position` is the source-local ordinal of the extraction grid, the
  same ordinal the video importer already writes into the asset URI. Gaps and selected ranges are
  simply absent positions. Two positions that decode to identical bytes are two occurrences of
  one asset; `store_assets` keeps collapsing the bytes and the occurrence keeps the position.
- **Sequence scope.** A sequence is a `Source` of kind `video` or `image_sequence` and its
  occurrences. Every video import is a new source, so two imports of one clip are two sequences. A
  track belongs to exactly one source and never spans two.
- **Image sequences.** An `image_sequence` source is written only by an import, for stills the
  dataset itself orders, such as one OpenLane segment. Every import writes its own, so two imports
  of one segment are two sequences and equal external ids in them never merge. `position` is the
  frame's ordinal in the dataset's order and `timestamp` its time since the sequence's first frame;
  a frame the dataset names but does not hold is an absent position, and a frame whose bytes repeat
  another is an occurrence of that asset. It is not a directory this process reads, so nothing
  ingests from it, and it carries no video provenance and no scan frame.
- **Track.** `Track(id, source_id, label_class, external_id?)`. `external_id` carries an imported
  identity (`instance_token`, `track_id`) and is unique per source. A track has at most one
  observation per occurrence.
- **Observation.** `(track_id, occurrence_id, annotation_id)`. The annotation stays an ordinary
  asset annotation: native geometry, schema-version validation and provenance are untouched, and
  `Annotation` gains no track field. An annotation is observed by at most one observation, so an
  asset that appears at two occurrences needs one annotation per occurrence it is tracked at.
- **Class consistency.** An observation's annotation class equals the track's class. Changing a
  class is a track operation that rewrites every observation atomically or refuses.
- **Gaps and reappearance.** A track ends where its observations end and reappears wherever a
  later observation exists. There is no stored end marker and no `occluded` observation.
- **Merge and split.** Merge requires the same source and disjoint occurrences. Split cuts at an
  occurrence and moves the later observations to a new track. Both are one transaction.
- **Deletion.** Deleting an annotation deletes its observation. Deleting a track deletes only its
  observations; deleting the annotations as well is a separate, explicit operation.
- **Untracked annotations** remain the normal case. Copy and paste mints a fresh annotation id,
  so a pasted annotation is never observed ([annotations](../../annotations.md)).

## Migration

A migration adds `frame_occurrence`, `track` and `track_observation`. It backfills occurrences
from assets of `video` sources whose `source_id` and `frame_index` are set. Image-directory
animations are excluded because two files share frame 0. That is the first-seen origin only: the
origins `store_assets` discarded are not recoverable, and the migration does not invent them. A
historical source may therefore have fewer occurrences than frames it was extracted with, and a
track can only observe an occurrence that exists. New video imports write every occurrence.
`batch_asset` membership is unchanged and stays asset-based. Image-sequence sources need no
backfill: none existed before the amendment.

## Work, correction and review

- **No new progress state.** The six per-asset states and the one-way batch and job lifecycle are
  unchanged. Track status is derived from the observed assets' progress and never stored.
- **Settling never propagates.** Accepting, skipping or promoting one asset says nothing about
  another asset in the same track. `pre_labeled` model output carries no track.
- **Writes follow the annotation.** An observation is edited through the job and batch that may
  write its annotation. A structural operation (merge, split, class change, relink) is refused
  unless every observation it touches sits on an asset the actor may write, so a correction batch
  holding some observations cannot restructure the rest. A settled batch is never reopened.
- **Releases.** A published manifest is immutable and gains tracks at the next `MANIFEST_VERSION`.
  It lists a track's observations only for assets the release contains, ordered by source
  sequence and position, never by database id, so the hash stays deterministic.

## Interpolation and modality

- **Interpolation is deferred** from the first slices. When it arrives it is a preview that
  persists nothing; confirming it writes ordinary annotations with an explicit provenance value
  added for the purpose. It is never classified as `human` or `model` by omission, and paste never
  triggers it.
- **Video and image sequences with 2D geometry only.** Point-cloud and calibrated 3D tracking is
  deferred, so a nuScenes `instance_token`, which follows a 3D box through lidar keyframes, stays a
  declared import loss. A `group_label` is not an ordering, a timestamp or an ego pose.

## Surfaces

The kernel owns the entities, the ports and a track service. REST, CLI, MCP and the browser read
and write through it and add no rule of their own. Decoding stays in the browser: this work
introduces no server-side video decoder.

## Slices

1. Occurrence model, migration and importer writes.
2. Track and observation kernel, REST, CLI and MCP.
3. Browser read and edit of tracks.
4. Release manifest bump.
5. OpenLane identity landing over image-sequence sources; nuScenes identity waits for 3D
   tracking. Then #1170 and #1171.

Each slice needs tests for duplicate-content frames, missing frames, multi-source imports,
independent copy and paste, id collisions, partial correction batches, stable releases and
import loss.

## What this forbids

- a `previous_id` or track field on `Annotation`;
- using `(asset_id, frame_index)` as a tracking key;
- a track that spans sources, or a stored track status;
- a restructuring track operation that touches an asset the actor may not write;
- a server-side video decoder;
- an `image_sequence` source written by anything but an import;
- a manifest that changes shape without a `MANIFEST_VERSION` bump.

## Why

The importer collapses identical frames into one asset, so an asset cannot say where in a clip it
occurred. Annotation-level links break on repeated frames, gaps and imported ids. Keeping the
annotation asset-scoped leaves the progress model, schema pins and releases alone.
