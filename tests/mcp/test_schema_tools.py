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
    assert preview["is_destructive"] is False
    assert preview["destructive_classes"] == []
    assert payload(call("create_schema_version", project=named, classes=BOTH))["version"] == 2


def test_preview_names_what_a_change_would_remove_without_writing_anything(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    preview = payload(call("preview_schema_change", project=named, classes=CAR_ONLY))
    assert preview["is_destructive"] is True
    assert preview["destructive_classes"] == ["sign"]
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
    assert result.isError
    assert "classes.0.name" in result.content[0].text


def test_the_label_class_schema_reaches_the_agent_with_the_domain_docstrings() -> None:
    # The reason the domain model goes into the signature at all: FastMCP puts its
    # docstring into `$defs`, which is the best guidance an agent gets about what
    # a class is. A hand-written body would have thrown it away.
    definitions = tool_schemas()["create_schema_version"].inputSchema["$defs"]
    assert "LabelClass" in definitions
    assert "Attribute" in definitions
    assert definitions["LabelClass"]["description"]


# --- the commit message, and when it was written (#230) -----------------------


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
