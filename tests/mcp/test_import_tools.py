"""``inspect_import`` / ``import_dataset``: the plan without writing, the commit with consent."""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest
from tests.fixtures.coco_source import write_coco_source
from tests.fixtures.kitti_source import write_kitti_source
from tests.mcp._flow import call, call_with_progress, error, payload, project

from visionset.kernel.domain import AssetProgress, BatchState
from visionset.kernel.services import (
    BatchService,
    IngestService,
    JobService,
    ProjectService,
    SchemaService,
    WorkspaceService,
)


def _state(root: Path, name: str) -> tuple[int, int, int]:
    with WorkspaceService.open(root) as service:
        found = ProjectService(service).resolve(name)
        return (
            len(IngestService(service).assets(found.id)),
            len(BatchService(service).list(found.id)),
            len(SchemaService(service).list_versions(found.id)),
        )


def test_inspect_reports_the_losses_and_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    src = write_coco_source(tmp_path / "src", lossy=True)

    plan = payload(call("inspect_import", project=named, format="coco", path=str(src)))

    assert plan["loss_kinds"] == ["label"]
    assert plan["losses"][0]["subject"] == "car"
    assert plan["creates_schema"] is True
    assert [c["name"] for c in plan["classes"]] == ["car", "lane"]
    assert (plan["images"], plan["labels"]) == (2, 3)
    assert _state(tmp_path / "ws", named) == (0, 0, 0)


def test_an_unconsented_loss_is_refused_and_consent_lets_it_through(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    src = write_coco_source(tmp_path / "src", lossy=True)

    refusal = error(call("import_dataset", project=named, format="coco", path=str(src)))
    assert refusal["code"] == "IMPORT_NOT_CONSENTED"
    assert refusal["retry_with"] == "consent_lossy"
    assert [loss["kind"] for loss in refusal["detail"]["losses"]] == ["label"]
    assert _state(tmp_path / "ws", named) == (0, 0, 0)

    run = payload(
        call(
            "import_dataset",
            project=named,
            format="coco",
            path=str(src),
            consent_lossy=["label"],
        )
    )
    assert run["batch_id"]
    assert _state(tmp_path / "ws", named) == (2, 1, 1)


def test_an_unknown_loss_kind_is_refused_before_anything_runs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    src = write_coco_source(tmp_path / "src")
    result = call(
        "import_dataset", project=named, format="coco", path=str(src), consent_lossy=["masks"]
    )
    assert result.is_error
    assert _state(tmp_path / "ws", named) == (0, 0, 0)


def test_the_import_is_an_approved_batch_of_annotated_assets(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    src = write_coco_source(tmp_path / "src")

    run = payload(call("import_dataset", project=named, format="coco", path=str(src)))

    assert (run["created_asset_count"], run["annotations_written"]) == (2, 3)
    assert run["schema_version"] == 1
    batch = payload(call("get_batch", batch_id=run["batch_id"]))
    assert batch["state"] == "approved"
    with WorkspaceService.open(tmp_path / "ws") as service:
        batch_id = UUID(run["batch_id"])
        assert BatchService(service).get(batch_id).state is BatchState.APPROVED
        assert JobService(service).batch_progress(batch_id)[AssetProgress.ANNOTATED] == 2


def test_progress_is_reported_per_stored_image(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    src = write_coco_source(tmp_path / "src")

    result, seen = call_with_progress("import_dataset", project=named, format="coco", path=str(src))

    payload(result)
    assert seen
    assert seen[-1][:2] == (2, 2)


def test_an_unknown_format_and_an_unreadable_source_are_coded_refusals(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    src = write_coco_source(tmp_path / "src")

    unknown = error(call("inspect_import", project=named, format="nope", path=str(src)))
    assert unknown["code"] == "IMPORT_FORMAT_NOT_FOUND"
    missing = error(
        call("import_dataset", project=named, format="coco", path=str(tmp_path / "missing"))
    )
    assert missing["code"] == "IMPORT_SOURCE_UNREADABLE"
    assert _state(tmp_path / "ws", named) == (0, 0, 0)


def test_a_kitti_source_is_inspected_as_scans_and_imported_with_consent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    src = write_kitti_source(tmp_path / "src")

    plan = payload(call("inspect_import", project=named, format="kitti", path=str(src)))
    assert (plan["scans"], plan["images"], plan["labels"], plan["frame"]) == (2, 0, 2, "lidar_flu")
    assert plan["loss_kinds"] == ["attribute", "geometry", "label"]

    refusal = error(call("import_dataset", project=named, format="kitti", path=str(src)))
    assert refusal["code"] == "IMPORT_NOT_CONSENTED"
    assert _state(tmp_path / "ws", named) == (0, 0, 0)

    run = payload(
        call(
            "import_dataset",
            project=named,
            format="kitti",
            path=str(src),
            consent_lossy=plan["loss_kinds"],
        )
    )
    assert (run["created_asset_count"], run["annotations_written"]) == (2, 2)
    assert _state(tmp_path / "ws", named) == (2, 1, 1)
