"""How `yolo-obb` and `dota` tell a hand-drawn rectangle from a quadrilateral that is not one."""

from __future__ import annotations

import random
from math import dist, pi, radians, tan
from statistics import median

import pytest
from tests.formats.test_yolo_obb import same_box

from visionset.formats._obb import FITTED, NO_AREA, NOT_A_RECTANGLE, Corners, read_corners
from visionset.kernel.domain import ObbGeometry, obb_corners


def _drawn(seed: int) -> tuple[ObbGeometry, Corners]:
    """A DOTA-like box: 30-60 by 10-20 pixels, each corner off by up to a pixel, then whole."""
    rng = random.Random(seed)
    truth = ObbGeometry(
        cx=rng.uniform(100, 400),
        cy=rng.uniform(100, 400),
        width=rng.uniform(30, 60),
        height=rng.uniform(10, 20),
        angle=rng.uniform(-pi / 2, pi / 2),
    )
    corners = tuple(
        (float(round(x + rng.uniform(-1, 1))), float(round(y + rng.uniform(-1, 1))))
        for x, y in obb_corners(truth)
    )
    return truth, corners


def _residual(points: Corners) -> float:
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = points
    return dist((x0 + x2, y0 + y2), (x1 + x3, y1 + y3))


def test_hand_drawn_boxes_are_their_nearest_rectangle_and_degraded() -> None:
    drawn = [_drawn(seed) for seed in range(200)]
    residuals = sorted(_residual(points) for _, points in drawn)
    assert median(residuals) >= 1.4
    assert residuals[int(0.99 * len(residuals))] >= 3.0

    reasons = []
    for truth, points in drawn:
        fitted, reason = read_corners(points, (0.5, 0.5))
        reasons.append(reason)
        assert isinstance(fitted, ObbGeometry)
        assert dist((fitted.cx, fitted.cy), (truth.cx, truth.cy)) <= 1.5
        assert (
            max(
                dist(found, nearest)
                for found in obb_corners(fitted)
                for nearest in [min(obb_corners(truth), key=lambda corner: dist(corner, found))]
            )
            <= 2.0
        )
    assert set(reasons) <= {"", FITTED}
    assert reasons.count(FITTED) >= 195


def test_an_exact_rectangle_is_lossless() -> None:
    truth = ObbGeometry(cx=200.0, cy=150.0, width=48.0, height=14.0, angle=0.7)

    found, reason = read_corners(tuple(obb_corners(truth)))

    assert reason == ""
    assert isinstance(found, ObbGeometry) and same_box(found, truth)


def _parallelogram(skew_degrees: float) -> Corners:
    shift = 40 * tan(radians(skew_degrees))
    return ((0.0, 0.0), (40.0, 0.0), (40.0 + shift, 40.0), (shift, 40.0))


@pytest.mark.parametrize(
    "points",
    [
        ((0.0, 0.0), (40.0, 0.0), (47.0, 20.0), (7.0, 20.0)),
        ((0.0, 0.0), (40.0, 0.0), (34.0, 20.0), (6.0, 20.0)),
    ],
    ids=["parallelogram-0.159", "trapezoid-0.150"],
)
def test_a_corner_within_a_sixth_of_the_shorter_side_is_kept(points: Corners) -> None:
    assert read_corners(points)[1] == FITTED


@pytest.mark.parametrize(
    ("points", "reason"),
    [
        (((0.0, 0.0), (40.0, 0.0), (48.0, 20.0), (8.0, 20.0)), NOT_A_RECTANGLE),
        (((0.0, 0.0), (40.0, 0.0), (33.0, 20.0), (7.0, 20.0)), NOT_A_RECTANGLE),
        (((20.0, 10.0), (60.0, 10.0), (54.0, 20.0), (26.0, 20.0)), NOT_A_RECTANGLE),
        (_parallelogram(30), NOT_A_RECTANGLE),
        (((20.0, 10.0), (60.0, 10.0), (66.0, 20.0), (26.0, 20.0)), NOT_A_RECTANGLE),
        (((0.0, 0.0), (30.0, -10.0), (60.0, 0.0), (30.0, 10.0)), NOT_A_RECTANGLE),
        (((0.0, 10.0), (20.0, 0.0), (60.0, 10.0), (20.0, 20.0)), NOT_A_RECTANGLE),
        (((0.0, 0.0), (40.0, 10.0), (0.0, 20.0), (10.0, 10.0)), NOT_A_RECTANGLE),
        (((30.0, 10.0), (62.0, 34.0), (24.0, 18.0), (56.0, 42.0)), NOT_A_RECTANGLE),
        (((0.0, 0.0), (40.0, 0.0), (40.0, 10.0), (39.0, 10.0)), NOT_A_RECTANGLE),
        (((10.0, 10.0), (20.0, 10.0), (30.0, 10.0), (40.0, 10.0)), NO_AREA),
    ],
    ids=[
        "parallelogram-0.179",
        "trapezoid-0.175",
        "trapezoid",
        "parallelogram-30-degrees-square",
        "parallelogram-30-degrees-thin",
        "kite",
        "lopsided-kite",
        "dart",
        "bow-tie",
        "collapsed-side",
        "collinear",
    ],
)
def test_a_quadrilateral_far_from_any_rectangle_is_refused(points: Corners, reason: str) -> None:
    assert read_corners(points, (0.5, 0.5)) == (None, reason)


def test_a_box_too_small_to_judge_is_kept_within_a_unit_of_its_precision() -> None:
    points = ((0.0, 0.0), (4.0, 0.0), (4.0, 2.0), (1.0, 2.0))

    assert read_corners(points, (0.5, 0.5))[1] == FITTED
    assert read_corners(points, (0.05, 0.05)) == (None, NOT_A_RECTANGLE)
