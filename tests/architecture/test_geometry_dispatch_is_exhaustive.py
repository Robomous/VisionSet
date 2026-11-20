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
    GeometryType,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    Task,
    VertexVisibility,
    check_vertex_visibility,
    geometry_needs_calibration,
    preprocessing_transform,
)
from visionset.kernel.domain import geometry as geometry_module
from visionset.server.models import geometry_of
from visionset.wire import geometry as wire_geometry


class _StandIn(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    type: Literal[GeometryType.KEYPOINTS] = GeometryType.KEYPOINTS
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
    "geometry_needs_calibration": lambda _: geometry_needs_calibration(STAND_IN),
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
    assert STAND_IN.type not in IMPLEMENTED_GEOMETRIES


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
