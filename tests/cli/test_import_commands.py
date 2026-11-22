"""``visionset import``: a dataset in, one approved batch out, losses only with consent."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID

import pytest
from tests.cli._flow import ok, payload, project, run, workspace
from tests.fixtures.coco_source import write_coco_source
from tests.fixtures.kitti_source import write_kitti_source

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
    """Assets, batches and schema versions the project holds."""
    with WorkspaceService.open(root) as service:
        found = ProjectService(service).resolve(name)
        return (
            len(IngestService(service).assets(found.id)),
            len(BatchService(service).list(found.id)),
            len(SchemaService(service).list_versions(found.id)),
        )


def test_an_import_lands_as_an_approved_batch_of_annotated_assets(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = project(root)
    src = write_coco_source(tmp_path / "src")

    batch_id = UUID(ok(root, "import", "coco", str(src), "--project", name))

    with WorkspaceService.open(root) as service:
        batch = BatchService(service).get(batch_id)
        assert batch.state is BatchState.APPROVED
        assert batch.schema_version == 1
        counts = JobService(service).batch_progress(batch_id)
        assert counts[AssetProgress.ANNOTATED] == 2
        with service.unit_of_work() as uow:
            labels = [a for asset_id in batch.asset_ids for a in uow.annotations.list(asset_id)]
    assert len(labels) == 3
    assert {label.provenance for label in labels} == {"import"}


def test_a_lossy_import_is_refused_until_its_kind_is_consented(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = project(root)
    src = write_coco_source(tmp_path / "src", lossy=True)

    refused = run(root, "import", "coco", str(src), "--project", name)
    assert refused.exit_code == 1, refused.output
    assert "--consent-lossy" in refused.stderr
    assert _state(root, name) == (0, 0, 0)

    wrong = run(root, "import", "coco", str(src), "--project", name, "--consent-lossy", "image")
    assert wrong.exit_code == 1, wrong.output
    assert _state(root, name) == (0, 0, 0)

    ok(root, "import", "coco", str(src), "--project", name, "--consent-lossy", "label")
    assert _state(root, name) == (2, 1, 1)


def test_a_refusal_under_json_carries_the_code_and_the_losses(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = project(root)
    src = write_coco_source(tmp_path / "src", lossy=True)

    result = run(root, "import", "coco", str(src), "--project", name, "--json")
    assert result.exit_code == 1, result.output
    error = json.loads(result.stdout)["error"]
    assert error["code"] == "IMPORT_NOT_CONSENTED"
    assert [loss["kind"] for loss in error["detail"]["losses"]] == ["label"]


def test_a_dry_run_reports_and_writes_nothing(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = project(root)
    src = write_coco_source(tmp_path / "src", lossy=True)

    result = run(root, "import", "coco", str(src), "--project", name, "--dry-run", "--json")
    assert result.exit_code == 1, result.output
    plan = json.loads(result.stdout)
    assert plan["loss_kinds"] == ["label"]
    assert plan["creates_schema"] is True
    assert (plan["new_assets"], plan["new_annotations"]) == (2, 3)
    assert _state(root, name) == (0, 0, 0)


def test_a_dry_run_with_the_consent_a_commit_needs_exits_zero(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = project(root)
    src = write_coco_source(tmp_path / "src", lossy=True)

    result = run(
        root, "import", "coco", str(src), "--project", name, "--dry-run", "--consent-lossy", "label"
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.splitlines()[0].split() == ["KIND", "SUBJECT", "COUNT", "REASON"]
    assert _state(root, name) == (0, 0, 0)


def test_running_the_same_source_again_creates_no_batch(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = project(root)
    src = write_coco_source(tmp_path / "src")
    ok(root, "import", "coco", str(src), "--project", name)

    again = payload(root, "import", "coco", str(src), "--project", name)
    assert again["batch_id"] is None
    assert again["annotations_already_present"] == 3
    assert _state(root, name) == (2, 1, 1)


def test_an_unknown_format_is_refused_with_the_importable_ones(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = project(root)
    src = write_coco_source(tmp_path / "src")

    result = run(root, "import", "nope", str(src), "--project", name, "--json")
    assert result.exit_code == 1, result.output
    error = json.loads(result.stdout)["error"]
    assert error["code"] == "IMPORT_FORMAT_NOT_FOUND"
    assert "coco" in error["message"]


def test_an_unreadable_source_is_refused(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = project(root)
    src = tmp_path / "src"
    (src / "annotations").mkdir(parents=True)
    (src / "annotations" / "instances_train.json").write_text("{not json", encoding="utf-8")

    for path in (src, tmp_path / "missing"):
        result = run(root, "import", "coco", str(path), "--project", name, "--json")
        assert result.exit_code == 1, result.output
        assert json.loads(result.stdout)["error"]["code"] == "IMPORT_SOURCE_UNREADABLE"
    assert _state(root, name) == (0, 0, 0)


@pytest.mark.parametrize("dirname", ["x" * 250, "bad\nname"])
def test_a_source_directory_name_that_is_not_a_valid_batch_name_still_imports(
    tmp_path: Path, dirname: str
) -> None:
    root = workspace(tmp_path)
    name = project(root)
    src = write_coco_source(tmp_path / dirname)

    dry = run(root, "import", "coco", str(src), "--project", name, "--dry-run")
    committed = run(root, "import", "coco", str(src), "--project", name)

    assert dry.exit_code == 0
    assert committed.exit_code == 0


def test_a_kitti_dry_run_counts_scans_and_a_consented_commit_imports_them(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = project(root)
    src = write_kitti_source(tmp_path / "src")
    consent = [
        arg for kind in ("label", "geometry", "attribute") for arg in ("--consent-lossy", kind)
    ]

    dry = run(root, "import", "kitti", str(src), "--project", name, "--dry-run", *consent)
    assert dry.exit_code == 0, dry.output
    assert "2 scan(s) in the lidar_flu frame and 2 label(s)" in dry.stderr
    assert _state(root, name) == (0, 0, 0)

    refused = run(root, "import", "kitti", str(src), "--project", name)
    assert refused.exit_code == 1, refused.output
    assert _state(root, name) == (0, 0, 0)

    batch_id = UUID(ok(root, "import", "kitti", str(src), "--project", name, *consent))
    with WorkspaceService.open(root) as service:
        assert BatchService(service).get(batch_id).state is BatchState.APPROVED
    assert _state(root, name) == (2, 1, 1)
