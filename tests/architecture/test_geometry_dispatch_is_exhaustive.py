"""Every dispatch over ``Geometry`` refuses a variant it was not written for.

The stand-in is test-only and never joins the union. It carries 2D ``points``,
which is the shape a fall-through branch would silently accept as a polygon.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal
from uuid import uuid4

import pytest
from pydantic import BaseModel, ConfigDict, ValidationError

from visionset.formats import _yolo_writer
from visionset.formats.coco import _annotation as coco_annotation
from visionset.formats.voc import _as_box as voc_box
from visionset.inference.nms import extent_of
from visionset.kernel.domain import (
    IMPLEMENTED_GEOMETRIES,
    BboxGeometry,
    Cuboid3DGeometry,
    GeometryType,
    KeypointsGeometry,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    Polyline3DGeometry,
    Task,
    VertexVisibility,
    check_vertex_visibility,
    geometry_fits_modality,
    geometry_needs_calibration,
    geometry_reference,
    preprocessing_transform,
)
from visionset.kernel.domain import geometry as geometry_module
from visionset.server.models import geometry_of
from visionset.wire import geometry as wire_geometry


class _StandIn(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    type: Literal["stand_in"] = "stand_in"
    points: list[tuple[float, float]]


STAND_IN: Any = _StandIn(points=[(1.0, 1.0), (2.0, 3.0), (4.0, 1.0)])

ANNOTATION = ManifestAnnotation(
    id=uuid4(),
    label_class="thing",
    schema_version=1,
    geometry=BboxGeometry(x=1.0, y=1.0, width=2.0, height=2.0),
    provenance="human",
).model_copy(update={"geometry": STAND_IN})

ASSET = ManifestAsset(
    asset_id=uuid4(),
    content_hash="0" * 64,
    uri="/incoming/frame.png",
    width=8,
    height=8,
    annotations=(),
).model_copy(update={"annotations": (ANNOTATION,)})

MANIFEST = Manifest(
    schema_version=1,
    classes=(LabelClass(name="thing", geometries=(GeometryType.BBOX,)),),
    assets=(),
).model_copy(update={"assets": (ASSET,)})


def _intersects_past_the_finite_check(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(geometry_module, "_coordinates_are_finite", lambda _: True)
    geometry_module.geometry_intersects_asset(STAND_IN, width=8, height=8)


SITES: dict[str, Callable[[pytest.MonkeyPatch], object]] = {
    "geometry_intersects_asset": _intersects_past_the_finite_check,
    "coordinates_are_finite": lambda _: geometry_module._coordinates_are_finite(STAND_IN),
    "geometry_needs_calibration": lambda _: geometry_needs_calibration(STAND_IN, modality="image"),
    "geometry_reference on a scan": lambda _: geometry_reference(STAND_IN, modality="point_cloud"),
    "geometry_fits_modality": lambda _: geometry_fits_modality(STAND_IN, modality="point_cloud"),
    "preprocessing scale": lambda _: preprocessing_transform._scaled(STAND_IN, 2.0, 2.0, 0.0, 0.0),
    "preprocessing mirror": lambda _: preprocessing_transform._mirrored(STAND_IN, 8.0),
    "preprocessing rotate": lambda _: preprocessing_transform._rotated_once(STAND_IN, 8.0),
    "nms extent": lambda _: extent_of(STAND_IN),
    "yolo derive_task": lambda _: _yolo_writer.derive_task(MANIFEST, frozenset(Task)),
    "yolo box": lambda _: _yolo_writer._as_box(ANNOTATION),
    "yolo ring": lambda _: _yolo_writer._as_ring(ANNOTATION),
    "voc box": lambda _: voc_box(ANNOTATION, ASSET, {"thing"}),
    "coco annotation": lambda _: coco_annotation(ANNOTATION, {"thing": 1}, ASSET),
    "server geometry_of": lambda _: geometry_of(STAND_IN),
    "wire geometry": lambda _: wire_geometry(STAND_IN),
}


def test_the_stand_in_is_not_an_implemented_geometry() -> None:
    assert STAND_IN.type not in {geometry.value for geometry in GeometryType}
    assert frozenset(GeometryType) == IMPLEMENTED_GEOMETRIES


@pytest.mark.parametrize("site", SITES)
def test_each_dispatch_refuses_an_unknown_variant(
    site: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(AssertionError, match="Expected code to be unreachable"):
        SITES[site](monkeypatch)


def test_vertex_visibility_is_checked_for_points_of_any_dimension() -> None:
    points = [(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)]
    visible = VertexVisibility.VISIBLE

    check_vertex_visibility((visible, visible), points)
    with pytest.raises(ValidationError) as refused:
        check_vertex_visibility((visible,), points)

    assert refused.value.title == "vertex visibility"
    error = refused.value.errors()[0]
    assert error["loc"] == ("visibility",)
    assert "names 1 vertices and the geometry has 2 points" in error["msg"]


PATH_3D = Polyline3DGeometry(points=[(0.0, 1.0, 5.0), (0.5, 1.0, 9.0)])
BOX_3D = Cuboid3DGeometry(center=(0.5, 1.0, 9.0), size=(4.2, 1.8, 1.5), yaw=0.25)
WIRE_3D: dict[str, object] = {
    "polyline_3d": {"type": "polyline_3d", "points": [[0.0, 1.0, 5.0], [0.5, 1.0, 9.0]]},
    "cuboid_3d": {
        "type": "cuboid_3d",
        "center": [0.5, 1.0, 9.0],
        "size": [4.2, 1.8, 1.5],
        "yaw": 0.25,
    },
}
THREE_D = [PATH_3D, BOX_3D]


def _in_manifest(geometry: Any) -> tuple[ManifestAnnotation, ManifestAsset, Manifest]:
    annotation = ANNOTATION.model_copy(update={"geometry": geometry})
    asset = ASSET.model_copy(update={"annotations": (annotation,)})
    return annotation, asset, MANIFEST.model_copy(update={"assets": (asset,)})


#: What each site answers for a 3D label: never a pixel extent, a box or a ring.
ANSWERS_3D: dict[str, Callable[[Any], object]] = {
    "geometry_intersects_asset": lambda g: geometry_module.geometry_intersects_asset(
        g, width=8, height=8
    ),
    "coordinates_are_finite": lambda g: geometry_module._coordinates_are_finite(g),
    "geometry_needs_calibration": lambda g: geometry_needs_calibration(g, modality="image"),
    "geometry_reference on a scan": lambda g: geometry_reference(g, modality="point_cloud"),
    "geometry_fits_modality": lambda g: geometry_fits_modality(g, modality="point_cloud"),
    "nms extent": lambda g: extent_of(g),
    "yolo derive_task": lambda g: _yolo_writer.derive_task(_in_manifest(g)[2], frozenset(Task)),
    "yolo box": lambda g: _yolo_writer._as_box(_in_manifest(g)[0]),
    "yolo ring": lambda g: _yolo_writer._as_ring(_in_manifest(g)[0]),
    "voc box": lambda g: voc_box(_in_manifest(g)[0], _in_manifest(g)[1], {"thing"}),
    "coco annotation": lambda g: coco_annotation(_in_manifest(g)[0], {"thing": 1}, ASSET),
    "server geometry_of": lambda g: geometry_of(g).to_domain(),
    "wire geometry": lambda g: wire_geometry(g),
}
EXPECTED_3D: dict[str, Callable[[Any], object]] = {
    "geometry_intersects_asset": lambda _: True,
    "coordinates_are_finite": lambda _: True,
    "geometry_needs_calibration": lambda _: True,
    "geometry_reference on a scan": lambda _: "scan_frame",
    "geometry_fits_modality": lambda _: True,
    "nms extent": lambda _: None,
    "yolo derive_task": lambda _: Task.DETECT,
    "yolo box": lambda _: None,
    "yolo ring": lambda _: None,
    "voc box": lambda _: None,
    "coco annotation": lambda _: None,
    "server geometry_of": lambda g: g,
    "wire geometry": lambda g: WIRE_3D[g.type.value],
}


def test_every_site_has_an_answer_for_each_3d_geometry() -> None:
    pixel_moving = {"preprocessing scale", "preprocessing mirror", "preprocessing rotate"}
    assert set(SITES) == set(ANSWERS_3D) | pixel_moving
    assert {g.type for g in THREE_D} == {GeometryType.POLYLINE_3D, GeometryType.CUBOID_3D}


@pytest.mark.parametrize("geometry", THREE_D, ids=lambda g: g.type.value)
@pytest.mark.parametrize("site", ANSWERS_3D)
def test_each_site_answers_a_3d_geometry(site: str, geometry: Any) -> None:
    assert ANSWERS_3D[site](geometry) == EXPECTED_3D[site](geometry)


@pytest.mark.parametrize("geometry", THREE_D, ids=lambda g: g.type.value)
@pytest.mark.parametrize(
    "move",
    [
        lambda g: preprocessing_transform._scaled(g, 2.0, 2.0, 0.0, 0.0),
        lambda g: preprocessing_transform._mirrored(g, 8.0),
        lambda g: preprocessing_transform._rotated_once(g, 8.0),
    ],
    ids=["scale", "mirror", "rotate"],
)
def test_a_pixel_moving_step_never_moves_a_3d_label(
    move: Callable[[Any], object], geometry: Any
) -> None:
    with pytest.raises(
        AssertionError, match=f"no pixel-moving step transforms a {geometry.type.value}"
    ):
        move(geometry)


KEYPOINTS = KeypointsGeometry(points=[(1.0, 1.0), (5.0, 3.0), (1.0, 1.0)])
#: What each site answers for keypoints: a pixel extent, never a box, ring or 3D frame.
EXPECTED_KEYPOINTS: dict[str, object] = {
    "geometry_intersects_asset": True,
    "coordinates_are_finite": True,
    "geometry_needs_calibration": False,
    "geometry_reference on a scan": None,
    "geometry_fits_modality": False,
    "nms extent": BboxGeometry(x=1.0, y=1.0, width=4.0, height=2.0),
    "yolo derive_task": Task.DETECT,
    "yolo box": None,
    "yolo ring": None,
    "voc box": None,
    "coco annotation": None,
    "server geometry_of": KEYPOINTS,
    "wire geometry": {"type": "keypoints", "points": [[1.0, 1.0], [5.0, 3.0], [1.0, 1.0]]},
}


@pytest.mark.parametrize("site", ANSWERS_3D)
def test_each_site_answers_keypoints(site: str) -> None:
    assert ANSWERS_3D[site](KEYPOINTS) == EXPECTED_KEYPOINTS[site]


@pytest.mark.parametrize(
    ("move", "expected"),
    [
        (
            lambda g: preprocessing_transform._scaled(g, 2.0, 3.0, 1.0, 0.5),
            [(3.0, 3.5), (11.0, 9.5)],
        ),
        (lambda g: preprocessing_transform._mirrored(g, 8.0), [(7.0, 1.0), (3.0, 3.0)]),
        (lambda g: preprocessing_transform._rotated_once(g, 8.0), [(1.0, 7.0), (3.0, 3.0)]),
    ],
    ids=["scale", "mirror", "rotate"],
)
def test_a_pixel_moving_step_moves_keypoints_in_order_with_their_visibility(
    move: Callable[[Any], Any], expected: list[tuple[float, float]]
) -> None:
    visibility = (VertexVisibility.VISIBLE, VertexVisibility.UNLABELED)
    moved = move(KeypointsGeometry(points=[(1.0, 1.0), (5.0, 3.0)], visibility=visibility))

    assert moved == KeypointsGeometry(points=expected, visibility=visibility)
