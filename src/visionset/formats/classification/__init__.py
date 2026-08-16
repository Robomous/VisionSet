# usage: from visionset.formats.classification import ClassificationExporter
"""Image classification: the pictures, and one CSV row per (image, tag).

The first installed format that writes a classification tag at all. Every other
plugin here has an explicit branch that drops one — a detection format has
nowhere to put a label with no location, and a lane format has fields for a lane
— so the rule that a multi-tagged image is exported once per tag had nothing to
attach to until this existed.

**One row per ``(image, tag)``, and the image is written once.** The obvious
alternative is a folder-per-class tree, which is what most single-label tooling
reads, and it cannot express this at all: an image tagged ``rain`` and ``night``
would have to be copied into two directories, doubling the bytes and making one
picture look like two examples. It would also disagree with the pre-export
compatibility report, which counts *annotations* rather than images.

**The vocabulary is the frozen schema's, not the data's.** ``classes.txt`` names
every class the release declares that can carry a tag, in authored order,
including ones nothing was labelled with. Deriving it from the annotations
present is the defect the YOLO exporter's class index was rewritten to avoid:
the list silently changes between two releases of one project, and a model
trained against the first is evaluated against a different label space.

**An asset with no tags gets its bytes and no row.** There is no per-image file
here to leave empty, unlike YOLO, so absence from ``labels.csv`` is the only
spelling available and it is the honest one.

``lossy = True``: a row is a path and a class name, so attributes, confidence,
provenance and annotation ids are dropped from every export whatever a release
holds. ``supported_geometries`` is ``{classification_tag}`` and
``degraded_geometries`` is **empty** — a box is not reduced to an image-level
tag, because three boxes of one class on one image would emit three identical
rows, and a report that counted them would be truthful about a file that is not.
Boxes, polygons and polylines are dropped, and the report names them by class
with a count before anything is written.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Final

from visionset.formats._layout import IMAGES_DIRNAME, folds_of, write_image
from visionset.kernel.domain import (
    ClassificationGeometry,
    GeometryType,
    Manifest,
    Release,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

#: The label file, at the root of the export.
#:
#: One file rather than one per fold: a consumer that wants a single split
#: filters on a column, where three files make the whole-dataset read the awkward
#: case. The fold is in the path too, so neither reading needs the other.
LABELS_FILENAME: Final = "labels.csv"

#: The label space, one name per line, in the release's authored schema order.
CLASSES_FILENAME: Final = "classes.txt"

#: The columns, and the order is the contract.
#:
#: ``image`` is relative to the export root so the directory can be moved to a
#: training machine and still resolve. ``fold`` is derivable from that path and
#: is written anyway, because parsing a path to learn which split a row is in is
#: the kind of thing every consumer would reimplement slightly differently.
HEADER: Final = ("image", "fold", "class")


class ClassificationExporter:
    """Writes a release as a multi-label image-classification dataset."""

    format_name = "classification"

    #: A row is a path and a class name. Attributes, confidence, provenance and
    #: the annotation's own id have nowhere to go, so consent is always asked.
    lossy = True

    #: Tags, and they arrive intact.
    supported_geometries = frozenset({GeometryType.CLASSIFICATION_TAG})

    #: Nothing is reduced. A box has a location this format cannot record, and
    #: turning it into an image-level tag would invent an annotation rather than
    #: reduce one — so geometry that is not a tag is dropped, and the report says
    #: so by class before anything is written.
    degraded_geometries: frozenset[GeometryType] = frozenset()

    #: A classification dataset is a directory of pictures.
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        declared = {one.name for one in manifest.classes}
        vocabulary = [
            one.name
            for one in manifest.classes
            if GeometryType.CLASSIFICATION_TAG in one.geometries
        ]
        folds = folds_of(release, manifest)

        rows: list[tuple[str, str, str]] = []
        for asset in manifest.assets:
            fold = folds[asset.asset_id]
            name = write_image(asset, dest / IMAGES_DIRNAME / fold, content)
            image = f"{IMAGES_DIRNAME}/{fold}/{name}"
            for annotation in asset.annotations:
                if annotation.label_class not in declared:
                    # Cannot happen — `SchemaChangeWouldOrphan` refuses to remove
                    # a class annotations depend on — but a row naming a class
                    # outside `classes.txt` would be a silent lie in a file read
                    # as ground truth.
                    raise ExportSourceUnreadable(
                        f"asset {asset.asset_id} carries class {annotation.label_class!r}, "
                        f"which the release's schema does not declare"
                    )
                if isinstance(annotation.geometry, ClassificationGeometry):
                    rows.append((image, fold, annotation.label_class))

        _write_labels(dest / LABELS_FILENAME, rows)
        dest.joinpath(CLASSES_FILENAME).write_text(
            "".join(f"{name}\n" for name in vocabulary), encoding="utf-8"
        )


def _write_labels(target: Path, rows: list[tuple[str, str, str]]) -> None:
    """The label file, written through ``csv`` rather than joined by hand.

    A class name is normalized but not otherwise restricted, so one holding a
    comma or a quote shifts every later column of a hand-built row — and the file
    still parses, which makes it the quiet kind of corruption. ``lineterminator``
    is pinned to ``\\n`` so the bytes do not depend on the platform the export ran
    on; the module's default is CRLF.
    """
    with target.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(HEADER)
        writer.writerows(rows)
