"""The tool listing itself: what ships, how it is described, and what it claims to do.

The listing is the only thing an agent sees before it chooses. These assertions
are about that listing rather than about any tool's behaviour, so they are the
ones that fail when a tool is added carelessly rather than wrongly.
"""

from __future__ import annotations

import inspect

import pytest
from tests.mcp._flow import tool_names, tool_schemas

from visionset.mcp.main import DESTROYS, TOOLS

SHIPPED = {
    "create_project",
    "list_projects",
    "get_project",
    "delete_project",
    "get_schema",
    "preview_schema_change",
    "create_schema_version",
    "ingest",
    "list_sources",
    "backfill_thumbnails",
    "list_batches",
    "get_batch",
    "approve_batch",
    "start_batch",
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
"""Written out rather than derived from ``TOOLS``, so that adding a tool is a
deliberate edit in two places. The ship-vs-fold decision is the whole point of
#35; a set computed from the table would agree with itself no matter what
landed."""


def test_the_server_advertises_exactly_the_shipped_tools() -> None:
    assert set(tool_names()) == SHIPPED


def test_every_registered_tool_reaches_the_listing() -> None:
    # A duplicate name does not raise: FastMCP logs a warning and discards the
    # second registration silently, so a copy-paste slip would leave a tool that
    # simply is not there. Counting is what catches it.
    assert len(tool_names()) == len(TOOLS)


def test_thirty_four_tools_ship() -> None:
    # The count is a decision, not an accident — 50 candidates were evaluated one
    # by one. A change here should be argued in `docs/mcp.md` first. #65 added the
    # thirty-fourth, `check_export`: the plan-before-apply half of an export, on
    # the `preview_schema_change` precedent.
    assert len(SHIPPED) == 34


@pytest.mark.parametrize("name", sorted(SHIPPED))
def test_every_tool_has_a_description_written_for_an_agent(name: str) -> None:
    described = tool_schemas()[name].description
    assert described
    # `inspect.cleandoc` is applied at registration because FastMCP ships `__doc__`
    # raw. Without it every description after the first line arrives indented.
    assert not described.startswith(" ")
    assert "\n    " not in described


@pytest.mark.parametrize("name", sorted(SHIPPED))
def test_every_parameter_of_every_tool_is_documented(name: str) -> None:
    # There is no docstring-argument parser anywhere in FastMCP, so a parameter is
    # documented only if it carries `Annotated[..., Field(description=...)]`. A
    # bare `project: str` tells a model nothing about what to put there.
    properties = tool_schemas()[name].inputSchema.get("properties", {})
    undocumented = [p for p, schema in properties.items() if not schema.get("description")]
    assert undocumented == []


def test_a_tool_that_can_destroy_data_says_so_and_takes_confirm() -> None:
    # `ToolAnnotations` are hints and enforce nothing; `confirm` is what enforces.
    # This is what keeps the two from drifting apart, in both directions.
    listed = tool_schemas()
    gated = {
        name for name in SHIPPED if "confirm" in listed[name].inputSchema.get("properties", {})
    }
    hinted = {
        name
        for name in SHIPPED
        if listed[name].annotations is not None and listed[name].annotations.destructiveHint
    }
    assert gated == hinted


def test_delete_project_is_the_only_destructive_tool() -> None:
    # Deliberate and worth pinning: `delete_annotations` removes rows and is *not*
    # destructive in this sense, because the batch gate guards it and deleting a
    # label is the ordinary edit loop.
    assert {tool.__name__ for tool, hints in TOOLS if hints is DESTROYS} == {"delete_project"}


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
    """The callable FastMCP actually registered under that name."""
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
