"""The point-cloud modality in the domain, and manifest version 5.

See ``docs/content/architecture/decisions/three-dimensional-labels-are-calibrated-image-labels.md``.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from tests.fixtures.calibration import calibration

from visionset.kernel import CalibrationMissing, CalibrationNotApplicable, UnsupportedMedia
from visionset.kernel.domain import (
    CALIBRATED_MANIFEST_VERSION,
    MANIFEST_VERSION,
    MODALITY_MANIFEST_VERSION,
    Asset,
    BboxGeometry,
    ClassificationGeometry,
    Cuboid3DGeometry,
    GeometryType,
    ImageFormat,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PointCloudBounds,
    PointCloudFormat,
    PointCloudMetadata,
    PolygonGeometry,
    Polyline3DGeometry,
    PolylineGeometry,
    ScanFrame,
    Source,
    SourceKind,
    canonical_bytes,
    geometry_fits_modality,
    geometry_needs_calibration,
    geometry_needs_scan_frame,
    geometry_reference,
    manifest_version_for,
    require_calibratable,
    require_image,
    require_scan_frame,
    sha256_hex,
)

SCAN = PointCloudMetadata(
    format=PointCloudFormat.PCD,
    point_count=3,
    bounds=PointCloudBounds(minimum=(0.0, -1.0, 0.0), maximum=(10.0, 4.0, 3.0)),
    fields=("x", "y", "z", "intensity"),
)
BOX = Cuboid3DGeometry(center=(8.0, 1.0, 0.8), size=(4.2, 1.8, 1.5), yaw=0.25)
PATH = Polyline3DGeometry(points=[(0.0, 1.0, 0.0), (5.0, 1.0, 0.0)])
TWO_D = [
    BboxGeometry(x=1, y=1, width=2, height=2),
    PolygonGeometry(points=[(0, 0), (1, 0), (1, 1)]),
    PolylineGeometry(points=[(0, 0), (1, 1)]),
]


def _scan_asset(**change: Any) -> Asset:
    fields: dict[str, Any] = {
        "project_id": uuid4(),
        "modality": "point_cloud",
        "content_hash": "c" * 64,
        "uri": "/scans/front.pcd",
        "source_id": uuid4(),
        "point_cloud": SCAN,
    }
    return Asset(**(fields | change))


def _scan_source(**change: Any) -> Source:
    fields: dict[str, Any] = {
        "project_id": uuid4(),
        "kind": SourceKind.POINT_CLOUD_DIRECTORY,
        "locator": "/scans",
        "frame": ScanFrame.LIDAR_FLU,
    }
    return Source(**(fields | change))


# --- the asset --------------------------------------------------------------


def test_an_image_asset_is_unchanged_and_carries_no_scan() -> None:
    asset = Asset(project_id=uuid4(), content_hash="a" * 64, uri="/a.png", width=4, height=3)
    assert (asset.modality, asset.point_cloud) == ("image", None)
    with pytest.raises(ValidationError, match="exactly on a point_cloud asset"):
        asset.model_validate(asset.model_dump() | {"point_cloud": SCAN})


def test_a_point_cloud_asset_needs_its_metadata() -> None:
    assert _scan_asset().point_cloud == SCAN
    with pytest.raises(ValidationError, match="exactly on a point_cloud asset"):
        _scan_asset(point_cloud=None)


@pytest.mark.parametrize(
    ("change", "named"),
    [
        ({"width": 4}, "width"),
        ({"height": 3}, "height"),
        ({"format": ImageFormat.PNG}, "format"),
        ({"calibration": calibration(width=4, height=3)}, "calibration"),
        ({"frame_index": 0, "frame_timestamp": 0.0}, "frame_index"),
    ],
)
def test_a_point_cloud_asset_carries_no_image_field(change: dict[str, Any], named: str) -> None:
    with pytest.raises(ValidationError, match=f"carries no {named}"):
        _scan_asset(**change)


def test_require_image_refuses_a_scan_and_passes_an_image() -> None:
    image = Asset(project_id=uuid4(), content_hash="a" * 64, uri="/a.png")
    assert require_image(image) is image
    with pytest.raises(UnsupportedMedia, match="point_cloud"):
        require_image(_scan_asset())


def test_a_scan_cannot_be_calibrated() -> None:
    require_calibratable(Asset(project_id=uuid4(), content_hash="a" * 64, uri="/a.png"))
    with pytest.raises(CalibrationNotApplicable):
        require_calibratable(_scan_asset())


@pytest.mark.parametrize(
    ("bounds", "fields"),
    [
        ({"minimum": (1.0, 0.0, 0.0), "maximum": (0.0, 0.0, 0.0)}, ("x", "y", "z")),
        ({"minimum": (0.0, 0.0, float("nan")), "maximum": (0.0, 0.0, 0.0)}, ("x", "y", "z")),
        ({"minimum": (0.0, 0.0, 0.0), "maximum": (0.0, 0.0, 0.0)}, ("x", "y")),
        ({"minimum": (0.0, 0.0, 0.0), "maximum": (0.0, 0.0, 0.0)}, ("y", "x", "z")),
        ({"minimum": (0.0, 0.0, 0.0), "maximum": (0.0, 0.0, 0.0)}, ("x", "y", "z", "z")),
        ({"minimum": (0.0, 0.0, 0.0), "maximum": (0.0, 0.0, 0.0)}, ("x", "y", "z", "normal")),
    ],
)
def test_scan_metadata_breaking_its_rules_is_refused(
    bounds: dict[str, Any], fields: tuple[str, ...]
) -> None:
    with pytest.raises(ValidationError):
        PointCloudMetadata(format="ply", point_count=1, bounds=bounds, fields=fields)


def test_a_scan_has_at_least_one_point() -> None:
    with pytest.raises(ValidationError):
        SCAN.model_validate(SCAN.model_dump() | {"point_count": 0})


# --- the source and its frame ------------------------------------------------


def test_a_point_cloud_source_declares_its_frame_and_an_image_source_does_not() -> None:
    assert _scan_source().require_frame() is ScanFrame.LIDAR_FLU
    with pytest.raises(ValidationError, match="must declare a scan frame"):
        _scan_source(frame=None)
    with pytest.raises(ValidationError, match="must not declare a scan frame"):
        Source(
            project_id=uuid4(),
            kind=SourceKind.IMAGE_DIRECTORY,
            locator="/a",
            frame=ScanFrame.LIDAR_FLU,
        )


def test_a_point_cloud_source_carries_no_camera_calibration() -> None:
    with pytest.raises(ValidationError, match="no camera calibration"):
        _scan_source(calibration=calibration(width=4, height=3))


FRAME_AXES = [
    (ScanFrame.LIDAR_FLU, (0, 1), (1, 1), (2, 1)),
    (ScanFrame.CAMERA_RDF, (2, 1), (0, -1), (1, -1)),
    (ScanFrame.LIDAR_RFU, (1, 1), (0, -1), (2, 1)),
]


def test_every_frame_has_its_axes_checked() -> None:
    assert [row[0] for row in FRAME_AXES] == list(ScanFrame)


@pytest.mark.parametrize(("frame", "forward", "left", "up"), FRAME_AXES)
def test_each_frame_names_right_handed_axes(
    frame: ScanFrame, forward: tuple[int, int], left: tuple[int, int], up: tuple[int, int]
) -> None:
    assert (frame.forward, frame.left, frame.up) == (forward, left, up)

    def unit(axis: tuple[int, int]) -> list[int]:
        vector = [0, 0, 0]
        vector[axis[0]] = axis[1]
        return vector

    f, lft = unit(frame.forward), unit(frame.left)
    cross = [
        f[1] * lft[2] - f[2] * lft[1],
        f[2] * lft[0] - f[0] * lft[2],
        f[0] * lft[1] - f[1] * lft[0],
    ]
    assert cross == unit(frame.up)


def test_a_scan_label_is_read_against_its_source_frame() -> None:
    asset = _scan_asset()
    assert require_scan_frame(asset, _scan_source()) is ScanFrame.LIDAR_FLU
    with pytest.raises(CalibrationMissing, match="no source"):
        require_scan_frame(asset, None)
    image_source = Source(project_id=uuid4(), kind=SourceKind.IMAGE_DIRECTORY, locator="/a")
    with pytest.raises(CalibrationMissing, match="declaring no frame"):
        require_scan_frame(asset, image_source)


# --- what a label is read against -------------------------------------------


@pytest.mark.parametrize("geometry", [BOX, PATH], ids=lambda g: g.type.value)
def test_a_3d_label_needs_a_calibration_on_an_image_and_a_frame_on_a_scan(geometry: Any) -> None:
    assert geometry_reference(geometry, modality="image") == "calibration"
    assert geometry_reference(geometry, modality="point_cloud") == "scan_frame"
    assert geometry_needs_calibration(geometry, modality="image")
    assert not geometry_needs_calibration(geometry, modality="point_cloud")
    assert geometry_needs_scan_frame(geometry, modality="point_cloud")
    assert not geometry_needs_scan_frame(geometry, modality="image")


@pytest.mark.parametrize("geometry", [*TWO_D, ClassificationGeometry()], ids=lambda g: g.type)
def test_a_2d_label_is_read_against_nothing(geometry: Any) -> None:
    for modality in ("image", "point_cloud"):
        assert geometry_reference(geometry, modality=modality) is None


@pytest.mark.parametrize("geometry", TWO_D, ids=lambda g: g.type.value)
def test_a_pixel_shape_fits_an_image_and_not_a_scan(geometry: Any) -> None:
    assert geometry_fits_modality(geometry, modality="image")
    assert not geometry_fits_modality(geometry, modality="point_cloud")


@pytest.mark.parametrize("geometry", [BOX, PATH, ClassificationGeometry()], ids=str)
def test_a_tag_and_a_3d_label_fit_both(geometry: Any) -> None:
    assert geometry_fits_modality(geometry, modality="image")
    assert geometry_fits_modality(geometry, modality="point_cloud")


# --- manifest version 5 ------------------------------------------------------

#: Written by the build before #1046, byte for byte, with the hash it published.
V3_DOCUMENT = (
    '{"assets":[{"annotations":[{"attributes":{},"confidence":null,"geometry":{"height":4.0,'
    '"type":"bbox","width":3.0,"x":1.0,"y":2.0},"id":"00000000-0000-0000-0000-000000000001",'
    '"label_class":"sign","model_ref":null,"provenance":"human","schema_version":1}],'
    '"asset_id":"00000000-0000-0000-0000-00000000000a","content_hash":"'
    + "a"
    * 64
    + '","height":48,"uri":"/in/a.png","width":64}],"classes":[{"attributes":[],"color":null,'
    '"geometries":["bbox"],"name":"sign"}],"manifest_version":3,"schema_version":1}'
)
V3_HASH = "b5a0f95c855f0a2b66c1d9b8e9616ebbba23cc2167f5855cf1d74fdb36187a7c"
V4_DOCUMENT = (
    '{"assets":[{"annotations":[{"attributes":{},"confidence":null,"geometry":{"height":4.0,'
    '"type":"bbox","width":3.0,"x":1.0,"y":2.0},"id":"00000000-0000-0000-0000-000000000001",'
    '"label_class":"sign","model_ref":null,"provenance":"human","schema_version":1}],'
    '"asset_id":"00000000-0000-0000-0000-00000000000a","content_hash":"'
    + "a"
    * 64
    + '","height":48,"uri":"/in/a.png","width":64},{"annotations":[{"attributes":{},'
    '"confidence":null,"geometry":{"center":[0.5,1.0,9.0],"size":[4.2,1.8,1.5],'
    '"type":"cuboid_3d","yaw":0.25},"id":"00000000-0000-0000-0000-000000000002",'
    '"label_class":"car_3d","model_ref":null,"provenance":"human","schema_version":1}],'
    '"asset_id":"00000000-0000-0000-0000-00000000000b","calibration":{"distortion":null,'
    '"extrinsics":{"rotation":[[1.0,0.0,0.0],[0.0,1.0,0.0],[0.0,0.0,1.0]],'
    '"translation":[0.0,0.0,1.2]},"intrinsics":{"cx":32.0,"cy":24.0,"fx":30.0,"fy":29.5,'
    '"height":48,"skew":0.0,"width":64}},"content_hash":"'
    + "b"
    * 64
    + '","height":48,"uri":"/in/b.png","width":64}],"classes":[{"attributes":[],"color":null,'
    '"geometries":["bbox"],"name":"sign"},{"attributes":[],"color":null,'
    '"geometries":["cuboid_3d"],"name":"car_3d"}],"manifest_version":4,"schema_version":1}'
)
V4_HASH = "04124917fddf30dc6e5d39ea13dab80ae9f14a0854b4e3c135597303cf950246"


@pytest.mark.parametrize(
    ("document", "digest", "version"),
    [(V3_DOCUMENT, V3_HASH, 3), (V4_DOCUMENT, V4_HASH, 4)],
    ids=["v3", "v4"],
)
def test_an_archived_manifest_loads_and_hashes_as_it_was_published(
    document: str, digest: str, version: int
) -> None:
    assert sha256_hex(document.encode()) == digest
    manifest = Manifest.model_validate_json(document)

    assert manifest.manifest_version == version
    assert all(asset.modality == "image" for asset in manifest.assets)
    assert canonical_bytes(manifest) == document.encode()
    assert manifest_version_for(manifest.assets) == version


def test_the_current_version_is_5() -> None:
    assert MANIFEST_VERSION == MODALITY_MANIFEST_VERSION == 5
    assert CALIBRATED_MANIFEST_VERSION == 4


def _manifest_scan(**change: Any) -> ManifestAsset:
    fields: dict[str, Any] = {
        "asset_id": UUID(int=20),
        "content_hash": "c" * 64,
        "uri": "/scans/front.pcd",
        "modality": "point_cloud",
        "point_cloud": SCAN,
        "frame": ScanFrame.LIDAR_FLU,
    }
    return ManifestAsset(**(fields | change))


def _label(geometry: Any) -> ManifestAnnotation:
    return ManifestAnnotation(
        id=uuid4(), label_class="car_3d", schema_version=1, geometry=geometry, provenance="human"
    )


def test_a_scan_in_a_manifest_carries_modality_metadata_and_frame() -> None:
    scan = _manifest_scan(annotations=(_label(BOX),))
    manifest = Manifest(manifest_version=manifest_version_for((scan,)), schema_version=1)
    manifest = manifest.model_copy(update={"assets": (scan,)})

    document = json.loads(canonical_bytes(manifest))
    (written,) = document["assets"]
    assert manifest.manifest_version == 5
    assert written["modality"] == "point_cloud"
    assert written["frame"] == "lidar_flu"
    assert written["point_cloud"]["point_count"] == 3
    assert "calibration" not in written
    assert Manifest.model_validate_json(canonical_bytes(manifest)) == manifest


def test_an_image_in_a_version_5_manifest_omits_its_modality() -> None:
    image = ManifestAsset(asset_id=uuid4(), content_hash="a" * 64, uri="/a.png", width=4, height=3)
    written = json.loads(canonical_bytes(image))
    assert not {"modality", "point_cloud", "frame"} & set(written)


@pytest.mark.parametrize("version", [3, 4])
def test_a_scan_cannot_ride_below_version_5(version: int) -> None:
    with pytest.raises(ValidationError, match="needs version 5"):
        Manifest(manifest_version=version, schema_version=1, assets=(_manifest_scan(),))


def test_the_lowest_version_names_a_scan_5_whatever_else_is_there() -> None:
    image = ManifestAsset(asset_id=uuid4(), content_hash="a" * 64, uri="/a.png")
    calibrated = image.model_copy(update={"calibration": calibration(width=4, height=3)})
    assert manifest_version_for((image,)) == 3
    assert manifest_version_for((image, calibrated)) == 4
    assert manifest_version_for((image, _manifest_scan())) == 5
    assert manifest_version_for((calibrated, _manifest_scan())) == 5


@pytest.mark.parametrize(
    "change",
    [
        {"point_cloud": None},
        {"frame": None},
        {"modality": "image"},
        {"width": 4},
        {"calibration": calibration(width=4, height=3)},
    ],
    ids=["no-metadata", "no-frame", "image-with-scan", "pixel-size", "calibration"],
)
def test_a_manifest_scan_breaking_its_rules_is_refused(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        _manifest_scan(**change)


@pytest.mark.parametrize("geometry", TWO_D, ids=lambda g: g.type.value)
def test_a_manifest_refuses_a_pixel_shape_on_a_scan(geometry: Any) -> None:
    with pytest.raises(ValidationError, match="cannot carry"):
        _manifest_scan(annotations=(_label(geometry),))


def test_a_cuboid_on_a_scan_needs_no_calibration_in_the_manifest() -> None:
    scan = _manifest_scan(annotations=(_label(BOX), _label(ClassificationGeometry())))
    assert scan.calibration is None
    assert {GeometryType(one.geometry.type) for one in scan.annotations} == {
        GeometryType.CUBOID_3D,
        GeometryType.CLASSIFICATION_TAG,
    }


def test_classes_survive_beside_a_scan() -> None:
    manifest = Manifest(
        schema_version=1,
        classes=(LabelClass(name="car_3d", geometries=(GeometryType.CUBOID_3D,)),),
        assets=(_manifest_scan(annotations=(_label(BOX),)),),
    )
    assert manifest.annotation_count == 1
