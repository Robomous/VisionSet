# usage: registered as job type "assets.backfill_thumbnails"
"""The thumbnail-backfill handler: render the previews a project is missing.

**A background job because of how long it is.** One decode and one JPEG encode
per asset without a preview, over a project that may hold thousands, is more
than a request should wait behind. The route answers 202 and points at a row.

**The work itself is one call.** ``IngestService.backfill_thumbnails`` is what
the CLI and the MCP tool run too, and the result is the same projection they
print, so the three surfaces cannot disagree about what a pass found.

**Idempotent.** Only assets with no preview are examined, and the last phase
re-reads each before writing, so a re-run after a crash finishes what the dead
attempt left and touches nothing else.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

from pydantic import JsonValue

from visionset.jobs.context import workspace_for
from visionset.jobs.registry import HandlerRef, register
from visionset.kernel.ports import ProgressReporter
from visionset.kernel.services import IngestService
from visionset.wire import thumbnail_backfill

JOB_TYPE = "assets.backfill_thumbnails"

PROJECT_KEY = "project_id"

HANDLER = register(HandlerRef(type=JOB_TYPE, func=f"{__name__}:run", idempotent=True))


def payload_for(project_id: UUID) -> dict[str, JsonValue]:
    """The payload this handler expects, built where the type is known."""
    return {PROJECT_KEY: str(project_id)}


def run(
    workspace_root: Path,
    payload: dict[str, JsonValue],
    reporter: ProgressReporter,
) -> dict[str, JsonValue]:
    """Backfill the named project's missing previews and say what that came to.

    ``reporter`` is consulted once, before starting: the pass is one call whose
    rendering phase is in no transaction, so there is no boundary inside it at
    which stopping leaves anything but what a re-run would resolve.
    """
    if reporter.is_cancelled():
        return {}
    project_id = UUID(str(payload[PROJECT_KEY]))
    workspace = workspace_for(workspace_root)
    return thumbnail_backfill(IngestService(workspace).backfill_thumbnails(project_id))
