"""MCP server over stdio. Run with: ``visionset mcp``, or ``python -m visionset.mcp.main``.

The fourth client of the kernel SDK, beside the REST API, the CLI and the SDK
itself. Every tool is a thin mapping onto one or two service calls; nothing is
decided here that the kernel has not already decided.

**Thirty-three tools, out of fifty candidates.** Each REST task from #27 to #30
recorded which MCP tools its capability implied, and this is the sweep that
settled them one by one. The parity rule means *evaluated*, not *implemented*:
tool-selection accuracy degrades with count, so a tool ships only when an agent
has a reason to reach for it that no neighbouring tool already covers. What
folded, what was dropped and why is argued in ``docs/mcp.md`` and in each
module's own docstring.

**Registration is this table, not a decorator at each definition site.** The CLI's
rule, for the CLI's reason: ``@server.tool()`` inside ``projects.py`` would make
that module import this one, which imports it. Doing it here also puts every
shipped tool on one screen, and gives the three cross-cutting decisions exactly
one place to live —

* ``guarded`` wraps every body, so a kernel refusal arrives as the error envelope
  rather than as an exception whose text FastMCP would ship to the client anyway,
  prefixed and unstructured;
* ``inspect.cleandoc`` is passed as ``description=`` because FastMCP otherwise
  ships ``__doc__`` **raw** — indentation and all — into the listing an agent
  reads;
* ``ToolAnnotations`` says whether a tool reads or writes. They are *hints* and
  enforce nothing; ``confirm`` is what enforces. So
  ``tests/mcp/test_registration.py`` asserts the two agree rather than trusting
  that they do.

A duplicate name would not raise: FastMCP logs a warning and silently discards
the second registration. That same test asserts the server lists exactly as many
tools as this table holds.

**No ``from __future__ import annotations`` here**, and it is not an oversight.
That import binds the name ``annotations`` to a ``__future__._Feature``, which
``from visionset.mcp import annotations`` below would then shadow — reported by
mypy as an incompatible import, exactly as it was for ``server/routes``. Nothing
in this module needs deferred evaluation.
"""

import inspect
from collections.abc import Callable
from typing import Any, Final

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from visionset.mcp import (
    annotations,
    assets,
    batches,
    datasets,
    formats,
    jobs,
    projects,
    releases,
    schemas,
    sources,
)
from visionset.mcp._errors import guarded

server = FastMCP("visionset")

READS: Final = ToolAnnotations(readOnlyHint=True)
"""Reads rows and changes nothing."""

WRITES: Final = ToolAnnotations(readOnlyHint=False, destructiveHint=False)
"""Changes state, but only ever adds to it or advances it."""

DESTROYS: Final = ToolAnnotations(readOnlyHint=False, destructiveHint=True)
"""Removes something that cannot be recovered. Carries ``confirm``."""

TOOLS: Final[tuple[tuple[Callable[..., Any], ToolAnnotations], ...]] = (
    # Registration is in cycle order — make a project, give it a schema, put
    # images in it, work through them, promote, publish, export — because that is
    # the order an agent meets them in, and a listing that reads as the workflow
    # is one a model can plan against.
    (projects.create_project, WRITES),
    (projects.list_projects, READS),
    (projects.get_project, READS),
    (projects.delete_project, DESTROYS),
    (schemas.get_schema, READS),
    (schemas.preview_schema_change, READS),
    (schemas.create_schema_version, WRITES),
    (sources.ingest, WRITES),
    (sources.list_sources, READS),
    (sources.backfill_thumbnails, WRITES),
    (batches.list_batches, READS),
    (batches.get_batch, READS),
    (batches.approve_batch, WRITES),
    (batches.start_batch, WRITES),
    (batches.list_batch_assets, READS),
    (jobs.get_job, READS),
    (jobs.start_job, WRITES),
    (jobs.next_pending_assets, READS),
    (assets.get_asset_image, READS),
    (annotations.list_asset_annotations, READS),
    (annotations.add_annotations, WRITES),
    (annotations.update_annotations, WRITES),
    (annotations.delete_annotations, WRITES),
    (jobs.set_asset_progress, WRITES),
    (jobs.complete_job, WRITES),
    (batches.complete_batch, WRITES),
    (batches.promote_batch, WRITES),
    (datasets.dataset_stats, READS),
    (releases.publish_release, WRITES),
    (releases.list_releases, READS),
    (releases.verify_release, READS),
    (formats.list_formats, READS),
    (releases.export_release, WRITES),
)
"""Every shipped tool, with what it does to the workspace.

``delete_annotations`` is ``WRITES`` rather than ``DESTROYS``, on purpose: it
takes no ``confirm``, because removing a label is the annotator edit loop and the
guard is the batch gate. In this surface ``destructiveHint`` and ``confirm`` mean
the same thing, and the registration test holds them to it.
"""


def _register() -> None:
    for tool, hints in TOOLS:
        server.tool(description=inspect.cleandoc(tool.__doc__ or ""), annotations=hints)(
            guarded(tool)
        )


_register()


def main() -> None:
    server.run()  # stdio transport by default


if __name__ == "__main__":
    main()
