# usage: from tests.mcp._flow import call, ok, payload, workspace
"""Calling tools the way an MCP client does, and walking the cycle up to a rung.

Plain functions, the way ``tests/cli/_flow.py`` and ``tests/server/_flow.py`` are
plain functions — there is no ``conftest.py`` anywhere in this repository and this
is not the module that starts one.

**Every call goes through the real protocol.** ``create_connected_server_and_client_session``
runs the actual server over a pair of in-memory streams and hands back a real
``ClientSession``, so a test sees what a client sees: a ``CallToolResult`` with
``isError`` and ``structuredContent``, and — for any tool that declares an output
schema — free validation of the result against it on every call.
``FastMCP.call_tool`` is deliberately **not** used: it skips input validation and
output validation, returns an undocumented two-tuple, and raises where the
protocol returns ``isError``.

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
from mcp.shared.memory import create_connected_server_and_client_session
from mcp.types import CallToolResult
from tests.fixtures.media import write_images

from visionset.kernel.services import WorkspaceService
from visionset.mcp.main import build_server, server

SCHEMA_CLASSES: list[dict[str, Any]] = [
    {
        "name": "sign",
        "geometry": "bbox",
        "color": "#ff0000",
        "attributes": [{"name": "occluded", "kind": "boolean", "default": False}],
    }
]
"""The smallest schema that is not trivial: one class, one optional attribute."""

BBOX: dict[str, Any] = {"type": "bbox", "x": 1.0, "y": 2.0, "width": 8.0, "height": 6.0}
"""A box that fits inside the fixtures' 64x48 images. ``type`` is always spelled out."""


def call(tool: str, /, **arguments: Any) -> CallToolResult:
    """Invoke one tool over a real client session and return the whole result."""
    return _call(server, tool, arguments)


def call_destructive(tool: str, /, **arguments: Any) -> CallToolResult:
    """The same, against a server started with ``--allow-destructive`` (#108).

    A second server rather than an environment variable, because the module-level
    one registers at import and a test cannot get in front of that. This is the
    seam ``build_server`` exists for: the posture is a *startup* decision, so
    exercising both means starting two.
    """
    return _call(build_server(allow_destructive=True), tool, arguments)


def _call(target: Any, tool: str, arguments: dict[str, Any]) -> CallToolResult:
    async def go() -> CallToolResult:
        async with create_connected_server_and_client_session(target) as client:
            return await client.call_tool(tool, arguments)

    return anyio.run(go)


def tool_names() -> list[str]:
    """Every tool the server advertises, in registration order."""

    async def go() -> list[str]:
        async with create_connected_server_and_client_session(server) as client:
            return [t.name for t in (await client.list_tools()).tools]

    return anyio.run(go)


def tool_schemas() -> dict[str, Any]:
    """Every advertised tool, keyed by name, for assertions about the listing itself."""

    async def go() -> dict[str, Any]:
        async with create_connected_server_and_client_session(server) as client:
            return {t.name: t for t in (await client.list_tools()).tools}

    return anyio.run(go)


def payload(result: CallToolResult) -> dict[str, Any]:
    """The structured half of a successful call, asserted to be one.

    ``isError`` covers a malformed *request* — an argument pydantic refused before
    the body ran. A domain refusal is a perfectly ordinary result carrying the
    error envelope, which is what :func:`error` is for.
    """
    assert not result.isError, result.content
    assert result.structuredContent is not None
    assert "error" not in result.structuredContent, result.structuredContent
    return result.structuredContent


def error(result: CallToolResult) -> dict[str, Any]:
    """The error envelope of a refused call, asserted to be one."""
    assert not result.isError, "a domain refusal is a result, not a protocol error"
    assert result.structuredContent is not None
    assert "error" in result.structuredContent, result.structuredContent
    envelope: dict[str, Any] = result.structuredContent["error"]
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


def schema(monkeypatch: Any, tmp_path: Path, *, name: str = "road-signs") -> str:
    """A project with schema version 1."""
    named = project(monkeypatch, tmp_path, name=name)
    payload(call("create_schema_version", project=named, classes=SCHEMA_CLASSES))
    return named


def ingested(
    monkeypatch: Any, tmp_path: Path, *, count: int = 2, name: str = "road-signs"
) -> tuple[str, str]:
    """A project with a schema and one batch of freshly ingested stills.

    Returns ``(project_name, batch_id)``.
    """
    named = schema(monkeypatch, tmp_path, name=name)
    incoming = tmp_path / "incoming"
    write_images(incoming, count=count)
    result = payload(call("ingest", project=named, path=str(incoming)))
    return named, str(result["batch_id"])


def open_batch(
    monkeypatch: Any, tmp_path: Path, *, count: int = 2, name: str = "road-signs"
) -> tuple[str, str, str]:
    """A batch approved and started, with its single job. Returns ``(project, batch, job)``."""
    named, batch_id = ingested(monkeypatch, tmp_path, count=count, name=name)
    payload(call("approve_batch", batch_id=batch_id))
    started = payload(call("start_batch", batch_id=batch_id))
    return named, batch_id, str(started["jobs"][0]["id"])
