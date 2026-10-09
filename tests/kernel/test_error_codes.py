"""The kernel owns every refusal's code and detail, so all three surfaces agree."""

from __future__ import annotations

import inspect
import json
from uuid import UUID

from visionset.kernel import (
    CorruptMedia,
    DestructiveSchemaChange,
    InvalidAnnotation,
    LossyExportNotConsented,
    ProjectNotFound,
    ReleaseContentWouldViolateSchema,
    SchemaChangeWouldOrphan,
    VisionSetError,
)
from visionset.kernel import errors as kernel_errors
from visionset.kernel.domain import (
    ClassCompatibility,
    ClassCount,
    ClassExportStatus,
    ExportCompatibility,
    GeometryType,
)
from visionset.kernel.error_codes import ERROR_CODES, error_code, error_detail


def test_every_declared_error_has_a_code_and_the_base_does_not() -> None:
    declared = {
        obj
        for obj in vars(kernel_errors).values()
        if inspect.isclass(obj) and issubclass(obj, VisionSetError)
    }
    assert set(ERROR_CODES) == declared - {VisionSetError}


def test_codes_are_unique() -> None:
    assert len(set(ERROR_CODES.values())) == len(ERROR_CODES)


def test_error_code_walks_the_mro() -> None:
    class Custom(ProjectNotFound):
        """Declared outside kernel/errors.py."""

    assert error_code(Custom("x")) == "PROJECT_NOT_FOUND"
    assert error_code(VisionSetError("x")) is None
    assert error_code(RuntimeError("x")) is None


def test_a_media_error_carries_its_reason_and_never_its_path() -> None:
    assert error_detail(CorruptMedia("truncated", name="/srv/in/clip.mp4")) == {
        "reason": "truncated"
    }


def test_the_blockers_of_an_orphaning_change() -> None:
    exc = SchemaChangeWouldOrphan(
        "no", blockers=(ClassCount(label_class="car", annotations=3, assets=2),)
    )
    assert error_detail(exc) == {
        "blockers": [{"label_class": "car", "annotations": 3, "assets": 2}]
    }


def test_the_blockers_of_a_release_content_violation() -> None:
    exc = ReleaseContentWouldViolateSchema(
        "no", blockers=(ClassCount(label_class="dog", annotations=1, assets=1),)
    )
    assert error_detail(exc) == {
        "blockers": [{"label_class": "dog", "annotations": 1, "assets": 1}]
    }


def test_the_classes_a_destructive_change_removes() -> None:
    assert error_detail(DestructiveSchemaChange("no", classes=("a", "b"))) == {
        "classes": ["a", "b"]
    }


def test_the_compatibility_report_uses_the_wire_spelling() -> None:
    report = ExportCompatibility(
        release_id=UUID(int=1),
        format_name="yolo",
        compatible=False,
        format_is_lossy=True,
        excluded_annotations=4,
        excluded_assets=2,
        classes=(
            ClassCompatibility(
                label_class="road",
                geometry=GeometryType.POLYGON,
                status=ClassExportStatus.DROPPED,
                annotations=4,
                assets=2,
                reason="not written",
            ),
        ),
    )
    detail = error_detail(LossyExportNotConsented("no", compatibility=report))
    assert detail is not None
    assert detail["compatibility"]["format"] == "yolo"
    assert detail["compatibility"]["release_id"] == str(UUID(int=1))
    assert detail["compatibility"]["classes"][0]["geometry"] == "polygon"


def test_index_is_the_detail_only_where_it_was_set() -> None:
    exc = InvalidAnnotation("bad")
    assert error_detail(exc) is None
    exc.index = 2
    assert error_detail(exc) == {"index": 2}


def test_every_detail_is_plain_json() -> None:
    samples: list[BaseException] = [
        CorruptMedia("x"),
        SchemaChangeWouldOrphan(
            "x", blockers=(ClassCount(label_class="a", annotations=1, assets=1),)
        ),
        DestructiveSchemaChange("x", classes=("a",)),
    ]
    for exc in samples:
        json.dumps(error_detail(exc))
