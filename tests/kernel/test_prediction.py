"""A prompt point is a place on the asset, and the rule that holds it to that.

The frame is inclusive at both ends, so the cases that matter most here are the
four corners: a rule that excluded them would make the far edge of every image a
place where clicking silently did nothing, and the editor's own hit test — which
draws the boundary the same way — would then send a coordinate this refuses.
"""

from __future__ import annotations

import math

import pytest

from visionset.kernel import PromptPointOutOfBounds
from visionset.kernel.domain import PointPrompt, require_points_on_asset


def _on(prompt: PointPrompt, *, width: int | None = 640, height: int | None = 480) -> None:
    require_points_on_asset(prompt, width=width, height=height)


# --- inside, including every edge ---------------------------------------------


def test_a_point_in_the_middle_is_on_the_asset() -> None:
    _on(PointPrompt(positive=((320.0, 240.0),)))


@pytest.mark.parametrize(
    "corner", [(0.0, 0.0), (640.0, 0.0), (0.0, 480.0), (640.0, 480.0)], ids=str
)
def test_every_corner_counts_as_on_the_asset(corner: tuple[float, float]) -> None:
    """Inclusive at both ends: the last row of pixels belongs to the picture."""
    _on(PointPrompt(positive=(corner,)))


def test_a_fractional_coordinate_is_fine() -> None:
    """A click is not obliged to land on a pixel, which is why these are floats."""
    _on(PointPrompt(positive=((0.5, 479.75),)))


# --- outside, on either axis and in either direction --------------------------


@pytest.mark.parametrize(
    "point", [(-0.5, 240.0), (640.5, 240.0), (320.0, -0.5), (320.0, 480.5)], ids=str
)
def test_a_point_past_any_edge_is_refused(point: tuple[float, float]) -> None:
    with pytest.raises(PromptPointOutOfBounds):
        _on(PointPrompt(positive=(point,)))


def test_the_refusal_names_the_coordinate_and_the_size() -> None:
    """What was sent and what would have been acceptable, both in the sentence.

    A caller composing coordinates in a script has no canvas to look at, so the
    message is the whole of what it gets to debug with.
    """
    with pytest.raises(PromptPointOutOfBounds) as raised:
        _on(PointPrompt(positive=((900.0, 700.0),)))
    said = str(raised.value)
    assert "900" in said and "700" in said
    assert "640" in said and "480" in said


def test_a_negative_point_is_checked_exactly_like_a_positive_one() -> None:
    """A *not that* pointing at nothing steers the answer as wrongly as a *this*."""
    with pytest.raises(PromptPointOutOfBounds) as raised:
        _on(PointPrompt(positive=((320.0, 240.0),), negative=((900.0, 240.0),)))
    assert "negative" in str(raised.value)


def test_one_bad_point_refuses_the_whole_gesture() -> None:
    """Not dropped: a prompt with a point removed is a different prompt."""
    with pytest.raises(PromptPointOutOfBounds):
        _on(PointPrompt(positive=((10.0, 10.0), (900.0, 10.0), (20.0, 20.0))))


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf], ids=["nan", "inf", "-inf"])
def test_a_non_finite_coordinate_is_not_on_anything(bad: float) -> None:
    """It falls out of the comparisons rather than being tested for, and is refused."""
    with pytest.raises(PromptPointOutOfBounds):
        _on(PointPrompt(positive=((bad, 240.0),)))


# --- an asset that never recorded its size ------------------------------------


@pytest.mark.parametrize(
    ("width", "height"),
    [(None, 480), (640, None), (None, None)],
    ids=["no-width", "no-height", "neither"],
)
def test_an_asset_of_unknown_size_is_not_checked(width: int | None, height: int | None) -> None:
    """There is nothing to check against, and refusing would punish the caller for it."""
    _on(PointPrompt(positive=((9_000.0, 9_000.0),)), width=width, height=height)
