# usage: from visionset.kernel.domain.rle import decode_counts, encode_counts
"""COCO-compatible run-length encoding for binary pixel masks, in pure Python.

A mask of ``height x width`` pixels is read in **column-major** (Fortran)
order: down the first column, then down the second, and so on, so pixel
``(x, y)`` is at index ``x * height + y``. That order is a sequence of
alternating runs, the first counting background (``0``) pixels, the next
foreground (``1``) pixels, then background again. The first run may be ``0``
when the mask starts with foreground; every later run is positive, and the runs
sum to exactly ``height * width``. Those are the **canonical runs**: one list
per mask, so equal masks have equal runs.

The **counts string** is COCO's compressed form of the runs, byte for byte the
one ``pycocotools`` writes: each run from the fourth on is stored as its
difference from the run two before it, and each value is written in
little-endian groups of five bits, one printable character per group
(``chr(48 + group)``), with ``0x20`` marking a continuation and ``0x10`` the sign
of the last group. :func:`encode_counts` of canonical runs is the canonical
string, so equal masks have equal strings too.

Decoding is bounded by the size the caller declares, never by the string:
:func:`decode_counts` refuses a string longer than
:data:`MAX_MASK_COUNTS_LENGTH`, a value with more five-bit groups than the
declared size can need, a negative run, and a running total past
``height * width`` the moment it passes it. Nothing proportional to the
decoded area is allocated, so a short string claiming a huge mask costs no
more than its own length.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Final

MAX_MASK_SIDE: Final = 32_768
"""The longest side, in pixels, a mask may declare."""

MAX_MASK_PIXELS: Final = 100_000_000
"""The most pixels, ``height * width``, a mask may declare."""

MAX_MASK_COUNTS_LENGTH: Final = 1024 * 1024
"""The longest counts string accepted, in characters."""

_FIRST_CHAR: Final = 48
_LAST_CHAR: Final = _FIRST_CHAR + 63


class MaskEncodingError(ValueError):
    """A mask's size or counts are malformed, out of bounds, or disagree with each other."""


def check_mask_size(height: int, width: int) -> int:
    """The pixel count of a ``height x width`` mask, or :class:`MaskEncodingError` why not."""
    for name, value in (("height", height), ("width", width)):
        if isinstance(value, bool) or not isinstance(value, int):
            raise MaskEncodingError(f"a mask {name} is an integer, not {type(value).__name__}")
        if value < 1:
            raise MaskEncodingError(f"a mask {name} must be at least 1 pixel, not {value}")
        if value > MAX_MASK_SIDE:
            raise MaskEncodingError(
                f"a mask {name} of {value} pixels exceeds the {MAX_MASK_SIDE}-pixel limit"
            )
    total = height * width
    if total > MAX_MASK_PIXELS:
        raise MaskEncodingError(
            f"a {height} by {width} mask is {total} pixels, over the {MAX_MASK_PIXELS}-pixel limit"
        )
    return total


def decode_counts(counts: str, height: int, width: int) -> tuple[int, ...]:
    """The canonical runs a counts string spells for a ``height x width`` mask.

    A string whose runs include a zero after the first is accepted, and the
    zero-length runs are merged away, so the result is always canonical.

    Raises:
        MaskEncodingError: the size is out of bounds, or the string is too
            long, empty, truncated, holds a character outside ``'0'..'o'``, a
            value too wide for the size, a negative run, or runs that do not sum
            to exactly ``height * width``.
    """
    total = check_mask_size(height, width)
    if not isinstance(counts, str):
        raise MaskEncodingError(f"mask counts are a string, not {type(counts).__name__}")
    if len(counts) > MAX_MASK_COUNTS_LENGTH:
        raise MaskEncodingError(
            f"mask counts of {len(counts)} characters exceed the "
            f"{MAX_MASK_COUNTS_LENGTH}-character limit"
        )
    # One sign bit beyond the total's own bits, five bits per group.
    max_groups = (total.bit_length() + 1) // 5 + 1
    raw: list[int] = []
    covered = 0
    position = 0
    length = len(counts)
    while position < length:
        value = 0
        groups = 0
        more = True
        while more:
            if position >= length:
                raise MaskEncodingError("mask counts end in the middle of a value")
            code = ord(counts[position])
            if not _FIRST_CHAR <= code <= _LAST_CHAR:
                raise MaskEncodingError(
                    f"mask counts hold {counts[position]!r} at {position}; "
                    f"only '0' through 'o' are COCO RLE characters"
                )
            group = code - _FIRST_CHAR
            value |= (group & 0x1F) << (5 * groups)
            more = bool(group & 0x20)
            position += 1
            groups += 1
            if groups > max_groups:
                raise MaskEncodingError(
                    f"a mask counts value runs past {max_groups} groups, more than a "
                    f"{height} by {width} mask can need"
                )
            if not more and group & 0x10:
                value |= -1 << (5 * groups)
        if len(raw) > 2:
            value += raw[-2]
        if value < 0:
            raise MaskEncodingError(f"mask run {len(raw)} is negative ({value})")
        covered += value
        if covered > total:
            raise MaskEncodingError(
                f"mask runs cover more than the {total} pixels of a {height} by {width} mask"
            )
        raw.append(value)
    if covered != total:
        raise MaskEncodingError(
            f"mask runs cover {covered} pixels and a {height} by {width} mask has {total}"
        )
    return _merged(raw)


def encode_counts(runs: Sequence[int]) -> str:
    """The COCO counts string for canonical ``runs``; see :func:`canonical_runs`."""
    out: list[str] = []
    for index, run in enumerate(runs):
        value = run - runs[index - 2] if index > 2 else run
        more = True
        while more:
            group = value & 0x1F
            value >>= 5
            more = value != -1 if group & 0x10 else value != 0
            if more:
                group |= 0x20
            out.append(chr(group + _FIRST_CHAR))
    return "".join(out)


def canonical_runs(runs: Iterable[int], height: int, width: int) -> tuple[int, ...]:
    """Uncompressed runs, as an import adapter reads them, checked and made canonical.

    The wire never carries this form; an adapter calls it and stores
    :func:`encode_counts` of the result.

    Raises:
        MaskEncodingError: the size is out of bounds, a run is not a
            non-negative integer, or the runs do not sum to ``height * width``.
    """
    total = check_mask_size(height, width)
    checked: list[int] = []
    covered = 0
    for index, run in enumerate(runs):
        if isinstance(run, bool) or not isinstance(run, int):
            raise MaskEncodingError(f"mask run {index} is an integer, not {type(run).__name__}")
        if run < 0:
            raise MaskEncodingError(f"mask run {index} is negative ({run})")
        covered += run
        if covered > total:
            raise MaskEncodingError(
                f"mask runs cover more than the {total} pixels of a {height} by {width} mask"
            )
        checked.append(run)
    if covered != total:
        raise MaskEncodingError(
            f"mask runs cover {covered} pixels and a {height} by {width} mask has {total}"
        )
    return _merged(checked)


def _merged(runs: Sequence[int]) -> tuple[int, ...]:
    merged: list[int] = []
    colour = 0
    for run in runs:
        if run:
            if merged and (len(merged) - 1) % 2 == colour:
                merged[-1] += run
            else:
                if not merged and colour == 1:
                    merged.append(0)
                merged.append(run)
        colour ^= 1
    return tuple(merged)


def runs_area(runs: Sequence[int]) -> int:
    """How many foreground pixels the runs hold."""
    return sum(runs[1::2])


def runs_bounds(runs: Sequence[int], height: int) -> tuple[int, int, int, int] | None:
    """``(x0, y0, x1, y1)`` of the foreground pixels, ends exclusive; ``None`` when empty."""
    x0 = y0 = None
    x1 = y1 = 0
    start = 0
    for index, run in enumerate(runs):
        end = start + run
        if index % 2 == 1:
            first_column, first_row = divmod(start, height)
            last_column, last_row = divmod(end - 1, height)
            if first_column != last_column:
                first_row, last_row = 0, height - 1
            x0 = first_column if x0 is None else min(x0, first_column)
            y0 = first_row if y0 is None else min(y0, first_row)
            x1 = max(x1, last_column + 1)
            y1 = max(y1, last_row + 1)
        start = end
    if x0 is None or y0 is None:
        return None
    return x0, y0, x1, y1


def bitmap_from_runs(runs: Sequence[int]) -> bytearray:
    """One byte per pixel in column-major order, ``1`` for foreground and ``0`` for background."""
    bitmap = bytearray(sum(runs))
    start = 0
    for index, run in enumerate(runs):
        if index % 2 == 1:
            bitmap[start : start + run] = b"\x01" * run
        start += run
    return bitmap


def runs_from_bitmap(bitmap: bytes | bytearray) -> tuple[int, ...]:
    """The canonical runs of a column-major bitmap whose foreground bytes are nonzero."""
    flags = bytes(bitmap).translate(_AS_FLAGS)
    runs: list[int] = []
    start = 0
    looking_for = b"\x01"
    length = len(flags)
    while start < length:
        end = flags.find(looking_for, start)
        if end == -1:
            end = length
        runs.append(end - start)
        start = end
        looking_for = b"\x00" if looking_for == b"\x01" else b"\x01"
    return _merged(runs) if runs else (0,)


_AS_FLAGS: Final = bytes([0] + [1] * 255)
