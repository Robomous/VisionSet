"""MCP server over stdio. Run with: ``visionset mcp``, or ``python -m visionset.mcp.main``.

The fourth client of the kernel SDK, beside the REST API, the CLI and the SDK
itself. Every tool is a thin mapping onto one or two service calls; nothing is
decided here that the kernel has not already decided.

**These tools, out of fifty candidates.** Each REST task from #27 to #30
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
  rather than as an exception whose text MCPServer would ship to the client anyway,
  prefixed and unstructured;
* ``inspect.cleandoc`` is passed as ``description=`` because MCPServer otherwise
  ships ``__doc__`` **raw** — indentation and all — into the listing an agent
  reads;
* ``ToolAnnotations`` says whether a tool reads or writes. They are *hints* and
  enforce nothing; ``confirm`` is what enforces. So
  ``tests/mcp/test_registration.py`` asserts the two agree rather than trusting
  that they do.

A duplicate name would not raise: MCPServer logs a warning and silently discards
the second registration. That same test asserts the server lists exactly as many
tools as this table holds.

**No ``from __future__ import annotations`` here**, and it is not an oversight.
That import binds the name ``annotations`` to a ``__future__._Feature``, which
``from visionset.mcp import annotations`` below would then shadow — reported by
mypy as an incompatible import, exactly as it was for ``server/routes``. Nothing
in this module needs deferred evaluation.
"""

import inspect
import os
from collections.abc import Callable
from typing import Any, Final

from mcp.server import MCPServer
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

READS: Final = ToolAnnotations(read_only_hint=True)
"""Reads rows and changes nothing."""

WRITES: Final = ToolAnnotations(read_only_hint=False, destructive_hint=False)
"""Changes state, but only ever adds to it or advances it."""

DESTROYS: Final = ToolAnnotations(read_only_hint=False, destructive_hint=True)
"""Removes something that cannot be recovered. Carries ``confirm``."""

TOOLS: Final[tuple[tuple[Callable[..., Any], ToolAnnotations], ...]] = (
    # Registration is in cycle order — make a project, give it a schema, put
    # images in it, work through them, promote, publish, export — because that is
    # the order an agent meets them in, and a listing that reads as the workflow
    # is one a model can plan against.
    (projects.create_project, WRITES),
    (projects.list_projects, READS),
    (projects.get_project, READS),
    (schemas.get_schema, READS),
    (schemas.compare_schema_versions, READS),
    (schemas.preview_schema_change, READS),
    (schemas.create_schema_version, WRITES),
    (sources.ingest, WRITES),
    (sources.list_sources, READS),
    (sources.backfill_thumbnails, WRITES),
    (batches.list_batches, READS),
    (batches.get_batch, READS),
    (batches.approve_batch, WRITES),
    (batches.start_batch, WRITES),
    (batches.repin_batch, WRITES),
    (batches.list_batch_assets, READS),
    (batches.create_batch, WRITES),
    # WRITES, not DESTROYS: removing membership destroys nothing — the asset
    # stays in its project and in every other batch. `delete_project` is
    # still the only DESTROYS.
    (batches.add_batch_assets, WRITES),
    (batches.remove_batch_assets, WRITES),
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
    (batches.create_correction_batch, WRITES),
    (datasets.dataset_stats, READS),
    (releases.publish_release, WRITES),
    (releases.list_releases, READS),
    (releases.verify_release, READS),
    (formats.list_formats, READS),
    (releases.check_export, READS),
    (releases.export_release, WRITES),
)
"""Every tool this server always offers, with what it does to the workspace.

``delete_annotations`` is ``WRITES`` rather than ``DESTROYS``, on purpose: it
takes no ``confirm``, because removing a label is the annotator edit loop and the
guard is the batch gate. In this surface ``destructiveHint`` and ``confirm`` mean
the same thing, and the registration test holds them to it.

Nothing here is destructive. See :data:`DESTRUCTIVE_TOOLS`.
"""

DESTRUCTIVE_TOOLS: Final[tuple[tuple[Callable[..., Any], ToolAnnotations], ...]] = (
    (projects.delete_project, DESTROYS),
)
"""Tools that destroy something, registered **only on request**.

#108, and the reason is measured rather than theoretical. Four real agent runs
were asked to tidy a schema and then delete a project; in **four of four** the
model sent ``confirm=True`` on the *first* call, having read the parameter in the
tool description. ``ConfirmationRequired`` never fired once, because nothing ever
made the un-gated call.

That is not the flag failing. Over HTTP or at a terminal it works exactly as #30
and #35 specify, because a *person* is the one adding it. What the runs settle is
narrower: **when the caller is a model, ``confirm`` is not a human in the loop.**
It is a parameter documented in the same listing the caller reads before choosing,
so the description that exists to explain the gate is also the instruction for
clearing it. There is no version of a self-describing tool schema where that is
not true.

So the gate moved somewhere the agent cannot reach — the server's own startup.
Without ``VISIONSET_MCP_ALLOW_DESTRUCTIVE=1`` these tools are **not registered**,
so the destructive verb is absent from the listing rather than present and gated,
and a tool that is not advertised cannot be called with a flag. ``visionset mcp
--allow-destructive`` is how a human says otherwise, once, when starting the
server.

``confirm`` itself is untouched, and deliberately: it is correct for every other
surface, the kernel's ``confirm=`` parameters are unchanged, and ``guarded`` and
``refused`` are shared. When these tools *are* registered they behave exactly as
before — the decision is only whether an agent is shown them at all.
"""

ALLOW_DESTRUCTIVE_ENV: Final = "VISIONSET_MCP_ALLOW_DESTRUCTIVE"
"""Set to ``1`` to advertise :data:`DESTRUCTIVE_TOOLS`.

An environment variable rather than an argument, because ``main()`` takes none:
this server is started by ``visionset mcp`` as a subprocess whose transport *is*
stdin and stdout, so configuration travels the same channel the workspace does.
An agent cannot set it — it is read once, at import, in a process the agent did
not start.
"""


def destructive_tools_allowed() -> bool:
    """Whether this process advertises the destructive tools.

    Read through a function rather than frozen into a constant so a test can
    ``monkeypatch.setenv`` and rebuild a registry; ``static_root()`` in
    ``server/main.py`` is the same seam for the same reason.
    """
    return os.environ.get(ALLOW_DESTRUCTIVE_ENV) == "1"


def registered_tools() -> tuple[tuple[Callable[..., Any], ToolAnnotations], ...]:
    """The table this process will register, in the order an agent meets them.

    Destructive tools go **last** rather than in cycle position. They are not part
    of the cycle — nothing downstream of ``delete_project`` exists — and a listing
    whose ordering doubles as the workflow should not put a dead end in the middle
    of it.
    """
    if not destructive_tools_allowed():
        return TOOLS
    return TOOLS + DESTRUCTIVE_TOOLS


def build_server(*, allow_destructive: bool | None = None) -> MCPServer:
    """A server offering exactly the tools this configuration asks for.

    A factory rather than a module-level registration, and the reason is the same
    one that made ``static_root()`` a function in ``server/main.py``: the
    alternative freezes the answer at import, where no test can reach it. #108's
    posture is a *startup* decision, so something has to be able to start a server
    twice with two answers.

    ``allow_destructive`` overrides the environment for one call, and ``None``
    means "ask it". Nothing in production passes it; the module-level
    :data:`server` below is what ``main()`` runs.

    Every tool is wrapped in :func:`guarded` and given ``inspect.cleandoc``'d
    documentation **here**, once, rather than at each definition — so neither can
    be forgotten by the next tool, and ``test_registration.py`` asserts it.
    """
    built = MCPServer("visionset")
    offered = TOOLS if allow_destructive is False else registered_tools()
    if allow_destructive is True:
        offered = TOOLS + DESTRUCTIVE_TOOLS
    for tool, hints in offered:
        built.tool(description=inspect.cleandoc(tool.__doc__ or ""), annotations=hints)(
            guarded(tool)
        )
    return built


server = build_server()
"""What ``main()`` runs, built once from this process's environment."""


def main() -> None:
    server.run()  # stdio transport by default


if __name__ == "__main__":
    main()
