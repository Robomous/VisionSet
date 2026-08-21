"""The change classifier: one case per row of the table in ``docs/content/schemas.md``.

The question every row answers is the same one: does an annotation that was
valid under ``previous`` stay valid under ``proposed``?
"""

from __future__ import annotations

import pytest

from visionset.kernel.domain import (
    Attribute,
    ChangeKind,
    GeometryType,
    LabelClass,
    diff_classes,
)

ADDITIVE = ChangeKind.ADDITIVE
DESTRUCTIVE = ChangeKind.DESTRUCTIVE


def _class(name: str = "sign", **overrides: object) -> LabelClass:
    return LabelClass(name=name, **{"geometries": (GeometryType.BBOX,), **overrides})  # type: ignore[arg-type]


def _with(*attributes: Attribute) -> LabelClass:
    return _class(attributes=attributes)


SIGN = _class()
OPTIONAL = Attribute(name="occluded", kind="boolean")
REQUIRED = Attribute(name="occluded", kind="boolean", required=True)

#: (case id, previous, proposed, expected {(kind, class, attribute)}).
CASES: list[tuple[str, tuple[LabelClass, ...], tuple[LabelClass, ...], set[object]]] = [
    (
        "first version is all additive",
        (),
        (SIGN, _class("lane", geometries=(GeometryType.POLYGON,))),
        {(ADDITIVE, "sign", None), (ADDITIVE, "lane", None)},
    ),
    ("class added", (SIGN,), (SIGN, _class("lane")), {(ADDITIVE, "lane", None)}),
    ("class removed", (SIGN, _class("lane")), (SIGN,), {(DESTRUCTIVE, "lane", None)}),
    (
        "class renamed is a removal plus an addition",
        (SIGN,),
        (_class("signal"),),
        {(ADDITIVE, "signal", None), (DESTRUCTIVE, "sign", None)},
    ),
    (
        "class name case change is a removal plus an addition",
        (SIGN,),
        (_class("Sign"),),
        {(ADDITIVE, "Sign", None), (DESTRUCTIVE, "sign", None)},
    ),
    (
        # A geometry set moves in two independent directions, and only one of
        # them can orphan a label — so the swap below is *both* at once, and the
        # two rows beneath it are each direction on its own.
        "class geometry swapped is a removal plus an addition",
        (SIGN,),
        (_class(geometries=(GeometryType.POLYGON,)),),
        {(ADDITIVE, "sign", None), (DESTRUCTIVE, "sign", None)},
    ),
    (
        "class gains a geometry",
        (SIGN,),
        (_class(geometries=(GeometryType.BBOX, GeometryType.POLYGON)),),
        {(ADDITIVE, "sign", None)},
    ),
    (
        "class loses a geometry",
        (_class(geometries=(GeometryType.BBOX, GeometryType.POLYGON)),),
        (SIGN,),
        {(DESTRUCTIVE, "sign", None)},
    ),
    ("class color changed is not a change", (SIGN,), (_class(color="#ff0000"),), set()),
    ("optional attribute added", (SIGN,), (_with(OPTIONAL),), {(ADDITIVE, "sign", "occluded")}),
    (
        "required attribute added",
        (SIGN,),
        (_with(REQUIRED),),
        {(DESTRUCTIVE, "sign", "occluded")},
    ),
    ("attribute removed", (_with(OPTIONAL),), (SIGN,), {(DESTRUCTIVE, "sign", "occluded")}),
    (
        "attribute became required",
        (_with(OPTIONAL),),
        (_with(REQUIRED),),
        {(DESTRUCTIVE, "sign", "occluded")},
    ),
    (
        "attribute became optional",
        (_with(REQUIRED),),
        (_with(OPTIONAL),),
        {(ADDITIVE, "sign", "occluded")},
    ),
    (
        "attribute kind changed",
        (_with(OPTIONAL),),
        (_with(Attribute(name="occluded", kind="string")),),
        {(DESTRUCTIVE, "sign", "occluded")},
    ),
    (
        "select option added",
        (_with(Attribute(name="weather", kind="select", options=("dry",))),),
        (_with(Attribute(name="weather", kind="select", options=("dry", "wet"))),),
        {(ADDITIVE, "sign", "weather")},
    ),
    (
        "select option removed",
        (_with(Attribute(name="weather", kind="select", options=("dry", "wet"))),),
        (_with(Attribute(name="weather", kind="select", options=("dry",))),),
        {(DESTRUCTIVE, "sign", "weather")},
    ),
    (
        "attribute default changed",
        (_with(OPTIONAL),),
        (_with(Attribute(name="occluded", kind="boolean", default=False)),),
        {(ADDITIVE, "sign", "occluded")},
    ),
    (
        "attributes reordered is not a change",
        (_with(OPTIONAL, Attribute(name="blurry", kind="boolean")),),
        (_with(Attribute(name="blurry", kind="boolean"), OPTIONAL),),
        set(),
    ),
    ("identical versions are not a change", (SIGN,), (SIGN,), set()),
]


@pytest.mark.parametrize(
    ("previous", "proposed", "expected"),
    [pytest.param(*case[1:], id=case[0]) for case in CASES],
)
def test_the_classifier_judges_each_kind_of_change(
    previous: tuple[LabelClass, ...],
    proposed: tuple[LabelClass, ...],
    expected: set[object],
) -> None:
    diff = diff_classes(previous, proposed)

    assert {(c.kind, c.label_class, c.attribute) for c in diff.changes} == expected
    assert diff.is_destructive is any(kind is DESTRUCTIVE for kind, _, _ in expected)  # type: ignore[misc]


def test_a_change_of_kind_does_not_also_report_its_options_and_default() -> None:
    """One verdict per attribute. Re-reading options against a type that no
    longer applies would add noise, never information."""
    before = _with(Attribute(name="weather", kind="select", options=("dry", "wet")))
    after = _with(Attribute(name="weather", kind="string", default="dry"))

    diff = diff_classes([before], [after])

    assert len(diff.changes) == 1
    assert diff.changes[0].kind is DESTRUCTIVE
    assert "changed kind" in diff.changes[0].detail


def test_only_the_narrowed_classes_are_reported_as_destructive() -> None:
    """The orphan check intersects with this set, so a widened class must not
    appear in it merely because the same version narrowed another one."""
    diff = diff_classes([SIGN, _class("lane")], [_with(OPTIONAL)])

    assert diff.is_destructive is True
    assert diff.destructive_classes == frozenset({"lane"})


def test_a_class_recased_is_named_as_a_rename_in_its_detail() -> None:
    """The one rename whose intent is not a guess: a version cannot hold both
    casings, so the diff says so where every surface reads it — while the
    verdict stays destructive, because labels match their class by exact name."""
    diff = diff_classes([SIGN], [_class("Sign")])

    removed = next(change for change in diff.changes if change.kind is DESTRUCTIVE)
    assert removed.label_class == "sign"
    assert removed.detail == (
        "class 'sign' removed; 'Sign' differs only in its casing, and annotations match "
        "their class by exact name, so a re-casing is a rename and orphans the labels under 'sign'"
    )
    assert diff.describe(ADDITIVE) == "class 'Sign' added"


def test_the_detail_of_one_kind_reads_as_a_sentence() -> None:
    """``describe`` is what the refusal messages are built from."""
    diff = diff_classes([SIGN, _class("lane")], [SIGN])

    assert diff.describe(DESTRUCTIVE) == "class 'lane' removed"
    assert diff.describe(ADDITIVE) == ""


def test_an_empty_diff_is_not_destructive() -> None:
    assert diff_classes([], []).is_destructive is False
    assert diff_classes([], []).destructive_classes == frozenset()
