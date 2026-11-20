"""`get_calibration`, `set_calibration`, `clear_calibration` — the agent's round trip."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from tests.fixtures.calibration import calibration_document
from tests.mcp._flow import call, error, ingested, payload

from visionset.kernel.domain import Annotation, Polyline3DGeometry
from visionset.kernel.services import WorkspaceService


def _ids(named: str) -> tuple[str, str]:
    source = payload(call("list_sources", project=named))["items"][0]["id"]
    asset = payload(call("list_project_assets", project=named))["items"][0]["id"]
    return str(source), str(asset)


@pytest.fixture()
def rig(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[str, str, str]:
    named, _ = ingested(monkeypatch, tmp_path, count=1)
    return (named, *_ids(named))


def test_a_source_calibration_round_trips(rig: tuple[str, str, str]) -> None:
    named, source_id, _ = rig
    assert payload(call("get_calibration", project=named, source_id=source_id)) == {
        "source_id": source_id,
        "calibration": None,
    }

    stated = payload(
        call(
            "set_calibration",
            project=named,
            source_id=source_id,
            calibration=calibration_document(),
        )
    )
    read = payload(call("get_calibration", project=named, source_id=source_id))

    assert stated == read == {"source_id": source_id, "calibration": calibration_document()}
    cleared = payload(call("clear_calibration", project=named, source_id=source_id))
    assert cleared["calibration"] is None


def test_an_asset_override_round_trips_and_falls_back_to_the_source(
    rig: tuple[str, str, str],
) -> None:
    named, source_id, asset_id = rig
    inherited, own = calibration_document(fx=10.0), calibration_document(fx=20.0)
    payload(call("set_calibration", project=named, source_id=source_id, calibration=inherited))

    stated = payload(call("set_calibration", project=named, asset_id=asset_id, calibration=own))
    assert stated == {"asset_id": asset_id, "override": own, "effective": own}
    assert payload(call("get_calibration", project=named, asset_id=asset_id)) == stated

    cleared = payload(call("clear_calibration", project=named, asset_id=asset_id))
    assert cleared == {"asset_id": asset_id, "override": None, "effective": inherited}


def test_a_calibration_measured_at_another_size_is_refused_by_code(
    rig: tuple[str, str, str],
) -> None:
    named, source_id, asset_id = rig
    wrong = calibration_document(width=64, height=48)
    for target in ({"source_id": source_id}, {"asset_id": asset_id}):
        refused = error(call("set_calibration", project=named, calibration=wrong, **target))
        assert refused["code"] == "CALIBRATION_RESOLUTION_MISMATCH"


def test_clearing_a_calibration_3d_labels_need_is_refused_by_code(
    rig: tuple[str, str, str], tmp_path: Path
) -> None:
    named, source_id, asset_id = rig
    payload(
        call(
            "set_calibration",
            project=named,
            source_id=source_id,
            calibration=calibration_document(),
        )
    )
    workspace = WorkspaceService.open(tmp_path / "ws")
    with workspace.unit_of_work() as uow:
        uow.annotations.add(
            Annotation(
                asset_id=UUID(asset_id),
                label_class="lane",
                schema_version=1,
                geometry=Polyline3DGeometry(points=[(0.0, 1.0, 5.0), (0.0, 1.0, 9.0)]),
                provenance="human",
            )
        )
    workspace.close()

    refused = error(call("clear_calibration", project=named, source_id=source_id))

    assert refused["code"] == "CALIBRATION_IN_USE"
    still = payload(call("get_calibration", project=named, source_id=source_id))
    assert still["calibration"] == calibration_document()


@pytest.mark.parametrize("targets", [{}, {"source_id": "x", "asset_id": "y"}])
def test_exactly_one_target_is_required(rig: tuple[str, str, str], targets: Any) -> None:
    named, _, _ = rig
    assert error(call("get_calibration", project=named, **targets))["code"] == "VALIDATION_ERROR"


def test_a_source_of_another_project_reads_as_missing(rig: tuple[str, str, str]) -> None:
    named, source_id, _ = rig
    payload(call("create_project", name="elsewhere"))
    refused = error(call("get_calibration", project="elsewhere", source_id=source_id))
    assert refused["code"] == "SOURCE_NOT_FOUND"
