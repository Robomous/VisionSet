# usage: from visionset.formats.coco import CocoExporter
"""COCO instances: one JSON per split, boxes and polygon segmentation together.

The second exporter, and the one that makes the plugin architecture do something
with *n > 1*. It is also where v1's shape breaks down entirely rather than merely
being wrong in details.

**v1 has two COCO exporters and neither describes a dataset.**
``CocoDetectionExporter`` skips every annotation whose ``type`` is not ``bbox``;
``CocoSegmentationExporter`` skips every one that is not ``polygon``. A project
holding both — which is the ordinary case, and the reason a schema declares a
geometry per class — must pick one export and silently lose the other half. There
is **one** exporter here, and a box and a polygon land in the same
``instances_*.json`` as they should: COCO has always carried both, and ``bbox`` is
a required field on every annotation whether or not it also has a
``segmentation``.

**``area`` is the polygon's area, not its bounding box's.** v1 wrote ``bw * bh``
for a segmentation, which overstates a triangle by a factor of two and any
concave shape by more. That number is not decoration: ``pycocotools`` buckets
detections into small/medium/large by it, so every evaluation run against such a
file reports the wrong breakdown and nothing says so. Here a polygon's area is the
shoelace formula and a box's is its width times its height.

Three faults are inherited from v1's shared base class and fixed the same way the
YOLO exporter fixes them — categories from the frozen schema rather than from the
annotations present, a read failure that aborts rather than being swallowed, and
pixel dimensions that are required rather than defaulted to ``(1, 1)``. See
:mod:`visionset.formats.yolo` for what each of those costs when it is wrong.

**This format is not lossy, and that is the point of having it.**
``supported_geometries`` is ``{bbox, polygon}``, and everything COCO has no field
for — attributes, confidence, provenance, the annotation's own id — is carried in
a ``"visionset"`` object on each annotation. COCO is JSON and every reader
tolerates keys it does not know; one nested object cannot collide with a future
COCO field the way four top-level ones could. So a release of boxes and polygons
exports **clean**, with no consent required, and the compatibility report is what
refuses a release holding a classification tag — which COCO genuinely has nowhere
to put.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Final

from visionset import __version__
from visionset.formats._layout import (
    FOLDS,
    IMAGES_DIRNAME,
    dimensions_of,
    folds_of,
    write_image,
)
from visionset.formats._targets import self_target
from visionset.kernel.domain import (
    BboxGeometry,
    GeometryType,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PolygonGeometry,
    Release,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

#: Where the instance files go, relative to ``dest``.
#:
#: ``annotations/instances_<fold>.json``, which is COCO's own layout — the name
#: ``pycocotools`` examples and every tutorial assume, and what makes an export
#: usable without a README.
ANNOTATIONS_DIRNAME: Final = "annotations"

#: How many digits a coordinate keeps.
#:
#: Four, v1's, and enough: the domain stores pixel coordinates, so this is a ten
#: thousandth of a pixel. Rounded at all because a float repr like
#: ``11.399999999999999`` in a document somebody diffs is noise, not precision.
PRECISION: Final = 4

#: The single license entry, and it is honest rather than decorative.
#:
#: COCO's ``licenses`` block exists so an image can name its terms. VisionSet
#: records no licensing information about an asset anywhere — not on ingest, not
#: in the manifest — so inventing one would be a claim nobody made. One entry
#: saying so, referenced by every image, keeps the block well-formed and says
#: exactly what is known.
LICENSE_ID: Final = 1
LICENSE_NAME: Final = "unspecified"


class CocoExporter:
    """Writes a release as COCO instances JSON, one file per split."""

    format_name = "coco"

    #: Nothing the domain can represent is dropped: geometry is native, and
    #: everything COCO has no field for rides in a ``visionset`` object per
    #: annotation. A release of boxes and polygons therefore exports without
    #: consent, which is the contrast with ``yolo`` and the reason both exist.
    lossy = False

    #: The two geometries COCO instances describe. A classification tag has no
    #: location, and COCO has no place for a label that is about the whole image —
    #: that is a different task with a different file — so the compatibility
    #: report is what refuses a release holding one, by class and with a count.
    supported_geometries = frozenset({GeometryType.BBOX, GeometryType.POLYGON})

    #: Empty, and it is the interesting empty set of the four: COCO writes a
    #: polygon *as a polygon*, with the shoelace area rather than the box's, so it
    #: reduces nothing.
    degraded_geometries: frozenset[GeometryType] = frozenset()

    supported_modalities = frozenset({"image"})

    targets = self_target(format_name, supported_geometries)

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        categories = _categories(manifest)
        category_of = {declared["name"]: declared["id"] for declared in categories}
        folds = folds_of(release, manifest)

        documents: dict[str, dict[str, Any]] = {
            fold: {
                "info": _info(release, manifest),
                "licenses": [{"id": LICENSE_ID, "name": LICENSE_NAME, "url": ""}],
                "images": [],
                "annotations": [],
                "categories": categories,
            }
            for fold in FOLDS
            if fold in set(folds.values())
        }

        # Ids are 1-based, **per fold**, and assigned in manifest order — which is
        # canonical, sorted by content hash — so two exports of one release agree
        # on every number in every file. Per fold because `pycocotools` loads one
        # file at a time and each is its own dataset: ids continuing across folds
        # would leave `instances_val.json` starting at some arbitrary number,
        # which reads as a file with rows missing. A uuid would be more obviously
        # stable and is not allowed — COCO ids are integers, and `pycocotools`
        # indexes with them.
        image_ids = dict.fromkeys(documents, 0)
        annotation_ids = dict.fromkeys(documents, 0)
        for asset in manifest.assets:
            fold = folds[asset.asset_id]
            document = documents[fold]
            image_ids[fold] += 1
            image_id = image_ids[fold]
            name = write_image(asset, dest / IMAGES_DIRNAME / fold, content)
            width, height = dimensions_of(asset)
            document["images"].append(
                {
                    "id": image_id,
                    "file_name": name,
                    "width": width,
                    "height": height,
                    "license": LICENSE_ID,
                    # The asset this row came from, so a reader can get back to
                    # the workspace. COCO has no field for it; see the class
                    # docstring for why one nested object rather than four keys.
                    "visionset": {
                        "asset_id": str(asset.asset_id),
                        "content_hash": asset.content_hash,
                    },
                }
            )
            for annotation in asset.annotations:
                row = _annotation(annotation, category_of, asset)
                if row is None:
                    continue
                annotation_ids[fold] += 1
                document["annotations"].append(
                    {"id": annotation_ids[fold], "image_id": image_id, **row}
                )

        target = dest / ANNOTATIONS_DIRNAME
        target.mkdir(parents=True, exist_ok=True)
        for fold, document in documents.items():
            _write_json(target / f"instances_{fold}.json", document)


def _categories(manifest: Manifest) -> list[dict[str, Any]]:
    """Every class the release's frozen schema declares, in its authored order.

    **Not the classes the annotations happen to use.** v1 built this list by
    sorting the names it found, so a class nobody had labelled yet vanished — and
    since ``category_id`` is the list position, the first box of a new class
    renumbered every other category. A model trained against one export and
    evaluated against the next is then wrong with nothing to report it.

    Ids are 1-based, which is COCO's convention and not ours: id ``0`` is
    conventionally background, and ``pycocotools`` treats a missing category id as
    an error rather than as a default.

    ``supercategory`` is the class name repeated, because VisionSet has no notion
    of a class hierarchy and the field is required by enough readers to be worth
    filling honestly rather than omitting.
    """
    return [
        {"id": index, "name": declared.name, "supercategory": declared.name}
        for index, declared in enumerate(manifest.classes, start=1)
    ]


def _info(release: Release, manifest: Manifest) -> dict[str, Any]:
    """The provenance block: which release this is, and what it was cut against.

    Everything here comes off the release or the manifest, so two exports of one
    release produce byte-identical documents. **Nothing reads the clock** —
    ``date_created`` is the release's own publication moment, not this run's,
    which is what makes that true and is also the more useful answer.
    """
    return {
        "description": f"VisionSet release {release.tag}",
        "version": release.tag,
        "year": release.created_at.year,
        "contributor": f"VisionSet {__version__}",
        "date_created": release.created_at.isoformat(),
        "url": "",
        # The three numbers that identify what this file was cut from. The
        # manifest hash is the important one: it names the exact frozen document,
        # so an export can be traced back to a release that can be re-verified.
        "visionset": {
            "release_id": str(release.id),
            "manifest_hash": release.manifest_hash,
            "manifest_version": manifest.manifest_version,
            "schema_version": manifest.schema_version,
        },
    }


def _annotation(
    annotation: ManifestAnnotation,
    category_of: dict[str, int],
    asset: ManifestAsset,
) -> dict[str, Any] | None:
    """One COCO annotation row, or ``None`` if this label has no place in one."""
    category_id = category_of.get(annotation.label_class)
    # Publication rejects new inconsistent manifests, but archived or externally
    # supplied manifests can still be malformed. An invented category id would
    # silently mislabel a file a trainer reads as ground truth.
    if category_id is None:
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} carries class {annotation.label_class!r}, "
            f"which the release's schema does not declare"
        )

    geometry = annotation.geometry
    if isinstance(geometry, BboxGeometry):
        box = _rounded((geometry.x, geometry.y, geometry.width, geometry.height))
        # **An empty `segmentation`, deliberately.** COCO allows one, and the
        # alternative — writing the box's own rectangle — would claim the object
        # fills its bounding box, which a mask consumer would take literally. A
        # box says where something is, not what shape it is.
        segmentation: list[list[float]] = []
        area = round(geometry.width * geometry.height, PRECISION)
    elif isinstance(geometry, PolygonGeometry):
        xs = [x for x, _ in geometry.points]
        ys = [y for _, y in geometry.points]
        box = _rounded((min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)))
        segmentation = [[round(value, PRECISION) for point in geometry.points for value in point]]
        area = round(_shoelace(geometry.points), PRECISION)
    else:
        return None

    return {
        "category_id": category_id,
        "bbox": list(box),
        "area": area,
        "segmentation": segmentation,
        # Zero always: `iscrowd=1` means an RLE-encoded region covering many
        # instances, which the domain cannot represent — a polygon here is one
        # object, and saying otherwise would change how every evaluation treats
        # it.
        "iscrowd": 0,
        "visionset": {
            "annotation_id": str(annotation.id),
            "schema_version": annotation.schema_version,
            "provenance": annotation.provenance,
            "model_ref": annotation.model_ref,
            "confidence": annotation.confidence,
            "attributes": annotation.attributes,
        },
    }


def _shoelace(points: Sequence[tuple[float, float]]) -> float:
    """The polygon's own area, by the shoelace formula.

    Absolute, so winding order does not matter — the domain does not constrain
    it, and a clockwise ring is not a negative object. This is the number
    ``pycocotools`` buckets detections by, which is why writing the bounding box's
    area here (v1 did) silently corrupts every small/medium/large breakdown a
    dataset is evaluated with.
    """
    total = 0.0
    for index, (x1, y1) in enumerate(points):
        x2, y2 = points[(index + 1) % len(points)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


def _rounded(values: tuple[float, ...]) -> tuple[float, ...]:
    return tuple(round(value, PRECISION) for value in values)


def _write_json(target: Path, document: dict[str, Any]) -> None:
    """One instances file.

    ``sort_keys`` is deliberately **off**: this document has a conventional key
    order that every example follows, and a reader opening
    ``instances_train.json`` should see ``info`` first, not ``annotations``. The
    determinism that matters comes from the ids and the ordering being derived
    from the manifest, which is canonical already.

    ``ensure_ascii`` is off so a class name in any script is readable rather than
    escaped; the file is written UTF-8, which JSON's own default encoding is.
    """
    target.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
