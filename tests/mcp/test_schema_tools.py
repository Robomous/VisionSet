"""``get_schema`` / ``preview_schema_change`` / ``create_schema_version``.

Also where the two consequences of taking domain models as parameters are pinned:
the domain's own validators refuse malformed input, and a discriminated union's
tag has to be spelled out even though the generated schema shows it as optional.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from tests.mcp._flow import SCHEMA_CLASSES, call, error, payload, project, schema, tool_schemas

CAR_ONLY: list[dict[str, Any]] = [{"name": "car", "geometry": "bbox"}]
BOTH: list[dict[str, Any]] = [*SCHEMA_CLASSES, {"name": "car", "geometry": "bbox"}]


def test_a_new_project_has_no_schema_at_all(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Schema-less on purpose: creating v1 implicitly would be the second door the
    # kernel closed.
    named = project(monkeypatch, tmp_path)
    assert error(call("get_schema", project=named))["message"]


def test_the_first_version_is_one_and_it_is_active(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    result = payload(call("get_schema", project=named))
    assert result["schema"]["version"] == 1
    assert result["active_version"] == 1
    assert result["available_versions"] == [1]


def test_get_schema_folds_the_version_listing_into_its_answer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    payload(call("create_schema_version", project=named, classes=BOTH))
    result = payload(call("get_schema", project=named))
    assert result["available_versions"] == [1, 2]
    assert result["active_version"] == 2
    assert {c["name"] for c in result["schema"]["classes"]} == {"sign", "car"}


def test_an_older_version_can_still_be_read(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    payload(call("create_schema_version", project=named, classes=BOTH))
    older = payload(call("get_schema", project=named, version=1))
    assert [c["name"] for c in older["schema"]["classes"]] == ["sign"]
    # Which version was asked for does not change which one is active.
    assert older["active_version"] == 2


def test_adding_a_class_is_additive_and_needs_no_flag(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    preview = payload(call("preview_schema_change", project=named, classes=BOTH))
    assert preview["diff"]["is_destructive"] is False
    assert preview["diff"]["destructive_classes"] == []
    assert preview["is_refused"] is False
    assert payload(call("create_schema_version", project=named, classes=BOTH))["version"] == 2


def test_preview_names_what_a_change_would_remove_without_writing_anything(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    preview = payload(call("preview_schema_change", project=named, classes=CAR_ONLY))
    assert preview["diff"]["is_destructive"] is True
    assert preview["diff"]["destructive_classes"] == ["sign"]
    # Destructive and still publishable — nothing is labeled — which is the
    # distinction `is_destructive` alone cannot draw and an agent otherwise
    # discovers by being refused.
    assert preview["is_refused"] is False
    assert preview["blockers"] == []
    # Writes nothing: still one version afterwards. That is the whole reason
    # `SchemaService.preview` finally has a caller.
    assert payload(call("get_schema", project=named))["available_versions"] == [1]


def test_a_narrowing_change_is_refused_and_names_the_flag_that_allows_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    refusal = error(call("create_schema_version", project=named, classes=CAR_ONLY))
    assert refusal["retry_with"] == "allow_destructive"
    assert (
        payload(
            call("create_schema_version", project=named, classes=CAR_ONLY, allow_destructive=True)
        )["version"]
        == 2
    )


def test_a_change_that_would_orphan_annotations_offers_no_flag_at_all(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The distinction a machine-readable `code` was needed for, answered directly:
    # `allow_destructive` retries one of these and nothing retries the other. A
    # client branching on "it was a 409" would loop here forever.
    from tests.mcp._flow import BBOX, open_batch

    named, _, job_id = open_batch(monkeypatch, tmp_path)
    asset_id = payload(call("next_pending_assets", job_id=job_id, count=1))["items"][0]["id"]
    payload(
        call(
            "add_annotations",
            job_id=job_id,
            annotations=[
                {
                    "asset_id": asset_id,
                    "label_class": "sign",
                    "geometry": BBOX,
                    "provenance": "human",
                }
            ],
        )
    )
    refusal = error(
        call("create_schema_version", project=named, classes=CAR_ONLY, allow_destructive=True)
    )
    assert refusal["retry_with"] is None


def test_a_class_bound_to_an_unimplemented_geometry_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    refusal = error(
        call("create_schema_version", project=named, classes=[{"name": "lane", "geometry": "mask"}])
    )
    assert "mask" in refusal["message"]


def test_the_domain_refuses_a_malformed_class_before_the_body_runs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # `classes` is typed `list[LabelClass]`, so the domain's own validators run
    # during argument parsing. That is a malformed *request* rather than a domain
    # refusal, so it arrives as `isError` with pydantic's own message naming the
    # offending field — a deliberately different shape from the error envelope,
    # the same split the API makes between 422 and 409.
    named = project(monkeypatch, tmp_path)
    result = call(
        "create_schema_version", project=named, classes=[{"name": "  ", "geometry": "bbox"}]
    )
    assert result.is_error
    assert "classes.0.name" in result.content[0].text


def test_the_label_class_schema_reaches_the_agent_with_the_domain_docstrings() -> None:
    # The reason the domain model goes into the signature at all: MCPServer puts its
    # docstring into `$defs`, which is the best guidance an agent gets about what
    # a class is. A hand-written body would have thrown it away.
    definitions = tool_schemas()["create_schema_version"].input_schema["$defs"]
    assert "LabelClass" in definitions
    assert "Attribute" in definitions
    assert definitions["LabelClass"]["description"]


# --- the commit message, and when it was written ------------------------------


def test_a_version_carries_the_description_the_agent_wrote(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    created = payload(
        call(
            "create_schema_version",
            project=named,
            classes=[{"name": "sign", "geometry": "bbox"}],
            description="the first contract",
        )
    )

    assert created["description"] == "the first contract"
    assert created["created_at"] is not None

    read = payload(call("get_schema", project=named))
    assert read["schema"]["description"] == "the first contract"


def test_a_version_created_without_one_reports_null_rather_than_omitting_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Always present, so an agent reads a value rather than inferring from absence."""
    named = project(monkeypatch, tmp_path)

    created = payload(
        call(
            "create_schema_version",
            project=named,
            classes=[{"name": "sign", "geometry": "bbox"}],
        )
    )

    assert "description" in created
    assert created["description"] is None
    assert created["created_at"] is not None


# --- comparing two versions ---------------------------------------------------


def test_comparing_two_versions_classifies_what_changed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    payload(call("create_schema_version", project=named, classes=SCHEMA_CLASSES))
    payload(
        call(
            "create_schema_version",
            project=named,
            classes=[*SCHEMA_CLASSES, {"name": "crossing", "geometry": "bbox"}],
        )
    )

    diff = payload(call("compare_schema_versions", project=named, from_version=1, to_version=2))

    assert diff["is_destructive"] is False
    assert diff["destructive_classes"] == []
    assert [(c["label_class"], c["kind"]) for c in diff["changes"]] == [("crossing", "additive")]


def test_a_narrowing_comparison_names_what_would_break(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The read an agent makes before `repin_batch` — the verdict, not the list."""
    named = project(monkeypatch, tmp_path)
    payload(call("create_schema_version", project=named, classes=SCHEMA_CLASSES))
    payload(
        call(
            "create_schema_version",
            project=named,
            classes=[{"name": "crossing", "geometry": "bbox"}],
            allow_destructive=True,
        )
    )

    diff = payload(call("compare_schema_versions", project=named, from_version=1, to_version=2))

    assert diff["is_destructive"] is True
    assert diff["destructive_classes"] == ["sign"]


def test_comparing_against_a_version_that_does_not_exist_is_a_refusal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    payload(call("create_schema_version", project=named, classes=SCHEMA_CLASSES))

    refused = error(call("compare_schema_versions", project=named, from_version=1, to_version=9))

    assert refused["retry_with"] is None
    assert "9" in refused["message"]


def test_version_zero_is_a_malformed_request_rather_than_a_domain_refusal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`ge=1` on the parameter, the `jobs_of` precedent: the kernel never sees it."""
    named = project(monkeypatch, tmp_path)
    payload(call("create_schema_version", project=named, classes=SCHEMA_CLASSES))

    result = call("compare_schema_versions", project=named, from_version=0, to_version=1)

    assert result.is_error


# --- provenance: the agent's own answer, defaulted to the honest one ----------


def test_an_agent_publishing_a_version_records_it_as_curated(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The default is `curated`, not null, and the default is the whole design.

    An agent calling this tool is designing the contract — the mid-job case has no
    MCP spelling, because nothing over this transport is part-way through drawing
    on an asset. Leaving the parameter out therefore means "curated" rather than
    "nobody said", which is the one place a surface may state provenance without
    the caller typing it.
    """
    named = schema(monkeypatch, tmp_path)

    created = payload(call("create_schema_version", project=named, classes=BOTH))

    assert created["provenance"] == "curated"


def test_an_agent_may_state_the_annotation_provenance_explicitly(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The override exists so an agent driving the annotation loop can be honest."""
    named = schema(monkeypatch, tmp_path)

    created = payload(
        call("create_schema_version", project=named, classes=BOTH, provenance="annotation")
    )

    assert created["provenance"] == "annotation"


def test_a_provenance_the_enum_does_not_declare_is_a_malformed_request(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Refused by the protocol's own input validation, before the kernel sees it.

    The column is plain text and no layer below refuses an invented value, so a
    version carrying one would be stored and unreadable forever — a version is
    never edited.
    """
    named = schema(monkeypatch, tmp_path)

    result = call("create_schema_version", project=named, classes=BOTH, provenance="invented")

    assert result.is_error
