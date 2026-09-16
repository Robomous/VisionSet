"""Export mask-to-geometry golden cases to tests/fixtures/mask_geometry.json.

`visionset.inference.masks` turns a segmenter's mask into this domain's
geometry, and `@visionset/annotator` reproduces it so a host that runs a model
in the browser gets the same shapes as one that runs it on the server. Those are
two implementations of one pipeline, and the only thing that makes "they agree"
a fact rather than a hope is a set of inputs both are held to.

Two gates, sharing no toolchain, exactly like `simplification.json`:
`tests/inference/test_mask_geometry_fixture.py` keeps this file matching the
Python; `frontend/annotator/src/core/mask/maskGeometry.test.ts` keeps the
TypeScript matching this file. The frontend CI job installs no Python and reads
only what is committed.

It carries **masks rather than contours**, because the mask is where these two
implementations meet: `simplification.json` already owns everything from the
contour onward, and what is unproven until this file exists is that the contour
fed into `polygon_at` is the same contour.

Masks travel as lit runs — `[y, first, last]`, inclusive — which both languages
reconstruct into identical pixels and a reviewer can read.

Written compact rather than indented, which is the one place this diverges from
`simplification.json`. That file is 101 KB indented and fits; this one carries a
mask, five pipeline stages and thirty-five shape answers per case, and indented it
runs to 886 KB — past the tracked-file size ceiling in
`tests/architecture/test_tracked_file_sizes.py`, which exists to keep media out of
git. Nothing is lost: a golden fixture regenerated wholesale by a script is read
through the tests that consume it, never line by line, and `sort_keys` keeps it
deterministic either way.

Usage: uv run python scripts/export_mask_geometry_fixtures.py
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from visionset.inference.masks import (
    CLOSING_REACH,
    MAXIMUM_CLOSING_RADIUS,
    MINIMUM_FRAGMENT_SHARE,
    closing_radius,
    components,
    contour,
    filled,
    outline,
    runs,
    shapes_from,
)
from visionset.kernel.domain import DEFAULT_TOLERANCE, MINIMUM_TOLERANCE, GeometryType

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = "tests/fixtures/mask_geometry.json"

TOLERANCES: list[float] = [0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0]

ALLOWED: list[list[GeometryType]] = [
    [GeometryType.BBOX],
    [GeometryType.POLYGON],
    # Both orders, deliberately: the kind must come from the set and not from
    # the caller's ordering, and two keys is how the fixture can say so.
    [GeometryType.BBOX, GeometryType.POLYGON],
    [GeometryType.POLYGON, GeometryType.BBOX],
    # A class holding neither: the answer is nothing, and nothing is widened.
    [GeometryType.POLYLINE],
]

Mask = list[list[int]]


def blank(width: int, height: int) -> Mask:
    return [[0] * width for _ in range(height)]


def painted(width: int, height: int, lit: list[tuple[int, int, int]]) -> Mask:
    mask = blank(width, height)
    for y, first, last in lit:
        for x in range(first, last + 1):
            mask[y][x] = 1
    return mask


def rect(width: int, height: int, x0: int, y0: int, x1: int, y1: int) -> Mask:
    return painted(width, height, [(y, x0, x1) for y in range(y0, y1 + 1)])


def disc(radius: int) -> Mask:
    size = 2 * radius + 8
    centre = size // 2
    return [
        [1 if (x - centre) ** 2 + (y - centre) ** 2 <= radius * radius else 0 for x in range(size)]
        for y in range(size)
    ]


def notched(depth: int, size: int = 64) -> Mask:
    mask = rect(size, size, 0, 0, size - 1, size - 1)
    for x in range(size - depth, size):
        mask[size // 2][x] = 0
    return mask


def holed(hole: int, size: int = 64) -> Mask:
    mask = rect(size, size, 0, 0, size - 1, size - 1)
    low = size // 2 - hole // 2
    for y in range(low, low + hole):
        for x in range(low, low + hole):
            mask[y][x] = 0
    return mask


def speckled() -> Mask:
    mask = blank(10, 10)
    mask[0][9] = 1  # a 1-px speck owning the topmost-leftmost pixel
    for y in range(3, 9):
        for x in range(1, 7):
            mask[y][x] = 1  # the real object, 36 px
    return mask


def islands() -> Mask:
    mask = blank(24, 12)
    for y in range(2, 7):
        for x in range(1, 6):
            mask[y][x] = 1  # 5x5 = 25
    for y in range(3, 7):
        for x in range(14, 18):
            mask[y][x] = 1  # 4x4 = 16
    return mask


def tied() -> Mask:
    """Two five-pixel components rooted at run indices 3 and 8."""
    mask = blank(30, 7)
    for x in (0, 4, 8, 12, 16, 20, 24):
        mask[0][x] = 1
    mask[1][0] = 1
    mask[1][2] = 1
    for y in (1, 2, 3, 4):
        mask[y][12] = 1
    for y in (2, 3, 4, 5):
        mask[y][2] = 1
    return mask


def halved() -> Mask:
    """The half-pixel rounding case, and it takes two points to be one.

    A *single* half-pixel click cannot tell the two roundings apart: the two
    candidate pixels are either one run or 8-connected, so they are the same
    piece, and a rounding that lands on nothing falls back to the piece the
    click is nearly inside anyway. Both spellings answer the same.

    So there are two points. ``A`` is 12 px, ``B`` is 4 px and far away. The
    first point sits at ``y = 2.5``: Python reads row 2, which is ``A``, so both
    labels are under the prompt and the larger wins. `Math.round` reads row 3,
    which is empty, so only ``B`` is under it and ``B`` is the answer. Two
    different pieces, and therefore two different shapes.
    """
    return painted(12, 8, [(1, 0, 5), (2, 0, 5), (1, 8, 9), (2, 8, 9)])


def bayed() -> Mask:
    """A 64x64 square with an 8x8 bite out of its right edge.

    Wide in *both* directions, which is what makes it a bay rather than a notch:
    a one-row bite closes at radius 1 however deep it is, because the dimension
    the close has to bridge is its height, not its depth.
    """
    mask = rect(64, 64, 0, 0, 63, 63)
    for y in range(28, 36):
        for x in range(56, 64):
            mask[y][x] = 0
    return mask


def diagonal() -> Mask:
    """Two pixels touching only at a corner: one 8-connected piece, one ring."""
    return painted(4, 4, [(1, 1, 1), (2, 2, 2)])


CASES: list[tuple[str, Mask, list[tuple[float, float]]]] = [
    ("empty", blank(20, 20), []),
    ("single-pixel", painted(5, 5, [(2, 3, 3)]), []),
    ("rectangle", rect(40, 40, 6, 6, 30, 24), []),
    ("disc", disc(20), []),
    ("speck-and-object", speckled(), []),
    ("two-islands", islands(), [(3.0, 4.0)]),
    ("point-picks-the-smaller-island", islands(), [(15.0, 4.0)]),
    ("points-across-components", islands(), [(15.0, 4.0), (3.0, 4.0)]),
    ("equal-area-tie", tied(), [(12.0, 2.0), (2.0, 3.0)]),
    ("equal-area-tie-reversed", tied(), [(2.0, 3.0), (12.0, 2.0)]),
    ("click-outside", islands(), [(20.0, 4.0)]),
    ("half-pixel-click", halved(), [(2.0, 2.5), (8.0, 1.0)]),
    ("diagonal-touch", diagonal(), []),
    ("narrow-notch", notched(2), []),
    ("deep-one-row-notch", notched(40), []),
    ("wide-bay", bayed(), []),
    # The cap, and the only case that reaches it. Below about 98,000 lit pixels
    # the reach never grows past six, so every other case here would pass a port
    # that dropped the cap altogether rather than merely changing it.
    ("capped-reach", rect(320, 320, 0, 0, 319, 319), []),
    ("enclosed-hole", holed(2), []),
    # A polygon at the floor and refused at the ceiling. 16 wide and one tall:
    # a longer strip keeps a vertex at 16 px however thin it is.
    ("thin", rect(20, 8, 2, 3, 17, 3), []),
]


def _runs(mask: Mask) -> list[list[int]]:
    return [list(run) for run in runs(mask)]


def _grid(mask: Mask) -> dict[str, Any]:
    return {"width": len(mask[0]), "height": len(mask), "runs": _runs(mask)}


def _shaped(shape: Any) -> dict[str, Any]:
    return {
        "geometry": json.loads(shape.geometry.model_dump_json()),
        "contour": [list(point) for point in shape.contour],
    }


def _key(allowed: list[GeometryType]) -> str:
    return ",".join(str(kind.value) for kind in allowed)


def _case(name: str, mask: Mask, at: list[tuple[float, float]]) -> dict[str, Any]:
    pieces = components(mask, at=at)
    head = pieces[0] if pieces else None
    whole = filled(head.mask) if head is not None else None
    return {
        "name": name,
        "mask": _grid(mask),
        "at": [list(point) for point in at],
        "components": [{"x": piece.x, "y": piece.y, **_grid(list(piece.mask))} for piece in pieces],
        "closing_radius": None if head is None else closing_radius(head.mask),
        "filled": None if whole is None else _grid([list(row) for row in whole]),
        "outline": None if whole is None else [list(point) for point in outline(whole)],
        "contour": None if whole is None else [list(point) for point in contour(whole)],
        "shapes": {
            _key(allowed): {
                str(tolerance): [
                    _shaped(shape)
                    for shape in shapes_from(mask, allowed=allowed, tolerance=tolerance, at=at)
                ]
                for tolerance in TOLERANCES
            }
            for allowed in ALLOWED
        },
    }


def build_fixture() -> dict[str, Any]:
    return {
        "minimum_fragment_share": MINIMUM_FRAGMENT_SHARE,
        "closing_reach": CLOSING_REACH,
        "maximum_closing_radius": MAXIMUM_CLOSING_RADIUS,
        "minimum_tolerance": MINIMUM_TOLERANCE,
        "default_tolerance": DEFAULT_TOLERANCE,
        "tolerances": TOLERANCES,
        "cases": [_case(name, mask, at) for name, mask, at in CASES],
    }


def main() -> None:
    out = REPO_ROOT / OUTPUT_PATH
    out.write_text(json.dumps(build_fixture(), separators=(",", ":"), sort_keys=True) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
