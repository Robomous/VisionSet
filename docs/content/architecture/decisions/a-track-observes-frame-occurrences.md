# A track observes frame occurrences

Status: **proposed** (#364). The direction was approved on 2026-11-26: keep content-addressed
media, model ordered frame occurrences separately, and give persistent sequence-scoped tracks
explicit observations. This page settles the details that approval left open. Slice 1, the
occurrence model, migration and importer writes, slice 2, the track and observation kernel
over REST, the CLI and MCP, slice 3, reading tracks and observing and unobserving in the browser,
and slice 4, tracks in the release manifest at version 7, are implemented - see
[annotations](../../annotations.md#a-track-observes-annotations-an-annotation-knows-nothing-of-tracks),
[the annotation workspace](../../ui/annotator.md#the-side-panel)
and [releases](../../releases.md#the-manifests-own-format-version). So is
[#1170](https://github.com/Robomous/VisionSet/issues/1170), MOTChallenge sequences in and out with
2D boxes over image-sequence sources - see [import](../../import.md#formats) and
[releases](../../releases.md#the-motchallenge-format); MOTS waits for raster masks. So is
[#1171](https://github.com/Robomous/VisionSet/issues/1171), CVAT XML 1.1 in and out as two named
dialects, CVAT for video's tracks over image-sequence sources with interpolation left unexpanded -
see [import](../../import.md#formats) and [releases](../../releases.md#the-cvat-xml-formats). So is
[#1199](https://github.com/Robomous/VisionSet/issues/1199), manifest version 9, which lists each
released image-sequence source's occurrences so those two exporters write every held frame, and
lets a timestamp be unknown - see [releases](../../releases.md#the-manifests-own-format-version).
The rest is not.

**Amended for slice 5 on 2026-11-26.** Neither imported identity had anything to land on: OpenLane
frames are stills with no source, and nuScenes keyframes are point-cloud scans with 3D boxes. The
amendment adds an ordered image-sequence source that an importer writes, so OpenLane's `track_id`
lands as a track. It kept tracking 2D, leaving nuScenes' `instance_token` a declared import loss,
until the next amendment.

**Amended for [#1189](https://github.com/Robomous/VisionSet/issues/1189) on 2026-11-27.** A track
may also follow a `cuboid_3d` through the scans of a point-cloud sequence, an ordered source an
importer writes as it writes an image sequence, so nuScenes' `instance_token` lands as a track. A
track's observations share one geometry type. Camera-calibrated 3D labels on images, and
`polyline_3d` in scans, are still never observed. It is implemented - see
[import](../../import.md#formats), [annotations](../../annotations.md#a-track-observes-annotations-an-annotation-knows-nothing-of-tracks)
and [releases](../../releases.md#the-manifests-own-format-version), at manifest version 11.

## The rule

**An asset is bytes. A frame occurrence is a position in a source. A track is a set of
observations, each naming an occurrence and an existing annotation.** The three never
substitute for one another.

- **Occurrence.** A `FrameOccurrence` is `(source_id, position, timestamp, asset_id)`, unique on
  `(source_id, position)`. `position` is the source-local ordinal of the extraction grid, the
  same ordinal the video importer already writes into the asset URI. Gaps and selected ranges are
  simply absent positions. Two positions that decode to identical bytes are two occurrences of
  one asset; `store_assets` keeps collapsing the bytes and the occurrence keeps the position.
- **Sequence scope.** A sequence is a `Source` of kind `video`, `image_sequence` or
  `point_cloud_sequence` and its occurrences. Every video import is a new source, so two imports of one clip are two sequences. A
  track belongs to exactly one source and never spans two.
- **Image sequences.** An `image_sequence` source is written only by an import, for stills the
  dataset itself orders, such as one OpenLane segment. Every import writes its own, so two imports
  of one segment are two sequences and equal external ids in them never merge. `position` is the
  frame's ordinal in the dataset's order and `timestamp` its time since the sequence's first frame,
or `null` when the dataset records no timing (never `0` in its place);
  a frame the dataset names but does not hold is an absent position, and a frame whose bytes repeat
  another is an occurrence of that asset. It is not a directory this process reads, so nothing
  ingests from it, and it carries no video provenance and no scan frame.
- **Point-cloud sequences.** A `point_cloud_sequence` source is the same for scans: written only by
  an import, for scans the dataset orders, such as one nuScenes scene, under the same rules for
  positions, timing, absent positions, repeated bytes and repeated imports. `position` is the
  scan's ordinal in the dataset's own order (for nuScenes, the scene's chain of samples), so a
  sample with no scan is an absent position. It declares no scan frame of its own: each scan's
  frame is the one its point-cloud directory source declares, and an import never reads a scan's
  labels in another frame, so every cuboid of one track is read in one frame and no observation
  carries or checks a calibration.
- **Track.** `Track(id, source_id, label_class, external_id?)`. `external_id` carries an imported
  identity (`instance_token`, `track_id`) and is unique per source. A track has at most one
  observation per occurrence.
- **Observation.** `(track_id, occurrence_id, annotation_id)`. The annotation stays an ordinary
  asset annotation: native geometry, schema-version validation and provenance are untouched, and
  `Annotation` gains no track field. An annotation is observed by at most one observation, so an
  asset that appears at two occurrences needs one annotation per occurrence it is tracked at.
- **What a track observes.** On an image occurrence, a 2D label; on a scan occurrence, a
  `cuboid_3d`. A camera-calibrated 3D label on an image and a `polyline_3d` in a scan are refused.
  Every observation of one track has the same geometry type, a rotated box counting as a box
  (#1209), so a track never mixes boxes and polygons, or boxes and cuboids
  (`TRACK_GEOMETRY_MISMATCH`); an import keeps a label that would mix them untracked and reports
  it. A track that mixed types before the rule keeps them: only adding an observation, or changing
  one's type, is judged.
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
`batch_asset` membership is unchanged and stays asset-based. Image-sequence and point-cloud-sequence
sources need no backfill: none existed before the amendments that added them.

## Work, correction and review

- **No new progress state.** The six per-asset states and the one-way batch and job lifecycle are
  unchanged. Track status is derived from the observed assets' progress and never stored.
- **Settling never propagates.** Accepting, skipping or promoting one asset says nothing about
  another asset in the same track. `pre_labeled` model output carries no track. A frame a
  completed batch settled `annotated` or `accepted` can reopen `pre_labeled` in a later batch with
  its observations intact, because seeding reads provenance alone; a pre-label run never replaces
  labels another batch confirmed, open or completed, so those observations survive, and observing
  anew there waits for the frame to be confirmed again.
- **Writes follow the annotation.** An observation is edited through the job and batch that may
  write its annotation. A structural operation (merge, split, class change, relink) is refused
  unless every observation it touches sits on an asset the actor may write, so a correction batch
  holding some observations cannot restructure the rest. A settled batch is never reopened.
- **Releases.** A published manifest is immutable and gains tracks at the next `MANIFEST_VERSION`.
  It lists a track's observations only for assets the release contains, ordered by source
  sequence and position, never by database id, so the hash stays deterministic. From version 9 it
  also lists each image-sequence source's occurrences of the assets it contains, observed or not,
  and from version 11 each point-cloud sequence's, which only a release holding one is written at.

## Interpolation and modality

- **Interpolation is deferred** from the first slices. When it arrives it is a preview that
  persists nothing; confirming it writes ordinary annotations with an explicit provenance value
  added for the purpose. It is never classified as `human` or `model` by omission, and paste never
  triggers it.
- **2D labels on images, cuboids on scans.** A nuScenes `instance_token` follows a `cuboid_3d`
  through a scene's lidar keyframes and lands as a track over a point-cloud sequence. Tracking a
  camera-calibrated 3D label through images, or a `polyline_3d` through scans, is deferred. A
  `group_label` is not an ordering, a timestamp or an ego pose, and no observation carries an ego
  pose: a scan sequence's cuboids are each in their own scan's sensor frame.

## Surfaces

The kernel owns the entities, the ports and a track service. REST, CLI, MCP and the browser read
and write through it and add no rule of their own. Decoding stays in the browser: this work
introduces no server-side video decoder.

## Slices

1. Occurrence model, migration and importer writes.
2. Track and observation kernel, REST, CLI and MCP.
3. Browser read and edit of tracks.
4. Release manifest bump.
5. OpenLane identity landing over image-sequence sources. Then #1170 and #1171.
6. nuScenes identity landing over point-cloud sequences (#1189).

Each slice needs tests for duplicate-content frames, missing frames, multi-source imports,
independent copy and paste, id collisions, partial correction batches, stable releases and
import loss.

## What this forbids

- a `previous_id` or track field on `Annotation`;
- using `(asset_id, frame_index)` as a tracking key;
- a track that spans sources, or a stored track status;
- a restructuring track operation that touches an asset the actor may not write;
- a server-side video decoder;
- an `image_sequence` or `point_cloud_sequence` source written by anything but an import;
- a track whose observations differ in geometry kind (a rotated box counts as a box); tracks that
  mixed kinds before #1189 are kept;
- a manifest that changes shape without a `MANIFEST_VERSION` bump.

## Why

The importer collapses identical frames into one asset, so an asset cannot say where in a clip it
occurred. Annotation-level links break on repeated frames, gaps and imported ids. Keeping the
annotation asset-scoped leaves the progress model, schema pins and releases alone.
