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
`complete_job` -> `complete_batch` (promote=true) -> `publish_release` -> \
`check_export` -> `export_release`.

A refused call is still a normal result: `{"error": {"code", "message", \
"retry_with", "hint"}}` with `isError` false, so check for the `error` key. Retry \
only with the parameter `retry_with` names, and only when it is set. A call with an \
argument the tool does not declare, or the wrong type, fails with `isError` true.

Geometry is in the asset's own pixels. `get_asset_image` sends a smaller preview: \
multiply any coordinate you measured on it by `scale`. Video cannot be ingested \
here. Read `visionset://workflow` for the full walk-through.
"""

WORKFLOW: Final = """\
# VisionSet workflow

1. **Project.** `list_projects`, `create_project`. A project owns a dataset.
2. **Schema.** `create_schema_version` with the classes and the geometries each allows
   (bbox, polygon, polyline, classification_tag). A version never changes; the next one is a
   new version. `get_schema` shows the one in force.
3. **Ingest.** `ingest` reads one directory of images, top level only, into a draft
   batch. Anything unreadable is reported in `failures`.
4. **Open the work.** `approve_batch` freezes membership and pins the schema;
   `start_batch` (or `approve_batch` with `start=true`) opens its jobs.
5. **Annotate.** Loop: `next_pending_assets` for a job, `get_asset_image` to look,
   `add_annotations` to label, or `set_asset_progress` with `skipped` to pass on one.
   Coordinates are in the asset's native pixels; multiply preview coordinates by `scale`.
6. **Finish.** `complete_job` for each job, then `complete_batch`. `complete_batch` with
   `promote=true` moves the finished work into the dataset.
7. **Release.** `publish_release` freezes the dataset under a tag. `check_export` says what
   an export would drop; `export_release` writes it out for a target or format.

## When a call is refused

The answer is `{"error": {"code", "message", "retry_with", "hint", "index", "detail"}}`.
`code` is stable and is the same string the REST API uses. `retry_with` names the one
parameter that turns the refusal into the same call succeeding, and is null when nothing
should be retried. `hint` names what to call next when the message does not.

Read `allowed_actions` on a batch or job before acting: it lists what the state permits,
including actions that have no tool on this surface.
"""
