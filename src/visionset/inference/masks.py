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

1. :func:`components` — which pieces of the mask survive the noise filter.
2. :func:`filled` — the gaps in them narrower than a reach, closed.
3. :func:`contour` — the boundary of what is left: traced along the pixels' edges,
   smoothed once, and reduced at :data:`MINIMUM_TOLERANCE`.
4. :func:`polygon_at` — that boundary, within a pixel tolerance somebody chose.

The geometry branch happens after step 2: a polygon class takes steps 3 and 4 on
the piece the prompt points at, a box class takes one extent over *every*
surviving piece. **A box therefore does not depend on the tolerance**, which is
what "applies to polygon only" means once it is code rather than a table.

**Only one of these is a question anybody is asked.** The reach of the close and
the noise floor are fixed here, because on the ordinary single clean piece every
setting of either produced the same shape — controls wired to nothing (#557).
The tolerance is the one that moves something a person can see.

**Which shape is produced is the caller's schema decision, not this module's
guess.** :func:`shapes_from` takes the geometry kinds the active class actually
admits and produces those or nothing: a class allowing polygons gets outlines, a
class allowing only boxes gets extents, and a class allowing neither is not
offered the gesture at all. Nothing is ever widened — a box cannot become the
outline it never held.

**The tolerance is a distance in the asset's pixels, and that is the whole
contract.** Every point of the contour lies within ``tolerance`` of the polygon
that is finally written, so the number means the same thing on every object and a
person reading it knows what they will get before they move it.

**The canonical contour, and why step 3 reduces before step 4 gets a choice.**
Douglas-Peucker is not nested: reducing at a quarter pixel and then at five does
not give what reducing once at five gives. The editor re-simplifies locally so
that moving the tolerance costs no round trip, while this module stays
authoritative on what is finally written — and those two can only be proved to
agree if they start from the same points. So :func:`contour` is *defined* as the
smoothed trace reduced once at :data:`MINIMUM_TOLERANCE`, that is what travels to
a client, and :func:`polygon_at` takes it rather than a raw trace.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Final

from visionset.kernel.domain import (
    DEFAULT_TOLERANCE,
    MINIMUM_TOLERANCE,
    BboxGeometry,
    Geometry,
    GeometryType,
    Mask,
    PolygonGeometry,
)

Point = tuple[float, float]
Corner = tuple[int, int]

MINIMUM_FRAGMENT_SHARE: Final = 0.05
"""How big a piece has to be, against the biggest one, to survive the noise filter.

A segmenter's mask routinely carries specks a twentieth the size of the thing
that was clicked — antialiasing along an edge, a reflection, a scrap of the same
colour across the frame. None of them is ever the answer to a click, so they are
dropped before anything else looks at the mask. Relative to the largest piece
rather than to the frame, so it means the same thing on a mask covering
everything and a mask covering a corner.

Applied unconditionally, and that is a decision rather than a simplification
(#557): as a setting it did nothing on the ordinary single clean piece and could
only be got wrong on the unusual one.
"""

CLOSING_REACH: Final = 0.002
"""The largest gap closed, as a share of the piece's own lit area.

A share rather than a pixel count, so it means the same thing on a thing fifty
pixels across and a thing five hundred across. Two parts in a thousand puts the
reach at about one pixel on an object fifty across, two on one a hundred across
and four on one two hundred across — the scale of the notches and bays a
segmenter leaves along an edge, and well under anything somebody would call a
feature of the shape.

Fixed rather than asked for (#557). It lives here rather than in the domain
because it is a number about *this* pipeline, the way
:data:`MINIMUM_FRAGMENT_SHARE` is.
"""

MAXIMUM_CLOSING_RADIUS: Final = 6
"""However large the piece, the reach stops here.

Two reasons that agree. A gap wider than a few pixels is a feature of the shape
rather than an artefact of tracing it, so a reach that keeps growing with the
object eventually closes a real bay somebody wanted; and the close costs a pass
per unit of radius, on the path somebody is waiting on after a click — an
unbounded reach worked out at 22 on a 4K frame, which is 44 passes to bridge
gaps that were never there.
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


def components(mask: Mask, *, at: Sequence[Point] = ()) -> list[Piece]:
    """Step 1 — the pieces of the mask worth turning into shapes.

    Everything below :data:`MINIMUM_FRAGMENT_SHARE` of the largest piece is
    dropped as noise, first and unconditionally. What survives is ordered with
    the piece the prompt points at (:func:`_pointed_at`) at the head and the rest
    biggest-first behind it, ties in reading order, so the answer is stable for a
    given mask.

    **That one ordering is the whole difference between the two geometries.** A
    polygon takes the head of the list, because a click asks about one object; a
    box takes the union of all of it, because a mask arriving in several pieces
    is nearly always one object seen around an occlusion. Neither branch needs a
    setting to say which it wants.

    An empty mask answers with no pieces, which is an ordinary answer and not an
    error — the click landed on sky.
    """
    found = runs(mask)
    if not found:
        return []
    labels = _components(found)
    size = _areas(found, labels)

    floor = max(size.values()) * MINIMUM_FRAGMENT_SHARE
    survived = {label for label, area in size.items() if area >= floor}
    kept = [(run, label) for run, label in zip(found, labels, strict=True) if label in survived]
    first = _pointed_at([run for run, _ in kept], [label for _, label in kept], size, at)
    rest = sorted(survived - {first}, key=lambda label: (-size[label], label))
    return [_cropped(label, found, labels) for label in (first, *rest)]


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


def closing_radius(mask: Mask) -> int:
    """How far to reach, for a piece of this size.

    :data:`CLOSING_REACH` names the largest *hole* to close, and a hole of area
    ``a`` needs a reach of about ``sqrt(a) / 2`` to be bridged — so the radius
    comes from the piece's own lit area rather than from a pixel count, and it
    means the same thing on a thing fifty pixels across and a thing five hundred
    across. Rounded down, so the smallest shapes get no closing at all rather
    than one that would swallow a feature, and capped at
    :data:`MAXIMUM_CLOSING_RADIUS` at the other end.
    """
    lit = sum(last - first + 1 for _, first, last in runs(mask))
    return min(int((lit * CLOSING_REACH) ** 0.5 / 2), MAXIMUM_CLOSING_RADIUS)


def filled(mask: Mask) -> Mask:
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

    Returns the mask unchanged — the same object — when the reach works out at
    nothing or the shape has no gap that narrow, which is the common case and
    saves rebuilding a grid to say so.
    """
    radius = closing_radius(mask)
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


def _set_bits(value: int) -> Iterator[int]:
    while value:
        low = value & -value
        yield low.bit_length() - 1
        value ^= low


def _turned(options: list[Corner], *, at: Corner, heading: tuple[int, int]) -> Corner:
    """Which way out of a corner that has more than one, left turn first.

    A corner with two ways out is where two lit pixels touch only diagonally. The
    left turn crosses onto the other pixel and keeps the 8-connected piece one
    ring; the right turn would close round the first pixel alone and cut the piece
    in two, which is not what :func:`components` said the piece was.
    """
    left = (heading[1], -heading[0])
    right = (-heading[1], heading[0])
    for wanted in (left, heading, right):
        for index, candidate in enumerate(options):
            if (candidate[0] - at[0], candidate[1] - at[1]) == wanted:
                return options.pop(index)
    raise AssertionError("a corner's ways out are its own edges")


def outline(mask: Mask) -> list[Point]:
    """The boundary of the piece this mask holds, along the pixels' edges.

    Vertices sit at pixel corners, so a lone lit pixel comes back as its unit
    square and the ring describes where the mask ends rather than a path through
    its outermost pixels. Clockwise, starting at the top-left corner of the
    topmost-leftmost lit pixel — a corner that has exactly one way in and one
    way out, which is what lets the walk stop on reaching it again.

    The edges come off the row bitsets: a pixel's top edge is on the ring where
    the row above is unlit at that column, and so on for the other three sides.
    So only boundary pixels are ever visited, and the walk is linear in the
    perimeter rather than in the area.

    The walk cannot leave the piece it starts in: every edge belongs to a lit
    pixel and two pixels sharing a corner are the same 8-connected piece — which
    is the piece :func:`components` already made the mask hold exactly one of.
    Holes have rings of their own and the walk never reaches them.
    """
    found = runs(mask)
    if not found:
        return []
    rows, _ = _bits(mask, pad=0)
    height = len(rows)
    edges: dict[Corner, list[Corner]] = {}

    def edge(start: Corner, end: Corner) -> None:
        edges.setdefault(start, []).append(end)

    for y, row in enumerate(rows):
        if not row:
            continue
        above = rows[y - 1] if y else 0
        below = rows[y + 1] if y + 1 < height else 0
        for x in _set_bits(row & ~above):
            edge((x, y), (x + 1, y))
        for x in _set_bits(row & ~(row >> 1)):
            edge((x + 1, y), (x + 1, y + 1))
        for x in _set_bits(row & ~below):
            edge((x + 1, y + 1), (x, y + 1))
        for x in _set_bits(row & ~(row << 1)):
            edge((x, y + 1), (x, y))

    start: Corner = (found[0][1], found[0][0])
    ring = [start]
    current, heading = start, (1, 0)
    while True:
        options = edges[current]
        following = (
            options.pop() if len(options) == 1 else _turned(options, at=current, heading=heading)
        )
        heading = (following[0] - current[0], following[1] - current[1])
        if following == start:
            break
        ring.append(following)
        current = following
    return [(float(x), float(y)) for x, y in ring]


def smoothed(ring: Sequence[Point]) -> list[Point]:
    """One pass of corner cutting over a closed ring.

    Every edge is replaced by the two points a quarter and three quarters of the
    way along it. On the unit-edge ring :func:`outline` produces, that turns a
    staircase into a straight or gently curved line while moving no corner by
    more than half a pixel — the cut is bounded by the edge length, and every
    edge is one pixel long. Run on a ring whose straight runs had already been
    merged into long edges it would round the real corners of a rectangle, which
    is why it comes before any reduction.

    Every produced point lies on an edge of the ring it was given, so the result
    never leaves the traced boundary and never crosses itself.
    """
    if len(ring) < 3:
        return list(ring)
    out: list[Point] = []
    for index, (px, py) in enumerate(ring):
        qx, qy = ring[(index + 1) % len(ring)]
        out.append((0.75 * px + 0.25 * qx, 0.75 * py + 0.25 * qy))
        out.append((0.25 * px + 0.75 * qx, 0.25 * py + 0.75 * qy))
    return out


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


def contour(mask: Mask) -> list[Point]:
    """Step 3 — the canonical boundary: traced, smoothed, reduced once at the floor.

    The reduction is part of the definition rather than an optimisation, and the
    module docstring says why: Douglas-Peucker is not nested, so a client that
    re-simplifies and a server that stays authoritative can only be proved to
    agree when both start here. At a quarter pixel it discards nothing the
    smoothed ring could express, and it turns the tens of thousands of points a
    large object's ring holds into the few thousand that describe its shape.
    """
    return simplified(smoothed(outline(mask)), tolerance=MINIMUM_TOLERANCE)


def _closed(kept: list[Point], *, tolerance: float) -> list[Point]:
    """Drop the one vertex Douglas-Peucker only kept because it was told to.

    The algorithm pins the first and last point of what it is given, and what it
    is given here is a *ring* cut open at an arbitrary corner. So the final vertex
    is pinned for a reason that stops being true the moment the ring closes, and
    it lands a fraction of a pixel from the first — a stray handle on an otherwise
    clean outline, most visible on the straight-edged shapes where it is least
    excusable: an axis-aligned rectangle came back as five points.

    Judged by the same tolerance as everything else rather than by exact
    equality: the artifact is a near-duplicate, not a duplicate, so testing
    ``kept[0] == kept[-1]`` never fires on the case that motivates it.

    Exactly one, and never a loop. Cutting the ring open pins exactly one vertex
    artificially, and that vertex is a near-duplicate of the first — a fraction of
    a pixel away, one edge-trace step after smoothing — so removing it barely moves
    the closing segment and cannot push a contour point past the tolerance. A
    second drop would be dropping a real corner the reduction chose to keep, and
    the contour behind it would then sit further out than the polygon promises.
    """
    if len(kept) > 3 and _distance_to_segment(kept[-1], kept[-2], kept[0]) <= tolerance:
        return kept[:-1]
    return kept


def polygon_at(
    points: Sequence[Point], *, tolerance: float = DEFAULT_TOLERANCE
) -> PolygonGeometry | None:
    """Step 4 — that contour within ``tolerance`` pixels, or ``None``.

    ``None`` covers a contour with nothing in it and one too thin to have three
    distinct corners: the domain requires three points, and a two-point "polygon"
    is a line somebody would have to fix by hand rather than a suggestion worth
    offering.

    Takes a contour rather than a mask, which is what lets the editor call the
    same step on the same input without another forward pass.
    """
    if len(points) < 3:
        return None
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


def _union_of(pieces: Sequence[Piece]) -> BboxGeometry | None:
    """One box over every piece, or ``None`` if none of them holds anything.

    The answer to a point prompt is *this object*, and a mask that arrives in
    several pieces is nearly always one object seen around an occlusion — a
    railing across an animal, a post in front of a car. Both of the alternatives
    are wrong in exactly that case: the largest piece alone cuts the object off
    at the occlusion, and a box per piece annotates one thing twice (#557).
    """
    boxes = [box for box in (_boxed(piece) for piece in pieces) if box is not None]
    if not boxes:
        return None
    left = min(box.x for box in boxes)
    top = min(box.y for box in boxes)
    right = max(box.x + box.width for box in boxes)
    bottom = max(box.y + box.height for box in boxes)
    return BboxGeometry(x=left, y=top, width=right - left, height=bottom - top)


def shapes_from(
    mask: Mask,
    *,
    allowed: Sequence[GeometryType],
    tolerance: float = DEFAULT_TOLERANCE,
    at: Sequence[Point] = (),
) -> list[Shaped]:
    """The whole pipeline: a mask and a class's geometries in, proposals out.

    The four steps in their fixed order, with the geometry branch after the
    first. A class that admits polygons gets the outline of the piece the prompt
    points at; one that admits only boxes gets a single box over every piece that
    survived the noise filter, measured off the mask's own extent rather than off
    a simplified outline's corners — which is what keeps the tolerance from
    quietly moving a box.

    **The branch is before the close, and the close is paid for once.** A close
    only ever adds pixels whose whole neighbourhood was already reachable, so it
    cannot push an edge outward and a box is the same box either way
    (``test_closing_never_moves_the_extent``). So a box skips it entirely, and a
    polygon runs it on the one piece it is about to trace — rather than on every
    piece that survived, which is work thrown away for all but one of them.

    **A list, though today it holds at most one.** The plural shape is kept
    because accepting part of a plural proposal is tracked work (#548) and
    because an empty list is how "nothing to propose" is already said.

    **Nothing is ever widened.** A class admitting neither kind gets an empty
    list: answering in a kind the caller did not ask for is how a suggestion
    arrives that the schema will refuse to store.
    """
    kind = target_kind(allowed)
    if kind is None:
        return []

    pieces = components(mask, at=at)
    if not pieces:
        return []

    if kind is GeometryType.BBOX:
        box = _union_of(pieces)
        return [] if box is None else [Shaped(geometry=box)]

    pointed = pieces[0]
    whole = Piece(x=pointed.x, y=pointed.y, mask=filled(pointed.mask))
    traced = _shifted(contour(whole.mask), piece=whole)
    polygon = polygon_at(traced, tolerance=tolerance)
    return [] if polygon is None else [Shaped(geometry=polygon, contour=tuple(traced))]
