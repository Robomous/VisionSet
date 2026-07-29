"""Publishing, verifying and exporting — plus ``dataset_stats`` and ``list_formats``."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from tests.mcp._flow import BBOX, SCHEMA_CLASSES, call, error, open_batch, payload

from visionset.kernel.ports import Exporter


def promoted(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *, count: int = 2) -> str:
    """A project whose dataset holds `count` annotated assets. Returns the project."""
    named, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=count)
    payload(call("start_job", job_id=job_id))
    for asset in payload(call("next_pending_assets", job_id=job_id, count=count))["items"]:
        payload(
            call(
                "add_annotations",
                job_id=job_id,
                annotations=[
                    {
                        "asset_id": asset["id"],
                        "label_class": "sign",
                        "geometry": BBOX,
                        "provenance": "model",
                        "model_ref": "probe@1",
                    }
                ],
            )
        )
    payload(call("complete_job", job_id=job_id))
    payload(call("complete_batch", batch_id=batch_id))
    payload(call("promote_batch", batch_id=batch_id))
    return named


def test_stats_count_both_annotations_and_the_assets_carrying_them(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = promoted(monkeypatch, tmp_path, count=2)
    stats = payload(call("dataset_stats", project=named))
    assert stats["asset_count"] == 2
    assert stats["annotated_asset_count"] == 2
    assert stats["annotation_count"] == 2
    # Both totals per class, because they answer different questions.
    assert stats["classes"] == [{"label_class": "sign", "annotations": 2, "assets": 2}]


def test_a_class_nobody_used_does_not_appear_in_the_stats(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = promoted(monkeypatch, tmp_path, count=1)
    payload(
        call(
            "create_schema_version",
            project=named,
            # The whole contract every time: keeping `sign` exactly as it was is
            # what makes this additive. Spelling only the name and geometry would
            # drop its `occluded` attribute, which is a narrowing change and needs
            # `allow_destructive` — a good demonstration of why `create_schema_version`
            # says "a class left out is a class removed".
            classes=[*SCHEMA_CLASSES, {"name": "pedestrian", "geometry": "bbox"}],
        )
    )
    stats = payload(call("dataset_stats", project=named))
    # What was counted, not what could be: which classes exist is the schema's
    # answer and `get_schema` is where it is read.
    assert [c["label_class"] for c in stats["classes"]] == ["sign"]


def test_publishing_freezes_the_trunk_with_its_counts_and_hash(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = promoted(monkeypatch, tmp_path, count=2)
    release = payload(call("publish_release", project=named, tag="v1.0"))
    assert release["tag"] == "v1.0"
    assert release["asset_count"] == 2
    assert release["annotation_count"] == 2
    assert release["schema_version"] == 1
    assert len(release["manifest_hash"]) == 64
    assert release["split"] is None


def test_a_split_recipe_is_stored_and_its_fractions_must_sum_to_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = promoted(monkeypatch, tmp_path, count=2)
    recipe: dict[str, Any] = {"train": 0.7, "val": 0.15, "test": 0.15, "seed": 42}
    assert (
        payload(call("publish_release", project=named, tag="v1.0", split=recipe))["split"] == recipe
    )
    # `SplitRecipe`'s own model validator, reached during argument parsing because
    # the domain model is the parameter type.
    assert call(
        "publish_release",
        project=named,
        tag="v2.0",
        split={"train": 0.5, "val": 0.2, "test": 0.2},
    ).isError


def test_publishing_an_empty_dataset_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from tests.mcp._flow import ingested

    named, _ = ingested(monkeypatch, tmp_path, count=1)
    assert error(call("publish_release", project=named, tag="v1.0"))["message"]


def test_a_release_tag_is_case_sensitive_unlike_a_project_name(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The two opposite rules, both kernel reads. This is the one that is
    # case-*sensitive*, so these are two different releases.
    named = promoted(monkeypatch, tmp_path, count=2)
    payload(call("publish_release", project=named, tag="v1.0"))
    payload(call("publish_release", project=named, tag="V1.0"))
    assert {r["tag"] for r in payload(call("list_releases", project=named))["items"]} == {
        "v1.0",
        "V1.0",
    }
    assert error(call("publish_release", project=named, tag="v1.0"))["message"]


def test_an_unknown_tag_is_refused_rather_than_returning_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = promoted(monkeypatch, tmp_path, count=1)
    payload(call("publish_release", project=named, tag="v1.0"))
    assert error(call("verify_release", project=named, tag="V1.0"))["message"]


def test_verification_of_an_untouched_release_is_ok(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = promoted(monkeypatch, tmp_path, count=2)
    payload(call("publish_release", project=named, tag="v1.0"))
    report = payload(call("verify_release", project=named, tag="v1.0"))
    assert report["ok"] is True
    assert report["manifest_intact"] is True
    assert report["checked"] == 2
    assert report["missing"] == report["corrupt"] == report["cache_mismatches"] == []


def test_only_the_dummy_exporter_is_installed_and_it_is_not_lossy() -> None:
    assert payload(call("list_formats")) == {
        "items": [{"name": "dummy", "lossy": False}],
        "total": 1,
    }


def test_export_writes_into_the_directory_it_was_given(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = promoted(monkeypatch, tmp_path, count=1)
    payload(call("publish_release", project=named, tag="v1.0"))
    dest = tmp_path / "exports" / "dummy"
    result = payload(
        call("export_release", project=named, tag="v1.0", format="dummy", dest=str(dest))
    )
    assert result["format"] == "dummy"
    assert result["directory"] == str(dest)
    assert dest.is_dir()
    # `DummyExporter` writes nothing, so zero is an export that ran rather than one
    # that failed — and the count comes from walking `dest`, never from the plugin.
    assert result["file_count"] == 0


def test_an_unknown_format_names_the_ones_that_are_installed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = promoted(monkeypatch, tmp_path, count=1)
    payload(call("publish_release", project=named, tag="v1.0"))
    refusal = error(
        call("export_release", project=named, tag="v1.0", format="yolo", dest=str(tmp_path / "out"))
    )
    assert "dummy" in refusal["message"]
    # A `KeyError` here would be outside the VisionSetError tree, so a mistyped
    # format has to arrive through `pick`.
    assert refusal["retry_with"] is None


def test_a_dest_that_is_a_file_is_refused_before_a_plugin_runs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = promoted(monkeypatch, tmp_path, count=1)
    payload(call("publish_release", project=named, tag="v1.0"))
    occupied = tmp_path / "not-a-dir"
    occupied.write_text("in the way\n")
    refusal = error(
        call("export_release", project=named, tag="v1.0", format="dummy", dest=str(occupied))
    )
    assert "must be a directory" in refusal["message"]


class LossyExporter:
    """An exporter that says it cannot carry everything, for the third gate word."""

    format_name = "lossy-probe"
    lossy = True

    def export(self, release: Any, manifest: Any, dest: Path) -> None:
        dest.mkdir(parents=True, exist_ok=True)


def test_a_lossy_format_refuses_until_its_own_flag_is_passed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The third gate word, never merged with `confirm` or `allow_destructive`:
    # nothing is destroyed and nothing is narrowed, and what is being consented to
    # is an incomplete *copy* of something that stays intact.
    from visionset.formats import registry

    plugin = LossyExporter()
    assert isinstance(plugin, Exporter)
    monkeypatch.setattr(registry, "exporters", lambda: {plugin.format_name: plugin})

    named = promoted(monkeypatch, tmp_path, count=1)
    payload(call("publish_release", project=named, tag="v1.0"))
    dest = tmp_path / "lossy-out"
    refusal = error(
        call("export_release", project=named, tag="v1.0", format="lossy-probe", dest=str(dest))
    )
    assert refusal["retry_with"] == "allow_lossy"
    assert not dest.exists(), "the gate is checked before anything is created"

    assert (
        payload(
            call(
                "export_release",
                project=named,
                tag="v1.0",
                format="lossy-probe",
                dest=str(dest),
                allow_lossy=True,
            )
        )["format"]
        == "lossy-probe"
    )
