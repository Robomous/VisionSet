# usage: from visionset.inference.masks import geometry_from
"""A binary mask in, one domain geometry out — and nothing about torch in between.

A segmenter answers with a grid of booleans; this domain stores boxes and
polygons. That conversion is the whole of this module, and it is written over
plain Python sequences rather than tensors for the reason ``nms`` is: it is the
part of a segmentation adapter that can be wrong in a way no GPU is needed to
see, so it is the part a test drives with literals.

**Which shape is produced is the caller's schema decision, not this module's
guess.** ``geometry_from`` takes the geometry kinds the active class actually
admits and produces one of those or nothing — D3 on #424, where a class allowing
polygons gets the outline, a class allowing only boxes gets the mask's extent,
and a class allowing neither is not offered the gesture at all.

**Tolerance is relative, and that is what makes one "detail" setting work.** D3
asks for a single knob that lands typical objects in a 10-40 vertex range. An
absolute pixel tolerance cannot: three pixels is nothing on a car and is the
whole of a bottle cap. So the tolerance handed to Douglas-Peucker is a fraction
of the region's own bounding diagonal, which makes the vertex count a property of
the *shape* rather than of how much of the frame it happens to fill.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from visionset.kernel.domain import BboxGeometry, Geometry, GeometryType, PolygonGeometry

Mask = Sequence[Sequence[bool]]
"""Rows of columns, ``mask[y][x]`` — the orientation every image library agrees
on and the one ``post_process_masks`` produces."""

Point = tuple[float, float]

DEFAULT_DETAIL: Final = 0.01
"""D3's single "detail" setting, as a fraction of the region's bounding diagonal.

Chosen against the shape the range was written for rather than by taste: for a
roughly circular object this keeps the vertices where the sagitta of a chord
exceeds the tolerance, which works out at ~13 vertices — inside D3's 10-40 band
with room on both sides for shapes more and less convoluted than a circle.
Smaller means more faithful and more vertices; larger means fewer.
"""

MINIMUM_TOLERANCE: Final = 0.5
"""No tolerance below half a pixel, however small the region.

Below this the simplification is arguing about detail the mask does not have —
its own coordinates are integers — and the vertex count runs away for nothing.
"""


def spans(mask: Mask) -> list[tuple[int, int, int]]:
    """``(y, first_x, last_x)`` for every row holding anything.

    Rows rather than pixels on purpose. A full-resolution mask is a megapixel of
    booleans, and anything here that looped over it in Python would cost more
    than the forward pass that produced it; ``list.index`` does the scan in C and
    the loop only ever sees the number of rows.
    """
    found: list[tuple[int, int, int]] = []
    for y, row in enumerate(mask):
        try:
            first = row.index(True)  # type: ignore[attr-defined]
        except ValueError:
            continue
        last = len(row) - 1 - list(reversed(row)).index(True)
        found.append((y, first, last))
    return found


def bbox_from(mask: Mask) -> BboxGeometry | None:
    """The mask's extent, or ``None`` if it holds nothing.

    ``None`` rather than a raise: an empty mask is an ordinary answer from a
    model asked about an empty patch of sky, and the caller turns it into "no
    suggestion" rather than into an error.

    The box is the pixels' outer edge, so a single lit pixel is one wide and one
    tall rather than zero — the domain refuses a zero-area box, and a
    one-pixel-wide object is a real thing to point at.
    """
    rows = spans(mask)
    if not rows:
        return None
    y_min = rows[0][0]
    y_max = rows[-1][0]
    x_min = min(first for _, first, _ in rows)
    x_max = max(last for _, _, last in rows)
    return BboxGeometry(
        x=float(x_min),
        y=float(y_min),
        width=float(x_max - x_min + 1),
        height=float(y_max - y_min + 1),
    )


def outline(mask: Mask) -> list[Point]:
    """The boundary of the blob the topmost-leftmost lit pixel belongs to.

    Moore-neighbourhood tracing with Jacob's stopping criterion: walk the ring of
    lit pixels, at each one resuming the search from where the previous step
    arrived, and stop on re-entering the start pixel from the direction first
    used to leave it. Stopping merely on *reaching* the start again is the
    classic bug — a shape with a one-pixel isthmus revisits its start mid-trace
    and the outline comes back truncated.

    **One blob, not all of them.** A component-labelling pass would be a second
    walk over every pixel to answer a question this caller does not have: a
    point-prompted segmenter answers with the thing under the point, and the
    speckle that survives its own post-processing is not a second object worth
    tracing. A mask holding two real blobs yields the first one found.
    """
    rows = spans(mask)
    if not rows:
        return []
    start = (rows[0][1], rows[0][0])
    height, width = len(mask), len(mask[0])

    def lit(point: tuple[int, int]) -> bool:
        x, y = point
        return 0 <= x < width and 0 <= y < height and bool(mask[y][x])

    # Clockwise from due west, which is where a scan arriving from the left came
    # from — so the first candidate examined is the one just above the start.
    around: Final = ((-1, 0), (-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1))

    traced = [start]
    current, entered_from = start, 0
    while True:
        for step in range(1, len(around) + 1):
            index = (entered_from + step) % len(around)
            candidate = (current[0] + around[index][0], current[1] + around[index][1])
            if lit(candidate):
                # The direction the *next* search resumes from: back the way we
                # came, which is the opposite neighbour.
                entered_from = (index + len(around) // 2) % len(around)
                current = candidate
                break
        else:
            # An isolated pixel has no ring to walk.
            return [(float(start[0]), float(start[1]))]
        if current == start:
            break
        traced.append(current)
        if len(traced) > 4 * (height + width):
            # A boundary longer than any real one is a trace that failed to
            # close. Returning what was walked beats looping.
            break
    return [(float(x), float(y)) for x, y in traced]


def _distance_to_segment(point: Point, start: Point, end: Point) -> float:
    """Perpendicular distance, degenerating to plain distance on a zero-length segment."""
    (px, py), (sx, sy), (ex, ey) = point, start, end
    dx, dy = ex - sx, ey - sy
    if dx == 0.0 and dy == 0.0:
        return ((px - sx) ** 2 + (py - sy) ** 2) ** 0.5
    return abs(dy * px - dx * py + ex * sy - ey * sx) / ((dx * dx + dy * dy) ** 0.5)


def simplified(points: Sequence[Point], *, tolerance: float) -> list[Point]:
    """Douglas-Peucker over an open polyline.

    Iterative rather than recursive: a traced boundary is thousands of points
    long and the recursive spelling of this algorithm is depth-unbounded on
    exactly the input it is given here.
    """
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    pending = [(0, len(points) - 1)]
    while pending:
        first, last = pending.pop()
        if last <= first + 1:
            continue
        worst, distance = first, -1.0
        for index in range(first + 1, last):
            found = _distance_to_segment(points[index], points[first], points[last])
            if found > distance:
                worst, distance = index, found
        if distance > tolerance:
            keep[worst] = True
            pending.append((first, worst))
            pending.append((worst, last))
    return [point for point, kept in zip(points, keep, strict=True) if kept]


def tolerance_for(points: Sequence[Point], *, detail: float) -> float:
    """The pixel tolerance ``detail`` means for a region of this size.

    See the module docstring: a fraction of the bounding diagonal, floored so it
    never argues about sub-pixel detail.
    """
    if not points:
        return MINIMUM_TOLERANCE
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    diagonal = ((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2) ** 0.5
    return max(MINIMUM_TOLERANCE, detail * diagonal)


def polygon_from(mask: Mask, *, detail: float = DEFAULT_DETAIL) -> PolygonGeometry | None:
    """The mask's outline, simplified — or ``None`` if no polygon can be made.

    ``None`` covers both an empty mask and a blob too thin to have three distinct
    corners: the domain requires three points, and a two-point "polygon" is a
    line somebody would have to fix by hand rather than a suggestion worth
    offering.
    """
    traced = outline(mask)
    if len(traced) < 3:
        return None
    tolerance = tolerance_for(traced, detail=detail)
    kept = _closed(simplified(traced, tolerance=tolerance), tolerance=tolerance)
    if len(kept) < 3:
        return None
    return PolygonGeometry(points=kept)


def _closed(kept: list[Point], *, tolerance: float) -> list[Point]:
    """Drop the vertices Douglas-Peucker only kept because it was told to.

    The algorithm pins the first and last point of what it is given, and what it
    is given here is a *ring* cut open at an arbitrary pixel. So the final vertex
    is pinned for a reason that stops being true the moment the ring closes, and
    it lands one pixel from the first — a stray handle on an otherwise clean
    outline, most visible on the straight-edged shapes where it is least
    excusable: an axis-aligned rectangle came back as five points.

    Judged by the same tolerance as everything else rather than by exact
    equality: the artifact is a near-duplicate, not a duplicate, so testing
    ``kept[0] == kept[-1]`` never fires on the case that motivates it.
    """
    while len(kept) > 3:
        if _distance_to_segment(kept[-1], kept[-2], kept[0]) > tolerance:
            return kept
        kept = kept[:-1]
    return kept


def bounds_of(points: Sequence[Point]) -> BboxGeometry | None:
    """The smallest box containing those points, or ``None`` if there are none.

    Zero-area is widened to one unit rather than refused, for the reason
    :func:`bbox_from` gives about a single lit pixel: the domain will not store a
    degenerate box, and a perfectly flat or vertical outline is a real thing for
    a segmenter to find at the edge of an image.
    """
    if not points:
        return None
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return BboxGeometry(
        x=min(xs),
        y=min(ys),
        width=max(max(xs) - min(xs), 1.0),
        height=max(max(ys) - min(ys), 1.0),
    )


def narrowed(geometry: Geometry, *, allowed: Sequence[GeometryType]) -> Geometry | None:
    """That shape in a kind the active class admits, or ``None`` if there is none.

    D3's rule, and it lives here — above the adapter and below the route —
    because it is a *schema* decision rather than a model one. The port carries
    no notion of what a class allows, deliberately: widening it would push a
    project's schema into a protocol that has to be implementable by a service
    that has never heard of this workspace.

    So a segmenter answers with the most informative shape it has, and the
    narrowing happens here: a polygon stands where polygons are allowed, becomes
    its own bounding box where only boxes are, and is refused where neither is —
    the tag-only class D3 says the gesture is not offered for at all. Nothing is
    ever widened, because a box cannot become the outline it never held.
    """
    kinds = set(allowed)
    if geometry.type in kinds:
        return geometry
    if isinstance(geometry, PolygonGeometry) and GeometryType.BBOX in kinds:
        return bounds_of(geometry.points)
    return None
