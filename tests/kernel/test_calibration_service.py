"""Calibration: the domain value, and `CalibrationService` over sources and assets."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from pydantic import ValidationError
from tests.fixtures.calibration import calibration, calibration_document
from tests.fixtures.media import write_image, write_images

from visionset.kernel import (
    AssetNotFound,
    CalibrationInUse,
    CalibrationResolutionMismatch,
    ConstraintViolated,
    ProjectNotFound,
    SourceNotFound,
    WorkspaceBusy,
)
from visionset.kernel.adapters.sqlite_metadata_store import SqliteMetadataStore
from visionset.kernel.domain import (
    Annotation,
    Asset,
    BboxGeometry,
    Calibration,
    Cuboid3DGeometry,
    Geometry,
    Polyline3DGeometry,
    Source,
    SourceKind,
    VideoMetadata,
    VideoProvenance,
    effective_calibration,
    geometry_needs_calibration,
)
from visionset.kernel.services import (
    CalibrationService,
    IngestService,
    ProjectService,
    SourceService,
    WorkspaceService,
)
from visionset.kernel.services import calibration_service as calibration_module

BOX = BboxGeometry(x=1, y=1, width=2, height=2)
PATH_3D = Polyline3DGeometry(points=[(0.0, 1.0, 5.0), (0.0, 1.0, 9.0)])
BOX_3D = Cuboid3DGeometry(center=(0.5, 1.0, 9.0), size=(4.2, 1.8, 1.5), yaw=0.25)


class Fixture:
    """A project with one ingested directory of two 32x24 stills."""

    def __init__(self, tmp_path: Path) -> None:
        self.root = tmp_path / "ws"
        self.workspace = WorkspaceService.init(self.root)
        self.project = ProjectService(self.workspace).create("rig")
        self.stills = tmp_path / "stills"
        write_images(self.stills, count=2)
        self.sources = SourceService(self.workspace)
        self.source = self.sources.register_images(self.project.id, self.stills)
        IngestService(self.workspace).ingest(self.source.id)
        self.assets = IngestService(self.workspace).assets(self.project.id)
        self.calibrations = CalibrationService(self.workspace)

    def label(self, asset: Asset, geometry: Geometry = BOX) -> None:
        with self.workspace.unit_of_work() as uow:
            uow.annotations.add(
                Annotation(
                    asset_id=asset.id,
                    label_class="lane",
                    schema_version=1,
                    geometry=geometry,
                    provenance="human",
                )
            )


@pytest.fixture()
def fx(tmp_path: Path) -> Any:
    made = Fixture(tmp_path)
    yield made
    made.workspace.close()


# --- the domain value --------------------------------------------------------


def test_a_calibration_round_trips_through_its_json() -> None:
    document = calibration_document()
    assert Calibration.model_validate(document).model_dump(mode="json") == document


def test_distortion_is_optional_and_extrinsics_are_not() -> None:
    assert calibration(distortion=False).distortion is None
    document = calibration_document()
    del document["extrinsics"]
    with pytest.raises(ValidationError):
        Calibration.model_validate(document)


@pytest.mark.parametrize(
    "rotation",
    [
        [[2.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, -1.0]],
        [[1.0, 0.1, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    ],
    ids=["scaled", "reflection", "sheared"],
)
def test_a_rotation_that_is_not_proper_is_refused(rotation: list[list[float]]) -> None:
    document = calibration_document()
    document["extrinsics"]["rotation"] = rotation
    with pytest.raises(ValidationError, match="rotation must"):
        Calibration.model_validate(document)


@pytest.mark.parametrize(
    ("field", "value"),
    [("fx", 0.0), ("fy", -1.0), ("width", 0), ("cx", float("nan"))],
)
def test_impossible_intrinsics_are_refused(field: str, value: float) -> None:
    document = calibration_document()
    document["intrinsics"][field] = value
    with pytest.raises(ValidationError):
        Calibration.model_validate(document)


def test_the_override_wins_then_the_source() -> None:
    project_id = uuid4()
    source = Source(project_id=project_id, kind=SourceKind.IMAGE_DIRECTORY, locator="/x")
    asset = Asset(project_id=project_id, content_hash="a" * 64, uri="/x/a.png")
    own, inherited = calibration(fx=10.0), calibration(fx=20.0)

    assert effective_calibration(asset, None) is None
    assert effective_calibration(asset, source.model_copy(update={"calibration": inherited})) == (
        inherited
    )
    overridden = asset.model_copy(update={"calibration": own})
    assert (
        effective_calibration(overridden, source.model_copy(update={"calibration": inherited}))
        == own
    )
    assert effective_calibration(overridden, source) == own


def test_no_implemented_geometry_needs_a_calibration_yet() -> None:
    assert not geometry_needs_calibration(
        BboxGeometry(x=0, y=0, width=1, height=1), modality="image"
    )


# --- a source's calibration --------------------------------------------------


def test_a_source_calibration_persists_and_is_replaced_whole(fx: Fixture) -> None:
    first, second = calibration(fx=10.0), calibration(fx=20.0, distortion=False)
    fx.calibrations.set_source_calibration(fx.source.id, first)
    fx.calibrations.set_source_calibration(fx.source.id, second)
    fx.workspace.close()

    reopened = WorkspaceService.open(fx.root)
    assert CalibrationService(reopened).source_calibration(fx.source.id) == second
    reopened.close()
    fx.workspace = WorkspaceService.open(fx.root)


def test_registering_the_same_directory_again_keeps_one_source_and_its_calibration(
    fx: Fixture,
) -> None:
    stated = calibration()
    fx.calibrations.set_source_calibration(fx.source.id, stated)

    again = fx.sources.register_images(fx.project.id, fx.stills, capture_params={"lens": "b"})

    assert again.id == fx.source.id
    assert [s.id for s in fx.sources.list(fx.project.id)] == [fx.source.id]
    assert again.calibration == stated


def test_the_identity_index_refuses_one_origin_twice_whatever_the_calibration(
    fx: Fixture,
) -> None:
    """Below the service's pre-check: calibration is not a term of the origin index."""
    fx.calibrations.set_source_calibration(fx.source.id, calibration(fx=10.0))
    twin = Source(
        project_id=fx.project.id,
        kind=SourceKind.IMAGE_DIRECTORY,
        locator=fx.source.locator,
        calibration=calibration(fx=20.0),
    )

    with pytest.raises(ConstraintViolated), fx.workspace.unit_of_work() as uow:
        uow.sources.add(twin)

    assert [s.id for s in fx.sources.list(fx.project.id)] == [fx.source.id]


def test_a_source_calibration_reaches_its_assets_until_one_overrides_it(fx: Fixture) -> None:
    inherited, own = calibration(fx=10.0), calibration(fx=20.0)
    fx.calibrations.set_source_calibration(fx.source.id, inherited)
    first, second = fx.assets

    fx.calibrations.set_asset_calibration(fx.project.id, first.id, own)

    resolved = fx.calibrations.asset_calibration(fx.project.id, first.id)
    assert (resolved.override, resolved.effective) == (own, own)
    resolved = fx.calibrations.asset_calibration(fx.project.id, second.id)
    assert (resolved.override, resolved.effective) == (None, inherited)


def test_a_source_calibration_measured_at_another_size_is_refused(fx: Fixture) -> None:
    with pytest.raises(CalibrationResolutionMismatch, match="32x24"):
        fx.calibrations.set_source_calibration(fx.source.id, calibration(width=64, height=48))
    assert fx.calibrations.source_calibration(fx.source.id) is None


def test_an_asset_with_its_own_calibration_does_not_block_its_source(fx: Fixture) -> None:
    """Only the assets that would inherit are measured against."""
    with fx.workspace.unit_of_work() as uow:
        for asset in fx.assets:
            uow.assets.update(asset.model_copy(update={"width": 64, "height": 48}))
    for asset in fx.assets:
        fx.calibrations.set_asset_calibration(
            fx.project.id, asset.id, calibration(width=64, height=48)
        )

    fx.calibrations.set_source_calibration(fx.source.id, calibration())


def test_a_clip_is_measured_by_the_size_it_stores_frames_at(fx: Fixture) -> None:
    clip = Source(
        project_id=fx.project.id,
        kind=SourceKind.VIDEO,
        locator=f"video-import:{uuid4()}",
        video=VideoProvenance(
            metadata=VideoMetadata(width=64, height=48, fps=30, duration_seconds=1, codec="h264"),
            extraction_fps=1,
            scale_percent=50,
        ),
    )
    with fx.workspace.unit_of_work() as uow:
        uow.sources.add(clip)

    with pytest.raises(CalibrationResolutionMismatch):
        fx.calibrations.set_source_calibration(clip.id, calibration(width=64, height=48))
    stored = fx.calibrations.set_source_calibration(clip.id, calibration(width=32, height=24))
    assert stored.calibration == calibration(width=32, height=24)


def test_clearing_a_source_calibration_falls_back_to_none(fx: Fixture) -> None:
    fx.calibrations.set_source_calibration(fx.source.id, calibration())
    fx.label(fx.assets[0])

    assert fx.calibrations.clear_source_calibration(fx.source.id).calibration is None
    assert fx.calibrations.clear_source_calibration(fx.source.id).calibration is None


def test_clearing_a_source_calibration_its_3d_labels_need_is_refused(fx: Fixture) -> None:
    stated = calibration()
    fx.calibrations.set_source_calibration(fx.source.id, stated)
    fx.label(fx.assets[0], PATH_3D)

    with pytest.raises(CalibrationInUse, match=str(fx.assets[0].id)):
        fx.calibrations.clear_source_calibration(fx.source.id)
    assert fx.calibrations.source_calibration(fx.source.id) == stated


def test_a_labelled_asset_with_its_own_calibration_does_not_block_clearing_the_source(
    fx: Fixture,
) -> None:
    fx.calibrations.set_source_calibration(fx.source.id, calibration())
    fx.calibrations.set_asset_calibration(fx.project.id, fx.assets[0].id, calibration(fx=9.0))
    fx.label(fx.assets[0], PATH_3D)

    assert fx.calibrations.clear_source_calibration(fx.source.id).calibration is None


@pytest.mark.parametrize("geometry", [PATH_3D, BOX_3D], ids=["polyline_3d", "cuboid_3d"])
def test_replacing_a_source_calibration_its_3d_labels_were_drawn_against_is_refused(
    fx: Fixture, geometry: Geometry
) -> None:
    stated = calibration()
    fx.calibrations.set_source_calibration(fx.source.id, stated)
    fx.label(fx.assets[0], geometry)

    with pytest.raises(CalibrationInUse, match=str(fx.assets[0].id)):
        fx.calibrations.set_source_calibration(fx.source.id, calibration(fx=40.0))
    assert fx.calibrations.source_calibration(fx.source.id) == stated


def test_stating_the_identical_source_calibration_again_is_a_no_op(fx: Fixture) -> None:
    stated = calibration()
    fx.calibrations.set_source_calibration(fx.source.id, stated)
    fx.label(fx.assets[0], PATH_3D)

    again = fx.calibrations.set_source_calibration(fx.source.id, calibration())

    assert again.calibration == stated
    assert fx.calibrations.source_calibration(fx.source.id) == stated


def test_replacing_a_source_calibration_with_only_2d_labels_is_allowed(fx: Fixture) -> None:
    fx.calibrations.set_source_calibration(fx.source.id, calibration())
    fx.label(fx.assets[0], BOX)

    stored = fx.calibrations.set_source_calibration(fx.source.id, calibration(fx=40.0))

    assert stored.calibration == calibration(fx=40.0)


def test_a_first_source_calibration_is_not_refused_by_labels(fx: Fixture) -> None:
    fx.label(fx.assets[0], PATH_3D)

    stored = fx.calibrations.set_source_calibration(fx.source.id, calibration())

    assert stored.calibration == calibration()


def test_a_labelled_asset_with_its_own_calibration_does_not_block_replacing_the_source(
    fx: Fixture,
) -> None:
    fx.calibrations.set_asset_calibration(fx.project.id, fx.assets[0].id, calibration(fx=9.0))
    fx.label(fx.assets[0], PATH_3D)
    first = fx.calibrations.set_source_calibration(fx.source.id, calibration())

    replaced = fx.calibrations.set_source_calibration(fx.source.id, calibration(fx=40.0))

    assert first.calibration == calibration()
    assert replaced.calibration == calibration(fx=40.0)


def test_a_source_of_another_project_reads_as_missing(fx: Fixture) -> None:
    other = ProjectService(fx.workspace).create("other")
    with pytest.raises(SourceNotFound):
        fx.calibrations.source_calibration(fx.source.id, project_id=other.id)
    with pytest.raises(SourceNotFound):
        fx.calibrations.set_source_calibration(uuid4(), calibration())


# --- an asset's override -----------------------------------------------------


def test_an_asset_override_persists_and_is_cleared_back_to_the_source(fx: Fixture) -> None:
    inherited, own = calibration(fx=10.0), calibration(fx=20.0)
    fx.calibrations.set_source_calibration(fx.source.id, inherited)
    asset = fx.assets[0]
    fx.calibrations.set_asset_calibration(fx.project.id, asset.id, own)
    assert IngestService(fx.workspace).asset(fx.project.id, asset.id).calibration == own

    cleared = fx.calibrations.clear_asset_calibration(fx.project.id, asset.id)

    assert (cleared.override, cleared.effective) == (None, inherited)


def test_clearing_an_override_onto_a_source_calibration_of_another_size_is_refused(
    fx: Fixture, tmp_path: Path
) -> None:
    mixed = tmp_path / "mixed"
    write_image(mixed / "large.png", size=(64, 48), seed=7)
    write_image(mixed / "small.png", size=(32, 24), seed=8)
    source = fx.sources.register_images(fx.project.id, mixed)
    IngestService(fx.workspace).ingest(source.id)
    by_width = {
        a.width: a
        for a in IngestService(fx.workspace).assets(fx.project.id)
        if a.source_id == source.id
    }
    large = by_width[64]
    own = calibration(width=64, height=48)
    fx.calibrations.set_asset_calibration(fx.project.id, large.id, own)
    fx.calibrations.set_source_calibration(source.id, calibration(width=32, height=24))

    with pytest.raises(CalibrationResolutionMismatch, match="64x48"):
        fx.calibrations.clear_asset_calibration(fx.project.id, large.id)
    assert fx.calibrations.asset_calibration(fx.project.id, large.id).override == own


def test_an_asset_override_measured_at_another_size_is_refused(fx: Fixture) -> None:
    with pytest.raises(CalibrationResolutionMismatch, match="32x24"):
        fx.calibrations.set_asset_calibration(
            fx.project.id, fx.assets[0].id, calibration(width=33, height=24)
        )


def test_an_asset_of_unknown_size_takes_any_calibration(fx: Fixture) -> None:
    with fx.workspace.unit_of_work() as uow:
        uow.assets.update(fx.assets[0].model_copy(update={"width": None, "height": None}))

    fx.calibrations.set_asset_calibration(
        fx.project.id, fx.assets[0].id, calibration(width=640, height=480)
    )


def test_clearing_the_last_calibration_a_labelled_asset_has_is_refused(fx: Fixture) -> None:
    asset = fx.assets[0]
    fx.calibrations.set_asset_calibration(fx.project.id, asset.id, calibration())
    fx.label(asset, PATH_3D)

    with pytest.raises(CalibrationInUse):
        fx.calibrations.clear_asset_calibration(fx.project.id, asset.id)

    fx.calibrations.set_source_calibration(fx.source.id, calibration())
    cleared = fx.calibrations.clear_asset_calibration(fx.project.id, asset.id)
    assert (cleared.override, cleared.effective) == (None, calibration())


@pytest.mark.parametrize("geometry", [PATH_3D, BOX_3D], ids=["polyline_3d", "cuboid_3d"])
def test_clearing_an_override_onto_a_different_source_calibration_is_refused_under_3d_labels(
    fx: Fixture, geometry: Geometry
) -> None:
    asset, own = fx.assets[0], calibration(fx=9.0)
    fx.calibrations.set_source_calibration(fx.source.id, calibration(fx=12.0))
    fx.calibrations.set_asset_calibration(fx.project.id, asset.id, own)
    fx.label(asset, geometry)

    with pytest.raises(CalibrationInUse, match=str(asset.id)):
        fx.calibrations.clear_asset_calibration(fx.project.id, asset.id)
    assert fx.calibrations.asset_calibration(fx.project.id, asset.id).override == own


def test_clearing_an_override_onto_a_different_source_calibration_without_3d_labels_is_allowed(
    fx: Fixture,
) -> None:
    asset = fx.assets[0]
    fx.calibrations.set_source_calibration(fx.source.id, calibration(fx=12.0))
    fx.calibrations.set_asset_calibration(fx.project.id, asset.id, calibration(fx=9.0))
    fx.label(asset)

    cleared = fx.calibrations.clear_asset_calibration(fx.project.id, asset.id)

    assert (cleared.override, cleared.effective) == (None, calibration(fx=12.0))


@pytest.mark.parametrize("geometry", [PATH_3D, BOX_3D], ids=["polyline_3d", "cuboid_3d"])
def test_replacing_an_override_its_asset_drew_3d_labels_against_is_refused(
    fx: Fixture, geometry: Geometry
) -> None:
    asset = fx.assets[0]
    own = calibration()
    fx.calibrations.set_asset_calibration(fx.project.id, asset.id, own)
    fx.label(asset, geometry)

    with pytest.raises(CalibrationInUse, match=str(asset.id)):
        fx.calibrations.set_asset_calibration(fx.project.id, asset.id, calibration(fx=40.0))
    assert fx.calibrations.asset_calibration(fx.project.id, asset.id).override == own


def test_stating_the_identical_override_again_is_a_no_op(fx: Fixture) -> None:
    asset = fx.assets[0]
    fx.calibrations.set_asset_calibration(fx.project.id, asset.id, calibration())
    fx.label(asset, PATH_3D)

    again = fx.calibrations.set_asset_calibration(fx.project.id, asset.id, calibration())

    assert (again.override, again.effective) == (calibration(), calibration())


def test_an_override_other_than_the_inherited_calibration_is_refused_under_3d_labels(
    fx: Fixture,
) -> None:
    asset, inherited = fx.assets[0], calibration(fx=10.0)
    fx.calibrations.set_source_calibration(fx.source.id, inherited)
    fx.label(asset, PATH_3D)

    with pytest.raises(CalibrationInUse, match=str(asset.id)):
        fx.calibrations.set_asset_calibration(fx.project.id, asset.id, calibration(fx=20.0))
    resolved = fx.calibrations.asset_calibration(fx.project.id, asset.id)
    assert (resolved.override, resolved.effective) == (None, inherited)

    pinned = fx.calibrations.set_asset_calibration(fx.project.id, asset.id, inherited)
    assert (pinned.override, pinned.effective) == (inherited, inherited)


def test_an_override_without_3d_labels_is_replaced(fx: Fixture) -> None:
    labelled, other = fx.assets
    fx.calibrations.set_source_calibration(fx.source.id, calibration())
    fx.label(labelled, PATH_3D)
    fx.label(other)
    fx.calibrations.set_asset_calibration(fx.project.id, other.id, calibration(fx=9.0))

    replaced = fx.calibrations.set_asset_calibration(fx.project.id, other.id, calibration(fx=40.0))

    assert replaced.override == calibration(fx=40.0)


def test_a_first_override_where_none_applied_is_not_refused_by_labels(fx: Fixture) -> None:
    fx.label(fx.assets[0], PATH_3D)

    stored = fx.calibrations.set_asset_calibration(fx.project.id, fx.assets[0].id, calibration())

    assert stored.effective == calibration()


def test_an_asset_is_scoped_by_its_project(fx: Fixture) -> None:
    other = ProjectService(fx.workspace).create("other")
    with pytest.raises(AssetNotFound):
        fx.calibrations.asset_calibration(other.id, fx.assets[0].id)
    with pytest.raises(ProjectNotFound):
        fx.calibrations.asset_calibration(uuid4(), fx.assets[0].id)


@pytest.mark.parametrize("write", ["clear", "set"])
@pytest.mark.parametrize("target", ["source", "asset"])
def test_a_set_or_clear_holds_the_write_lock_while_it_checks_for_3d_labels(
    fx: Fixture, monkeypatch: pytest.MonkeyPatch, target: str, write: str
) -> None:
    """A label write landing between the check and the write is what the lock prevents."""
    asset = fx.assets[0]
    if target == "source":
        fx.calibrations.set_source_calibration(fx.source.id, calibration())
    else:
        fx.calibrations.set_asset_calibration(fx.project.id, asset.id, calibration())
    contender = SqliteMetadataStore(fx.root / "visionset.db", busy_timeout_ms=0)
    outcomes: list[str] = []
    checked = calibration_module._dependent

    def interleaved(uow: Any, assets: Any) -> list[Asset]:
        found = checked(uow, assets)
        try:
            with contender.unit_of_work() as other:
                other.annotations.add(
                    Annotation(
                        asset_id=asset.id,
                        label_class="lane",
                        schema_version=1,
                        geometry=PATH_3D,
                        provenance="human",
                    )
                )
            outcomes.append("landed")
        except WorkspaceBusy:
            outcomes.append("blocked")
        return found

    monkeypatch.setattr(calibration_module, "_dependent", interleaved)
    if (target, write) == ("source", "clear"):
        fx.calibrations.clear_source_calibration(fx.source.id)
    elif (target, write) == ("asset", "clear"):
        fx.calibrations.clear_asset_calibration(fx.project.id, asset.id)
    elif target == "source":
        fx.calibrations.set_source_calibration(fx.source.id, calibration(fx=40.0))
    else:
        fx.calibrations.set_asset_calibration(fx.project.id, asset.id, calibration(fx=40.0))
    contender.close()

    assert outcomes == ["blocked"]
