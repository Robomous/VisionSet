"""The tool listing itself: what ships, how it is described, and what it claims to do.

The listing is the only thing an agent sees before it chooses. These assertions
are about that listing rather than about any tool's behaviour, so they are the
ones that fail when a tool is added carelessly rather than wrongly.
"""

from __future__ import annotations

import inspect

import pytest
from tests.mcp._flow import tool_names, tool_schemas

from visionset.mcp.main import (
    ALLOW_DESTRUCTIVE_ENV,
    DESTROYS,
    DESTRUCTIVE_TOOLS,
    TOOLS,
    registered_tools,
)

SHIPPED = {
    "create_project",
    "list_projects",
    "get_project",
    "get_schema",
    "compare_schema_versions",
    "preview_schema_change",
    "create_schema_version",
    "ingest",
    "list_sources",
    "backfill_thumbnails",
    "list_batches",
    "get_batch",
    "approve_batch",
    "start_batch",
    "repin_batch",
    "complete_batch",
    "list_batch_assets",
    "promote_batch",
    "get_job",
    "start_job",
    "complete_job",
    "next_pending_assets",
    "set_asset_progress",
    "list_asset_annotations",
    "add_annotations",
    "update_annotations",
    "delete_annotations",
    "get_asset_image",
    "dataset_stats",
    "publish_release",
    "list_releases",
    "verify_release",
    "check_export",
    "export_release",
    "list_formats",
}
"""Every tool this server offers by default.

Written out rather than derived from ``TOOLS``, so that adding a tool is a
deliberate edit in two places. The ship-vs-fold decision is the whole point of
#35; a set computed from the table would agree with itself no matter what
landed."""

DESTRUCTIVE = {"delete_project"}
"""Offered only when the server was started with ``--allow-destructive`` (#108).

Absent from the listing by default rather than present and gated, because
``confirm`` is documented in the same listing an agent reads before choosing —
four of four real runs sent it on the first call. A tool that is not advertised
cannot be called with a flag."""


def test_the_server_advertises_exactly_the_shipped_tools() -> None:
    assert set(tool_names()) == SHIPPED


def test_every_registered_tool_reaches_the_listing() -> None:
    # A duplicate name does not raise: MCPServer logs a warning and discards the
    # second registration silently, so a copy-paste slip would leave a tool that
    # simply is not there. Counting is what catches it.
    assert len(tool_names()) == len(TOOLS)


def test_the_gated_listing_is_exactly_the_shipped_set_plus_the_destructive_one() -> None:
    # Named, never counted. A bare integer here was the whole point of #35 — 50
    # candidates evaluated one by one — but it reported an off-by-one where the
    # set reports *which* tool moved, and it went stale twice in one run while
    # the set beside it was already correct. What ships is still a decision to be
    # argued in `docs/mcp.md`; this is how the decision is written down.
    assert set(tool_names(allow_destructive=True)) == SHIPPED | DESTRUCTIVE
    assert {tool.__name__ for tool, _hints in DESTRUCTIVE_TOOLS} == DESTRUCTIVE


@pytest.mark.parametrize("name", sorted(SHIPPED))
def test_every_tool_has_a_description_written_for_an_agent(name: str) -> None:
    described = tool_schemas()[name].description
    assert described
    # `inspect.cleandoc` is applied at registration because MCPServer ships `__doc__`
    # raw. Without it every description after the first line arrives indented.
    assert not described.startswith(" ")
    assert "\n    " not in described


@pytest.mark.parametrize("name", sorted(SHIPPED))
def test_every_parameter_of_every_tool_is_documented(name: str) -> None:
    # There is no docstring-argument parser anywhere in MCPServer, so a parameter is
    # documented only if it carries `Annotated[..., Field(description=...)]`. A
    # bare `project: str` tells a model nothing about what to put there.
    properties = tool_schemas()[name].input_schema.get("properties", {})
    undocumented = [p for p, schema in properties.items() if not schema.get("description")]
    assert undocumented == []


def test_a_tool_that_can_destroy_data_says_so_and_takes_confirm() -> None:
    # `ToolAnnotations` are hints and enforce nothing; `confirm` is what enforces.
    # This is what keeps the two from drifting apart, in both directions.
    listed = tool_schemas()
    gated = {
        name for name in SHIPPED if "confirm" in listed[name].input_schema.get("properties", {})
    }
    hinted = {
        name
        for name in SHIPPED
        if listed[name].annotations is not None and listed[name].annotations.destructive_hint
    }
    assert gated == hinted


def test_nothing_in_the_default_listing_destroys_anything() -> None:
    # Deliberate and worth pinning: `delete_annotations` removes rows and is *not*
    # destructive in this sense, because the batch gate guards it and deleting a
    # label is the ordinary edit loop.
    assert [tool.__name__ for tool, hints in TOOLS if hints is DESTROYS] == []


def test_delete_project_is_the_only_destructive_tool() -> None:
    assert {tool.__name__ for tool, hints in DESTRUCTIVE_TOOLS} == DESTRUCTIVE
    assert all(hints is DESTROYS for _, hints in DESTRUCTIVE_TOOLS)


def test_the_destructive_tools_are_absent_until_the_server_is_started_for_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#108's whole answer, in one assertion.

    Absent from the listing rather than present and gated: a `confirm` parameter
    is documented in the same listing an agent reads before choosing, so the
    description that explains the gate is also the instruction for clearing it.
    Four of four measured runs sent it on the first call.
    """
    monkeypatch.delenv(ALLOW_DESTRUCTIVE_ENV, raising=False)
    assert registered_tools() == TOOLS

    monkeypatch.setenv(ALLOW_DESTRUCTIVE_ENV, "1")
    assert registered_tools() == TOOLS + DESTRUCTIVE_TOOLS


@pytest.mark.parametrize("value", ["", "0", "true", "yes", "TRUE"])
def test_only_an_exact_one_opens_the_destructive_tools(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """Exact, because the variable is a switch a human set and not a preference.

    `visionset mcp` writes `1` or `0` and nothing else; anything ambiguous
    arriving from somewhere is the case where refusing is right.
    """
    monkeypatch.setenv(ALLOW_DESTRUCTIVE_ENV, value)
    assert registered_tools() == TOOLS


def test_the_destructive_tools_keep_the_confirm_and_hint_agreement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The constraint #108 states: whatever *is* registered still agrees in both directions.

    Checked against the table rather than a live listing, because the server
    registers at import and this process imported it without the flag — building
    a second `MCPServer` here would test a registry nothing runs.
    """
    for tool, hints in DESTRUCTIVE_TOOLS:
        assert hints is DESTROYS
        assert "confirm" in inspect.signature(tool).parameters


def test_no_tool_administers_tokens() -> None:
    # Argued in docs/auth.md with #25: minting a credential is a
    # privilege-escalation primitive pointed at the agent's own sandbox, and an
    # agent's "shown exactly once" is a transcript.
    assert not [name for name in tool_names() if "token" in name]


def test_every_tool_name_is_snake_case() -> None:
    assert all(name.islower() and " " not in name and "-" not in name for name in tool_names())


def test_the_table_is_in_cycle_order_not_alphabetical() -> None:
    # The listing reads as the workflow — make a project, schema, ingest, work,
    # promote, publish, export — because that is the order an agent meets them in.
    names = tool_names()
    assert names.index("create_project") < names.index("create_schema_version")
    assert names.index("create_schema_version") < names.index("ingest")
    assert names.index("ingest") < names.index("approve_batch")
    assert names.index("add_annotations") < names.index("promote_batch")
    assert names.index("promote_batch") < names.index("publish_release")
    assert names.index("publish_release") < names.index("export_release")


def test_every_tool_body_is_wrapped_so_a_refusal_cannot_escape() -> None:
    # `guarded` is applied once, in the registration loop. An unwrapped tool would
    # ship `str(exc)` to the client prefixed and unstructured, which is the shape
    # the error envelope exists to replace.
    for tool, _ in TOOLS:
        registered = server_tool(tool.__name__)
        assert getattr(registered, "__wrapped__", None) is not None


def server_tool(name: str) -> object:
    """The callable MCPServer actually registered under that name."""
    from visionset.mcp.main import server

    found = server._tool_manager.get_tool(name)
    assert found is not None, name
    return found.fn


def test_the_error_envelope_has_one_shape_everywhere() -> None:
    # Four keys, always present, null where they do not apply. A caller that has
    # to test for a key's existence before reading it is a caller writing two
    # branches for one answer.
    from visionset.mcp._errors import refused

    assert set(refused("x")["error"]) == {"message", "retry_with", "hint", "index"}


def test_guarded_preserves_the_signature_the_input_schema_is_built_from() -> None:
    # `functools.wraps` is load-bearing rather than cosmetic here: without
    # `__wrapped__`, `inspect.signature` would report `(*args, **kwargs)` and every
    # tool would advertise an empty input schema.
    from visionset.mcp import projects
    from visionset.mcp._errors import guarded

    assert inspect.signature(guarded(projects.create_project)) == inspect.signature(
        projects.create_project
    )
