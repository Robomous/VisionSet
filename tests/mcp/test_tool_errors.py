"""The error envelope itself: one shape, and the field that says how to retry.

There are deliberately **two** failure shapes in this surface, and telling them
apart is the point:

* a malformed *request* — an argument pydantic refused before the body ran —
  arrives as ``isError=True`` carrying pydantic's own message, which names the
  offending field. That is the API's 422.
* a *domain refusal* is an ordinary successful call whose payload is the error
  envelope. That is the API's 404 or 409, and it is the one a caller branches on.

Collapsing them would mean either losing the field path on a bad argument or
making every refusal look like a protocol failure.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from tests.mcp._flow import (
    call,
    call_destructive,
    error,
    ingested,
    payload,
    project,
    schema,
    workspace,
)

from visionset.kernel import (
    ConfirmationRequired,
    DestructiveSchemaChange,
    LossyExportNotConsented,
    SchemaChangeWouldOrphan,
)
from visionset.mcp._errors import RETRY_WITH, refused


def test_the_envelope_always_carries_the_same_four_keys(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # A caller that has to test for a key before reading it is a caller writing
    # two branches for one answer.
    workspace(monkeypatch, tmp_path)
    assert set(error(call("get_project", project="nope"))) == {
        "message",
        "retry_with",
        "hint",
        "index",
    }
    assert set(refused("anything")["error"]) == {"message", "retry_with", "hint", "index"}


def test_a_domain_refusal_is_a_result_and_not_a_protocol_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    workspace(monkeypatch, tmp_path)
    result = call("get_project", project="nope")
    assert result.is_error is False
    assert result.structured_content is not None


def test_a_malformed_argument_is_a_protocol_error_naming_the_field(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    result = call("get_schema", project=named, version=0)
    assert result.is_error
    assert "version" in result.content[0].text


def test_a_missing_required_argument_is_a_protocol_error() -> None:
    result = call("get_project")
    assert result.is_error


def test_an_unknown_tool_is_a_protocol_error() -> None:
    result = call("no_such_tool")
    assert result.is_error


def test_nothing_leaks_a_traceback(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # `guarded` catches only `VisionSetError`; every kernel call that raises
    # outside the family is guarded at its own call site instead. If one were
    # missed, MCPServer would ship the exception's text prefixed with
    # "Error executing tool", which is what this looks for.
    named = schema(monkeypatch, tmp_path)
    for result in (
        call("ingest", project=named, path=str(tmp_path / "nowhere")),
        call("ingest", project=named, path=str(tmp_path), fps=-1),
        call("get_batch", batch_id="not-a-uuid"),
        call("list_batch_assets", batch_id="not-a-uuid"),
    ):
        assert not result.is_error, result.content
        assert "Traceback" not in str(result.content)


def test_confirm_is_the_retry_word_for_destroying_data(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    assert error(call_destructive("delete_project", project=named))["retry_with"] == "confirm"


def test_allow_destructive_is_the_retry_word_for_narrowing_a_contract(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    refusal = error(
        call(
            "create_schema_version",
            project=named,
            classes=[{"name": "car", "geometries": ["bbox"]}],
        )
    )
    assert refusal["retry_with"] == "allow_destructive"


def test_the_orphan_refusal_offers_nothing_and_that_is_the_whole_point() -> None:
    # `SchemaChangeWouldOrphan` is deliberately not a subclass of
    # `DestructiveSchemaChange`, so the MRO walk finds nothing — which is what
    # stops a client retrying forever. Two refusals that would be the same HTTP
    # status, told apart by a field rather than by the status.
    assert not issubclass(SchemaChangeWouldOrphan, DestructiveSchemaChange)
    assert SchemaChangeWouldOrphan not in RETRY_WITH


def test_the_three_gate_words_are_three_and_are_never_merged() -> None:
    # `confirm` guards destroying data, `allow_destructive` guards narrowing a
    # contract, `allow_lossy` guards emitting an incomplete copy of something that
    # stays intact. Different words, different errors, never one `except`.
    expected = {
        ConfirmationRequired: "confirm",
        DestructiveSchemaChange: "allow_destructive",
        LossyExportNotConsented: "allow_lossy",
    }
    assert expected == RETRY_WITH
    assert len(set(RETRY_WITH.values())) == 3


def test_most_refusals_are_not_retryable_at_all(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=1)
    assert error(call("start_batch", batch_id=batch_id))["retry_with"] is None
    assert error(call("get_project", project="nope"))["retry_with"] is None


def test_a_bulk_refusal_carries_the_position_and_an_ordinary_one_does_not(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from tests.mcp._flow import BBOX, open_batch

    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    asset_id = payload(call("next_pending_assets", job_id=job_id, count=1))["items"][0]["id"]
    bulk = error(
        call(
            "add_annotations",
            job_id=job_id,
            annotations=[
                {
                    "asset_id": asset_id,
                    "label_class": "nope",
                    "geometry": BBOX,
                    "provenance": "human",
                }
            ],
        )
    )
    assert bulk["index"] == 0
    assert error(call("get_job", job_id="not-a-uuid"))["index"] is None


def test_the_one_tool_returning_image_content_still_refuses_in_the_envelope(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # `get_asset_image` declares `-> CallToolResult`, and MCPServer would put a
    # returned dict into a text block with `structuredContent` null. `guarded`
    # wraps the envelope for exactly this tool so a client parses one shape.
    from uuid import uuid4

    named, _ = ingested(monkeypatch, tmp_path, count=1)
    result = call("get_asset_image", project=named, asset_id=str(uuid4()))
    assert result.structured_content is not None
    assert set(result.structured_content["error"]) == {"message", "retry_with", "hint", "index"}
    # And the text half says the same thing, for a client that reads only content.
    assert "error" in result.content[0].text
