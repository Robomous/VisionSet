# usage: from visionset.formats.lanes import TuSimpleExporter, CuLaneExporter
"""The five lane formats: TuSimple, CurveLanes, BDD100K, CULane, OpenLane 2D.

The port of v1's ``lane_utils.py`` (442 LOC), which is the workload VisionSet's
predecessor actually ran. Every judgement about *what a lane is* — its style, its
colour, its role on the road, and above all its left-to-right order — lives once
in :mod:`._core`; these classes decide a directory layout and a serialization and
nothing else.

## Six exporter functions, five plugins

v1 has six exporter functions and its own HTTP endpoint zipped two of them
together: ``export_culane_txt`` and ``export_culane_mask`` are the annotation
file and the segmentation mask of **one** dataset format, and a caller asking for
CULane wants both. So :class:`CuLaneExporter` writes both, and the count of
plugins is five while the count of ported exporters is six.

## Every one of them is lossy, and only one is lossy about the geometry

Four write the vertices they were given. Only TuSimple does not, and the
difference is declared rather than described: TuSimple's file format *is* "the X
where the lane crosses each of these rows", so a lane goes in as vertices and
comes out as samples on a fixed grid. That is #158's third state — carried, but
reduced — so ``polyline`` is in ``degraded_geometries`` there and in
``supported_geometries`` in the other four.

``lossy`` is ``True`` for all five anyway, and the reason is the one YOLO has: a
lane file has fields for a lane, and the domain lets an annotation carry
arbitrary attributes, a confidence, a provenance and an id that none of these
formats has anywhere to put. The three lane attributes are mapped into each
format's own vocabulary where one exists (:data:`._core.BDD100K_CATEGORIES`,
:data:`._core.OPENLANE_CATEGORIES`) and dropped where none does.

**The loss worth naming out loud is OpenLane's per-point visibility.** OpenLane
2D marks each vertex visible or not, and VisionSet has nowhere to store that:
``PolylineGeometry.points`` is a list of coordinates, and per-vertex data would be
a change to the annotation model rather than to a format. So the ``visibility``
array is written all-visible. v1 had the same field and the same default; the
difference is that v1's dict-shaped annotations could in principle have carried
it, and this records that extending the domain for one format was declined. See
#223's port inventory.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any, Final

from visionset.formats._layout import (
    IMAGES_DIRNAME,
    dimensions_of,
    folds_of,
    write_image,
)
from visionset.formats.lanes._core import (
    BDD100K_CATEGORIES,
    CULANE_SLOTS,
    DIRECTIONS,
    OPENLANE_CATEGORIES,
    OTHER,
    Lane,
    interpolate_x,
    is_y_monotonic,
    lanes_of,
    refuse,
)
from visionset.kernel.domain import GeometryType, Manifest, ManifestAsset, Release
from visionset.kernel.ports import ContentReader

#: Where per-image label files go, beside ``images/``.
LABELS_DIRNAME: Final = "labels"

#: How many digits a coordinate keeps, matching the COCO exporter.
PRECISION: Final = 4

#: The row spacing TuSimple samples at, in pixels. The format's own constant.
TUSIMPLE_ROW_STEP: Final = 10

#: TuSimple's sentinel for "this lane does not cross this row".
TUSIMPLE_ABSENT: Final = -2

#: How wide a lane is painted into a CULane segmentation mask, in pixels.
#:
#: Sixteen, which is what CULane's own ``laneseg_label_w16`` directory is named
#: after — the number is part of the format, not a rendering preference.
CULANE_MASK_WIDTH: Final = 16

#: Where CULane's masks go. The upstream dataset's own directory name.
CULANE_MASK_DIRNAME: Final = f"laneseg_label_w{CULANE_MASK_WIDTH}"


class TuSimpleExporter:
    """TuSimple: one JSONL file per fold, lanes sampled on a fixed row grid."""

    format_name = "tusimple"

    lossy = True

    #: Nothing arrives intact; see ``degraded_geometries``.
    supported_geometries: frozenset[GeometryType] = frozenset()

    #: A lane is resampled onto ``h_samples``, so the vertices that went in are
    #: not the numbers that come out. Structural, not rounding — the other four
    #: formats write the vertices and declare ``polyline`` supported.
    degraded_geometries = frozenset({GeometryType.POLYLINE})

    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        rows: dict[str, list[str]] = {}
        for asset, fold, name in _walk(release, manifest, dest, content):
            entry = _tusimple_entry(asset, f"{IMAGES_DIRNAME}/{fold}/{name}")
            rows.setdefault(fold, []).append(json.dumps(entry, allow_nan=False))

        for fold, lines in rows.items():
            # `.json` holding JSON Lines is TuSimple's own convention, not a
            # mistake: `label_data_0313.json` in the upstream dataset is one JSON
            # object per line, and a reader written against TuSimple expects it.
            target = dest / f"label_data_{fold}.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")


class CurveLanesExporter:
    """CurveLanes: one ``.lines.json`` per image, vertices written as given."""

    format_name = "curvelanes"

    lossy = True
    supported_geometries = frozenset({GeometryType.POLYLINE})
    degraded_geometries: frozenset[GeometryType] = frozenset()
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        for asset, fold, _ in _walk(release, manifest, dest, content):
            lines = [
                [{"x": round(x, PRECISION), "y": round(y, PRECISION)} for x, y in lane.points]
                for lane in lanes_of(asset)
            ]
            _write_json(dest / LABELS_DIRNAME / fold, asset, ".lines.json", {"Lines": lines})


class Bdd100kLaneExporter:
    """BDD100K lane marking: one JSON per image, ``poly2d`` with open vertices."""

    format_name = "bdd100k-lane"

    lossy = True
    supported_geometries = frozenset({GeometryType.POLYLINE})
    degraded_geometries: frozenset[GeometryType] = frozenset()
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        for asset, fold, _ in _walk(release, manifest, dest, content):
            labels = [_bdd_label(index, lane) for index, lane in enumerate(lanes_of(asset))]
            _write_json(
                dest / LABELS_DIRNAME / fold,
                asset,
                ".json",
                {"name": asset.content_hash, "labels": labels},
            )


class CuLaneExporter:
    """CULane: ``.lines.txt`` per image, plus the four-slot segmentation mask."""

    format_name = "culane"

    lossy = True

    #: The ``.lines.txt`` carries every vertex, so the geometry arrives intact.
    #: The mask is an additional artifact rather than a substitute for it — which
    #: is exactly why both are written by one plugin.
    supported_geometries = frozenset({GeometryType.POLYLINE})
    degraded_geometries: frozenset[GeometryType] = frozenset()
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        for asset, fold, _ in _walk(release, manifest, dest, content):
            lanes = lanes_of(asset)
            target = dest / LABELS_DIRNAME / fold
            target.mkdir(parents=True, exist_ok=True)
            # Integers, because CULane's own files are integers. Sub-pixel
            # precision is lost and that is not `degraded_geometries`: the same
            # rounding is what YOLO does at four decimal places, and every vertex
            # is still present, in order, unconverted.
            text = "".join(
                " ".join(f"{round(x)} {round(y)}" for x, y in lane.points) + "\n" for lane in lanes
            )
            (target / f"{asset.content_hash}.lines.txt").write_text(text, encoding="utf-8")
            _write_culane_mask(asset, lanes, dest / CULANE_MASK_DIRNAME / fold)


class OpenLane2dExporter:
    """OpenLane 2D: one JSON per image, categories from style and colour."""

    format_name = "openlane-2d"

    lossy = True
    supported_geometries = frozenset({GeometryType.POLYLINE})
    degraded_geometries: frozenset[GeometryType] = frozenset()
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        for asset, fold, name in _walk(release, manifest, dest, content):
            _write_json(
                dest / LABELS_DIRNAME / fold,
                asset,
                ".json",
                {
                    # Null because VisionSet records no camera calibration
                    # anywhere. OpenLane's readers accept it, and inventing a
                    # matrix would be a claim nobody made — the COCO exporter's
                    # `licenses` argument, one format over.
                    "intrinsic": None,
                    "extrinsic": None,
                    "file_path": f"{IMAGES_DIRNAME}/{fold}/{name}",
                    "lane_lines": _openlane_lines(lanes_of(asset)),
                },
            )


def _walk(
    release: Release,
    manifest: Manifest,
    dest: Path,
    content: ContentReader,
) -> list[tuple[ManifestAsset, str, str]]:
    """Copy every image into its fold; hand back each asset, its fold and its filename.

    All five exporters do exactly this and then write labels; the images are
    copied here so a lane format cannot forget them and produce labels pointing at
    nothing. The **filename** comes back because two of the five write a path to
    the picture into the label document, and the suffix is sniffed from the bytes
    rather than taken from the asset's uri — so only ``write_image`` knows it.
    """
    folds = folds_of(release, manifest)
    walked = []
    for asset in manifest.assets:
        fold = folds[asset.asset_id]
        name = write_image(asset, dest / IMAGES_DIRNAME / fold, content)
        walked.append((asset, fold, name))
    return walked


def _write_json(into: Path, asset: ManifestAsset, suffix: str, document: object) -> None:
    into.mkdir(parents=True, exist_ok=True)
    (into / f"{asset.content_hash}{suffix}").write_text(
        json.dumps(document, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )


def _tusimple_entry(asset: ManifestAsset, raw_file: str) -> dict[str, Any]:
    """One TuSimple record: the rows sampled, and each lane's X at each row.

    ``h_samples`` is derived from the asset's own height rather than assumed to be
    720. v1 defaulted the height and scaled TuSimple's ``160..710 step 10`` grid
    proportionally, which is the right idea; here the height is *known*, because
    ``dimensions_of`` refuses an asset that has none rather than inventing one.
    """
    _, height = dimensions_of(asset)
    start = max(0, round(height * 160 / 720 / TUSIMPLE_ROW_STEP) * TUSIMPLE_ROW_STEP)
    h_samples = list(range(start, height, TUSIMPLE_ROW_STEP))

    lanes = []
    for lane in lanes_of(asset):
        if not is_y_monotonic(lane.points):
            # Refused rather than sorted: the order of the points is the value,
            # and a lane that doubles back has no single X per row to write. The
            # domain deliberately does not impose this rule — it is TuSimple's.
            raise refuse(
                asset,
                f"carries lane {lane.label_class!r} whose points are not sorted by "
                f"ascending Y, which TuSimple's row sampling requires",
            )
        sampled = [interpolate_x(lane.points, float(y)) for y in h_samples]
        lanes.append([TUSIMPLE_ABSENT if x is None else round(x, 2) for x in sampled])

    return {"raw_file": raw_file, "h_samples": h_samples, "lanes": lanes}


def _bdd_label(index: int, lane: Lane) -> dict[str, Any]:
    """One BDD100K label, with the category resolved from style and colour."""
    if lane.position == "crosswalk":
        category, style = "crosswalk zebra", "solid"
    else:
        category, style = BDD100K_CATEGORIES.get((lane.style, lane.color), (OTHER, OTHER))
    return {
        "id": f"lane_{index}",
        "category": category,
        "attributes": {
            "laneDirection": DIRECTIONS.get(lane.position, "parallel"),
            "laneStyle": style,
            "laneType": category,
        },
        "poly2d": [
            {
                "vertices": [[round(x, PRECISION), round(y, PRECISION)] for x, y in lane.points],
                "types": "L" * len(lane.points),
                # Never true: an open path is what a polyline is, and it is the
                # whole distinction from `PolygonGeometry`.
                "closed": False,
            }
        ],
    }


def _openlane_lines(lanes: list[Lane]) -> list[dict[str, Any]]:
    """OpenLane's ``lane_lines``, numbered in left-to-right order.

    Road edges take categories 13 and 14 — left and right — assigned by the order
    they appear, which is v1's rule and is why the ordering has to be settled
    before anything is numbered.
    """
    written = []
    edges = 0
    for index, lane in enumerate(lanes):
        if lane.position == "road_edge":
            edges += 1
            category = 13 if edges == 1 else 14
        elif lane.position == "crosswalk":
            category = 0
        else:
            category = OPENLANE_CATEGORIES.get((lane.style, lane.color), 0)
        written.append(
            {
                "category": category,
                # All visible: the domain has no per-vertex data, so this is what
                # is known rather than what was measured. See the module docstring.
                "visibility": [1] * len(lane.points),
                "uv": [[round(x, PRECISION), round(y, PRECISION)] for x, y in lane.points],
                "attribute": category,
                "track_id": f"lane_{index}",
            }
        )
    return written


def _write_culane_mask(asset: ManifestAsset, lanes: list[Lane], into: Path) -> None:
    """The four-slot segmentation mask, one grey level per CULane lane slot.

    Straight segments, where v1 densified with a scipy ``CubicSpline`` when scipy
    happened to be installed and fell back to straight segments when it was not.
    scipy is not a VisionSet dependency and adding one to smooth a mask is not a
    trade worth making — so there is one code path, which is also the one v1
    actually took on any machine without scipy.
    """
    from PIL import Image, ImageDraw

    width, height = dimensions_of(asset)
    taken: dict[int, Lane] = {}
    for lane in lanes:
        slot = CULANE_SLOTS.get(lane.position)
        if slot is None:
            continue
        if slot in taken:
            raise refuse(
                asset,
                f"has two lanes in the {lane.position!r} position, which CULane "
                f"encodes as a single mask slot ({slot}) and cannot hold twice",
            )
        taken[slot] = lane

    image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(image)
    for slot, lane in taken.items():
        draw.line(list(lane.points), fill=slot, width=CULANE_MASK_WIDTH)

    into.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    (into / f"{asset.content_hash}.png").write_bytes(buffer.getvalue())
