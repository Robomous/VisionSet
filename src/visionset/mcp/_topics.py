# usage: from visionset.mcp._topics import TOPICS
"""Long-form reference served as resources, so tool descriptions can stay short.

Every tool description is read on every session; the rationale and edge cases
behind pre-labeling, export and schema changes are read only when an agent needs
them. Each description names the resource that holds the rest, and
``tests/mcp/test_guide.py`` asserts every ``visionset://`` URI mentioned anywhere
is served.
"""

from __future__ import annotations

from typing import Final, NamedTuple


class Topic(NamedTuple):
    uri: str
    name: str
    text: str


PRE_LABELING_URI: Final = "visionset://pre-labeling"
EXPORT_URI: Final = "visionset://export"
SCHEMA_CHANGES_URI: Final = "visionset://schema-changes"
ANNOTATION_GEOMETRY_URI: Final = "visionset://annotation-geometry"

PRE_LABELING: Final = """\
# Pre-labeling

Applies to `get_pre_label_plan`, `pre_label_batch`, `pre_label_job` and
`pre_label_project`. Pre-labeling asks a model connection to label assets and
writes what it finds at `pre_labeled`, never at `annotated`: nobody judged it, so
it stays editable and out of the dataset until somebody does.

## Which classes a run asks about

The batch's pinned schema is the prompt. A run does not ask about every class the
schema declares, only the ones the model's answer can be written as: a class
admitting a shape the run writes and demanding no attribute a prediction cannot
supply. An answer naming one of those classes, matched case-insensitively, is
written under the schema's own spelling. A schema with nothing askable is refused
before anything runs.

`get_pre_label_plan` is a single read that shows this before the long call:

- `asked_classes` is the prompt itself, in the schema's own spelling.
- `produces` is the shapes the run would write: every shape the connection's model
  answers in, or exactly `geometries` when you name some. A schema of polygon
  classes is askable of a model that answers polygons and refused for one that
  answers boxes; a boxes-only selection of a model that answers both leaves every
  polygon-only class out.
- `excluded_classes` names the rest, each with every reason: `no_producible_geometry`
  (the class admits no shape the model produces) and `required_attribute` (the class
  demands an attribute value and a model's answer carries none). Both can hold at
  once, which is why `reasons` is a list.
- Every class of the pinned schema is in exactly one of the two lists;
  `schema_version` is the pin both came from, and a re-pin changes both.

Pass the same `geometries` to the plan as to the run. Every run result carries its
own `plan`: read it whenever `assets_labeled` is lower than expected, because a run
that asked about two of five classes labels nothing under the other three and the
counters cannot say so.

## Geometries

A run writes every shape the model produces unless `geometries` says which. A model
declaring both a box and a polygon writes both for every region it answers with,
unpaired. `geometries` filters to the shapes named and a region in any other shape
is counted in `regions_discarded`. Naming a shape the model does not produce is
refused before anything runs.

## Which assets a run touches

Only assets nothing has touched, which is not the same as assets reading
`unannotated`. An asset already `pre_labeled`, annotated, skipped, awaiting review
or accepted is passed over, and so is an `unannotated` one that still carries
annotations from a round that was skipped and later restored (that sequence deletes
no labels). A frame already pre-labeled is never re-asked about by a plain call, at
any confidence.

`replace_model_labels` is the deliberate exception: it also reaches every frame
still `pre_labeled` and supersedes the model's labels with this call's answer, one
frame per transaction. A frame the model now finds nothing on returns to
`unannotated`; `annotations_replaced` says how many labels went. A frame anyone
edited, confirmed or skipped in the batch is never touched either way, and neither
is a frame another batch, open or completed, holds `annotated`, `review_pending` or
`accepted`, or one already in the dataset; `assets_protected` says how many were passed
over. The model's own labels from an earlier run in this job stay replaceable unless
another batch confirmed them after this job wrote them. This cannot be undone: read
`progress.pre_labeled` on `get_batch` or `get_job` first.

An asset somebody starts working while the call is running is passed over rather
than failing the call; `assets_skipped` says how many.

## What is discarded rather than fatal

- A region that could not be written as the class it named (a label naming no phrase
  asked for, or a shape the class does not admit or the model never declared) is
  discarded and counted in `regions_discarded`. A text-prompted detector answers with
  text decoded from spans over the prompt, so a span crossing the boundary between
  two phrases can answer with neither; a model declaring two shapes may answer in
  the one a class does not take.
- A mapped region with no overlap with a measured asset is counted separately in
  `regions_out_of_bounds`; an asset without dimensions remains eligible.

## Blocking, progress and interruption

These calls block until every job is done: a stdio server has no background worker,
so a queued run would answer with a job id nothing would ever claim (the REST API
queues it instead, because it has a dispatcher). The run does one forward pass per
untouched asset, so expect minutes for a batch of any size; on a CPU a local model
took about a minute and a half per image. A client that sends a `progressToken` gets
a progress notification as assets are considered, with the total once it is exact; a
client that resets its request timeout on progress keeps waiting, and one that
ignores progress must set its request timeout for the whole run.

Interrupting is safe. A plain run only writes to an asset nothing has touched and
commits one asset's labels in the same transaction as its move to `pre_labeled`, so
a cut-off call has entered some prefix of the assets and touched nothing else.
Calling again resumes with whatever is still untouched (plus, with
`replace_model_labels`, the frames still `pre_labeled`) rather than starting over or
double-writing.

## Batch versus job

`pre_label_batch` runs once per open job and reports each as an item in `items`,
with its own `job_id` and `plan`; a job already `completed` is passed over, since a
batch finished half in the annotator is the ordinary case. `annotations_written` at
the top is the total. `pre_label_job` is the same run for one job and refuses a
`completed` one: naming a job is a decision to run it, and a finished one has
nothing left to write. The schema is pinned to the batch, so both ask the same
classes.

## Refusals

Before anything runs: a batch that is not `in_annotation`, a job that is
`completed` (`pre_label_job`), a connection whose model answers places rather than
words, a schema with nothing askable, and a deployment without the local runtime
(the install command is in the message).
"""

EXPORT: Final = """\
# Exporting a release

Applies to `check_export`, `assess_recipe` and `export_release`.

## Target or format

Give exactly one of `target` and `format`; both or neither is refused. A target is
the model the release will train (`list_export_targets` names them) and resolves to
the format that writes for it; the export then carries only the geometries that
trainer has a task for, and the report names the target. A format addresses no
trainer. So `target="yolov10"` can report a polygon class `dropped` where
`format="ultralytics"` reports it `supported`.

## What a check reports

`check_export` reads the release's frozen manifest and judges every class against
what the format declares it can write, so the numbers are exact. Each class has a
`status`:

- `supported`: written as it stands.
- `dropped`: not in the output at all. `excluded_annotations` counts those labels and
  `excluded_assets` the assets that arrive with at least one missing.
  `untagged_assets` counts the assets a single-tag format (`classification-dir`)
  leaves out whole because they carry no classification tag.
- `degraded`: in the output, reduced (a polygon written as its axis-aligned bounding
  box, as `yolov5-yaml` and `voc` do), counted by `degraded_annotations` and
  `degraded_assets`. `reason` says which.

`compatible` true means the format loses nothing from this release and
`export_release` runs without `allow_lossy`. False means it refuses until you pass it;
the same report comes back with that refusal and is written to the export directory
as `visionset-export-report.json`, so checking first is a convenience.

A class with zero annotations never makes a release incompatible, whatever its
status; those rows are still listed with their zeros.

`compatible` is not a format's `lossy` flag in `list_formats`. That flag covers what
a geometry list cannot see (attributes, confidence, provenance) and is true of the
format forever; `compatible` is about the labels this release holds.

## Destination

`dest` must be an absolute path outside the workspace, and either missing or an empty
directory; it is created if missing. Anything else is refused with
`EXPORT_DESTINATION_REFUSED`: a relative or `~` path, the workspace or a directory
inside or above it, a file, or a directory that cannot be created. A directory that
already holds files is refused with `EXPORT_DESTINATION_NOT_EMPTY` unless
`allow_non_empty=true`, and is never emptied; its files are counted in `file_count`
and `total_bytes`.

## Integrity

Every image the release names is checked against its content hash before anything is
written. A missing or altered one refuses the export with `EXPORT_SOURCE_UNREADABLE`;
`verify_release` says which.

## Lossy exports

A format that cannot express everything the release holds refuses until you pass
`allow_lossy=true`. That is a different gate from `confirm`: nothing is destroyed, and
what you consent to is an incomplete copy. Two things trigger it: a format that
declares itself lossy, and a format whose declared capabilities cannot carry a class
the release uses. Call `check_export` for the numbers, or read the report off the
refusal.

## Report file

Every successful export writes `visionset-export-report.json` into `dest`, saying
what was and was not carried. It is the kernel's file, not the format's, and is
excluded from `file_count`.

## Recipes

`recipe` applies one of the project's pre-processing recipes (`list_preprocessing_recipes`):
every image is resized as the recipe says and augmented variants are written for the
train fold, named `<hash>-aug<k>` beside their source. The result separates
`source_file_count` from `augmented_file_count`, and `preprocessing` carries the recipe
as it ran, its hash, the Pillow version and a file-to-source mapping; the report on
disk carries the same. An augmenting recipe refuses a release published without a
split, a step refuses a geometry it cannot move, and `AUGMENTATION_INCOMPATIBLE` names
every step the export's target or the registry cannot vouch for, such as a flip over
keypoints a target trains for pose. `check_export` with the same
`recipe` refuses what the export would, and its report is otherwise unchanged by it.

## Assessing a draft recipe

`assess_recipe` takes a spec rather than a recipe name, so a recipe can be judged
before it is saved. It never refuses for the recipe: what `export_release` with
`allow_lossy=true` would refuse it with comes back as `refusal` (`code` and
`message`), beside `resolution`, every step's verdict and reasons per class and
geometry. When nothing refuses, `counts` says what the export would write:
`source_files` (the images the format reads), `augmented_files`, the files in each
fold (null without a split) and the labels a cropping resize cuts away
(`dropped_labels`) or down (`clipped_labels`). Consent is not judged: without
`allow_lossy`, a lossy format or a cropping resize is refused for the loss first,
and `check_export` says whether it will be.
"""

SCHEMA_CHANGES: Final = """\
# Changing a schema

Applies to `preview_schema_change`, `compare_schema_versions`,
`create_schema_version` and `repin_batch`.

## Additive and destructive

`diff.is_destructive` true means the proposal narrows the contract: a class or an
attribute is gone, or a class lost one of its geometries. `diff.destructive_classes`
names them, and applying it needs `allow_destructive=true`. Adding classes, optional
attributes or another geometry to a class is additive and needs no flag. Matching
against the current version is by exact class name, so a rename reads as one removal
plus one addition.

A keypoint spec counts too. Adding one to a class that already accepts keypoints, or
renaming, adding, removing or reordering its `names`, is destructive for that class's
keypoints annotations, and refused outright while any exist. Removing the spec, or
changing only its `skeleton`, is additive.

## `is_refused` is the answer no flag changes

True means annotations already exist under a class the proposal drops, so
`create_schema_version` refuses outright however you call it. `blockers` names each
such class with how many annotations and assets it carries. Do not retry with
`allow_destructive=true`: that flag answers a different refusal and retrying is a
loop. Either keep the class, or delete the annotations `blockers` counts and preview
again. `list_blocking_assets` pages through the assets that carry them.

## Advisory

A preview locks nothing. Somebody can label a class between the preview and the
publish, in which case the publish refuses and that refusal is the authoritative one.

## Comparing versions

`compare_schema_versions` returns the same classification for two versions that
already exist. Order matters (1 to 2 and 2 to 1 are different questions) and a version
compared with itself is an empty diff. Its caller is `repin_batch`: a batch is judged
against the version it pinned at approval, so compare the pinned version (`get_batch`)
with the active one (`get_schema`) first. `is_destructive` false means the re-pin needs
no flag.
"""

ANNOTATION_GEOMETRY: Final = """\
# Annotation geometry

Applies to `add_annotations` and `update_annotations`. Every 2D coordinate is in the
asset's own pixels, never normalized. `type` selects the shape:

- `bbox`: `x`, `y` (top-left corner), `width`, `height`.
- `obb`: a rotated rectangle: `cx`, `cy` (its centre), `width`, `height` (both above
  zero) and `angle` in radians. The width side runs along `(cos angle, sin angle)` with
  y down, so a positive angle turns clockwise on screen. Stored canonical: `width >=
  height` and `angle` in `[-pi/2, pi/2)` (a square's in `[-pi/4, pi/4)`), so a read may
  spell a box differently from the write and still draw the same pixels.
- `polygon`: `points`, at least three `[x, y]` pairs; the ends join.
- `polyline`: `points`, at least two `[x, y]` pairs in order; the ends do not join.
- `polyline_3d`: `points`, at least two `[x, y, z]` triples in order, never pixels.
- `cuboid_3d`: `center` `[x, y, z]` (the box's middle), `size` `[length, width, height]`
  and `yaw` in radians. Every size is above zero: `length` runs along the heading,
  `width` across it. `yaw` lies within `[-pi, pi]` and is refused outside it rather
  than wrapped. No `visibility`.
- `mask`: a binary pixel mask over the whole asset. `size` is `[height, width]` and must
  equal the asset's pixel size (else `ANNOTATION_GEOMETRY_OUT_OF_BOUNDS`); `counts` is
  the COCO compressed RLE string over the pixels in column-major order, first run
  background. The runs must sum to `height * width`; uncompressed run lists are not
  accepted. Stored canonical, so a read may spell `counts` differently from the write.
  One mask is one annotation of one class: a class-id map becomes one mask per class.
- `keypoints`: `points`, at least one `[x, y]` pair in order. The position is the
  point's identity: points are never reordered, deduplicated, padded or truncated, and
  two may share a pixel. When the class declares a keypoint spec (`get_schema`), send
  exactly one point per name in the spec's order, or the write is refused with
  `KEYPOINT_COUNT_MISMATCH`; without a spec, any count of at least one is accepted.
  Optional `visibility` as for a polyline, below. The skeleton constrains no point.
- `classification_tag`: no coordinates.

The 3D frame depends on the asset's modality; see the next two sections.

## On an image, 3D labels need a calibration

On an image, 3D coordinates are metres in the camera's sensor frame (x right, y down,
z forward). A cuboid's `height` runs along y, `yaw` turns about +y (down), and the
heading is +x at `0`, in general `(cos yaw, 0, -sin yaw)`.

A `polyline_3d` or `cuboid_3d` is read against its asset's calibration: the asset's own override
when it has one, else its source's (`get_calibration`). Writing one to an asset with
neither is refused with `CALIBRATION_MISSING`; `set_calibration` first. No image-frame
bounds check applies to a 3D point.

## On a point-cloud scan, 3D labels use the source's frame

On a scan, 3D coordinates are in the frame its source declares (`lidar_flu`,
`lidar_rfu` or `camera_rdf`; the source's `frame`), not the camera's. A cuboid's
`height` runs along that frame's up axis; `yaw` turns counter-clockwise about up seen
from above, and at `0` the heading is the frame's forward axis: `(cos yaw, sin yaw, 0)`
on `lidar_flu`, `(-sin yaw, cos yaw, 0)` on `lidar_rfu`. On `camera_rdf` up is -y and the
heading is `(-sin yaw, 0, cos yaw)`: +z at `0`, not the +x an image uses on the same axes.

A scan needs no calibration, and `set_calibration` on one is refused with
`CALIBRATION_NOT_APPLICABLE`. A 3D label on a scan whose source declares no frame is
`CALIBRATION_MISSING`. A scan has no pixels: `bbox`, `obb`, `polygon`, `polyline`,
`keypoints` and `mask` on one are refused with `INVALID_ANNOTATION`;
`classification_tag` is accepted.

## Vertex visibility

A polyline, a `polyline_3d` or a `keypoints` may carry `visibility`, one state per point and
in the same order:
`0` unlabeled (nobody judged the vertex), `1` occluded (judged, and hidden), `2`
visible (judged, and seen). Only those integers are accepted; `true`, `"2"` and
`2.0` are refused, and so is `null`.

**Omit the key when you do not know.** An absent `visibility` means nobody said,
which is not the same as every vertex visible, and it is never answered as `null`.
A list whose length differs from `points` is refused, never padded or truncated.

**An update replaces the whole geometry, so resend it to keep it.**
`update_annotations` takes the geometry you send as the new one: if you move a
point and leave `visibility` out, the stored visibility is cleared. Copy it from
`list_asset_annotations`, and adjust it with the points — add or remove the state
of a vertex you add or remove.
"""

TOPICS: Final = (
    Topic(PRE_LABELING_URI, "pre-labeling", PRE_LABELING),
    Topic(EXPORT_URI, "export", EXPORT),
    Topic(SCHEMA_CHANGES_URI, "schema-changes", SCHEMA_CHANGES),
    Topic(ANNOTATION_GEOMETRY_URI, "annotation-geometry", ANNOTATION_GEOMETRY),
)
"""Every extra resource :func:`visionset.mcp.main.build_server` serves."""
