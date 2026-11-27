# usage: from visionset.formats.dota import DotaExporter, DotaImporter
"""DOTA: ``x1 y1 x2 y2 x3 y3 x4 y4 category difficult`` per rotated box, in pixels.

The layout of the DOTA benchmark: ``<fold>/images/<picture>`` and
``<fold>/labelTxt/<picture stem>.txt``, one label file per picture (empty when it
holds nothing), with no class list — a row names its class by the category
token. Corners are in pixels, in order round the rectangle, written to nine
decimals and never clamped into the picture. No ``imagesource:`` or ``gsd:``
header is written.

**Rotated boxes only.** Every other geometry is dropped and the export report
says so; nothing is converted. ``difficult`` is ``1`` for a box carrying a
boolean attribute named ``difficult`` set to true and ``0`` otherwise. A row
cannot quote a category, so each run of whitespace in a class name is written as
one hyphen, DOTA's own spelling (``baseball diamond`` as ``baseball-diamond``),
and an import of the output names the class with the hyphen. Two written classes
that would share a category, or a name that is only whitespace, refuse the
export by name.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Final

from visionset.formats._layout import folds_of, write_image
from visionset.formats._obb import decimal, obb_of
from visionset.formats._targets import self_target
from visionset.formats.dota.reader import DIFFICULT, LABELS_DIRNAME, DotaImporter
from visionset.kernel.domain import (
    GeometryType,
    Manifest,
    ManifestAsset,
    Release,
    SplitAssignment,
    obb_corners,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

__all__ = [
    "DIFFICULT",
    "IMAGES_DIRNAME",
    "LABELS_DIRNAME",
    "DotaExporter",
    "DotaImporter",
    "category_tokens",
]

IMAGES_DIRNAME: Final = "images"

#: Nine decimals of a pixel keep any box a rectangle to within the reader's tolerance.
PRECISION: Final = 9

_WHITESPACE: Final = re.compile(r"\s+")


class DotaExporter:
    """Writes a release's rotated boxes as a DOTA dataset."""

    format_name = "dota"

    #: A row is four corners, a category and a difficulty: every other geometry,
    #: every other attribute, confidence and provenance are dropped.
    lossy = True

    supported_geometries = frozenset({GeometryType.OBB})

    degraded_geometries: frozenset[GeometryType] = frozenset()

    supported_modalities = frozenset({"image"})

    targets = self_target("dota", frozenset({GeometryType.OBB}))

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
        assignment: SplitAssignment | None,
    ) -> None:
        written = {
            annotation.label_class
            for asset in manifest.assets
            for annotation in asset.annotations
            if obb_of(annotation) is not None
        }
        tokens = category_tokens(one.name for one in manifest.classes if one.name in written)
        declared = {one.name for one in manifest.classes}
        folds = folds_of(manifest, assignment)
        for asset in manifest.assets:
            rows = list(_rows(asset, declared, tokens))
            fold = dest / folds[asset.asset_id]
            write_image(asset, fold / IMAGES_DIRNAME, content)
            target = (fold / LABELS_DIRNAME / asset.content_hash).with_suffix(".txt")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("".join(f"{row}\n" for row in rows), encoding="utf-8")


def category_tokens(names: Iterable[str]) -> dict[str, str]:
    """Each class name as DOTA's single-token category, each whitespace run a hyphen.

    Raises:
        ExportSourceUnreadable: a name is only whitespace, or two names would be
            written as the same category.
    """
    tokens: dict[str, str] = {}
    taken: dict[str, str] = {}
    for name in names:
        token = _WHITESPACE.sub("-", name.strip())
        if not token:
            raise ExportSourceUnreadable(
                f"class {name!r} is empty once its whitespace is removed, so it cannot be "
                "written as a DOTA category"
            )
        other = taken.setdefault(token, name)
        if other != name:
            raise ExportSourceUnreadable(
                f"classes {other!r} and {name!r} would both be written as DOTA category {token!r}"
            )
        tokens[name] = token
    return tokens


def _rows(asset: ManifestAsset, declared: set[str], tokens: Mapping[str, str]) -> Iterable[str]:
    for annotation in asset.annotations:
        name = annotation.label_class
        if name not in declared:
            raise ExportSourceUnreadable(
                f"asset {asset.asset_id} carries class {name!r}, "
                f"which the release's schema does not declare"
            )
        geometry = obb_of(annotation)
        if geometry is None:
            continue
        corners = " ".join(
            decimal(value, PRECISION) for corner in obb_corners(geometry) for value in corner
        )
        difficult = 1 if annotation.attributes.get(DIFFICULT) is True else 0
        yield f"{corners} {tokens[name]} {difficult}"
