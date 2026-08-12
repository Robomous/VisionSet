"""Export simplification golden cases to tests/fixtures/simplification.json.

The editor re-runs `detail` locally so that moving it costs no round trip, while
the kernel stays authoritative on what is finally written. Those are two
implementations of one algorithm, and the only thing that makes "they agree" a
fact rather than a hope is a set of inputs both are held to.

Two gates, sharing no toolchain, exactly like the spec and its client:
`tests/inference/test_simplification_fixture.py` keeps this file matching the
Python; `frontend/annotator/src/core/geometry/simplify.test.ts` keeps the
TypeScript matching this file. The frontend CI job installs no Python and reads
only what is committed — the arrangement `wire_annotations.json` already uses,
and for the same reason.

It carries **contours rather than masks**, because a contour is where the two
implementations meet: everything before it needs a segmenter's output and runs
only here, and everything after it has to give the same answer in both places.
The contours are produced by the real pipeline from shapes chosen to exercise
what can differ — a curve whose vertex count actually moves between steps, a
rectangle whose closing artifact has to be dropped identically, a shape small
enough that the tolerance floor decides instead of the ratio, and one too thin
to be a polygon at all.

Usage: uv run python scripts/export_simplification_fixtures.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from visionset.inference.masks import (
    EPSILON,
    MINIMUM_TOLERANCE,
    contour,
    polygon_at,
    tolerance_for,
)
from visionset.kernel.domain import Detail

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = "tests/fixtures/simplification.json"


def disc(radius: int) -> list[list[bool]]:
    width = height = 2 * radius + 8
    cx, cy = width // 2, height // 2
    return [
        [(x - cx) ** 2 + (y - cy) ** 2 <= radius * radius for x in range(width)]
        for y in range(height)
    ]


def rect(x0: int, y0: int, x1: int, y1: int, *, size: int = 100) -> list[list[bool]]:
    return [[x0 <= x <= x1 and y0 <= y <= y1 for x in range(size)] for y in range(size)]


def blob(radius: int, lobes: int) -> list[list[bool]]:
    """A wobbly disc — the shape whose vertex count moves most between steps."""
    width = height = 2 * radius + 12
    cx, cy = width // 2, height // 2
    grid = []
    for y in range(height):
        row = []
        for x in range(width):
            dx, dy = x - cx, y - cy
            distance = (dx * dx + dy * dy) ** 0.5
            wobble = 1.0 + 0.18 * math.sin(math.atan2(dy, dx) * lobes)
            row.append(distance <= radius * wobble)
        grid.append(row)
    return grid


CASES: list[tuple[str, list[list[bool]]]] = [
    # A curve: every step keeps a different number of vertices, so a simplifier
    # that ignored `detail` entirely would be caught here and nowhere else.
    ("disc", disc(60)),
    ("blob", blob(70, 5)),
    # Straight edges: the ring is cut open at an arbitrary pixel and the closing
    # artifact has to be dropped identically, or one side answers five corners.
    ("rectangle", rect(10, 10, 60, 60)),
    ("thin-rectangle", rect(10, 10, 80, 14)),
    # Small enough that the half-pixel floor decides rather than the ratio, which
    # is a different branch of `tolerance_for` and the one a port most easily
    # leaves out.
    ("tiny-disc", disc(4)),
    # Two points: below what a polygon can be, and both sides must refuse.
    ("two-pixels", rect(10, 10, 11, 10)),
]


def build_fixture() -> dict[str, Any]:
    return {
        "minimum_tolerance": MINIMUM_TOLERANCE,
        "epsilon": {step.value: EPSILON[step] for step in Detail},
        "cases": [
            {
                "name": name,
                "contour": [list(point) for point in contour(mask)],
                "tolerance": {
                    step.value: tolerance_for(contour(mask), detail=step) for step in Detail
                },
                "polygon": {step.value: _points(mask, step) for step in Detail},
            }
            for name, mask in CASES
        ],
    }


def _points(mask: list[list[bool]], step: Detail) -> list[list[float]] | None:
    polygon = polygon_at(contour(mask), detail=step)
    return None if polygon is None else [list(point) for point in polygon.points]


def main() -> None:
    out = REPO_ROOT / OUTPUT_PATH
    out.write_text(json.dumps(build_fixture(), indent=2, sort_keys=True) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
