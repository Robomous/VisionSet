# usage: registered as job type "export.release"
"""The export handler: write a release through a format plugin, then archive it.

**This is the code that moved.** Every line below was in
``routes/releases.py::export_release``, running inside the request that asked for
it: clear the destination, call ``ReleaseService.export``, zip the result. The
route now enqueues and answers ``202``; the work is the same work.

**It is also why this package is not in the kernel.** Turning a format *name*
into an ``Exporter`` means ``visionset.formats.registry``, and import-linter
forbids ``visionset.kernel`` from importing it — the same wall that makes
``ReleaseService.export`` take an instance rather than a name. A handler that
needs a plugin therefore cannot be a kernel module, and that single fact places
``visionset.jobs`` where it is.

**Idempotent.** A re-run clears its own destination first and writes the same
bytes from an immutable release, so a crashed export retried after a restart
produces the archive the first attempt was going to.

**The destination is built here, from the workspace root, and that is what makes
clearing it safe.** ``ReleaseService.export`` will not delete under a path a
caller named — the port's contract, because the caller may have named something
it cares about. This handler owns the path: workspace root, a fixed directory
name, a release id and a format name, and nothing else is ever written there.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Final
from uuid import UUID

from pydantic import JsonValue

from visionset.formats import registry
from visionset.jobs.context import workspace_for
from visionset.jobs.registry import HandlerRef, register
from visionset.kernel.ports import ProgressReporter, resolve_target
from visionset.kernel.services import ReleaseService

JOB_TYPE = "export.release"

HANDLER = register(HandlerRef(type=JOB_TYPE, func=f"{__name__}:run", idempotent=True))

#: Where an export lands, under the workspace root. A sibling of ``uploads/`` and
#: server-owned in the same way: the kernel writes neither, and
#: ``WorkspaceService.open`` tolerates both because it only ever refuses a
#: *non-empty* directory at ``init``.
EXPORTS_DIRNAME: Final = "exports"


def payload_for(
    release_id: UUID, format_name: str, *, target: str | None, allow_lossy: bool
) -> dict[str, JsonValue]:
    """The payload this handler expects, built where the type is known.

    One place names these four keys and the same place reads them — a route
    spelling them by hand would be free to spell them differently, and the
    mismatch would surface as a ``KeyError`` inside a worker. ``format`` is
    the resolved format's own name even when the caller addressed a target,
    so the worker resolves the same plugin the request was refused or
    accepted against.
    """
    return {
        "release_id": str(release_id),
        "format": format_name,
        "target": target,
        "allow_lossy": allow_lossy,
    }


def archive_path(workspace_root: Path, release_id: UUID, format_name: str) -> Path:
    """Where this export's archive ends up. Shared with the route that serves it.

    A **sibling** of the output directory rather than a file inside it, so that a
    re-export cannot sweep the previous archive into the new one — the rule the
    synchronous route already followed, kept here because this is now the only
    place that knows the layout.
    """
    return workspace_root / EXPORTS_DIRNAME / str(release_id) / f"{format_name}.zip"


def run(
    workspace_root: Path,
    payload: dict[str, JsonValue],
    reporter: ProgressReporter,
) -> dict[str, JsonValue]:
    """Export the release named in ``payload`` and return where the archive is.

    ``reporter`` is consulted **once, before starting**, and not during. An
    ``Exporter`` writes a directory and reports nothing while it does — the port
    has no progress channel and giving it one would change every plugin's
    signature for a number only one caller wants. So the honest cancellation
    point is the one before any bytes are written, and the honest progress report
    is the one this returns.

    The path in ``result`` is **relative to the workspace root**, because an
    absolute one is a server-side path on the wire — the rule that keeps
    ``Source.path`` and ``Asset.uri`` unpublished. The route that serves the
    archive rejoins it to the root it already has.
    """
    if reporter.is_cancelled():
        return {}

    release_id = UUID(str(payload["release_id"]))
    format_name = str(payload["format"])
    target_name = None if payload.get("target") is None else str(payload["target"])
    allow_lossy = bool(payload["allow_lossy"])

    workspace = workspace_for(workspace_root)
    # Through the *module*, never ``from ... import exporters``: a module global
    # is what a test can replace, and the alternative would leave this the one
    # place an injected exporter cannot reach. It is the seam
    # ``registry.exporter()`` already uses, for the same reason.
    #
    # ``pick``, never ``exporters()[name]``: a ``KeyError`` is outside the
    # ``VisionSetError`` tree, and here it would fail a job with a traceback
    # instead of a sentence naming what is installed.
    installed = registry.exporters()
    exporter, _ = registry.pick(installed, format_name)
    target = None if target_name is None else resolve_target(installed, target_name)[1]

    destination = workspace_root / EXPORTS_DIRNAME / str(release_id) / format_name
    # Cleared first, because the archive must describe *this* run.
    shutil.rmtree(destination, ignore_errors=True)
    result = ReleaseService(workspace).export(
        release_id, exporter, destination, allow_lossy=allow_lossy, target=target
    )

    archive = archive_path(workspace_root, release_id, format_name)
    # ``make_archive`` wants the name without the suffix and appends one.
    shutil.make_archive(str(archive.with_suffix("")), "zip", root_dir=destination)

    reporter.report(processed=result.file_count, total=result.file_count)
    return {
        "release_id": str(release_id),
        "format": result.format_name,
        "target": result.target,
        "archive": str(archive.relative_to(workspace_root)),
        "file_count": result.file_count,
        "total_bytes": result.total_bytes,
    }
