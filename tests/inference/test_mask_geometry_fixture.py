"""The Python half of the mask-to-geometry parity gate.

`tests/fixtures/mask_geometry.json` is a committed artifact and the only thing
carrying this pipeline across the language boundary: the `frontend` CI job
installs no Python and reads what is in the repository.

So it needs two independent links. This is the first — the fixture is the
application's own output, and this module fails when it drifts. The second is
`frontend/annotator/src/core/mask/maskGeometry.test.ts`.

The tests after the staleness check are about the fixture rather than the code:
a golden fixture that never reaches a branch is not a gate, so each one names a
branch and fails if no case exercises it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from scripts.export_mask_geometry_fixtures import ALLOWED, OUTPUT_PATH, TOLERANCES, build_fixture

from visionset.inference.masks import (
    CLOSING_REACH,
    MAXIMUM_CLOSING_RADIUS,
    MINIMUM_FRAGMENT_SHARE,
)
from visionset.kernel.domain import DEFAULT_TOLERANCE, MINIMUM_TOLERANCE

REPO_ROOT = Path(__file__).resolve().parents[2]


def committed() -> dict[str, Any]:
    payload: dict[str, Any] = json.loads((REPO_ROOT / OUTPUT_PATH).read_text())
    return payload


def named(name: str) -> dict[str, Any]:
    return next(case for case in committed()["cases"] if case["name"] == name)


def test_the_committed_fixture_matches_the_application() -> None:
    assert committed() == build_fixture(), (
        "tests/fixtures/mask_geometry.json is stale — run "
        "`uv run python scripts/export_mask_geometry_fixtures.py` and commit the result."
    )


def test_the_fixture_carries_the_constants_the_port_needs() -> None:
    """The TypeScript reads these rather than restating them, so they have to travel."""
    payload = committed()
    assert payload["minimum_fragment_share"] == MINIMUM_FRAGMENT_SHARE
    assert payload["closing_reach"] == CLOSING_REACH
    assert payload["maximum_closing_radius"] == MAXIMUM_CLOSING_RADIUS
    assert payload["minimum_tolerance"] == MINIMUM_TOLERANCE
    assert payload["default_tolerance"] == DEFAULT_TOLERANCE
    assert payload["tolerances"] == TOLERANCES


def test_every_case_covers_every_allowed_set_and_every_tolerance() -> None:
    keys = {",".join(str(kind.value) for kind in allowed) for allowed in ALLOWED}
    for case in committed()["cases"]:
        assert set(case["shapes"]) == keys
        for shapes in case["shapes"].values():
            assert set(shapes) == {str(tolerance) for tolerance in TOLERANCES}


def test_a_case_has_more_than_one_surviving_component() -> None:
    assert [case for case in committed()["cases"] if len(case["components"]) > 1]


def test_a_case_points_at_something_other_than_the_default_head() -> None:
    """Without one, a port that took the first component would pass the whole gate."""
    moved = [
        case
        for case in committed()["cases"]
        if case["at"]
        and len(case["components"]) > 1
        and case["components"][0]["x"] > case["components"][1]["x"]
    ]
    assert moved, "no case proves the prompt moves the head"


def test_a_case_has_two_pointed_components_of_equal_area() -> None:
    """The tie `_pointed_at` settles by reading order — an interpreter cannot decide it."""
    case = named("equal-area-tie")
    assert case["components"][0]["x"] == 12
    assert named("equal-area-tie-reversed")["components"][0]["x"] == 12


def _head_runs(case: dict[str, Any]) -> list[list[int]]:
    """The head piece's own runs, before the close touched it."""
    return list(case["components"][0]["runs"])


def test_a_case_is_changed_by_the_closing_and_another_is_not() -> None:
    """Both halves, or the step is only half proved.

    A fixture holding no closed gap would pass a port that skipped the close
    entirely; one holding nothing the close leaves alone would pass a port that
    closed everything, at any radius.
    """
    reaching = [case for case in committed()["cases"] if case["closing_radius"]]
    changed = [case for case in reaching if case["filled"]["runs"] != _head_runs(case)]
    unchanged = [case for case in reaching if case["filled"]["runs"] == _head_runs(case)]
    assert changed, "no case is changed by the close"
    assert unchanged, "no case with a reach is left alone by the close"


def test_a_case_clicks_at_a_half_pixel() -> None:
    """The coordinate where Python's rounding and JavaScript's disagree."""
    halves = [
        case
        for case in committed()["cases"]
        if any(value != int(value) for point in case["at"] for value in point)
    ]
    assert halves, "no case tells the two roundings apart"


def test_a_case_touches_only_diagonally() -> None:
    case = named("diagonal-touch")
    assert len(case["components"]) == 1, "a diagonal touch is one 8-connected piece"
    assert len(case["outline"]) == 8, "and one ring round both unit squares"


def test_a_case_boxes_more_than_its_polygon_traces() -> None:
    """The branch that is the whole point of keeping the two geometries apart."""
    wider = []
    for case in committed()["cases"]:
        box = case["shapes"]["bbox"]["1.0"]
        polygon = case["shapes"]["polygon"]["1.0"]
        if not box or not polygon:
            continue
        span = max(point[0] for point in polygon[0]["geometry"]["points"]) - min(
            point[0] for point in polygon[0]["geometry"]["points"]
        )
        if box[0]["geometry"]["width"] > span + 1:
            wider.append(case)
    assert wider, "no case shows a box spanning more than its polygon"


def test_a_case_moves_its_vertex_count_across_the_ladder() -> None:
    moving = [
        case
        for case in committed()["cases"]
        if len(
            {
                len(shapes[0]["geometry"]["points"])
                for shapes in case["shapes"]["polygon"].values()
                if shapes and shapes[0]["geometry"]["type"] == "polygon"
            }
        )
        >= 3
    ]
    assert moving, "no case tells the tolerances apart"


def test_a_box_is_the_same_box_at_every_tolerance() -> None:
    for case in committed()["cases"]:
        answers = [shapes for shapes in case["shapes"]["bbox"].values()]
        assert all(answer == answers[0] for answer in answers), case["name"]


def test_the_two_orderings_of_one_allowed_set_agree() -> None:
    for case in committed()["cases"]:
        assert case["shapes"]["bbox,polygon"] == case["shapes"]["polygon,bbox"], case["name"]


def test_a_class_admitting_neither_kind_is_offered_nothing() -> None:
    for case in committed()["cases"]:
        for shapes in case["shapes"]["polyline"].values():
            assert shapes == []


def test_a_case_proposes_nothing_at_all() -> None:
    empty = [
        case
        for case in committed()["cases"]
        if all(not shapes for shapes in case["shapes"]["polygon"].values())
    ]
    assert empty, "no case is below what a shape can be"


@pytest.mark.parametrize("case", committed()["cases"], ids=lambda c: str(c["name"]))
def test_a_mask_is_lit_runs_inside_its_own_frame(case: dict[str, Any]) -> None:
    grid = case["mask"]
    for y, first, last in grid["runs"]:
        assert 0 <= y < grid["height"]
        assert 0 <= first <= last < grid["width"]
