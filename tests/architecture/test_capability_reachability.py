"""Every action the wire declares can actually be performed, on every surface.

## The gap this closes

`kernel/domain/capabilities.py` answers *what may be asked of this resource*, and
`tests/kernel/test_capabilities.py` proves that answer against the services over
the whole state square. Both drive Python, so neither can see whether anything
**outside** the SDK reaches the method a declaration promises — and under the
`ui-capabilities` contract a conforming client renders what the wire declares, so
an action nothing can perform obliges every client to offer a control that cannot
work.

That is not hypothetical: `edit_membership` was once declared on every draft with
no route to call, and `BatchAction.DELETE` was *withdrawn* rather than routed on
the explicit condition that the member returns in the same change as its
surfaces. This file is the measurement that makes such a condition checkable
rather than remembered.

## Computed, not asserted

The claim is **declared == reachable**, and the enumeration is what makes it one
rather than a list somebody kept up to date. `SURFACES` is keyed by `BatchAction`
and checked for exact coverage of the enum, so a new member with no surface fails
here before it can reach a client; each entry is then resolved against the
application's real routing table and the MCP server's real tool listing, so an
entry naming something that does not exist fails too. Neither half can be
satisfied by editing this file alone.

## Batches only, and why

`BatchAction` is the one vocabulary where the correspondence is a clean bijection
on both surfaces. `JobAction.START` deliberately has **no** MCP tool — a job
auto-starts on the first write, a decision with
its own measurement behind it — and `AssetAction` folds five names onto one
progress route. Extending this gate to those means encoding two exemptions, and
an exemption written down here is a rule this file no longer proves. They keep
the kernel matrix, which is what they always had.
"""

from __future__ import annotations

from typing import Final

from visionset.kernel.domain import BatchAction
from visionset.mcp.main import DESTRUCTIVE_TOOLS, TOOLS
from visionset.server.main import create_app

#: Where each declared batch action is performed: ``(method, path, MCP tool)``.
#:
#: The path is the route template as FastAPI holds it, so a moved path fails here
#: rather than being silently accepted — which is the point, since a client
#: reading `allowed_actions` has to know where to send the call.
#:
#: Two actions share ``edit_membership``: adding and removing membership are one
#: capability with two directions, and the declaration is about whether the batch
#: may be edited at all. The tuple names the *removal* on both surfaces because
#: that is the half the browser calls; the addition is asserted beside it below.
SURFACES: Final[dict[BatchAction, tuple[str, str, str]]] = {
    BatchAction.APPROVE: ("POST", "/batches/{batch_id}/approve", "approve_batch"),
    BatchAction.START: ("POST", "/batches/{batch_id}/start", "start_batch"),
    BatchAction.COMPLETE: ("POST", "/batches/{batch_id}/complete", "complete_batch"),
    BatchAction.REPIN: ("POST", "/batches/{batch_id}/repin", "repin_batch"),
    BatchAction.PROMOTE: ("POST", "/batches/{batch_id}/promote", "promote_batch"),
    BatchAction.CREATE_CORRECTION: (
        "POST",
        "/batches/{batch_id}/corrections",
        "create_correction_batch",
    ),
    BatchAction.EDIT_MEMBERSHIP: (
        "DELETE",
        "/batches/{batch_id}/assets",
        "remove_batch_assets",
    ),
    BatchAction.DELETE: ("DELETE", "/batches/{batch_id}", "delete_batch"),
}


def _routes() -> set[tuple[str, str]]:
    """Every ``(method, path)`` the application publishes.

    Read off the generated OpenAPI document rather than by walking
    ``app.routes``: an included router is not flattened into ``APIRoute``
    objects, so the attribute walk sees only the app's own four. The document is
    also the better subject — "reachable" for a client means *in the contract it
    was handed*, which is what `openapi.json` and the generated TypeScript client
    are both built from.
    """
    return {
        (method.upper(), path)
        for path, operations in create_app().openapi()["paths"].items()
        for method in operations
    }


def _tool_names() -> set[str]:
    """Every tool this server can offer, including the destructive ones.

    ``DESTRUCTIVE_TOOLS`` counts as reachable: those tools are absent from the
    default listing so that a *model* cannot call one it was not shown, and a
    human starting the server with ``--allow-destructive`` is who they are for.
    Absent-by-configuration is not the same as absent.
    """
    return {tool.__name__ for tool, _ in TOOLS + DESTRUCTIVE_TOOLS}


def test_every_declared_batch_action_is_named_here() -> None:
    """The enumeration covers the enum, so a new member cannot skip this file."""
    assert set(SURFACES) == set(BatchAction)


def test_every_declared_batch_action_has_a_route() -> None:
    served = _routes()
    missing = {
        action.value: (method, path)
        for action, (method, path, _) in SURFACES.items()
        if (method, path) not in served
    }
    assert missing == {}


def test_every_declared_batch_action_has_an_mcp_tool() -> None:
    offered = _tool_names()
    missing = {
        action.value: tool for action, (_, _, tool) in SURFACES.items() if tool not in offered
    }
    assert missing == {}


def test_membership_editing_reaches_both_of_its_directions() -> None:
    """The one action whose surface is a pair, so the tuple above cannot say it all."""
    assert ("POST", "/batches/{batch_id}/assets") in _routes()
    assert "add_batch_assets" in _tool_names()
