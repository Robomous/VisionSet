"""The Python half of the simplifier's parity gate.

`tests/fixtures/simplification.json` is a committed artifact, and the only thing
that carries this algorithm across the language boundary: the `frontend` CI job
installs no Python and reads what is in the repository. The editor re-simplifies
a contour locally so that moving `detail` costs no round trip, and this module is
what makes "the two agree" checkable rather than asserted.

So it needs two independent links, the shape `openapi.json` and its generated
client already have. This is the first — the fixture is the application's own
output. The second is
`frontend/annotator/src/core/geometry/simplify.test.ts`, which proves the
TypeScript reproduces what this file contains.

Duplicating the regeneration in a test rather than leaving it to CI is
deliberate, for `test_the_committed_openapi_matches_the_application`'s reason:
this one fails during `uv run pytest`, in the command a contributor was already
running, instead of ten minutes later on a push.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from scripts.export_simplification_fixtures import OUTPUT_PATH, build_fixture

from visionset.inference.masks import EPSILON, MINIMUM_TOLERANCE
from visionset.kernel.domain import Detail

REPO_ROOT = Path(__file__).resolve().parents[2]


def committed() -> dict[str, Any]:
    payload: dict[str, Any] = json.loads((REPO_ROOT / OUTPUT_PATH).read_text())
    return payload


def test_the_committed_fixture_matches_the_application() -> None:
    assert committed() == build_fixture(), (
        "tests/fixtures/simplification.json is stale — run "
        "`uv run python scripts/export_simplification_fixtures.py` and commit the result."
    )


def test_the_fixture_carries_the_constants_the_port_needs() -> None:
    """The TypeScript reads these rather than restating them, so they have to travel."""
    payload = committed()
    assert payload["minimum_tolerance"] == MINIMUM_TOLERANCE
    assert payload["epsilon"] == {step.value: EPSILON[step] for step in Detail}


def test_every_step_of_the_vocabulary_is_covered() -> None:
    for case in committed()["cases"]:
        assert set(case["polygon"]) == {step.value for step in Detail}
        assert set(case["tolerance"]) == {step.value for step in Detail}


def test_a_case_exists_whose_vertex_count_moves_with_every_step() -> None:
    """Without one, a port that ignored `detail` would pass the whole gate.

    Every straight-edged case answers four corners at all three settings, which
    is correct and proves nothing about the setting.
    """
    moving = [
        case
        for case in committed()["cases"]
        if len({len(points) for points in case["polygon"].values() if points is not None}) == 3
    ]
    assert moving, "no case tells the three steps apart"


def test_a_case_exists_where_the_floor_decides_rather_than_the_ratio() -> None:
    """The other branch of `tolerance_for`, and the one a port most easily leaves out."""
    floored = [
        case
        for case in committed()["cases"]
        if set(case["tolerance"].values()) == {MINIMUM_TOLERANCE}
    ]
    assert floored, "no case reaches the minimum tolerance on every step"


def test_a_case_exists_that_cannot_be_a_polygon_at_all() -> None:
    """Both sides have to refuse, and refusing is easy to port as an empty list."""
    refused = [
        case
        for case in committed()["cases"]
        if all(points is None for points in case["polygon"].values())
    ]
    assert refused, "no case is below what a polygon can be"


@pytest.mark.parametrize("case", committed()["cases"], ids=lambda c: str(c["name"]))
def test_a_contour_is_points_in_the_assets_own_pixels(case: dict[str, Any]) -> None:
    for point in case["contour"]:
        assert len(point) == 2
        assert all(isinstance(value, (int, float)) for value in point)
