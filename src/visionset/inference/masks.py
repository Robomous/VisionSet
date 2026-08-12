# usage: from visionset.inference.masks import shapes_from
"""A binary mask in, domain geometry out — and nothing about torch in between.

A segmenter answers with a grid of booleans; this domain stores boxes and
polygons. That conversion is the whole of this module, and it is written over
plain Python sequences rather than tensors for the reason ``nms`` is: it is the
part of a segmentation adapter that can be wrong in a way no GPU is needed to
see, so it is the part a test drives with literals.

**It lives above the adapter now, and that is the point.** Every choice below —
which pieces of the mask are shapes, whether the holes inside them are closed,
how much of the outline survives — used to be made inside the segmentation
adapter with a constant nobody could reach. They are product decisions, they are
the ones a person adjusts, and an adapter is the one place a caller cannot reach
them from. ``PointSegmenter`` stops at the mask precisely so that this runs once
for every segmenter there will ever be.

**The pipeline is fixed and its order is not configurable.**

1. :func:`components` — which pieces of the mask survive.
2. :func:`filled` — the gaps in them narrower than a reach, closed or kept.
3. :func:`contour` — the boundary of what is left.
4. :func:`polygon_at` — that boundary, reduced to a vertex count somebody can edit.

The geometry branch happens after step 2: a polygon class takes steps 3 and 4, a
box class takes the filled piece's extent. **A box therefore does not depend on
``detail``**, which is what "applies to polygon only" means once it is code
rather than a table.

**Which shape is produced is the caller's schema decision, not this module's
guess.** :func:`shapes_from` takes the geometry kinds the active class actually
admits and produces those or nothing: a class allowing polygons gets outlines, a
class allowing only boxes gets extents, and a class allowing neither is not
offered the gesture at all. Nothing is ever widened — a box cannot become the
outline it never held.

**Tolerance is relative, and that is what makes one "detail" setting work.** The
design asks for a knob that lands typical objects in a 10-40 vertex range. An
absolute pixel tolerance cannot: three pixels is nothing on a car and is the
whole of a bottle cap. So the tolerance handed to Douglas-Peucker is a fraction
of the region's own bounding diagonal, which makes the vertex count a property of
the *shape* rather than of how much of the frame it happens to fill.

**The canonical contour, and why step 3 reduces before step 4 gets a choice.**
Douglas-Peucker is not nested: reducing at half a pixel and then at five pixels
does not give what reducing once at five pixels gives. The editor re-simplifies
locally so that moving ``detail`` costs no round trip, while this module stays
authoritative on what is finally written — and those two can only be proved to
agree if they start from the same points. So :func:`contour` is *defined* as the
traced boundary reduced once at :data:`MINIMUM_TOLERANCE`, that is what travels
to a client, and :func:`polygon_at` takes it rather than a raw trace. It also
bounds a payload that would otherwise run to tens of thousands of integer-pixel
points on a large object.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final

from visionset.kernel.domain import (
    DEFAULT_DETAIL,
    DEFAULT_FILL_HOLES,
    DEFAULT_FRAGMENTS,
    BboxGeometry,
    Detail,
    Fragments,
    Geometry,
    GeometryType,
    Mask,
    PolygonGeometry,
)

Point = tuple[float, float]

EPSILON: Final[Mapping[Detail, float]] = {
    Detail.COARSE: 0.025,
    Detail.BALANCED: 0.01,
    Detail.FINE: 0.004,
}
"""What each step means, as a fraction of the region's bounding diagonal.

``BALANCED`` is calibrated rather than chosen by taste, and the other two are
placed around it. For a roughly circular object it keeps the vertices where the
sagitta of a chord exceeds the tolerance, which works out at ~13 — inside the
10-40 band with room on both sides for shapes more and less convoluted than a
circle. ``COARSE`` is two and a half times as tolerant and ``FINE`` two and a
half times as strict, which moves the same circle to roughly 8 and roughly 21:
three settings a person can tell apart without any of them being useless.

It is a mapping here and not a member value on ``Detail`` because the numbers are
a property of *this* simplification algorithm. A second one would want its own
table and the same three names.
"""

MINIMUM_TOLERANCE: Final = 0.5
"""No tolerance below half a pixel, however small the region.

Below this the simplification is arguing about detail the mask does not have —
its own coordinates are integers — and the vertex count runs away for nothing.
"""

MINIMUM_FRAGMENT_SHARE: Final = 0.05
"""How big a piece has to be, against the biggest one, to be worth proposing.

Only consulted when the caller asked for every piece. A segmenter's mask
routinely carries specks a twentieth the size of the thing that was clicked —
antialiasing along an edge, a reflection, a scrap of the same colour across the
frame — and proposing each of them as its own annotation turns one click into a
cleanup job. Relative to the largest piece rather than to the frame, so it means
the same thing on a mask covering everything and a mask covering a corner.
"""


@dataclass(frozen=True, slots=True)
class Piece:
    """One connected piece of a mask, cropped to its own extent.

    ``x`` and ``y`` are where the crop sits in the asset, and every coordinate
    this module finally emits has them added back.

    Cropped rather than carried at full size, which is what keeps a plural answer
    affordable: a 4K mask is eight million booleans, and materialising one of
    those per piece would cost more than the forward pass that produced it. A
    piece is the size of the thing, not the size of the picture.
    """

    x: int
    y: int
    mask: Mask


@dataclass(frozen=True, slots=True)
class Shaped:
    """One proposal: the geometry, and the contour it was reduced from.

    ``contour`` is empty for a box, because a box is not reduced from anything —
    it is the piece's extent, and there is nothing a client could re-derive from
    a different setting. That emptiness is the same fact
    ``PARAMETER_APPLIES_TO`` states from the other end.
    """

    geometry: Geometry
    contour: tuple[Point, ...] = ()


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


def runs(mask: Mask) -> list[tuple[int, int, int]]:
    """``(y, first_x, last_x)`` for every maximal run of lit pixels, in reading order.

    Runs rather than pixels, for the reason :func:`spans` gives: ``list.index``
    scans in C, and the Python-level loop only ever goes round as many times as
    the row changes colour — not once per pixel. A megapixel mask of one clean
    object is a few hundred runs, which is what makes blob selection affordable
    on the interactive path.
    """
    found: list[tuple[int, int, int]] = []
    for y, row in enumerate(mask):
        width = len(row)
        at = 0
        while at < width:
            try:
                first = row.index(True, at)  # type: ignore[attr-defined]
            except ValueError:
                break
            try:
                last = row.index(False, first) - 1  # type: ignore[attr-defined]
            except ValueError:
                last = width - 1
            found.append((y, first, last))
            # +2 rather than +1: the pixel that ended the run is known unlit.
            at = last + 2
    return found


def _adjacent(one: tuple[int, int, int], other: tuple[int, int, int]) -> bool:
    """Do two runs on neighbouring rows touch, counting diagonals?"""
    return one[1] <= other[2] + 1 and other[1] <= one[2] + 1


def _components(found: Sequence[tuple[int, int, int]]) -> list[int]:
    """One label per run: which piece it belongs to, 8-connected.

    Union-find over *runs* rather than a flood fill over pixels. The row-pair
    walk is two pointers over lists already sorted by ``x``, so the whole pass
    is linear in the number of runs.
    """
    parent = list(range(len(found)))

    def root(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def join(left: int, right: int) -> None:
        one, other = root(left), root(right)
        if one != other:
            # The earlier run wins, so a label is always its piece's first run.
            parent[max(one, other)] = min(one, other)

    rows: dict[int, list[int]] = {}
    for index, (y, _, _) in enumerate(found):
        rows.setdefault(y, []).append(index)
    for y, here in rows.items():
        above = rows.get(y - 1)
        if not above:
            continue
        this, prior = 0, 0
        while this < len(here) and prior < len(above):
            mine, theirs = found[here[this]], found[above[prior]]
            if _adjacent(mine, theirs):
                join(here[this], above[prior])
            if mine[2] < theirs[2]:
                this += 1
            else:
                prior += 1
    return [root(index) for index in range(len(found))]


def _gap(point: Point, run: tuple[int, int, int]) -> float:
    """Distance from a point to a run, which is a horizontal segment of pixels."""
    x, y = point
    row, first, last = run
    across = max(0.0, first - x, x - last)
    return (across * across + (row - y) * (row - y)) ** 0.5


def _areas(found: Sequence[tuple[int, int, int]], labels: Sequence[int]) -> dict[int, int]:
    """Lit pixels per label, summed off the runs rather than counted."""
    size: dict[int, int] = {}
    for (_, first, last), label in zip(found, labels, strict=True):
        size[label] = size.get(label, 0) + last - first + 1
    return size


def _pointed_at(
    found: Sequence[tuple[int, int, int]],
    labels: Sequence[int],
    size: Mapping[int, int],
    at: Sequence[Point],
) -> int:
    """The label of the piece the prompt asks about.

    A point-prompted segmenter is asked *about a place*, so the piece that
    answers is the one under the point — not the one that happens to own the
    topmost-leftmost lit pixel, which is a property of where the speckle fell
    rather than of what was clicked.

    Three cases, in order. A point inside a piece picks that piece; several
    points inside several pieces pick the largest of them, because two positives
    are a caller describing one object rather than proposing two. A point inside
    none of them — the model's mask need not cover the exact pixel clicked —
    picks the piece nearest the point, which is still an answer about where the
    user pointed. Negatives never select: they say what the shape is not, and a
    piece is chosen before its shape is known.

    Without any point at all the topmost-leftmost piece still wins. Nothing but a
    point prompt has an opinion about which piece was meant.
    """
    if not at:
        return labels[0]
    under = {
        labels[index]
        for point in at
        for index, (row, first, last) in enumerate(found)
        if row == round(point[1]) and first <= round(point[0]) <= last
    }
    if under:
        return max(under, key=lambda label: size[label])
    nearest = min(
        range(len(found)), key=lambda index: min(_gap(point, found[index]) for point in at)
    )
    return labels[nearest]


def _cropped(label: int, found: Sequence[tuple[int, int, int]], labels: Sequence[int]) -> Piece:
    """That label's runs, painted into a mask the size of their own extent."""
    mine = [run for run, owner in zip(found, labels, strict=True) if owner == label]
    top = mine[0][0]
    bottom = mine[-1][0]
    left = min(first for _, first, _ in mine)
    right = max(last for _, _, last in mine)
    grid = [[False] * (right - left + 1) for _ in range(bottom - top + 1)]
    for row, first, last in mine:
        line = grid[row - top]
        for x in range(first - left, last - left + 1):
            line[x] = True
    return Piece(x=left, y=top, mask=grid)


def components(
    mask: Mask, *, fragments: Fragments = DEFAULT_FRAGMENTS, at: Sequence[Point] = ()
) -> list[Piece]:
    """Step 1 — the pieces of the mask worth turning into shapes.

    ``ONE`` is the piece the prompt points at, per :func:`_pointed_at`. ``ALL``
    is every piece at or above :data:`MINIMUM_FRAGMENT_SHARE` of the largest,
    ordered biggest first so that a panel showing several proposals leads with
    the one most likely to be the thing that was clicked; ties keep reading
    order, so the result is stable for a given mask.

    An empty mask answers with no pieces, which is an ordinary answer and not an
    error — the click landed on sky.
    """
    found = runs(mask)
    if not found:
        return []
    labels = _components(found)
    size = _areas(found, labels)

    if fragments is Fragments.ONE:
        chosen = [_pointed_at(found, labels, size, at)]
    else:
        floor = max(size.values()) * MINIMUM_FRAGMENT_SHARE
        chosen = sorted(
            (label for label, area in size.items() if area >= floor),
            key=lambda label: (-size[label], label),
        )
    return [_cropped(label, found, labels) for label in chosen]


def _bits(mask: Mask, *, pad: int) -> tuple[list[int], int]:
    """The mask as one integer per row, offset by ``pad`` on every side.

    A bitset because the two morphological passes below are then whole-row
    shifts and ORs, which CPython does on machine words inside one big-integer
    operation. The same passes written as nested loops over pixels would be a
    Python-level step per pixel per radius step, on the path somebody is waiting
    on after a click.
    """
    width = len(mask[0]) + 2 * pad
    rows = [0] * (len(mask) + 2 * pad)
    for y, first, last in runs(mask):
        rows[y + pad] |= ((1 << (last - first + 1)) - 1) << (first + pad)
    return rows, width


def _grown(rows: Sequence[int], *, radius: int, width: int) -> list[int]:
    """Every lit pixel spread by ``radius`` in each direction — a square dilation."""
    frame = (1 << width) - 1
    across = []
    for row in rows:
        spread = row
        for step in range(1, radius + 1):
            spread |= (row << step) | (row >> step)
        across.append(spread & frame)
    height = len(rows)
    return [
        _joined(across[max(0, y - radius) : min(height, y + radius + 1)]) for y in range(height)
    ]


def _shrunk(rows: Sequence[int], *, radius: int, width: int) -> list[int]:
    """The dual: a pixel survives only with its whole square neighbourhood lit.

    Outside the frame counts as unlit, which the shifts give for free — bits move
    off the end and zeros arrive — and which is right here because the frame was
    padded wide enough that nothing real sits against its edge.
    """
    frame = (1 << width) - 1
    across = []
    for row in rows:
        kept = row
        for step in range(1, radius + 1):
            kept &= (row << step) & (row >> step) & frame
        across.append(kept & frame)
    height = len(rows)
    return [
        _met(across[max(0, y - radius) : min(height, y + radius + 1)])
        if radius <= y < height - radius
        else 0
        for y in range(height)
    ]


def _joined(rows: Sequence[int]) -> int:
    joined = 0
    for row in rows:
        joined |= row
    return joined


def _met(rows: Sequence[int]) -> int:
    met = rows[0]
    for row in rows[1:]:
        met &= row
    return met


def closing_radius(mask: Mask, *, fill_holes: float) -> int:
    """How far to reach, for a piece of this size and that share.

    The share names the largest *hole* to close, and a hole of area ``a`` needs a
    reach of about ``sqrt(a) / 2`` to be bridged — so the radius comes from the
    piece's own lit area rather than from a pixel count, and the setting means
    the same thing on a thing fifty pixels across and a thing five hundred
    across. Rounded down, so the smallest shapes get no closing at all rather
    than one that would swallow a feature.
    """
    if fill_holes <= 0.0:
        return 0
    lit = sum(last - first + 1 for _, first, last in runs(mask))
    return int((lit * fill_holes) ** 0.5 / 2)


def filled(mask: Mask, *, fill_holes: float = DEFAULT_FILL_HOLES) -> Mask:
    """Step 2 — close the small gaps in a piece, wherever they are.

    A morphological close: grow the shape, then shrink it back by the same
    amount. Anything narrower than the reach is bridged on the way out and not
    re-opened on the way back, and everything wider is left exactly as it was.

    **A close rather than a flood fill of enclosed holes, and the reason is
    measurable.** Boundary tracing walks a shape's *outer* ring, and
    ``PolygonGeometry`` is one ring with no interior — so an enclosed hole is
    invisible to the contour and to the extent alike, and filling one changes the
    mask and nothing a caller ever sees. Filling an 8x8 hole in a 20x20 square
    moves the mask from 336 lit pixels to 400 and leaves the traced outline
    byte-identical. A close reaches the gaps that *do* show: the bays a segmenter
    bites out of an edge, the notch where two strokes almost meet, the pinhole at
    a corner.

    ``0.0`` closes nothing and is a legitimate request rather than a disabled
    feature: a mask of foliage is mostly gaps and every one of them is real.

    Returns the mask unchanged — the same object — when the reach works out at
    nothing or the shape has no gap that narrow, which is the common case and
    saves rebuilding a grid to say so.
    """
    radius = closing_radius(mask, fill_holes=fill_holes)
    if radius < 1:
        return mask
    before, width = _bits(mask, pad=radius)
    after = _shrunk(_grown(before, radius=radius, width=width), radius=radius, width=width)
    if after == before:
        return mask
    height = len(mask)
    return [
        [
            bit == "1"
            for bit in format(after[y + radius], f"0{width}b")[::-1][radius : radius + len(mask[0])]
        ]
        for y in range(height)
    ]


def outline(mask: Mask) -> list[Point]:
    """The boundary of the piece this mask holds.

    Moore-neighbourhood tracing with Jacob's stopping criterion: walk the ring of
    lit pixels, at each one resuming the search from where the previous step
    arrived, and stop on re-entering the start pixel from the direction first
    used to leave it. Stopping merely on *reaching* the start again is the
    classic bug — a shape with a one-pixel isthmus revisits its start mid-trace
    and the outline comes back truncated.

    The walk cannot leave the piece it starts in: it only ever steps to an
    8-adjacent lit pixel, and two pixels 8-adjacent to each other are the same
    piece by definition. Which piece it starts in is no longer a question here —
    :func:`components` has already made the mask hold exactly one.
    """
    found = runs(mask)
    if not found:
        return []
    start = (found[0][1], found[0][0])
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

    **Ported line for line into TypeScript**, so the editor can re-simplify a
    contour without asking. `tests/fixtures/simplification.json` is what holds
    the two spellings to the same answers; change one and the gate fails until
    the other follows.
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


def tolerance_for(points: Sequence[Point], *, detail: Detail = DEFAULT_DETAIL) -> float:
    """The pixel tolerance ``detail`` means for a region of this size.

    See the module docstring: a fraction of the bounding diagonal, floored so it
    never argues about sub-pixel detail.
    """
    if not points:
        return MINIMUM_TOLERANCE
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    diagonal = ((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2) ** 0.5
    return max(MINIMUM_TOLERANCE, EPSILON[detail] * diagonal)


def contour(mask: Mask) -> list[Point]:
    """Step 3 — the canonical boundary: traced, then reduced once at the floor.

    The reduction is part of the definition rather than an optimisation, and the
    module docstring says why: Douglas-Peucker is not nested, so a client that
    re-simplifies and a server that stays authoritative can only be proved to
    agree when both start here. At half a pixel it discards nothing a mask of
    integer coordinates could express, and it turns a staircase of thousands of
    single-pixel steps into the handful of segments those steps were drawing.
    """
    return simplified(outline(mask), tolerance=MINIMUM_TOLERANCE)


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


def polygon_at(
    points: Sequence[Point], *, detail: Detail = DEFAULT_DETAIL
) -> PolygonGeometry | None:
    """Step 4 — that contour at the requested vertex density, or ``None``.

    ``None`` covers a contour with nothing in it and one too thin to have three
    distinct corners: the domain requires three points, and a two-point "polygon"
    is a line somebody would have to fix by hand rather than a suggestion worth
    offering.

    Takes a contour rather than a mask, which is what lets the editor call the
    same step on the same input without another forward pass.
    """
    if len(points) < 3:
        return None
    tolerance = tolerance_for(points, detail=detail)
    kept = _closed(simplified(points, tolerance=tolerance), tolerance=tolerance)
    if len(kept) < 3:
        return None
    return PolygonGeometry(points=kept)


def _shifted(points: Sequence[Point], *, piece: Piece) -> list[Point]:
    """A cropped piece's coordinates put back where the asset has them."""
    return [(x + piece.x, y + piece.y) for x, y in points]


def _boxed(piece: Piece) -> BboxGeometry | None:
    """The piece's extent, in the asset's coordinates."""
    box = bbox_from(piece.mask)
    if box is None:
        return None
    return box.model_copy(update={"x": box.x + piece.x, "y": box.y + piece.y})


def target_kind(allowed: Sequence[GeometryType]) -> GeometryType | None:
    """The kind an answer for that class will come back in, before there is one.

    Polygon where a class admits it, because it is the more informative shape and
    a box can always be read off it; a box where that is all there is; nothing at
    all for a class that holds no shape.

    A function rather than a branch inside :func:`shapes_from`, because a caller
    has to declare *which parameters apply* before it knows whether the model
    found anything — and a second spelling of this rule in a route would be free
    to disagree with the one that actually decides.
    """
    kinds = set(allowed)
    if GeometryType.POLYGON in kinds:
        return GeometryType.POLYGON
    if GeometryType.BBOX in kinds:
        return GeometryType.BBOX
    return None


def shapes_from(
    mask: Mask,
    *,
    allowed: Sequence[GeometryType],
    detail: Detail = DEFAULT_DETAIL,
    fill_holes: float = DEFAULT_FILL_HOLES,
    fragments: Fragments = DEFAULT_FRAGMENTS,
    at: Sequence[Point] = (),
) -> list[Shaped]:
    """The whole pipeline: a mask and a class's geometries in, proposals out.

    The four steps in their fixed order, with the geometry branch after the
    second. A class that admits polygons gets outlines; one that admits only
    boxes gets extents, measured off the filled piece rather than off a
    simplified outline's corners — which is what keeps ``detail`` from quietly
    moving a box.

    **Nothing is ever widened.** A class admitting neither kind gets an empty
    list, and a piece too thin to be a polygon is dropped rather than demoted to
    a box: answering in a kind the caller did not ask for is how a suggestion
    arrives that the schema will refuse to store.
    """
    kind = target_kind(allowed)
    if kind is None:
        return []

    shaped: list[Shaped] = []
    for piece in components(mask, fragments=fragments, at=at):
        whole = Piece(x=piece.x, y=piece.y, mask=filled(piece.mask, fill_holes=fill_holes))
        if kind is GeometryType.POLYGON:
            traced = _shifted(contour(whole.mask), piece=whole)
            polygon = polygon_at(traced, detail=detail)
            if polygon is not None:
                shaped.append(Shaped(geometry=polygon, contour=tuple(traced)))
            continue
        box = _boxed(whole)
        if box is not None:
            shaped.append(Shaped(geometry=box))
    return shaped
