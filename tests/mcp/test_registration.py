"""The tool listing itself: what ships, how it is described, and what it claims to do.

The listing is the only thing an agent sees before it chooses. These assertions
are about that listing rather than about any tool's behaviour, so they are the
ones that fail when a tool is added carelessly rather than wrongly.
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from tests.mcp._flow import call, payload, tool_names, tool_schemas, workspace

from visionset.kernel.domain import IMPLEMENTED_GEOMETRIES, GeometryType
from visionset.mcp.main import (
    ALLOW_DESTRUCTIVE_ENV,
    DESTROYS,
    DESTRUCTIVE_TOOLS,
    TOOLS,
    build_server,
    registered_tools,
)

SHIPPED = {
    "create_project",
    "list_projects",
    "get_project",
    "get_schema",
    "compare_schema_versions",
    "preview_schema_change",
    "list_blocking_assets",
    "create_schema_version",
    "get_schema_draft",
    "set_schema_draft",
    "publish_schema_draft",
    "clear_schema_draft",
    "ingest",
    "list_sources",
    "backfill_thumbnails",
    "list_batches",
    "get_batch",
    "approve_batch",
    "start_batch",
    "get_pre_label_plan",
    "pre_label_batch",
    "pre_label_project",
    "pre_label_job",
    "repin_batch",
    "complete_batch",
    "finish_batch",
    "list_batch_assets",
    "promote_batch",
    "create_correction_batch",
    "create_batch",
    "add_batch_assets",
    "remove_batch_assets",
    "get_job",
    "complete_job",
    "next_pending_assets",
    "set_asset_progress",
    "list_asset_annotations",
    "add_annotations",
    "update_annotations",
    "delete_annotations",
    "list_frame_occurrences",
    "list_asset_occurrences",
    "list_tracks",
    "get_track_status",
    "create_track",
    "start_track",
    "observe_track",
    "unobserve_track",
    "set_track_class",
    "merge_tracks",
    "split_track",
    "delete_track",
    "list_project_assets",
    "get_asset_image",
    "get_calibration",
    "set_calibration",
    "clear_calibration",
    "dataset_stats",
    "publish_release",
    "list_releases",
    "verify_release",
    "check_export",
    "export_release",
    "list_export_targets",
    "list_preprocessing_recipes",
    "get_preprocessing_recipe",
    "create_preprocessing_recipe",
    "update_preprocessing_recipe",
    "list_formats",
    "format_matrix",
    "inspect_import",
    "import_dataset",
    "list_inference_connections",
    "list_providers",
    "model_download_size",
    "create_inference_connection",
    "download_connection_weights",
    "check_connection_integrity",
    "test_inference_connection",
    "update_inference_connection",
}
"""Every tool this server offers by default.

Written out rather than derived from ``TOOLS``, so that adding a tool is a
deliberate edit in two places. The ship-vs-fold decision is the whole point of
a set computed from the table would agree with itself no matter what
landed."""

DESTRUCTIVE = {
    "delete_batch",
    "delete_project",
    "delete_inference_connection",
    "delete_preprocessing_recipe",
}
"""Offered only when the server was started with ``--allow-destructive``.

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
    # Named, never counted. A bare integer here says nothing — 50
    # candidates evaluated one by one — but it reported an off-by-one where the
    # set reports *which* tool moved, and it went stale twice in one run while
    # the set beside it was already correct. What ships is still a decision to be
    # argued in `docs/content/mcp.md`; this is how the decision is written down.
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


@pytest.mark.parametrize(
    "name",
    ["pre_label_batch", "pre_label_project", "pre_label_job", "download_connection_weights"],
)
def test_the_progress_context_is_injected_never_published(name: str) -> None:
    # These four take MCPServer's `Context` to send progress. It is the SDK's to
    # fill, so a client must never see it as an argument it could pass.
    tool = tool_schemas()[name]
    assert "ctx" not in tool.input_schema.get("properties", {})
    assert "ctx" not in tool.input_schema.get("required", [])


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


def test_the_destructive_set_is_exactly_these_and_every_one_is_marked() -> None:
    assert {tool.__name__ for tool, hints in DESTRUCTIVE_TOOLS} == DESTRUCTIVE
    assert all(hints is DESTROYS for _, hints in DESTRUCTIVE_TOOLS)


def test_the_destructive_tools_are_absent_until_the_server_is_started_for_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The destructive posture's whole answer, in one assertion.

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
    """Whatever *is* registered still agrees in both directions.

    Checked against the table rather than a live listing, because the server
    registers at import and this process imported it without the flag — building
    a second `MCPServer` here would test a registry nothing runs.
    """
    for tool, hints in DESTRUCTIVE_TOOLS:
        assert hints is DESTROYS
        assert "confirm" in inspect.signature(tool).parameters


def test_no_tool_administers_tokens() -> None:
    # Argued in docs/content/auth.md: minting a credential is a
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
    # Six keys, always present, null where they do not apply. A caller that has
    # to test for a key's existence before reading it is a caller writing two
    # branches for one answer.
    from visionset.mcp._errors import refused

    assert set(refused("x")["error"]) == {
        "message",
        "retry_with",
        "hint",
        "index",
        "code",
        "detail",
    }


def test_guarded_preserves_the_signature_the_input_schema_is_built_from() -> None:
    # `functools.wraps` is load-bearing rather than cosmetic here: without
    # `__wrapped__`, `inspect.signature` would report `(*args, **kwargs)` and every
    # tool would advertise an empty input schema.
    from visionset.mcp import projects
    from visionset.mcp._errors import guarded

    wrapped = inspect.signature(guarded(projects.create_project))
    original = inspect.signature(projects.create_project, eval_str=True)
    assert list(map(str, wrapped.parameters.values())) == list(
        map(str, original.parameters.values())
    )


def test_every_tool_refuses_an_argument_it_does_not_declare() -> None:
    # A misspelled argument used to be dropped, so `list_batch_assets` with `job_id`
    # answered the unfiltered list. The schema is closed, and so is the model.
    for name, tool in tool_schemas().items():
        assert tool.input_schema.get("additionalProperties") is False, name


PLACEHOLDER = {"type": "object", "additionalProperties": True}


def _result_arms(schema: dict[str, Any]) -> list[dict[str, Any]]:
    definitions = schema.get("$defs", {})
    return [
        definitions[arm["$ref"].removeprefix("#/$defs/")] if "$ref" in arm else arm
        for arm in schema["anyOf"]
    ]


@pytest.mark.parametrize("allow_destructive", [False, True])
def test_every_tool_declares_its_result_or_the_refusal_envelope(allow_destructive: bool) -> None:
    # The placeholder object told a client nothing. Every tool now publishes its
    # own shape, and the refusal as the alternative, because a refusal arrives as
    # an ordinary result rather than with `isError`.
    for tool in build_server(allow_destructive=allow_destructive)._tool_manager.list_tools():
        schema = tool.output_schema
        assert schema is not None, tool.name
        assert schema["type"] == "object", tool.name
        arms = _result_arms(schema)
        titles = [arm.get("title") for arm in arms]
        assert "Refusal" in titles, tool.name
        for arm in arms:
            assert arm != PLACEHOLDER, tool.name
            assert arm.get("properties"), (tool.name, arm)


def test_a_real_result_and_a_real_refusal_both_validate_against_the_published_schema(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The client this suite calls through validates every structured result
    # against the published schema too, so every call in tests/mcp checks it; this
    # one says so out loud for one success and one refusal.
    workspace(monkeypatch, tmp_path)
    schema = tool_schemas()["create_project"].output_schema
    made = payload(call("create_project", name="roads"))
    again = call("create_project", name="ROADS")
    jsonschema.validate(made, schema)
    jsonschema.validate(again.structured_content, schema)
    assert again.structured_content["error"]["code"] == "PROJECT_NAME_TAKEN"


def test_a_geometry_variant_publishes_its_type_as_required() -> None:
    definitions = tool_schemas()["add_annotations"].input_schema["$defs"]
    variants = [d for d in definitions.values() if d.get("title", "").endswith("Geometry")]
    assert variants
    for variant in variants:
        assert "type" in variant["required"], variant["title"]
        assert "default" not in variant["properties"]["type"], variant["title"]


def test_no_tool_advertises_a_geometry_a_class_cannot_use() -> None:
    implemented = sorted(g.value for g in IMPLEMENTED_GEOMETRIES)
    unimplemented = {g.value for g in GeometryType} - set(implemented)
    for name, tool in tool_schemas().items():
        enum = tool.input_schema.get("$defs", {}).get("GeometryType", {}).get("enum")
        if enum is not None:
            assert enum == implemented, name
        assert not unimplemented & set(json.dumps(tool.input_schema).split('"')), name


def test_a_class_is_named_by_name_and_referred_to_by_label_class() -> None:
    # One rule, not two spellings: the class itself carries `name`; anything
    # pointing at a class calls the field `label_class`. No third spelling.
    listing = json.dumps(
        [(tool.input_schema, tool.output_schema) for tool in tool_schemas().values()]
    )
    for stray in ('"class_name"', '"class"', '"class_id"'):
        assert stray not in listing, stray
