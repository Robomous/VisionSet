"""The export report against the bytes on disk, for every installed exporter.

#158's guard, and the reason it is a file of its own rather than three more tests
in ``test_yolo.py``. The defect was not that an exporter did the wrong thing —
YOLO's own ``test_a_polygon_is_written_as_its_bounding_box`` passed throughout,
because writing the box is what that exporter is *for*. The defect was that
nothing compared the report to the output, so the two could describe the same
release differently and every test agreed with the half it was looking at.

**Every count here is read back out of the written artifacts.** Nothing asserts
"the report says 1 and 1 is what we expect"; it asserts "the report says 1, and
counting the rows in the label files finds exactly the annotations it did not
claim". That is #158's first acceptance criterion, and it is the only shape of
test that could have caught the original.

The dispatch table is the fifth criterion: a fourth exporter registering into the
``visionset.formats`` group either lands a counter here or is declared as one
that writes nothing, and ``test_every_installed_exporter_is_accounted_for``
fails until somebody chooses. A format cannot be added and quietly skipped.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ElementTree
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from tests.formats.test_yolo import Fixture, _box

from visionset.formats.coco import ANNOTATIONS_DIRNAME as COCO_ANNOTATIONS_DIRNAME
from visionset.formats.registry import exporters
from visionset.formats.voc import ANNOTATIONS_DIRNAME as VOC_ANNOTATIONS_DIRNAME
from visionset.formats.yolo import DATA_FILENAME, LABELS_DIRNAME
from visionset.kernel.domain import (
    Annotation,
    ClassExportStatus,
    ClassificationGeometry,
    ExportCompatibility,
    PolygonGeometry,
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
#: It is the reproduction from #158's own body, deliberately — the report there
#: said three annotations would be excluded and the output held four rows where
#: two were expected.
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


#: How to count what each format actually wrote, keyed by ``format_name``.
COUNTERS: dict[str, Callable[[Path], Counter[str]]] = {
    "yolo": _yolo_counts,
    "voc": _voc_counts,
    "coco": _coco_counts,
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
    """A fourth format cannot reintroduce #158 by not being looked at.

    The one assertion here that is about this file rather than about the code: a
    new exporter either gets a counter and is compared against its own output, or
    is declared non-writing on purpose. Silence is not an option.
    """
    assert set(_installed()) == set(COUNTERS) | NON_WRITING


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
    """#158's first and second acceptance criteria, counted rather than restated.

    The number a caller consents to losing is checked against the arithmetic of
    the artifact: everything the release held, minus everything on disk. Under
    the old model YOLO answered 3 here and the subtraction gave 1.
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
    """#158's third criterion: a written class's reason must not deny being written."""
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
    """The reproduction from #158's body, in the numbers it disagreed about."""
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
    """#158's fourth criterion. COCO writes a polygon as a polygon, so it degrades nothing."""
    release_id = labelled.publish()
    dest = tmp_path / "out"
    report = _export(labelled, release_id, _installed()["coco"], dest)
    written = _coco_counts(dest)
    labelled.close()

    assert written == Counter({"sign": 3, "lane": 2})
    assert (report.excluded_annotations, report.degraded_annotations) == (1, 0)
    assert report.degraded == ()
    assert [one.label_class for one in report.excluded] == ["weather"]
