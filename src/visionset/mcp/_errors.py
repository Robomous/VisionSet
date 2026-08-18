# usage: from visionset.mcp._errors import guarded
"""What a kernel refusal looks like to an agent: a sentence, and what to do next.

The third spelling of a contract ``server/errors.py`` keeps over HTTP and
``cli/_errors.py`` keeps at a terminal, and it sits between them on purpose. A
REST client branches on a machine-readable ``code`` because it is a program; a
shell branches on zero versus non-zero because a person reads the sentence. An
agent is both — it reads, and it decides — so it gets the kernel's own sentence
**and** one machine-readable field:

.. code-block:: json

    {"error": {"message": "...", "retry_with": "allow_destructive",
               "hint": null, "index": null}}

**There is deliberately no ``code``.** The codes live in ``server/errors.py``'s
``ERROR_RULES``, which this package may not import, and deriving one from a class
name is forbidden — a public contract keyed to a Python identifier breaks
silently on a refactor and passes every test. What a code was
actually needed for here is one question, "may I retry this, and with what?", and
:data:`RETRY_WITH` answers it directly. ``DESTRUCTIVE_SCHEMA_CHANGE`` is
retryable with a flag and ``SCHEMA_CHANGE_WOULD_ORPHAN`` is not; publishing the
flag rather than the code is what keeps an agent out of the retry loop
``SchemaChangeWouldOrphan``'s own docstring warns about. If a caller ever needs
the full table, ``ERROR_RULES``' code column gets promoted beside
``visionset.wire`` — it is not re-spelled here.

**Every tool is wrapped once, in ``main.py``'s registration table**, rather than
each body decorating itself. One spelling that cannot be forgotten, and
``test_registration.py`` asserts every registered tool went through it. Letting
an exception escape instead is not neutral: MCPServer catches it, prepends
``"Error executing tool X: "`` and ships ``str(exc)`` to the client anyway — the
same disclosure with none of the structure.

**Only ``VisionSetError`` is caught**, the CLI's rule. A ``FileNotFoundError``, a
bare ``ValueError`` from a non-positive rate, or a pydantic ``ValidationError``
from a geometry built out of tool arguments are not refusals this surface
understands, and each is guarded at the one call site that can raise it —
:func:`refused` is how a tool body reports one in the same envelope without
pretending it came from the kernel.
"""

from __future__ import annotations

import functools
import inspect
import json
from collections.abc import Callable
from typing import Any, Final

from mcp.types import CallToolResult, TextContent

from visionset.kernel import (
    ConfirmationRequired,
    DestructiveSchemaChange,
    LossyExportNotConsented,
    NotAWorkspace,
    ReleaseContentWouldViolateSchema,
    ThumbnailNotCached,
    VisionSetError,
)
from visionset.kernel.services import WORKSPACE_ENV_VAR

RETRY_WITH: Final[dict[type[BaseException], str]] = {
    # The three gate words, never merged into one. Each guards a different thing:
    # `confirm` destroying data, `allow_destructive` narrowing a contract,
    # `allow_lossy` emitting an incomplete copy of something that stays intact.
    ConfirmationRequired: "confirm",
    DestructiveSchemaChange: "allow_destructive",
    LossyExportNotConsented: "allow_lossy",
}
"""The parameter that turns this refusal into the same call, succeeding.

Walked by MRO, the way ``server/errors.py`` walks ``ERROR_RULES``. Sparse on
purpose: **most refusals are not retryable at all**, and
``SchemaChangeWouldOrphan`` is deliberately absent rather than mapped — it is not
a subclass of ``DestructiveSchemaChange`` precisely so that no flag appears to
override it.
"""

_HINTS: Final[dict[type[BaseException], str]] = {
    # A remedy an *agent* can act on, which is not the same set the CLI has. The
    # kernel's own sentence for a missing workspace ends in "use
    # WorkspaceService.init", a Python call; an agent cannot make one, and it
    # cannot set an environment variable either — so the hint names the thing
    # whoever configured the client has to fix.
    NotAWorkspace: (
        f"No workspace is configured. Whoever runs this MCP server must set "
        f"{WORKSPACE_ENV_VAR} in its environment, or start it with "
        f"`visionset mcp --workspace <path>`."
    ),
    ThumbnailNotCached: (
        "Call `backfill_thumbnails` for this project to render the missing "
        "previews, or ask for `full=true` to read the original bytes."
    ),
    # The envelope stays four keys — see the module docstring — so the report
    # itself is not folded into it. What an agent needs is where to read it, and
    # `check_export` answers with the exact document this refusal was computed
    # from, for the same release and the same format.
    LossyExportNotConsented: (
        "Call `check_export` with the same release and format to see exactly "
        "which classes would be dropped and how many annotations that is, then "
        "re-run `export_release` with `allow_lossy=true` to accept the loss."
    ),
    ReleaseContentWouldViolateSchema: (
        "Reconcile the annotations or publish a schema that describes them, then "
        "publish the release again."
    ),
}
"""A next step this surface can add under the kernel's sentence.

Sparse for the reason the CLI's is: a hint that restates the message is noise,
and most kernel sentences already carry their own remedy.
"""


def _walk(table: dict[type[BaseException], str], exc: BaseException) -> str | None:
    for cls in type(exc).__mro__:
        found = table.get(cls)
        if found is not None:
            return found
    return None


def refused(message: str, *, hint: str | None = None) -> dict[str, Any]:
    """The same envelope, for a refusal this surface made rather than the kernel.

    Used where a kernel call would otherwise raise something outside the
    ``VisionSetError`` tree — a missing path, a non-positive rate — so the shape
    a caller parses does not depend on which layer said no.
    """
    return {"error": {"message": message, "retry_with": None, "hint": hint, "index": None}}


def _envelope(exc: VisionSetError) -> dict[str, Any]:
    return {
        "error": {
            "message": str(exc),
            "retry_with": _walk(RETRY_WITH, exc),
            "hint": _walk(_HINTS, exc),
            # Which item of a sequence the caller passed is at fault. Set by
            # `AnnotationService`'s `_blaming` and unrecoverable at the boundary:
            # the write is all-or-nothing, so nothing landed and there is no
            # partial result to count from.
            "index": exc.index,
        }
    }


def guarded[**P, T](fn: Callable[P, T]) -> Callable[P, T | dict[str, Any]]:
    """Turn any kernel refusal raised by ``fn`` into the error envelope.

    ``functools.wraps`` is load-bearing rather than cosmetic: MCPServer builds a
    tool's ``inputSchema`` from ``inspect.signature(fn, eval_str=True)`` and its
    description from ``fn.__doc__``, and the signature call follows ``__wrapped__``
    back to the annotations' own module. Without it every tool would take
    ``*args, **kwargs`` and document nothing.

    **A tool that returns ``CallToolResult`` gets its refusal wrapped in one too**,
    and that is not a detail. MCPServer puts a returned ``dict`` into
    ``structuredContent`` only when the declared return type is a mapping; from a
    tool declared ``-> CallToolResult`` the same dict comes back as JSON text with
    ``structuredContent`` **null**. ``get_asset_image`` is the one such tool, and
    without this its refusals would be the only answers in the whole surface a
    client had to parse out of a text block. The check is done once, here, rather
    than in that tool's body, so it cannot be forgotten by the next one.
    """
    returns_result = inspect.signature(fn, eval_str=True).return_annotation is CallToolResult

    @functools.wraps(fn)
    def guard(*args: P.args, **kwargs: P.kwargs) -> T | dict[str, Any]:
        try:
            return fn(*args, **kwargs)
        except VisionSetError as exc:
            envelope = _envelope(exc)
            if not returns_result:
                return envelope
            rendered = CallToolResult(
                content=[TextContent(type="text", text=json.dumps(envelope, indent=2))],
                structured_content=envelope,
            )
            return rendered  # type: ignore[return-value]

    return guard
