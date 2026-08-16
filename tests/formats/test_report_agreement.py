"""The export report against the bytes on disk, for every installed exporter.

A file of its own rather than three more tests in ``test_yolo.py``, because the
defect it guards is not an exporter doing the wrong thing — YOLO's own
``test_a_polygon_is_written_as_its_bounding_box`` passes either way, since writing
the box is what that exporter is *for*. The defect is that nothing compares the
report to the output, so the two can describe the same release differently and
every test agrees with the half it is looking at.

**Every count here is read back out of the written artifacts.** Nothing asserts
"the report says 1 and 1 is what we expect"; it asserts "the report says 1, and
counting the rows in the label files finds exactly the annotations it did not
claim". That is the only shape of test that catches this class of defect.

The dispatch table is the fifth criterion: a fourth exporter registering into the
``visionset.formats`` group either lands a counter here or is declared as one
that writes nothing, and ``test_every_installed_exporter_is_accounted_for``
fails until somebody chooses. A format cannot be added and quietly skipped.
"""

from __future__ import annotations

import csv
import json
import xml.etree.ElementTree as ElementTree
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from tests.formats.test_yolo import CLASSES, Fixture, _box

from visionset.formats.classification import LABELS_FILENAME as CLASSIFICATION_LABELS
from visionset.formats.coco import ANNOTATIONS_DIRNAME as COCO_ANNOTATIONS_DIRNAME
from visionset.formats.lanes import LABELS_DIRNAME as LANE_LABELS_DIRNAME
from visionset.formats.registry import exporters
from visionset.formats.voc import ANNOTATIONS_DIRNAME as VOC_ANNOTATIONS_DIRNAME
from visionset.formats.yolo import DATA_FILENAME, LABELS_DIRNAME
from visionset.kernel.domain import (
    Annotation,
    ClassExportStatus,
    ClassificationGeometry,
    ExportCompatibility,
    GeometryType,
    LabelClass,
    PolygonGeometry,
    PolylineGeometry,
)
from visionset.kernel.ports import Exporter

#: Formats that write no annotations at all, and are therefore outside the
#: report-versus-output comparison.
#:
#: Named rather than skipped by a heuristic. ``DummyExporter`` exists to prove
#: entry-point discovery works and writes nothing; it also declares every
#: geometry supported, so its report promises everything and its output holds
#: nothing. That is a contradiction the comparison below would catch, and it is
#: not a defect — it is what "no-op" means. An exporter joins this set only by
#: somebody deciding it should.
NON_WRITING = frozenset({"dummy"})


def _polygon(points: list[tuple[float, float]] | None = None) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="lane",
        schema_version=1,
        geometry=PolygonGeometry(points=points or [(8.0, 12.0), (24.0, 12.0), (8.0, 36.0)]),
        provenance="human",
    )


def _tag() -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="weather",
        schema_version=1,
        geometry=ClassificationGeometry(),
        provenance="human",
    )


#: The release every test here exports: three boxes, two polygons, one tag,
#: spread over three assets so ``assets`` counts differ from ``annotations``.
#:
#: The shape the report and the output are most likely to disagree over: three
#: annotations reported excluded against four rows on disk where two were
#: expected.
DRAWING: dict[int, list[Annotation]] = {
    0: [_box(x=8, y=6, width=20, height=22), _polygon()],
    1: [_box(x=2, y=2, width=10, height=10), _polygon([(30.0, 4.0), (44.0, 4.0), (44.0, 20.0)])],
    2: [_box(x=1, y=1, width=8, height=8), _tag()],
}


def _yolo_counts(root: Path) -> Counter[str]:
    """Every label row, by class name, resolved through ``data.yaml``'s own index.

    Through the index rather than by position, because reading the file the way
    ultralytics reads it is the point: a row's meaning is ``names[index]``, and a
    test that assumed the schema order would agree with a wrong export.
    """
    names: dict[int, str] = {}
    for line in (root / DATA_FILENAME).read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped[:1].isdigit() and ":" in stripped:
            index, name = stripped.split(":", 1)
            names[int(index)] = json.loads(name.strip())
    found: Counter[str] = Counter()
    for path in sorted((root / LABELS_DIRNAME).rglob("*.txt")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                found[names[int(line.split()[0])]] += 1
    return found


def _voc_counts(root: Path) -> Counter[str]:
    """Every ``<object>``, by the ``<name>`` a devkit consumer reads it under."""
    found: Counter[str] = Counter()
    for path in sorted((root / VOC_ANNOTATIONS_DIRNAME).rglob("*.xml")):
        for element in ElementTree.parse(path).getroot().findall("object"):
            name = element.findtext("name")
            assert name is not None
            found[name] += 1
    return found


def _coco_counts(root: Path) -> Counter[str]:
    """Every instance, by the category name its ``category_id`` points at."""
    found: Counter[str] = Counter()
    for path in sorted((root / COCO_ANNOTATIONS_DIRNAME).rglob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        names = {one["id"]: one["name"] for one in document["categories"]}
        for annotation in document["annotations"]:
            found[names[annotation["category_id"]]] += 1
    return found


def _classification_counts(root: Path) -> Counter[str]:
    """Every label row, by the class name in its own column.

    Read with ``csv`` rather than split on commas, for the reason the exporter
    writes with it: a class name may hold one.
    """
    with (root / CLASSIFICATION_LABELS).open(encoding="utf-8", newline="") as handle:
        return Counter(row["class"] for row in csv.DictReader(handle))


#: How to count what each format actually wrote, keyed by ``format_name``.
COUNTERS: dict[str, Callable[[Path], Counter[str]]] = {
    "yolo": _yolo_counts,
    "voc": _voc_counts,
    "coco": _coco_counts,
    "classification": _classification_counts,
}


def _installed() -> dict[str, Exporter]:
    return exporters()


def _export(
    fixture: Fixture, release_id: UUID, plugin: Exporter, dest: Path
) -> ExportCompatibility:
    result = fixture.releases.export(release_id, plugin, dest, allow_lossy=True)
    return result.compatibility


@pytest.fixture
def labelled(tmp_path: Path) -> Fixture:
    fixture = Fixture(tmp_path)
    fixture.label(DRAWING)
    return fixture


# --- the guard ----------------------------------------------------------------


def test_every_installed_exporter_is_accounted_for() -> None:
    """A fourth format cannot disagree with its own report by not being looked at.

    The one assertion here that is about this file rather than about the code: a
    new exporter either gets a counter and is compared against its own output, or
    is declared non-writing on purpose. Silence is not an option.
    """
    assert set(_installed()) == set(COUNTERS) | set(LANE_COUNTERS) | NON_WRITING


def test_a_non_writing_exporter_really_writes_nothing(tmp_path: Path, labelled: Fixture) -> None:
    """The exemption above, checked rather than trusted."""
    release_id = labelled.publish()
    for name in NON_WRITING:
        dest = tmp_path / f"out-{name}"
        _export(labelled, release_id, _installed()[name], dest)
        # The kernel's own report is the one file in there, and it is written
        # after the plugin runs.
        assert [path.name for path in dest.iterdir()] == ["visionset-export-report.json"]
    labelled.close()


@pytest.mark.parametrize("format_name", sorted(COUNTERS))
def test_the_report_agrees_with_what_the_format_wrote(
    tmp_path: Path, labelled: Fixture, format_name: str
) -> None:
    """Report versus artifact, per class, for every writing format.

    Three claims, each read off the bytes:

    - a **dropped** class contributes nothing to the output;
    - a **degraded** class contributes every one of its annotations, because it
      is converted rather than removed — this is exactly the row YOLO and VOC
      used to write while the report called it excluded;
    - a **supported** class contributes every one of its annotations too.
    """
    release_id = labelled.publish()
    dest = tmp_path / f"out-{format_name}"
    report = _export(labelled, release_id, _installed()[format_name], dest)
    written = COUNTERS[format_name](dest)
    labelled.close()

    for declared in report.classes:
        expected = 0 if declared.status is ClassExportStatus.DROPPED else declared.annotations
        assert written[declared.label_class] == expected, (
            f"{format_name} reports {declared.label_class!r} as {declared.status.value} "
            f"with {declared.annotations} annotation(s), and wrote "
            f"{written[declared.label_class]}"
        )
    # Nothing appeared under a name the report never mentioned.
    assert set(written) <= {one.label_class for one in report.classes}


@pytest.mark.parametrize("format_name", sorted(COUNTERS))
def test_excluded_annotations_is_exactly_what_is_missing_from_the_output(
    tmp_path: Path, labelled: Fixture, format_name: str
) -> None:
    """The count, checked rather than restated.

    The number a caller consents to losing is checked against the arithmetic of
    the artifact: everything the release held, minus everything on disk. A
    two-valued model answers 3 here where the subtraction gives 1.
    """
    release_id = labelled.publish()
    dest = tmp_path / f"out-{format_name}"
    report = _export(labelled, release_id, _installed()[format_name], dest)
    written = COUNTERS[format_name](dest)
    held = sum(one.annotations for one in report.classes)
    labelled.close()

    assert report.excluded_annotations == held - sum(written.values())


@pytest.mark.parametrize("format_name", sorted(COUNTERS))
def test_a_reason_says_what_actually_happens_to_that_class(
    tmp_path: Path, labelled: Fixture, format_name: str
) -> None:
    """A written class's reason must not deny being written."""
    release_id = labelled.publish()
    report = _export(labelled, release_id, _installed()[format_name], tmp_path / "out")
    labelled.close()

    for declared in report.classes:
        if declared.status is ClassExportStatus.SUPPORTED:
            assert declared.reason is None
            continue
        assert declared.reason is not None
        if declared.status is ClassExportStatus.DEGRADED:
            # It is written, so nothing here may say it cannot be.
            assert "cannot" not in declared.reason
            assert "lost" in declared.reason
        else:
            assert "drops it" in declared.reason


# --- the two formats the defect was found in ----------------------------------


def test_yolo_reports_the_polygon_it_writes_as_degraded_not_excluded(
    tmp_path: Path, labelled: Fixture
) -> None:
    """The reproduction, in the numbers a two-valued model disagrees about."""
    release_id = labelled.publish()
    dest = tmp_path / "out"
    report = _export(labelled, release_id, _installed()["yolo"], dest)
    written = _yolo_counts(dest)
    labelled.close()

    # Three boxes and two polygons reach the label files; only the tag does not.
    assert written == Counter({"sign": 3, "lane": 2})
    assert (report.excluded_annotations, report.degraded_annotations) == (1, 2)
    assert [one.label_class for one in report.excluded] == ["weather"]
    assert [one.label_class for one in report.degraded] == ["lane"]
    # Still not compatible, and still asking for consent: a polygon flattened to
    # a box has lost its shape. Only the accounting moved.
    assert not report.compatible


def test_voc_reports_the_polygon_it_writes_as_degraded_not_excluded(
    tmp_path: Path, labelled: Fixture
) -> None:
    release_id = labelled.publish()
    dest = tmp_path / "out"
    report = _export(labelled, release_id, _installed()["voc"], dest)
    written = _voc_counts(dest)
    labelled.close()

    assert written == Counter({"sign": 3, "lane": 2})
    assert (report.excluded_annotations, report.degraded_annotations) == (1, 2)
    assert not report.compatible


def test_coco_is_unchanged_because_it_reduces_nothing(tmp_path: Path, labelled: Fixture) -> None:
    """COCO writes a polygon as a polygon, so it degrades nothing."""
    release_id = labelled.publish()
    dest = tmp_path / "out"
    report = _export(labelled, release_id, _installed()["coco"], dest)
    written = _coco_counts(dest)
    labelled.close()

    assert written == Counter({"sign": 3, "lane": 2})
    assert (report.excluded_annotations, report.degraded_annotations) == (1, 0)
    assert report.degraded == ()
    assert [one.label_class for one in report.excluded] == ["weather"]


def test_classification_writes_the_tag_and_reports_everything_else_dropped(
    tmp_path: Path, labelled: Fixture
) -> None:
    """The mirror image of the three formats above.

    ``DRAWING`` holds three boxes, two polygons and one tag. Every other
    installed format writes the boxes and drops the tag; this one writes the tag
    and drops the rest, which is what makes the pair of assertions worth having
    in the same file.
    """
    release_id = labelled.publish()
    dest = tmp_path / "out"
    report = _export(labelled, release_id, _installed()["classification"], dest)
    written = _classification_counts(dest)
    labelled.close()

    assert written == Counter({"weather": 1})
    assert (report.excluded_annotations, report.degraded_annotations) == (5, 0)
    assert sorted(one.label_class for one in report.excluded) == ["lane", "sign"]
    assert not report.compatible


# --- the lane family ----------------------------------------------------------
#
# Five more installed exporters, and none of them can be counted the way the
# three above are. A YOLO row starts with a class index, a VOC `<object>` has a
# `<name>` and a COCO instance has a `category_id` — so "what did this format
# write, per class" is a question their artifacts answer. A lane file does not:
# TuSimple and CurveLanes and CULane record no class at all, and BDD100K and
# OpenLane record their *own* category derived from style and colour. That is a
# property of single-purpose formats, not an oversight.
#
# So they are compared at the granularity their output supports — every lane on
# disk against every lane the report did not call dropped — which keeps the
# guarantee (the report is checked against the bytes) without inventing a class
# attribution the files do not carry.


def _polyline(points: list[tuple[float, float]] | None = None) -> Annotation:
    """One lane. Y-ascending, because TuSimple refuses anything else."""
    return Annotation(
        asset_id=uuid4(),
        label_class="centerline",
        schema_version=1,
        geometry=PolylineGeometry(points=points or [(6.0, 4.0), (18.0, 22.0), (30.0, 44.0)]),
        provenance="human",
    )


#: The same shape as ``DRAWING``, plus three lanes. Kept separate rather than
#: folded in, because the three reproduction tests above assert exact counters
#: chosen to make a report disagree, and widening their release would rewrite the
#: reproduction they exist to preserve.
LANE_DRAWING: dict[int, list[Annotation]] = {
    0: [_box(x=8, y=6, width=20, height=22), _polyline()],
    1: [
        _polyline([(2.0, 2.0), (10.0, 20.0), (16.0, 46.0)]),
        _polyline([(40.0, 3.0), (48.0, 25.0), (56.0, 45.0)]),
    ],
    2: [_box(x=1, y=1, width=8, height=8), _tag()],
}

LANE_CLASSES = (*CLASSES, LabelClass(name="centerline", geometries=(GeometryType.POLYLINE,)))


def _tusimple_lanes(root: Path) -> int:
    total = 0
    for path in sorted(root.glob("label_data_*.json")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                total += len(json.loads(line)["lanes"])
    return total


def _curvelanes_lanes(root: Path) -> int:
    return sum(
        len(json.loads(path.read_text(encoding="utf-8"))["Lines"])
        for path in sorted((root / LANE_LABELS_DIRNAME).rglob("*.lines.json"))
    )


def _bdd100k_lanes(root: Path) -> int:
    return sum(
        len(json.loads(path.read_text(encoding="utf-8"))["labels"])
        for path in sorted((root / LANE_LABELS_DIRNAME).rglob("*.json"))
    )


def _culane_lanes(root: Path) -> int:
    return sum(
        len([line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()])
        for path in sorted((root / LANE_LABELS_DIRNAME).rglob("*.lines.txt"))
    )


def _openlane_lanes(root: Path) -> int:
    return sum(
        len(json.loads(path.read_text(encoding="utf-8"))["lane_lines"])
        for path in sorted((root / LANE_LABELS_DIRNAME).rglob("*.json"))
    )


#: How to count the lanes each lane format wrote, keyed by ``format_name``.
LANE_COUNTERS: dict[str, Callable[[Path], int]] = {
    "tusimple": _tusimple_lanes,
    "curvelanes": _curvelanes_lanes,
    "bdd100k-lane": _bdd100k_lanes,
    "culane": _culane_lanes,
    "openlane-2d": _openlane_lanes,
}


@pytest.fixture
def laned(tmp_path: Path) -> Fixture:
    fixture = Fixture(tmp_path, classes=LANE_CLASSES)
    fixture.label(LANE_DRAWING)
    return fixture


@pytest.mark.parametrize("format_name", sorted(LANE_COUNTERS))
def test_a_lane_format_writes_exactly_the_lanes_it_did_not_call_dropped(
    tmp_path: Path, laned: Fixture, format_name: str
) -> None:
    """Report versus artifact for the class-blind formats.

    The three lanes in ``LANE_DRAWING`` are the only thing any of these can hold,
    so this is also the assertion that a lane format does **not** quietly write a
    box or a tag it declared dropped.
    """
    release_id = laned.publish()
    dest = tmp_path / f"out-{format_name}"
    report = _export(laned, release_id, _installed()[format_name], dest)
    written = LANE_COUNTERS[format_name](dest)
    laned.close()

    kept = sum(
        one.annotations for one in report.classes if one.status is not ClassExportStatus.DROPPED
    )
    assert written == kept == 3
    assert report.excluded_annotations == 3  # two boxes and a tag
    assert sorted(one.label_class for one in report.excluded) == ["sign", "weather"]


def test_tusimple_calls_the_lane_it_resamples_degraded_and_the_others_do_not(
    tmp_path: Path, laned: Fixture
) -> None:
    """The one geometry declaration that differs across the five, asserted as such.

    TuSimple writes X-at-each-row and not the vertices it was given, so its lanes
    are ``DEGRADED``; the other four write the vertices, so theirs are
    ``SUPPORTED``. Every one of the five is still ``lossy`` — which is a different
    question, and the reason both fields exist.
    """
    release_id = laned.publish()
    reports = {
        name: _export(laned, release_id, _installed()[name], tmp_path / f"out-{name}")
        for name in sorted(LANE_COUNTERS)
    }
    laned.close()

    for name, report in reports.items():
        (lane,) = [one for one in report.classes if one.label_class == "centerline"]
        expected = ClassExportStatus.DEGRADED if name == "tusimple" else ClassExportStatus.SUPPORTED
        assert lane.status is expected, f"{name} declares centerline {lane.status.value}"
        assert not report.compatible  # a box and a tag are still dropped
        assert _installed()[name].lossy


@pytest.mark.parametrize("format_name", ["yolo", "coco", "voc"])
def test_the_three_general_formats_declare_polyline_truthfully(
    tmp_path: Path, laned: Fixture, format_name: str
) -> None:
    """What YOLO, COCO and VOC can genuinely do with an open path.

    The answer, verified against the bytes rather than assumed: **nothing**, and
    all three already said so. YOLO and VOC are box formats and reduce a *polygon*
    to its bounds, which is defensible because a polygon encloses an area a box
    can approximate; an open path encloses nothing, so a box drawn round it is an
    invention rather than a reduction. COCO's ``segmentation`` is a closed ring
    and it has no open-path primitive at all.

    So ``polyline`` is in neither ``supported_geometries`` nor
    ``degraded_geometries`` for the three, the report calls the class dropped, and
    the label files contain no trace of it. Nothing changed in those exporters —
    this test is the verification the issue asked for.
    """
    release_id = laned.publish()
    dest = tmp_path / f"out-{format_name}"
    report = _export(laned, release_id, _installed()[format_name], dest)
    written = COUNTERS[format_name](dest)
    laned.close()

    plugin = _installed()[format_name]
    assert GeometryType.POLYLINE not in plugin.supported_geometries
    assert GeometryType.POLYLINE not in plugin.degraded_geometries

    (lane,) = [one for one in report.classes if one.label_class == "centerline"]
    assert lane.status is ClassExportStatus.DROPPED
    assert lane.annotations == 3
    assert written["centerline"] == 0


# --- one class, two shapes ----------------------------------------------------

#: A single class labelled both ways, which is what #584 made expressible. YOLO
#: writes the boxes whole and reduces the polygons; COCO carries both intact.
MIXED_CLASSES = (LabelClass(name="sign", geometries=(GeometryType.BBOX, GeometryType.POLYGON)),)

#: Two boxes and one polygon, all under ``sign``, on two assets.
MIXED_DRAWING: dict[int, list[Annotation]] = {
    0: [_box(x=8, y=6, width=20, height=22), _polygon()],
    1: [_box(x=2, y=2, width=10, height=10)],
}


@pytest.fixture
def mixed(tmp_path: Path) -> Fixture:
    fixture = Fixture(tmp_path, classes=MIXED_CLASSES)
    fixture.label(
        {
            position: [one.model_copy(update={"label_class": "sign"}) for one in drawn]
            for position, drawn in MIXED_DRAWING.items()
        }
    )
    return fixture


@pytest.mark.parametrize("format_name", sorted(COUNTERS))
def test_a_class_labelled_two_ways_gets_a_report_row_for_each(
    tmp_path: Path, mixed: Fixture, format_name: str
) -> None:
    """The defect a per-class report cannot express, and the reason it is per shape.

    Under YOLO one class here is two different answers at once — the boxes are
    written whole, the polygons are written as their bounding box and lose their
    shape. A report with one row per class could carry only one of those verdicts,
    and would describe half its own output wrongly whichever it picked.

    The counts are read off the artifact, like every other test in this file: the
    rows a format wrote under the class name must equal the sum of the rows it did
    not report as dropped.
    """
    release_id = mixed.publish()
    dest = tmp_path / f"out-{format_name}"
    report = _export(mixed, release_id, _installed()[format_name], dest)
    written = COUNTERS[format_name](dest)
    mixed.close()

    rows = [one for one in report.classes if one.label_class == "sign"]
    assert {one.geometry for one in rows} == {GeometryType.BBOX, GeometryType.POLYGON}
    assert sum(one.annotations for one in rows) == 3

    carried = sum(one.annotations for one in rows if one.status is not ClassExportStatus.DROPPED)
    assert written["sign"] == carried, (
        f"{format_name} reports {[(one.geometry.value, one.status.value) for one in rows]} "
        f"and wrote {written['sign']} row(s)"
    )


def test_yolo_splits_one_mixed_class_into_a_whole_half_and_a_degraded_half(
    tmp_path: Path, mixed: Fixture
) -> None:
    """The verdicts themselves, named — the parametrized test above only compares counts.

    Written against YOLO specifically because it is the format whose two answers
    differ: ``supported_geometries`` is ``{bbox}`` and ``degraded_geometries`` is
    ``{polygon}``, so one class produces one of each. COCO carries both and would
    make the assertion vacuous.
    """
    release_id = mixed.publish()
    report = _export(mixed, release_id, _installed()["yolo"], tmp_path / "out")
    mixed.close()

    verdicts = {one.geometry: one.status for one in report.classes if one.label_class == "sign"}
    assert verdicts == {
        GeometryType.BBOX: ClassExportStatus.SUPPORTED,
        GeometryType.POLYGON: ClassExportStatus.DEGRADED,
    }
    # Nothing is lost, so consent is still asked for — a degraded export is not a
    # compatible one, which is the call `_compatibility` already made.
    assert report.excluded_annotations == 0
    assert report.degraded_annotations == 1
    assert report.compatible is False
