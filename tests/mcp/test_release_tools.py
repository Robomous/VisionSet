"""Publishing, verifying and exporting — plus ``dataset_stats`` and ``list_formats``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from tests.mcp._flow import BBOX, SCHEMA_CLASSES, call, error, open_batch, payload

from visionset.kernel.domain import GeometryType
from visionset.kernel.ports import ContentReader, Exporter
from visionset.kernel.services import EXPORT_REPORT_FILENAME


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


def test_the_installed_exporters_declare_what_they_can_carry() -> None:
    assert payload(call("list_formats")) == {
        "items": [
            {
                # #63. Lossless: boxes and polygons are native, and everything
                # COCO has no field for rides in a `visionset` object.
                "name": "coco",
                "lossy": False,
                "geometries": ["bbox", "polygon"],
                "degraded_geometries": [],
                "modalities": ["image"],
            },
            {
                "name": "dummy",
                "lossy": False,
                # #65: what the format can carry. `dummy` declares everything,
                # which is what makes it the format that never refuses.
                "geometries": sorted(one.value for one in GeometryType),
                "degraded_geometries": [],
                "modalities": ["image", "point_cloud", "video"],
            },
            {
                # #64. Lossy because a VOC `<object>` has a fixed set of children
                # its consumers index by tag name.
                "name": "voc",
                "lossy": True,
                "geometries": ["bbox"],
                "degraded_geometries": ["polygon"],
                "modalities": ["image"],
            },
            {
                # #62, and the first format in this repository that writes
                # anything. Lossy because a label row is five numbers, so
                # attributes, confidence and provenance never survive.
                "name": "yolo",
                "lossy": True,
                "geometries": ["bbox"],
                "degraded_geometries": ["polygon"],
                "modalities": ["image"],
            },
        ],
        "total": 4,
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
        call(
            "export_release",
            project=named,
            tag="v1.0",
            format="not-a-format",
            dest=str(tmp_path / "out"),
        )
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

    #: #65's capability declaration. Everything, so this double's *subject* stays
    #: what it was — the file it writes, or the flag it sets — rather than a
    #: geometry report nobody wrote this test for.
    supported_geometries = frozenset(GeometryType)
    degraded_geometries: frozenset[GeometryType] = frozenset()
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Any,
        manifest: Any,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
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


class PolygonsOnlyExporter:
    """Lossless by its own declaration, and unable to write the one geometry in play.

    The pair #65 exists for: `lossy` is false, so a refusal against this one is
    entirely about what the release holds.
    """

    format_name = "polygons-probe"
    lossy = False

    supported_geometries = frozenset({GeometryType.POLYGON})
    degraded_geometries: frozenset[GeometryType] = frozenset()
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Any,
        manifest: Any,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        dest.mkdir(parents=True, exist_ok=True)


def _only(monkeypatch: pytest.MonkeyPatch, plugin: Exporter) -> None:
    from visionset.formats import registry

    monkeypatch.setattr(registry, "exporters", lambda: {plugin.format_name: plugin})


def test_check_export_reports_what_a_format_would_drop(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    plugin = PolygonsOnlyExporter()
    assert isinstance(plugin, Exporter)
    named = promoted(monkeypatch, tmp_path, count=1)
    payload(call("publish_release", project=named, tag="v1.0"))
    _only(monkeypatch, plugin)

    report = payload(call("check_export", project=named, tag="v1.0", format="polygons-probe"))

    assert report["compatible"] is False
    assert report["format"] == "polygons-probe"
    assert report["format_is_lossy"] is False
    assert report["excluded_annotations"] == 1
    (sign,) = [one for one in report["classes"] if one["status"] != "supported"]
    # Dropped, not degraded: this probe declares no `degraded_geometries`, so a
    # box it cannot write is genuinely absent from the output.
    assert sign["status"] == "dropped"
    assert sign["reason"] == "polygons-probe cannot place a bbox and drops it"


def test_a_format_that_carries_everything_reports_compatible(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = promoted(monkeypatch, tmp_path, count=1)
    payload(call("publish_release", project=named, tag="v1.0"))

    report = payload(call("check_export", project=named, tag="v1.0", format="dummy"))

    assert report["compatible"] is True
    assert (report["excluded_annotations"], report["excluded_assets"]) == (0, 0)


def test_a_lossless_format_that_would_drop_a_class_still_asks_for_consent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The refusal names `check_export`, because the envelope's four keys hold no report."""
    plugin = PolygonsOnlyExporter()
    named = promoted(monkeypatch, tmp_path, count=1)
    payload(call("publish_release", project=named, tag="v1.0"))
    _only(monkeypatch, plugin)
    dest = tmp_path / "polygons-out"

    refusal = error(
        call(
            "export_release",
            project=named,
            tag="v1.0",
            format="polygons-probe",
            dest=str(dest),
        )
    )

    assert refusal["retry_with"] == "allow_lossy"
    assert refusal["hint"] is not None
    assert "check_export" in refusal["hint"]
    assert not dest.exists()


def test_an_export_carries_the_report_it_was_consented_to(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    plugin = PolygonsOnlyExporter()
    named = promoted(monkeypatch, tmp_path, count=1)
    payload(call("publish_release", project=named, tag="v1.0"))
    _only(monkeypatch, plugin)
    dest = tmp_path / "polygons-out"

    result = payload(
        call(
            "export_release",
            project=named,
            tag="v1.0",
            format="polygons-probe",
            dest=str(dest),
            allow_lossy=True,
        )
    )

    assert result["compatibility"]["compatible"] is False
    # …and the same document is on disk, which is what makes the answer readable
    # by whatever picks the directory up later.
    written = json.loads((dest / EXPORT_REPORT_FILENAME).read_text(encoding="utf-8"))
    assert written == result["compatibility"]
