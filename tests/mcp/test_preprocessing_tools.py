"""The pre-processing recipe tools, and a recipe on export."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from tests.mcp._flow import call, call_destructive, error, payload, project, tool_names
from tests.mcp.test_release_tools import promoted

LETTERBOX: dict[str, Any] = {
    "target": "yolo11",
    "steps": [{"kind": "resize", "strategy": "letterbox", "width": 640, "height": 640}],
    "variants_per_asset": 0,
}
FLIPS: dict[str, Any] = {
    "target": None,
    "steps": [{"kind": "augment", "op": "hflip"}],
    "variants_per_asset": 1,
}


@pytest.fixture()
def named(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> str:
    return project(monkeypatch, tmp_path)


def test_a_recipe_is_created_and_listed_with_its_whole_spec(named: str) -> None:
    created = payload(call("create_preprocessing_recipe", project=named, name="lb", spec=LETTERBOX))

    assert created["name"] == "lb"
    assert created["spec"]["steps"][0]["pad_value"] == 114
    listed = payload(call("list_preprocessing_recipes", project=named))
    assert listed == {"items": [created], "total": 1}


def test_a_taken_name_and_a_broken_spec_are_refused(named: str) -> None:
    payload(call("create_preprocessing_recipe", project=named, name="lb", spec=LETTERBOX))

    taken = error(call("create_preprocessing_recipe", project=named, name="lb", spec=FLIPS))
    assert "already has a pre-processing recipe named 'lb'" in taken["message"]
    broken = call(
        "create_preprocessing_recipe",
        project=named,
        name="v",
        spec={**LETTERBOX, "variants_per_asset": 2},
    )
    assert broken.is_error


def test_delete_is_offered_only_on_request_and_takes_confirm(named: str) -> None:
    payload(call("create_preprocessing_recipe", project=named, name="lb", spec=LETTERBOX))
    assert "delete_preprocessing_recipe" not in tool_names()
    assert "delete_preprocessing_recipe" in tool_names(allow_destructive=True)

    refusal = error(call_destructive("delete_preprocessing_recipe", project=named, name="lb"))
    assert refusal["retry_with"] == "confirm"
    assert payload(call("list_preprocessing_recipes", project=named))["total"] == 1

    removed = payload(
        call_destructive("delete_preprocessing_recipe", project=named, name="lb", confirm=True)
    )
    assert removed["deleted"]["name"] == "lb"
    assert payload(call("list_preprocessing_recipes", project=named))["total"] == 0
    missing = error(call_destructive("delete_preprocessing_recipe", project=named, name="lb"))
    assert "no pre-processing recipe named 'lb'" in missing["message"]


def test_an_unknown_recipe_on_export_is_refused_by_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    named = promoted(monkeypatch, tmp_path)
    payload(call("publish_release", project=named, tag="v1.0"))
    refusal = error(call("check_export", project=named, tag="v1.0", format="dummy", recipe="nope"))
    assert "no pre-processing recipe named 'nope'" in refusal["message"]


def test_an_augmenting_recipe_over_an_unsplit_release_is_refused_on_check_and_export(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    named = promoted(monkeypatch, tmp_path)
    payload(call("publish_release", project=named, tag="v1.0"))
    payload(call("create_preprocessing_recipe", project=named, name="flips", spec=FLIPS))

    checked = error(call("check_export", project=named, tag="v1.0", format="dummy", recipe="flips"))
    exported = error(
        call(
            "export_release",
            project=named,
            tag="v1.0",
            format="dummy",
            dest=str(tmp_path / "out"),
            recipe="flips",
        )
    )
    for refusal in (checked, exported):
        assert "no split recipe" in refusal["message"]


def test_an_export_with_a_recipe_reports_the_recipe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    named = promoted(monkeypatch, tmp_path)
    payload(call("publish_release", project=named, tag="v1.0"))
    payload(call("create_preprocessing_recipe", project=named, name="lb", spec=LETTERBOX))

    result = payload(
        call(
            "export_release",
            project=named,
            tag="v1.0",
            format="dummy",
            dest=str(tmp_path / "out"),
            recipe="lb",
        )
    )

    assert result["preprocessing"]["recipe_name"] == "lb"
    assert result["preprocessing"]["recipe_hash"]
    assert result["preprocessing"]["mapping"] == []
    assert (result["source_file_count"], result["augmented_file_count"]) == (0, 0)
