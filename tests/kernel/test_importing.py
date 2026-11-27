"""The import domain: path safety, dataset consistency and per-kind consent."""

from __future__ import annotations

from pathlib import PurePosixPath

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import (
    Attribute,
    BboxGeometry,
    Cuboid3DGeometry,
    GeometryType,
    ImportConsent,
    ImportedClass,
    ImportedDataset,
    ImportedFrame,
    ImportedImage,
    ImportedLabel,
    ImportedScan,
    ImportedSequence,
    ImportLoss,
    ImportLossKind,
    PolygonGeometry,
    ScanFrame,
    ScanLayout,
    loss_kinds,
)

BOX = BboxGeometry(x=1, y=1, width=4, height=4)


def _loss(kind: ImportLossKind) -> ImportLoss:
    return ImportLoss(kind=kind, subject="car", count=2, reason="because")


@pytest.mark.parametrize(
    "path",
    [
        "../escape.png",
        "images/../../escape.png",
        "/etc/passwd",
        "C:/x.png",
        "a\\..\\b.png",
        "",
        ".",
    ],
)
def test_an_image_path_outside_the_source_is_refused(path: str) -> None:
    with pytest.raises(ValidationError):
        ImportedImage(path=path)


def test_a_nested_relative_path_is_accepted() -> None:
    assert ImportedImage(path="images/train/a.png").path == PurePosixPath("images/train/a.png")


@pytest.mark.parametrize("kind", list(ImportLossKind))
def test_each_loss_kind_is_reported_and_needs_its_own_consent(kind: ImportLossKind) -> None:
    losses = [_loss(kind)]

    assert loss_kinds(losses) == {kind}
    assert ImportConsent().uncovered(losses) == {kind}
    assert ImportConsent(kinds=frozenset({kind})).uncovered(losses) == frozenset()
    others = frozenset(ImportLossKind) - {kind}
    assert ImportConsent(kinds=others).uncovered(losses) == {kind}


def test_consent_covers_exactly_the_named_kinds() -> None:
    losses = [_loss(ImportLossKind.LABEL), _loss(ImportLossKind.GEOMETRY)]

    assert ImportConsent(kinds=frozenset({ImportLossKind.LABEL})).uncovered(losses) == {
        ImportLossKind.GEOMETRY
    }
    assert ImportConsent(kinds=frozenset(ImportLossKind)).uncovered(losses) == frozenset()
    assert ImportConsent().uncovered([]) == frozenset()


def test_a_loss_counts_at_least_one_item() -> None:
    with pytest.raises(ValidationError):
        ImportLoss(kind=ImportLossKind.LABEL, subject="car", count=0, reason="nothing")


def test_a_label_must_name_a_declared_class_with_its_geometry() -> None:
    car = ImportedClass(name="car", geometries=(GeometryType.BBOX,))
    with pytest.raises(ValidationError, match="undeclared class"):
        ImportedDataset(
            classes=(car,),
            images=(
                ImportedImage(
                    path="a.png", labels=(ImportedLabel(class_name="bus", geometry=BOX),)
                ),
            ),
        )
    polygon = PolygonGeometry(points=[(0, 0), (4, 0), (0, 4)])
    with pytest.raises(ValidationError, match="does not declare polygon"):
        ImportedDataset(
            classes=(car,),
            images=(
                ImportedImage(
                    path="a.png", labels=(ImportedLabel(class_name="car", geometry=polygon),)
                ),
            ),
        )


def test_an_image_and_a_class_are_each_listed_once() -> None:
    car = ImportedClass(name="car", geometries=(GeometryType.BBOX,))
    with pytest.raises(ValidationError, match="listed twice"):
        ImportedDataset(
            classes=(car,), images=(ImportedImage(path="a.png"), ImportedImage(path="a.png"))
        )
    with pytest.raises(ValidationError, match="declared twice"):
        ImportedDataset(classes=(car, car), images=())


def test_class_names_are_stripped_the_way_a_schema_strips_them() -> None:
    assert ImportedClass(name=" car ", geometries=(GeometryType.BBOX,)).name == "car"
    assert ImportedLabel(class_name="car ", geometry=BOX).class_name == "car"


KITTI = ScanLayout(fields=("x", "y", "z", "intensity"))
CUBOID = Cuboid3DGeometry(center=(10.0, 0.0, -0.8), size=(4.0, 1.6, 1.5), yaw=0.3)
BOTH = (GeometryType.BBOX, GeometryType.CUBOID_3D)


def _scan(geometry: BboxGeometry | Cuboid3DGeometry = CUBOID) -> ImportedScan:
    return ImportedScan(
        path="velodyne/0.bin",
        layout=KITTI,
        labels=(ImportedLabel(class_name="car", geometry=geometry),),
    )


def test_a_dataset_of_scans_declares_its_frame() -> None:
    classes = (ImportedClass(name="car", geometries=BOTH),)
    with pytest.raises(ValidationError, match="frame"):
        ImportedDataset(classes=classes, scans=(_scan(),))

    dataset = ImportedDataset(classes=classes, scans=(_scan(),), frame=ScanFrame.LIDAR_FLU)
    assert dataset.scans[0].labels[0].geometry == CUBOID


def test_a_dataset_is_of_images_or_of_scans_never_both() -> None:
    classes = (ImportedClass(name="car", geometries=BOTH),)
    with pytest.raises(ValidationError, match="not both"):
        ImportedDataset(
            classes=classes,
            images=(ImportedImage(path="a.png"),),
            scans=(_scan(),),
            frame=ScanFrame.LIDAR_FLU,
        )
    with pytest.raises(ValidationError, match="no scan frame"):
        ImportedDataset(
            classes=classes, images=(ImportedImage(path="a.png"),), frame=ScanFrame.LIDAR_FLU
        )


def test_a_scan_label_in_pixels_is_refused() -> None:
    classes = (ImportedClass(name="car", geometries=BOTH),)
    with pytest.raises(ValidationError, match="no pixels"):
        ImportedDataset(classes=classes, scans=(_scan(BOX),), frame=ScanFrame.LIDAR_FLU)


def test_a_scan_path_outside_the_source_is_refused() -> None:
    with pytest.raises(ValidationError):
        ImportedScan(path="../velodyne/0.bin", layout=KITTI)


@pytest.mark.parametrize(
    "fields", [("x", "y"), ("x", "y", "z", "z"), ("x", "y", "z", "intensity", "intensity")]
)
def test_a_scan_layout_names_each_coordinate_once(fields: tuple[str, ...]) -> None:
    with pytest.raises(ValidationError):
        ScanLayout(fields=fields)  # type: ignore[arg-type]


def test_a_layout_with_a_skipped_field_is_a_pcd_with_a_padding_field() -> None:
    header = ScanLayout(fields=("x", "y", "z", "intensity", "_")).pcd_header(2).decode()

    assert "FIELDS x y z intensity _\n" in header
    assert "POINTS 2\nDATA binary\n" in header


# --- sequences and track ids ----------------------------------------------------


def _tracked(
    *paths: str,
    sequences: tuple[ImportedSequence, ...],
    geometry: BboxGeometry | Cuboid3DGeometry = BOX,
) -> ImportedDataset:
    return ImportedDataset(
        classes=(ImportedClass(name="car", geometries=BOTH),),
        images=tuple(
            ImportedImage(
                path=path,
                labels=(ImportedLabel(class_name="car", geometry=geometry, track="7"),),
            )
            for path in paths
        ),
        sequences=sequences,
    )


def _sequence(*paths: str, times: tuple[float, ...] | None = None) -> ImportedSequence:
    stamps = times if times is not None else tuple(float(i) for i in range(len(paths)))
    return ImportedSequence(
        name="segment-1",
        frames=tuple(
            ImportedFrame(path=p, timestamp=t) for p, t in zip(paths, stamps, strict=True)
        ),
    )


def test_a_tracked_label_on_a_sequenced_image_is_accepted() -> None:
    dataset = _tracked("a.png", "b.png", sequences=(_sequence("a.png", "b.png"),))
    assert [frame.timestamp for frame in dataset.sequences[0].frames] == [0.0, 1.0]


@pytest.mark.parametrize(
    ("sequences", "message"),
    [
        ((), "in no sequence"),
        ((_sequence("a.png", "b.png"), _sequence("b.png")), "in two sequences"),
        ((_sequence("a.png", "b.png", "c.png"),), "not a listed image"),
    ],
)
def test_a_track_id_needs_exactly_one_sequence_of_listed_images(
    sequences: tuple[ImportedSequence, ...], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        _tracked("a.png", "b.png", sequences=sequences)


def test_a_track_id_on_a_3d_label_is_refused() -> None:
    with pytest.raises(ValidationError, match="an image.s 2D labels only"):
        _tracked("a.png", sequences=(_sequence("a.png"),), geometry=CUBOID)


@pytest.mark.parametrize(
    ("paths", "times"),
    [(("a.png", "a.png"), (0.0, 1.0)), (("a.png", "b.png"), (1.0, 0.0)), (("a.png",), (-1.0,))],
)
def test_a_sequence_lists_each_frame_once_in_time_order(
    paths: tuple[str, ...], times: tuple[float, ...]
) -> None:
    with pytest.raises(ValidationError):
        _sequence(*paths, times=times)


@pytest.mark.parametrize("track", ["", "  "])
def test_a_blank_track_id_is_refused(track: str) -> None:
    with pytest.raises(ValidationError):
        ImportedLabel(class_name="car", geometry=BOX, track=track)


def test_a_class_defines_each_attribute_once_whatever_its_case() -> None:
    with pytest.raises(ValidationError, match="two attributes with the same name"):
        ImportedClass(
            name="car",
            geometries=(GeometryType.BBOX,),
            attributes=(
                Attribute(name="color", kind="string"),
                Attribute(name="Color", kind="string"),
            ),
        )


def test_a_label_names_its_attribute_values_as_a_definition_would() -> None:
    box = BboxGeometry(x=0, y=0, width=1, height=1)
    label = ImportedLabel(class_name="car", geometry=box, attributes={" color ": "red"})
    assert label.attributes == {"color": "red"}
    with pytest.raises(ValidationError, match="non-blank"):
        ImportedLabel(class_name="car", geometry=box, attributes={" ": "red"})
    with pytest.raises(ValidationError, match="same attribute"):
        ImportedLabel(class_name="car", geometry=box, attributes={"color": "red", "color ": "b"})
