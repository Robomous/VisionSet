# usage: from tests.mcp._flow import call, ok, payload, workspace
"""Calling tools the way an MCP client does, and walking the cycle up to a rung.

Plain functions, the way ``tests/cli/_flow.py`` and ``tests/server/_flow.py`` are
plain functions — there is no ``conftest.py`` anywhere in this repository and this
is not the module that starts one.

**Every call goes through the real protocol.** ``Client(server)`` — the SDK's own
in-memory transport — runs the actual server over a pair of in-memory streams, so
a test sees what a client sees: a ``CallToolResult`` with ``isError`` and
``structuredContent`` on the wire, and — for any tool that declares an output
schema — free validation of the result against it on every call.
``MCPServer.call_tool`` is deliberately **not** used: it skips input validation and
output validation, returns an undocumented two-tuple, and raises where the
protocol returns ``isError``.

The Python attributes are the snake_case field names (``is_error``,
``structured_content``); the camelCase spellings above are the JSON aliases, which
is what a non-Python client actually reads.

**No async test infrastructure.** :func:`call` bridges with ``anyio.run``, so
every test module here is plain synchronous pytest with no marker, no fixture and
no plugin. A fresh session per call is not waste — the server opens and closes the
workspace per tool call anyway, so it is what production does too.

**Every rung is reached by calling tools**, never by reaching past them into the
SDK. A helper that built "an approved batch" out of ``BatchService`` would test
the later tool against a state no agent can produce. Reading state *back* for an
assertion goes through the kernel, because the tool's answer is what is under
test and cannot also be the evidence.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import anyio
from mcp.client import Client
from mcp.types import CallToolResult
from tests.fixtures.media import write_images

from visionset.kernel.services import WorkspaceService
from visionset.mcp.main import build_server, server

SCHEMA_CLASSES: list[dict[str, Any]] = [
    {
        "name": "sign",
        "geometries": ["bbox"],
        "color": "#ff0000",
        "attributes": [{"name": "occluded", "kind": "boolean", "default": False}],
    }
]
"""The smallest schema that is not trivial: one class, one optional attribute."""

#: The lane class, for the suites that write one. Not in ``SCHEMA_CLASSES``.
CENTERLINE: dict[str, Any] = {"name": "centerline", "geometries": ["polyline"]}

BBOX: dict[str, Any] = {"type": "bbox", "x": 1.0, "y": 2.0, "width": 8.0, "height": 6.0}
"""A box that fits inside the fixtures' 64x48 images. ``type`` is always spelled out."""


def call(tool: str, /, **arguments: Any) -> CallToolResult:
    """Invoke one tool over a real client session and return the whole result."""
    return _call(server, tool, arguments)


def call_destructive(tool: str, /, **arguments: Any) -> CallToolResult:
    """The same, against a server started with ``--allow-destructive``.

    A second server rather than an environment variable, because the module-level
    one registers at import and a test cannot get in front of that. This is the
    seam ``build_server`` exists for: the posture is a *startup* decision, so
    exercising both means starting two.
    """
    return _call(build_server(allow_destructive=True), tool, arguments)


def _call(target: Any, tool: str, arguments: dict[str, Any]) -> CallToolResult:
    async def go() -> CallToolResult:
        async with Client(target) as client:
            return await client.call_tool(tool, arguments)

    return anyio.run(go)


def tool_names(*, allow_destructive: bool = False) -> list[str]:
    """Every tool the server advertises, in registration order.

    ``allow_destructive`` builds a second server rather than setting the
    environment variable, for ``call_allowing_destruction``'s reason: the
    module-level one registers at import and a test cannot get in front of that.
    """
    listing = build_server(allow_destructive=True) if allow_destructive else server

    async def go() -> list[str]:
        async with Client(listing) as client:
            return [t.name for t in (await client.list_tools()).tools]

    return anyio.run(go)


def tool_schemas() -> dict[str, Any]:
    """Every advertised tool, keyed by name, for assertions about the listing itself."""

    async def go() -> dict[str, Any]:
        async with Client(server) as client:
            return {t.name: t for t in (await client.list_tools()).tools}

    return anyio.run(go)


def payload(result: CallToolResult) -> dict[str, Any]:
    """The structured half of a successful call, asserted to be one.

    ``isError`` covers a malformed *request* — an argument pydantic refused before
    the body ran. A domain refusal is a perfectly ordinary result carrying the
    error envelope, which is what :func:`error` is for.
    """
    assert not result.is_error, result.content
    assert result.structured_content is not None
    assert "error" not in result.structured_content, result.structured_content
    return result.structured_content


def error(result: CallToolResult) -> dict[str, Any]:
    """The error envelope of a refused call, asserted to be one."""
    assert not result.is_error, "a domain refusal is a result, not a protocol error"
    assert result.structured_content is not None
    assert "error" in result.structured_content, result.structured_content
    envelope: dict[str, Any] = result.structured_content["error"]
    return envelope


def workspace(monkeypatch: Any, tmp_path: Path) -> Path:
    """Create a workspace and point the server at it through the environment.

    ``setenv`` to the empty string is how a test says "no ambient workspace" —
    never ``delenv(..., raising=False)``, which records no undo when the variable
    was already absent and would leak a developer's own workspace into the suite.
    """
    root = tmp_path / "ws"
    WorkspaceService.init(root).close()
    monkeypatch.setenv("VISIONSET_WORKSPACE", str(root))
    return root


def project(monkeypatch: Any, tmp_path: Path, *, name: str = "road-signs") -> str:
    """A workspace with one project in it. Returns the project name."""
    workspace(monkeypatch, tmp_path)
    payload(call("create_project", name=name))
    return name


def schema(
    monkeypatch: Any,
    tmp_path: Path,
    *,
    name: str = "road-signs",
    classes: list[dict[str, Any]] | None = None,
) -> str:
    """A project with schema version 1.

    ``classes`` is threaded rather than defaulted wider on purpose: eight tests
    elsewhere read the class list ``SCHEMA_CLASSES`` produces, so a suite that
    needs another geometry names one instead of changing what everyone gets.
    """
    named = project(monkeypatch, tmp_path, name=name)
    payload(
        call(
            "create_schema_version",
            project=named,
            classes=SCHEMA_CLASSES if classes is None else classes,
        )
    )
    return named


def ingested(
    monkeypatch: Any,
    tmp_path: Path,
    *,
    count: int = 2,
    name: str = "road-signs",
    classes: list[dict[str, Any]] | None = None,
) -> tuple[str, str]:
    """A project with a schema and one batch of freshly ingested stills.

    Returns ``(project_name, batch_id)``.
    """
    named = schema(monkeypatch, tmp_path, name=name, classes=classes)
    incoming = tmp_path / "incoming"
    write_images(incoming, count=count)
    result = payload(call("ingest", project=named, path=str(incoming)))
    return named, str(result["batch_id"])


def open_batch(
    monkeypatch: Any,
    tmp_path: Path,
    *,
    count: int = 2,
    name: str = "road-signs",
    classes: list[dict[str, Any]] | None = None,
) -> tuple[str, str, str]:
    """A batch approved and started, with its single job. Returns ``(project, batch, job)``."""
    named, batch_id = ingested(monkeypatch, tmp_path, count=count, name=name, classes=classes)
    payload(call("approve_batch", batch_id=batch_id))
    started = payload(call("start_batch", batch_id=batch_id))
    return named, batch_id, str(started["jobs"][0]["id"])
