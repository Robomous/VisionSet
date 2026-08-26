"""``derive_task``: the one task an export is written for, from what is present and accepted.

The manifest handed in is already narrowed to the target — ``ReleaseService``
removes what the target does not carry before the plugin sees it — so the
``accepted`` set here is the *dialect's*, and the narrowing shows up as an
absence in the manifest rather than as a smaller set. Both halves are pinned:
the geometry that selects a task, and the acceptance that lets it.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from visionset.formats._yolo_writer import derive_task
from visionset.kernel.domain import (
    BboxGeometry,
    ClassificationGeometry,
    Geometry,
    GeometryType,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PolygonGeometry,
    Task,
)

EVERY_TASK = frozenset({Task.DETECT, Task.SEGMENT, Task.CLASSIFY})

BOX = BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0)
POLYGON = PolygonGeometry(points=[(0.0, 0.0), (4.0, 0.0), (2.0, 3.0)])
TAG = ClassificationGeometry()


def _manifest(*geometries: Geometry) -> Manifest:
    annotations = tuple(
        ManifestAnnotation(
            id=uuid4(),
            label_class="thing",
            schema_version=1,
            geometry=geometry,
            provenance="human",
        )
        for geometry in geometries
    )
    return Manifest(
        schema_version=1,
        classes=(LabelClass(name="thing", geometries=tuple(GeometryType)),),
        assets=(
            ManifestAsset(
                asset_id=uuid4(),
                content_hash="0" * 64,
                uri="/incoming/frame.png",
                width=8,
                height=8,
                annotations=annotations,
            ),
        ),
    )


@pytest.mark.parametrize(
    ("present", "expected"),
    [
        ((), Task.DETECT),
        ((BOX,), Task.DETECT),
        ((POLYGON,), Task.SEGMENT),
        ((BOX, POLYGON), Task.SEGMENT),
        ((TAG,), Task.CLASSIFY),
        ((TAG, BOX), Task.DETECT),
        ((TAG, POLYGON), Task.SEGMENT),
    ],
)
def test_the_geometry_present_selects_the_task(
    present: tuple[Geometry, ...], expected: Task
) -> None:
    assert derive_task(_manifest(*present), EVERY_TASK) is expected


def test_a_polygon_is_detect_when_segment_is_not_accepted() -> None:
    assert derive_task(_manifest(POLYGON), frozenset({Task.DETECT})) is Task.DETECT


def test_a_tag_is_detect_when_classify_is_not_accepted() -> None:
    assert derive_task(_manifest(TAG), frozenset({Task.DETECT})) is Task.DETECT


def test_a_polygon_beside_a_tag_is_classify_only_when_segment_is_not_accepted() -> None:
    accepted = frozenset({Task.DETECT, Task.CLASSIFY})

    assert derive_task(_manifest(TAG, POLYGON), accepted) is Task.DETECT
    assert derive_task(_manifest(TAG), accepted) is Task.CLASSIFY
