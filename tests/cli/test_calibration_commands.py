"""``visionset calibration``: a source's camera, and one asset's override, at a terminal."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from tests.cli._flow import ingested_batch, ok, payload, run, usage_error, workspace
from tests.fixtures.calibration import calibration_document

from visionset.kernel.domain import Annotation, Polyline3DGeometry
from visionset.kernel.services import (
    IngestService,
    ProjectService,
    SourceService,
    WorkspaceService,
)


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.delenv("VISIONSET_WORKSPACE", raising=False)
    return workspace(tmp_path)


@pytest.fixture()
def rig(root: Path, tmp_path: Path) -> tuple[str, str, str]:
    name, _ = ingested_batch(root, tmp_path)
    opened = WorkspaceService.open(root)
    project = ProjectService(opened).resolve(name)
    source = SourceService(opened).list(project.id)[0]
    asset = IngestService(opened).assets(project.id)[0]
    opened.close()
    return name, str(source.id), str(asset.id)


def _file(tmp_path: Path, document: dict[str, Any], name: str = "camera.json") -> str:
    path = tmp_path / name
    path.write_text(json.dumps(document), encoding="utf-8")
    return str(path)


def _refusal(root: Path, *argv: str) -> dict[str, Any]:
    result = run(root, *argv, "--json")
    assert result.exit_code == 1, result.output
    error: dict[str, Any] = json.loads(result.stdout)["error"]
    return error


def test_a_source_calibration_round_trips(
    root: Path, tmp_path: Path, rig: tuple[str, str, str]
) -> None:
    name, source, _ = rig
    shown = payload(root, "calibration", "show", "-p", name, "--source", source)
    assert shown == {"source_id": source, "calibration": None}

    stated = payload(
        root,
        "calibration",
        "set",
        _file(tmp_path, calibration_document()),
        "-p",
        name,
        "--source",
        source,
    )
    shown = payload(root, "calibration", "show", "-p", name, "--source", source)

    assert stated == shown == {"source_id": source, "calibration": calibration_document()}
    cleared = payload(root, "calibration", "clear", "-p", name, "--source", source)
    assert cleared["calibration"] is None


def test_what_show_prints_is_what_set_reads(
    root: Path, tmp_path: Path, rig: tuple[str, str, str]
) -> None:
    name, source, asset = rig
    ok(
        root,
        "calibration",
        "set",
        _file(tmp_path, calibration_document()),
        "-p",
        name,
        "--source",
        source,
    )
    printed = payload(root, "calibration", "show", "-p", name, "--source", source)

    stated = payload(
        root,
        "calibration",
        "set",
        _file(tmp_path, printed["calibration"], "again.json"),
        "-p",
        name,
        "--asset",
        asset,
    )
    assert stated == {
        "asset_id": asset,
        "override": calibration_document(),
        "effective": calibration_document(),
    }
    cleared = payload(root, "calibration", "clear", "-p", name, "--asset", asset)
    assert cleared["override"] is None
    assert cleared["effective"] == calibration_document()


def test_a_calibration_measured_at_another_size_is_refused_by_code(
    root: Path, tmp_path: Path, rig: tuple[str, str, str]
) -> None:
    name, source, asset = rig
    wrong = _file(tmp_path, calibration_document(width=64, height=48))
    for target in (("--source", source), ("--asset", asset)):
        refused = _refusal(root, "calibration", "set", wrong, "-p", name, *target)
        assert refused["code"] == "CALIBRATION_RESOLUTION_MISMATCH"


def test_clearing_a_calibration_3d_labels_need_is_refused_by_code(
    root: Path, tmp_path: Path, rig: tuple[str, str, str]
) -> None:
    name, source, asset = rig
    ok(
        root,
        "calibration",
        "set",
        _file(tmp_path, calibration_document()),
        "-p",
        name,
        "--source",
        source,
    )
    opened = WorkspaceService.open(root)
    with opened.unit_of_work() as uow:
        uow.annotations.add(
            Annotation(
                asset_id=UUID(asset),
                label_class="lane",
                schema_version=1,
                geometry=Polyline3DGeometry(points=[(0.0, 1.0, 5.0), (0.0, 1.0, 9.0)]),
                provenance="human",
            )
        )
    opened.close()

    refused = _refusal(root, "calibration", "clear", "-p", name, "--source", source)

    assert refused["code"] == "CALIBRATION_IN_USE"


def test_replacing_a_calibration_3d_labels_were_drawn_against_is_refused_by_code(
    root: Path, tmp_path: Path, rig: tuple[str, str, str]
) -> None:
    name, source, asset = rig
    stated = _file(tmp_path, calibration_document())
    ok(root, "calibration", "set", stated, "-p", name, "--source", source)
    opened = WorkspaceService.open(root)
    with opened.unit_of_work() as uow:
        uow.annotations.add(
            Annotation(
                asset_id=UUID(asset),
                label_class="lane",
                schema_version=1,
                geometry=Polyline3DGeometry(points=[(0.0, 1.0, 5.0), (0.0, 1.0, 9.0)]),
                provenance="human",
            )
        )
    opened.close()
    other = _file(tmp_path, calibration_document(fx=40.0), name="other.json")

    refused = _refusal(root, "calibration", "set", other, "-p", name, "--source", source)

    assert refused["code"] == "CALIBRATION_IN_USE"
    ok(root, "calibration", "set", stated, "-p", name, "--source", source)
    ok(root, "calibration", "set", stated, "-p", name, "--asset", asset)
    refused = _refusal(root, "calibration", "set", other, "-p", name, "--asset", asset)
    assert refused["code"] == "CALIBRATION_IN_USE"


@pytest.mark.parametrize("targets", [(), ("--source", "x", "--asset", "y")])
def test_exactly_one_target_is_a_usage_error(
    root: Path, rig: tuple[str, str, str], targets: tuple[str, ...]
) -> None:
    name, source, asset = rig
    argv = {"x": source, "y": asset}
    result = run(root, "calibration", "show", "-p", name, *(argv.get(a, a) for a in targets))
    assert result.exit_code == 2
    assert "exactly one of --source and --asset" in usage_error(result)


def test_a_malformed_file_is_a_usage_error(
    root: Path, tmp_path: Path, rig: tuple[str, str, str]
) -> None:
    name, source, _ = rig
    document = calibration_document()
    document["intrinsics"]["fx"] = 0
    result = run(
        root, "calibration", "set", _file(tmp_path, document), "-p", name, "--source", source
    )
    assert result.exit_code == 2
    assert "intrinsics.fx" in usage_error(result)
