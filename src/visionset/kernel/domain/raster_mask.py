# usage: from visionset.kernel.domain import rasterize_polygon, split_class_map, trace_mask
"""Operations on :class:`~visionset.kernel.domain.geometry.MaskGeometry`, in pure Python.

A mask is decoded here to a **bitmap**: one byte per pixel in column-major
order, ``1`` foreground and ``0`` background, the layout the RLE runs already
count in. Every operation is exact on pixels except where its docstring says
what it loses.

**Polygon to mask** (:func:`rasterize_polygon`, :func:`rasterize_rings`) lights
a pixel when its centre ``(x + 0.5, y + 0.5)`` is inside under the even-odd
rule; a centre exactly on a horizontal edge is inside below it, one on a
vertical edge inside to its right. Everything finer than a pixel is lost: a
sliver between two centres lights nothing, and a polygon wholly off the frame
gives an empty mask.

**Mask to polygons** (:func:`trace_mask`) follows the pixel edges, so the rings
it returns have integer vertices on pixel corners and rasterize back to exactly
the mask. Foreground is 4-connected: two pixels touching only at a corner are
two regions. A :class:`~visionset.kernel.domain.geometry.PolygonGeometry` has no
holes, so a caller storing each region's ``outer`` ring as a polygon loses the
``holes`` — :class:`TracedRegion` returns them so the loss can be counted.

**Class-id maps** (:func:`split_class_map`, :func:`compose_class_map`) are
row-major sequences of integers, ``values[y * width + x]``, the order an image
library reads a palette or grey-level map in. A map becomes one mask per class
present, and the indexes a caller names as background or ignore become no mask.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass
from itertools import groupby
from math import ceil, isfinite

from visionset.kernel.domain.geometry import MaskGeometry, PolygonGeometry, mask_runs
from visionset.kernel.domain.rle import (
    MaskEncodingError,
    bitmap_from_runs,
    check_mask_size,
    encode_counts,
    runs_from_bitmap,
)
from visionset.kernel.domain.segmentation import Mask

Point = tuple[float, float]


def mask_bitmap(geometry: MaskGeometry) -> bytearray:
    """The mask as a column-major bitmap, ``bitmap[x * height + y]``."""
    return bitmap_from_runs(mask_runs(geometry))


def mask_from_bitmap(bitmap: bytes | bytearray, *, height: int, width: int) -> MaskGeometry:
    """The mask a column-major bitmap draws; any nonzero byte is foreground.

    Raises:
        MaskEncodingError: the size is out of bounds or the bitmap's length is not
            ``height * width``.
    """
    total = check_mask_size(height, width)
    if len(bitmap) != total:
        raise MaskEncodingError(
            f"a {height} by {width} bitmap has {total} pixels, not {len(bitmap)}"
        )
    return MaskGeometry(size=(height, width), counts=encode_counts(runs_from_bitmap(bitmap)))


def mask_from_rows(rows: Mask) -> MaskGeometry:
    """The mask a row-major grid draws, ``rows[y][x]`` truthy for foreground.

    A segmenter's answer is this shape; every row must be as long as the first.
    """
    height = len(rows)
    width = len(rows[0]) if height else 0
    check_mask_size(height, width)
    if any(len(row) != width for row in rows):
        raise MaskEncodingError("every row of a mask grid must be as long as the first")
    row_major = b"".join(bytes(1 if value else 0 for value in row) for row in rows)
    return mask_from_bitmap(_transposed(row_major, height, width), height=height, width=width)


def mask_rows(geometry: MaskGeometry) -> list[bytes]:
    """The mask as row-major rows of ``0`` and ``1`` bytes, ``rows[y][x]``."""
    height, _ = geometry.size
    bitmap = bytes(mask_bitmap(geometry))
    return [bitmap[y::height] for y in range(height)]


def _transposed(row_major: bytes | bytearray, height: int, width: int) -> bytes:
    return b"".join(bytes(row_major[x::width]) for x in range(width))


def rasterize_rings(rings: Sequence[Sequence[Point]], *, height: int, width: int) -> MaskGeometry:
    """The pixels whose centres fall inside ``rings`` under the even-odd rule.

    Each ring is closed implicitly, the way a polygon's is; a ring inside another
    is a hole. See the module docstring for what the pixel-centre rule loses.

    Raises:
        MaskEncodingError: the size is out of bounds.
        ValueError: a vertex is not finite.
    """
    check_mask_size(height, width)
    crossings: list[list[float]] = [[] for _ in range(height)]
    for ring in rings:
        if not all(isfinite(value) for point in ring for value in point):
            raise ValueError("a ring to rasterize must have finite vertices")
        for (x0, y0), (x1, y1) in zip(ring, [*ring[1:], *ring[:1]], strict=True):
            if y0 == y1:
                continue
            low, high = min(y0, y1), max(y0, y1)
            first = max(0, ceil(low - 0.5))
            last = min(height, ceil(high - 0.5))
            for y in range(first, last):
                # Clamped off the frame on both sides, so an extreme slope cannot overflow.
                t = (y + 0.5 - y0) / (y1 - y0)
                crossing = x0 + t * (x1 - x0) if isfinite(x1 - x0) else x0 * (1 - t) + x1 * t
                crossings[y].append(min(max(crossing, -1.0), width + 1.0))
    row_major = bytearray(height * width)
    for y, xs in enumerate(crossings):
        xs.sort()
        for start, end in zip(xs[0::2], xs[1::2], strict=True):
            left = max(0, ceil(start - 0.5))
            right = min(width, ceil(end - 0.5))
            if right > left:
                row_major[y * width + left : y * width + right] = b"\x01" * (right - left)
    return mask_from_bitmap(_transposed(row_major, height, width), height=height, width=width)


def rasterize_polygon(polygon: PolygonGeometry, *, height: int, width: int) -> MaskGeometry:
    """The polygon as a ``height x width`` mask, lit at pixel centres; see the module docstring."""
    return rasterize_rings([polygon.points], height=height, width=width)


def mask_union(masks: Iterable[MaskGeometry], *, height: int, width: int) -> MaskGeometry:
    """The pixels any of ``masks`` holds, as one ``height x width`` mask. Exact.

    Unlike one :func:`rasterize_rings` call over several rings, where a ring inside
    another is a hole, a pixel two masks share stays foreground.

    Raises:
        MaskEncodingError: the size is out of bounds or a mask's size is not
            ``(height, width)``.
    """
    total = check_mask_size(height, width)
    union = 0
    for mask in masks:
        if mask.size != (height, width):
            raise MaskEncodingError(
                f"a {mask.size[0]} by {mask.size[1]} mask cannot join a {height} by {width} union"
            )
        union |= int.from_bytes(mask_bitmap(mask), "big")
    return mask_from_bitmap(union.to_bytes(total, "big"), height=height, width=width)


@dataclass(frozen=True, slots=True)
class TracedRegion:
    """One 4-connected foreground region: its outline and the outlines of its holes.

    Rings run along pixel edges with integer vertices, the outer clockwise on
    screen (y down) and each hole counter-clockwise.
    """

    outer: PolygonGeometry
    holes: tuple[PolygonGeometry, ...] = ()


_RIGHT = {(1, 0): (0, 1), (0, 1): (-1, 0), (-1, 0): (0, -1), (0, -1): (1, 0)}
_LEFT = {value: key for key, value in _RIGHT.items()}


def trace_mask(geometry: MaskGeometry) -> tuple[TracedRegion, ...]:
    """Every foreground region's outline and holes, in a deterministic order.

    The rings together rasterize back to exactly the mask under
    :func:`rasterize_rings`. Regions are ordered by their outline's first vertex,
    top to bottom then left to right. An empty mask has no regions. The cost is
    proportional to the foreground area.
    """
    height, width = geometry.size
    bitmap = mask_bitmap(geometry)

    def lit(x: int, y: int) -> bool:
        return 0 <= x < width and 0 <= y < height and bitmap[x * height + y] == 1

    outgoing: dict[tuple[int, int], list[tuple[int, int]]] = {}
    runs = mask_runs(geometry)
    start = 0
    for index, run in enumerate(runs):
        if index % 2 == 1:
            for pixel in range(start, start + run):
                x, y = divmod(pixel, height)
                # Foreground on the right of every edge, so outlines run clockwise.
                if not lit(x, y - 1):
                    outgoing.setdefault((x, y), []).append((1, 0))
                if not lit(x + 1, y):
                    outgoing.setdefault((x + 1, y), []).append((0, 1))
                if not lit(x, y + 1):
                    outgoing.setdefault((x + 1, y + 1), []).append((-1, 0))
                if not lit(x - 1, y):
                    outgoing.setdefault((x, y + 1), []).append((0, -1))
        start += run

    used: set[tuple[tuple[int, int], tuple[int, int]]] = set()
    rings: list[list[tuple[int, int]]] = []
    for vertex in sorted(outgoing, key=lambda v: (v[1], v[0])):
        for direction in outgoing[vertex]:
            if (vertex, direction) not in used:
                rings.append(_walk(vertex, direction, outgoing, used))

    outers = [ring for ring in rings if _area2(ring) > 0]
    holes: list[list[list[tuple[int, int]]]] = [[] for _ in outers]
    for ring in rings:
        if _area2(ring) > 0:
            continue
        (x0, y0), (x1, y1) = ring[0], ring[1]
        dx, dy = _unit(x1 - x0), _unit(y1 - y0)
        rx, ry = _RIGHT[(dx, dy)]
        probe = (x0 + dx / 2 + rx / 2, y0 + dy / 2 + ry / 2)
        enclosing = min(
            (i for i, outer in enumerate(outers) if _contains(outer, probe)),
            key=lambda i: _area2(outers[i]),
        )
        holes[enclosing].append(ring)
    return tuple(
        TracedRegion(
            outer=_polygon(outer),
            holes=tuple(_polygon(hole) for hole in inner),
        )
        for outer, inner in zip(outers, holes, strict=True)
    )


def _walk(
    start: tuple[int, int],
    direction: tuple[int, int],
    outgoing: dict[tuple[int, int], list[tuple[int, int]]],
    used: set[tuple[tuple[int, int], tuple[int, int]]],
) -> list[tuple[int, int]]:
    corners: list[tuple[int, int]] = []
    vertex, heading = start, direction
    previous: tuple[int, int] | None = None
    while True:
        used.add((vertex, heading))
        if heading != previous:
            corners.append(vertex)
        previous = heading
        vertex = (vertex[0] + heading[0], vertex[1] + heading[1])
        # At a corner-touching pinch the right turn keeps 4-connected regions apart.
        options = outgoing[vertex]
        heading = next(
            turn for turn in (_RIGHT[heading], heading, _LEFT[heading]) if turn in options
        )
        if (vertex, heading) == (start, direction):
            if heading == previous:
                corners.pop(0)
            return corners


def _unit(value: int) -> int:
    return (value > 0) - (value < 0)


def _area2(ring: Sequence[tuple[int, int]]) -> int:
    return sum(
        x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, [*ring[1:], ring[0]], strict=True)
    )


def _contains(ring: Sequence[tuple[int, int]], point: tuple[float, float]) -> bool:
    px, py = point
    inside = False
    for (x0, y0), (x1, y1) in zip(ring, [*ring[1:], ring[0]], strict=True):
        if (y0 > py) != (y1 > py) and px < x0 + (py - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


def _polygon(ring: Sequence[tuple[int, int]]) -> PolygonGeometry:
    return PolygonGeometry(points=[(float(x), float(y)) for x, y in ring])


def split_class_map(
    values: Sequence[int], *, height: int, width: int, ignore: Collection[int] = ()
) -> dict[int, MaskGeometry]:
    """One mask per class id present in a row-major class-id map, keyed and ordered by id.

    ``ignore`` names the indexes that are not classes — background, void,
    ignore — and produces no mask for them. A class's mask covers exactly the
    pixels holding its id, so the masks never overlap and, with the ignored
    pixels, cover the map.

    Raises:
        MaskEncodingError: the size is out of bounds or ``values`` does not hold
            ``height * width`` entries.
    """
    total = check_mask_size(height, width)
    if len(values) != total:
        raise MaskEncodingError(
            f"a {height} by {width} class map has {total} pixels, not {len(values)}"
        )
    spans: dict[int, list[tuple[int, int]]] = {}
    position = 0
    for x in range(width):
        for value, group in groupby(values[x::width]):
            length = sum(1 for _ in group)
            if value not in ignore:
                spans.setdefault(value, []).append((position, length))
            position += length
    masks: dict[int, MaskGeometry] = {}
    for class_id in sorted(spans):
        runs: list[int] = []
        cursor = 0
        for begin, length in spans[class_id]:
            if begin == cursor and runs:
                runs[-1] += length
            else:
                runs.extend((begin - cursor, length))
            cursor = begin + length
        if total > cursor:
            runs.append(total - cursor)
        masks[class_id] = MaskGeometry(size=(height, width), counts=encode_counts(runs))
    return masks


@dataclass(frozen=True, slots=True)
class ClassMapComposition:
    """A class-id map recomposed from masks, and what did not fit in one value per pixel.

    ``values`` is row-major. A pixel two or more classes claim keeps the lowest
    class id; ``overlapping_pixels`` counts those pixels and
    ``overlapping_classes`` names every class that lost or kept one.
    """

    values: list[int]
    overlapping_pixels: int
    overlapping_classes: frozenset[int]


def compose_class_map(
    masks: Iterable[tuple[int, MaskGeometry]], *, height: int, width: int, fill: int
) -> ClassMapComposition:
    """A row-major class-id map from ``(class_id, mask)`` pairs; unclaimed pixels hold ``fill``.

    Several masks of one class are a union and never overlap each other. The
    result does not depend on the order of ``masks``.

    Raises:
        MaskEncodingError: the size is out of bounds or a mask's size is not
            ``(height, width)``.
    """
    total = check_mask_size(height, width)
    owner: list[int | None] = [None] * total
    contested = bytearray(total)
    classes: set[int] = set()
    for class_id, mask in sorted(masks, key=lambda pair: pair[0]):
        if mask.size != (height, width):
            raise MaskEncodingError(
                f"a {mask.size[0]} by {mask.size[1]} mask cannot compose a {height} by {width} map"
            )
        start = 0
        for index, run in enumerate(mask_runs(mask)):
            if index % 2 == 1:
                for pixel in range(start, start + run):
                    current = owner[pixel]
                    if current is None:
                        owner[pixel] = class_id
                    elif current != class_id:
                        contested[pixel] = 1
                        classes.update((current, class_id))
            start += run
    column_major = [fill if value is None else value for value in owner]
    values = [column_major[x * height + y] for y in range(height) for x in range(width)]
    return ClassMapComposition(
        values=values,
        overlapping_pixels=sum(contested),
        overlapping_classes=frozenset(classes),
    )


def mask_mirrored(geometry: MaskGeometry) -> MaskGeometry:
    """The mask mirrored left to right: pixel ``(x, y)`` lands at ``(W - 1 - x, y)``. Exact."""
    height, width = geometry.size
    bitmap = mask_bitmap(geometry)
    flipped = b"".join(
        bytes(bitmap[x * height : (x + 1) * height]) for x in range(width - 1, -1, -1)
    )
    return mask_from_bitmap(flipped, height=height, width=width)


def mask_rotated_once(geometry: MaskGeometry) -> MaskGeometry:
    """One counter-clockwise quarter turn: pixel ``(x, y)`` lands at ``(y, W - 1 - x)``. Exact.

    The result is ``W`` high and ``H`` wide.
    """
    height, width = geometry.size
    bitmap = bytes(mask_bitmap(geometry))
    turned = b"".join(bitmap[y::height][::-1] for y in range(height))
    return mask_from_bitmap(turned, height=width, width=height)


def mask_resampled(geometry: MaskGeometry, *, height: int, width: int) -> MaskGeometry:
    """The mask at another size, each pixel taking the source pixel under its centre.

    Nearest-neighbour, and lossy whenever the size changes: a feature narrower
    than the step between sampled centres can vanish or thicken.
    """
    check_mask_size(height, width)
    source_height, source_width = geometry.size
    bitmap = bytes(mask_bitmap(geometry))
    rows = [min(source_height - 1, int((y + 0.5) * source_height / height)) for y in range(height)]
    columns = [min(source_width - 1, int((x + 0.5) * source_width / width)) for x in range(width)]
    resampled = b"".join(
        bytes(bitmap[column * source_height + row] for row in rows) for column in columns
    )
    return mask_from_bitmap(resampled, height=height, width=width)
