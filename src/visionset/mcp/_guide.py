# usage: from visionset.mcp._guide import INSTRUCTIONS, WORKFLOW
"""What a connection tells an agent before it has called anything.

A cold agent otherwise learns the workflow from nothing but a tool listing, and
the order of the steps lives only in ``docs/content/mcp-walkthrough.md``, which an
agent connected over stdio cannot read. Two pieces, with different jobs:

* :data:`INSTRUCTIONS` is returned by ``initialize`` and is read **every session**,
  so it stays short: the order, the error envelope, the one coordinate trap.
* :data:`WORKFLOW` is served as the resource ``visionset://workflow`` and is read
  on demand, so it can say more without taxing every conversation.

Both describe only tools that exist; ``tests/mcp/test_guide.py`` asserts every
backticked tool name in them is registered, so a rename cannot leave the guide
pointing at nothing.
"""

from __future__ import annotations

from typing import Final

WORKFLOW_URI: Final = "visionset://workflow"
"""Where :data:`WORKFLOW` is served."""

INSTRUCTIONS: Final = """\
VisionSet builds computer-vision datasets. Typical order: `create_project` -> \
`create_schema_version` -> `ingest` (a directory of still images on the server's \
machine) -> `approve_batch` (start=true) -> loop { `next_pending_assets` -> \
`get_asset_image` -> `add_annotations`, or `set_asset_progress` to skip } -> \
`finish_batch` (promote=true) -> `publish_release` -> \
`check_export` -> `export_release`.

A refused call is still a normal result: `{"error": {"code", "message", \
"retry_with", "hint"}}` with `isError` false, so check for the `error` key. Retry \
only with the parameter `retry_with` names, and only when it is set. A call with an \
argument the tool does not declare, or the wrong type, fails with `isError` true.

Geometry is in the asset's own pixels. `get_asset_image` sends a smaller preview: \
multiply any coordinate you measured on it by `scale`. Video cannot be ingested \
here. Read `visionset://workflow` for the full walk-through; `visionset://pre-labeling`, \
`visionset://export` and `visionset://schema-changes` hold the detail behind those tools.
"""

WORKFLOW: Final = """\
# VisionSet workflow

1. **Project.** `list_projects`, `create_project`. A project owns a dataset.
2. **Schema.** `create_schema_version` with the classes and the geometries each allows
   (bbox, obb, polygon, polyline, keypoints, mask, classification_tag). A keypoints class may
   carry a `keypoints` spec: point `names` in order and `skeleton` edges as index pairs. A
   version never changes; the next one is a new version. `get_schema` shows the one in force.
3. **Ingest.** `ingest` reads one directory of images, top level only, into a draft
   batch. Anything unreadable is reported in `failures`.
4. **Open the work.** `approve_batch` freezes membership and pins the schema;
   `start_batch` (or `approve_batch` with `start=true`) opens its jobs.
5. **Annotate.** Loop: `next_pending_assets` for a job, `get_asset_image` to look,
   `add_annotations` to label, or `set_asset_progress` with `skipped` to pass on one.
   Coordinates are in the asset's native pixels; multiply preview coordinates by `scale`.
6. **Finish.** Once every asset is settled, `finish_batch` completes the jobs and the batch
   together; with `promote=true` it moves the finished work into the dataset.
   `complete_job` closes one job on its own, and `complete_batch` needs every job closed.
7. **Release.** `publish_release` freezes the dataset under a tag. `check_export` says what
   an export would drop; `export_release` writes it out for a target or format.

## When a call is refused

The answer is `{"error": {"code", "message", "retry_with", "hint", "index", "detail"}}`.
`code` is stable and is the same string the REST API uses. `retry_with` names the one
parameter that turns the refusal into the same call succeeding, and is null when nothing
should be retried. `hint` names what to call next when the message does not.

Read `allowed_actions` on a batch or job before acting: it lists what the state permits,
trimmed to actions that have a tool here. A job needs no start (the first write starts it),
and a batch `delete` is listed only when the server was started with destructive tools.

## Reference resources

- `visionset://pre-labeling`: what `get_pre_label_plan`, `pre_label_batch` and
  `pre_label_job` ask, touch, discard and refuse.
- `visionset://export`: `check_export`, `assess_recipe` and `export_release` statuses,
  destinations, lossy gates and recipes.
- `visionset://schema-changes`: additive versus destructive, and why `is_refused` ignores flags.
"""
