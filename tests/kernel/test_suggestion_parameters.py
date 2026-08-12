"""The suggestion parameters declare what they apply to, and that is checked.

`PARAMETER_APPLIES_TO` is the only statement of which geometry each parameter
means anything for, and the browser reads it off the wire rather than working it
out. That makes an omission invisible in exactly the way `capabilities.py` was
written to prevent: a parameter with no row would either vanish from every panel
or, under a kinder default, appear on a box class where it does nothing.

So the first test here is the one that matters. It sweeps `SuggestParameter`
itself, so a second parameter arrives with its applicability stated or the suite
goes red naming it.
"""

import pytest

from visionset.kernel.domain import (
    DEFAULT_DETAIL,
    PARAMETER_APPLIES_TO,
    Detail,
    GeometryType,
    SuggestParameter,
    suggest_parameters,
)


@pytest.mark.parametrize("parameter", list(SuggestParameter), ids=lambda p: p.value)
def test_every_parameter_declares_the_geometries_it_applies_to(
    parameter: SuggestParameter,
) -> None:
    assert parameter in PARAMETER_APPLIES_TO, (
        f"{parameter.value} has no applicability declaration — add a row to "
        "PARAMETER_APPLIES_TO rather than letting it default to every geometry"
    )
    assert PARAMETER_APPLIES_TO[parameter], (
        f"{parameter.value} applies to no geometry at all, which offers a control "
        "that can never be rendered"
    )


def test_the_table_names_no_parameter_the_vocabulary_does_not_have() -> None:
    assert set(PARAMETER_APPLIES_TO) == set(SuggestParameter)


@pytest.mark.parametrize("parameter", list(SuggestParameter), ids=lambda p: p.value)
def test_a_declared_geometry_is_one_the_domain_actually_stores(
    parameter: SuggestParameter,
) -> None:
    assert PARAMETER_APPLIES_TO[parameter] <= set(GeometryType)


def test_a_polygon_is_offered_every_parameter() -> None:
    assert suggest_parameters(GeometryType.POLYGON) == (SuggestParameter.DETAIL,)


def test_a_box_is_offered_nothing_at_all() -> None:
    # `detail` changes an outline and a box has none, so a box class declares no
    # parameters — which is what tells a client to render no adjustments rather
    # than an empty section (#557).
    assert suggest_parameters(GeometryType.BBOX) == ()


def test_a_kind_that_holds_no_shape_is_offered_nothing() -> None:
    assert suggest_parameters(GeometryType.CLASSIFICATION_TAG) == ()


def test_the_reader_answers_in_declaration_order() -> None:
    # Declaration order is display order, so the panel's layout is decided here
    # and not by whatever order a dict happened to be built in.
    for geometry in GeometryType:
        offered = suggest_parameters(geometry)
        assert list(offered) == [p for p in SuggestParameter if p in offered]


def test_the_default_is_a_member_of_its_own_vocabulary() -> None:
    assert DEFAULT_DETAIL in Detail
