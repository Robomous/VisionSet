# usage: from visionset.formats.lanes._core import lanes_of, order_left_to_right
"""The lane vocabulary and the pure geometry, ported from v1's ``lane_utils.py``.

Everything here is a function of a :class:`ManifestAsset` and its annotations —
no filesystem, no port, no plugin. The five exporters in :mod:`.` are thin: they
decide a layout and a serialization, and every judgement about *what a lane is*
happens once, here, so five formats cannot disagree about which lane is the ego
lane.

## The taxonomy is a convention on attribute names, not a domain type

A lane's style, colour and road position are :class:`Attribute` values on the
annotation, keyed by the names in :data:`STYLE`, :data:`COLOR` and
:data:`POSITION`. That is a **convention this package defines and documents**,
not something the kernel knows: `LabelClass` declares attributes freely, and a
project that wants BDD100K or OpenLane categories declares three ``select``
attributes with these names and these options. :func:`declare_lane_attributes`
hands back exactly those declarations, so a caller building a schema does not
have to transcribe the option lists and get one wrong.

The alternative — a `LaneAttributes` model in the domain — was rejected for the
reason `DatasetChange.operation` is a `str`: the taxonomy belongs to a family of
*formats*, and putting it in the kernel would make the domain know what a road
is. A project labelling railway tracks uses the same polyline geometry and none
of this vocabulary.

**A missing attribute is not an error and is never invented.** It resolves to
``"other"``, which is a value every one of these formats defines for itself, and
that is why the exporters do not raise over one. v1's BDD100K exporter raised
unless a caller passed ``require_attributes=False``; there is no per-call flag on
the ``Exporter`` port and there should not be one, because the caller who would
set it is the same caller who chose the format. What replaces it is the
``lossy`` declaration, which is answered once and honestly.

## Position falls back to the class name, and that is load-bearing

``_class_to_position`` is v1's, kept whole. A great many lane schemas *are* the
positions — a project whose classes are ``ego_left``/``ego_right``/``road_edge``
has said everything CULane needs and would find an extra ``position_role``
attribute redundant. So the class name is consulted when the attribute is absent,
and only names in :data:`POSITION_VALUES` count; anything else is ``"other"``.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Final

from visionset.kernel.domain import (
    Attribute,
    ManifestAnnotation,
    ManifestAsset,
    PolylineGeometry,
)
from visionset.kernel.errors import ExportSourceUnreadable

#: The attribute name carrying a lane's marking style.
STYLE: Final = "style"

#: The attribute name carrying a lane's paint colour.
COLOR: Final = "color"

#: The attribute name carrying a lane's role on the road.
#:
#: Named ``position_role`` rather than ``position`` because a lane's position is
#: also its geometry, and an attribute called ``position`` beside a list of points
#: reads as coordinates. v1's name, kept.
POSITION: Final = "position_role"

#: What :data:`STYLE` may say. v1's ``LANE_STYLE_VALUES``, unchanged.
STYLE_VALUES: Final[tuple[str, ...]] = (
    "continuous",
    "dashed",
    "double_continuous",
    "double_dashed",
    "botts_dots",
    "other",
)

#: What :data:`COLOR` may say. v1's ``LANE_COLOR_VALUES``, unchanged.
COLOR_VALUES: Final[tuple[str, ...]] = ("white", "yellow", "blue", "other")

#: What :data:`POSITION` may say. v1's ``LANE_POSITION_VALUES``, unchanged.
POSITION_VALUES: Final[tuple[str, ...]] = (
    "ego_left",
    "ego_right",
    "adjacent_left",
    "adjacent_right",
    "road_edge",
    "crosswalk",
    "other",
)

#: The value every unset lane attribute resolves to.
OTHER: Final = "other"

#: ``position_role`` → the CULane lane slot it occupies. v1's ``CULANE_SLOT_MAP``.
#:
#: CULane's segmentation masks encode exactly four lanes by pixel value, so a
#: position outside this map contributes no mask — it is not that the lane is
#: unimportant, it is that the format has four slots.
CULANE_SLOTS: Final[dict[str, int]] = {
    "ego_left": 1,
    "ego_right": 2,
    "adjacent_left": 3,
    "adjacent_right": 4,
}

#: ``(style, colour)`` → OpenLane 2D category integer. v1's map, unchanged.
#:
#: ``0`` is OpenLane's own "unknown", which is what an unmapped pair resolves to.
OPENLANE_CATEGORIES: Final[dict[tuple[str, str], int]] = {
    ("dashed", "white"): 1,
    ("continuous", "white"): 2,
    ("double_dashed", "white"): 3,
    ("double_continuous", "white"): 4,
    ("dashed", "yellow"): 7,
    ("continuous", "yellow"): 8,
    ("double_dashed", "yellow"): 9,
    ("double_continuous", "yellow"): 10,
    ("dashed", "blue"): 1,
    ("continuous", "blue"): 2,
    ("botts_dots", "white"): 2,
    ("botts_dots", "yellow"): 8,
}

#: ``(style, colour)`` → ``(BDD100K category, BDD100K laneStyle)``. v1's map.
BDD100K_CATEGORIES: Final[dict[tuple[str, str], tuple[str, str]]] = {
    ("continuous", "white"): ("single white", "solid"),
    ("dashed", "white"): ("single white", "dashed"),
    ("double_continuous", "white"): ("double white", "solid"),
    ("double_dashed", "white"): ("double white", "dashed"),
    ("continuous", "yellow"): ("single yellow", "solid"),
    ("dashed", "yellow"): ("single yellow", "dashed"),
    ("double_continuous", "yellow"): ("double yellow", "solid"),
    ("double_dashed", "yellow"): ("double yellow", "dashed"),
    ("continuous", "blue"): ("single other", "solid"),
    ("dashed", "blue"): ("single other", "dashed"),
    ("double_continuous", "blue"): ("double other", "solid"),
    ("double_dashed", "blue"): ("double other", "dashed"),
    ("botts_dots", "white"): ("solid divider", "solid"),
    ("botts_dots", "yellow"): ("solid divider", "solid"),
    ("botts_dots", "blue"): ("solid divider", "solid"),
    ("botts_dots", "other"): ("solid divider", "solid"),
}

#: ``position_role`` → BDD100K's ``laneDirection``. v1's ``_DIRECTION_MAP``.
DIRECTIONS: Final[dict[str, str]] = {
    "ego_left": "parallel",
    "ego_right": "parallel",
    "adjacent_left": "parallel",
    "adjacent_right": "parallel",
    "road_edge": "parallel",
    "crosswalk": "vertical",
    "other": "parallel",
}


@dataclass(frozen=True, slots=True)
class Lane:
    """One polyline annotation, with its lane vocabulary already resolved.

    Exists so the five exporters share one answer to "what is this lane": the
    resolution rules — attribute first, class name second, ``other`` last — run
    once here rather than five times with a chance of drifting.
    """

    annotation: ManifestAnnotation
    points: tuple[tuple[float, float], ...]
    style: str
    color: str
    position: str

    @property
    def label_class(self) -> str:
        return self.annotation.label_class


def lanes_of(asset: ManifestAsset) -> list[Lane]:
    """Every polyline on this asset, left to right, vocabulary resolved.

    Non-polyline annotations are **not an error and not a loss reported here** —
    a lane format is asked for lanes, and #65's compatibility report is what tells
    a caller that the release also held boxes the format will not write. This is
    v1's ``[a for a in annotations if a.get("type") == "polyline"]``, which every
    one of its six exporters opened with.
    """
    lanes = [
        Lane(
            annotation=annotation,
            points=tuple(geometry.points),
            style=_attribute(annotation, STYLE, STYLE_VALUES),
            color=_attribute(annotation, COLOR, COLOR_VALUES),
            position=_position(annotation),
        )
        for annotation in asset.annotations
        if isinstance(geometry := annotation.geometry, PolylineGeometry)
    ]
    return order_left_to_right(lanes)


def order_left_to_right(lanes: Sequence[Lane]) -> list[Lane]:
    """Sorted by X at the bottom-most point. v1's ``assign_lane_order``.

    The bottom of the frame is the near field, where lanes are furthest apart and
    their left-to-right order is unambiguous; at the horizon they converge and any
    ordering there is noise. Every format that numbers its lanes — CULane's slots,
    BDD100K's ``lane_0``, OpenLane's ``track_id`` — numbers them in this order, so
    two formats exported from one release agree about which lane is which.

    A ``Lane`` always has at least two points, because ``PolylineGeometry`` refuses
    fewer; v1 needed an empty-list guard here and this does not.
    """
    return sorted(lanes, key=lambda lane: max(lane.points, key=lambda p: p[1])[0])


def is_y_monotonic(points: Sequence[tuple[float, float]]) -> bool:
    """Whether Y never decreases along the path. v1's, unchanged.

    Equal consecutive Y values pass: a horizontal segment is monotonic in the
    non-decreasing sense, and refusing it would reject an ordinary lane crossing
    the frame.
    """
    return all(points[i][1] <= points[i + 1][1] for i in range(len(points) - 1))


def interpolate_x(points: Sequence[tuple[float, float]], y: float) -> float | None:
    """X where the path crosses row ``y``, or ``None`` if it never does.

    v1's ``_interpolate_x``, and it assumes ascending Y — which is why the one
    caller, the TuSimple exporter, refuses a lane that is not Y-monotonic before
    calling it rather than letting it return a plausible wrong number.
    """
    if y < points[0][1] or y > points[-1][1]:
        return None
    for (x1, y1), (x2, y2) in zip(points, points[1:], strict=False):
        if y1 <= y <= y2:
            if y2 == y1:
                return x1
            return x1 + (y - y1) / (y2 - y1) * (x2 - x1)
    return None


def declare_lane_attributes() -> tuple[Attribute, ...]:
    """The three attributes a lane schema declares, ready to attach to a class.

    Offered so a caller — an SDK script, an agent building a schema, a test —
    does not transcribe three option lists and get one wrong. Every option is
    ``select``, and none is ``required``: a project may label lane *shape* without
    committing to a marking vocabulary, and the exporters resolve what is absent
    to ``other`` rather than refusing.
    """
    return (
        Attribute(name=STYLE, kind="select", options=STYLE_VALUES, default=OTHER),
        Attribute(name=COLOR, kind="select", options=COLOR_VALUES, default=OTHER),
        Attribute(name=POSITION, kind="select", options=POSITION_VALUES, default=OTHER),
    )


def refuse(asset: ManifestAsset, reason: str) -> ExportSourceUnreadable:
    """Name the asset in a refusal, the way the YOLO exporter names an unknown class.

    ``ExportSourceUnreadable`` is about bytes in its docstring and about *stored
    state a format cannot use* in practice — the YOLO exporter already raises it
    for a class the schema does not declare. It answers 409 and carries its
    message to the caller, which is what a lane that cannot be written needs; the
    alternative was a new error class for two call sites.
    """
    return ExportSourceUnreadable(f"asset {asset.asset_id} {reason}")


def _attribute(annotation: ManifestAnnotation, name: str, allowed: Iterable[str]) -> str:
    """One taxonomy value, or ``other``.

    A value outside the vocabulary resolves to ``other`` rather than travelling
    into a category map that would miss it anyway: the schema is free to declare
    ``style`` as a plain string, and a format asked to write ``"dashed-ish"`` has
    nowhere to put it.
    """
    value = annotation.attributes.get(name)
    return value if isinstance(value, str) and value in set(allowed) else OTHER


def _position(annotation: ManifestAnnotation) -> str:
    """The attribute, else the class name, else ``other``. v1's fallback, kept."""
    declared = _attribute(annotation, POSITION, POSITION_VALUES)
    if declared != OTHER:
        return declared
    name = annotation.label_class.lower()
    return name if name in set(POSITION_VALUES) - {OTHER} else OTHER
