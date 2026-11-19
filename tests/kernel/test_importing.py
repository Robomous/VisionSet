"""The import domain: path safety, dataset consistency and per-kind consent."""

from __future__ import annotations

from pathlib import PurePosixPath

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import (
    BboxGeometry,
    GeometryType,
    ImportConsent,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLoss,
    ImportLossKind,
    PolygonGeometry,
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
