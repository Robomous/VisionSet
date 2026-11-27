"""CVAT XML 1.1, both dialects: hand-written documents in, and exports read by a separate reader."""

from __future__ import annotations

import xml.etree.ElementTree as ElementTree
from collections.abc import Iterator, Sequence
from io import BytesIO
from pathlib import Path
from typing import BinaryIO
from uuid import UUID, uuid4

import pytest
from PIL import Image
from tests.fixtures.media import write_image

from visionset.formats.cvat import (
    CvatImagesExporter,
    CvatImagesImporter,
    CvatVideoExporter,
    CvatVideoImporter,
)
from visionset.formats.mot import MotExporter
from visionset.kernel import ExportSourceUnreadable, ImportSourceUnreadable
from visionset.kernel.domain import (
    TRACKED_MANIFEST_VERSION,
    AssetProgress,
    BboxGeometry,
    ClassExportStatus,
    ClassificationGeometry,
    GeometryType,
    ImportConsent,
    ImportedDataset,
    ImportLossKind,
    ImportRun,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    ManifestObservation,
    ManifestTrack,
    PolygonGeometry,
    PolylineGeometry,
    Release,
)
from visionset.kernel.domain.schema import Attribute
from visionset.kernel.ports import ContentReader, Importer
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    DatasetService,
    ImportService,
    JobService,
    ProjectService,
    ReleaseService,
    SchemaService,
    SourceService,
    TrackService,
    WorkspaceService,
)

SIZE = (40, 30)
EVERY_LOSS = tuple(ImportLossKind)

LABELS = """
<label><name>car</name><type>rectangle</type><attributes/></label>
<label><name>road</name><type>polygon</type></label>
<label><name>lane</name><type>polyline</type></label>
<label><name>sunny</name><type>tag</type></label>
<label><name>spare</name><type>rectangle</type></label>
<label><name>other</name><type>any</type></label>
"""


def _document(body: str, *, task: str = "", labels: str = LABELS, head: str = "") -> str:
    return (
        f'<?xml version="1.0" encoding="utf-8"?>{head}\n<annotations>\n<version>1.1</version>\n'
        f"<meta><task>{task}<labels>{labels}</labels></task></meta>\n{body}\n</annotations>\n"
    )


def _images_source(
    root: Path, body: str, *, pictures: Sequence[str] = ("a.png",), **kw: str
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "annotations.xml").write_text(_document(body, **kw), encoding="utf-8")
    for index, name in enumerate(pictures):
        write_image(root / "images" / name, size=SIZE, seed=index)
    return root


def _video_source(
    root: Path,
    body: str,
    *,
    size: int = 5,
    absent: Sequence[int] = (),
    name: str = "drive",
    suffix: str = ".png",
    seed: int = 0,
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    task = (
        f"<name>{name}</name><size>{size}</size><mode>interpolation</mode>"
        f"<original_size><width>{SIZE[0]}</width><height>{SIZE[1]}</height></original_size>"
    )
    (root / "annotations.xml").write_text(_document(body, task=task), encoding="utf-8")
    for frame in range(size):
        if frame not in absent:
            write_image(
                root / "images" / f"frame_{frame:06d}{suffix}", size=SIZE, seed=seed + frame
            )
    return root


def _image(name: str, shapes: str, *, identity: int = 0, extra: str = "") -> str:
    return (
        f'<image id="{identity}" name="{name}" width="{SIZE[0]}" height="{SIZE[1]}"{extra}>'
        f"{shapes}</image>"
    )


#: The one loss ``LABELS`` brings to every read: ``other`` is of type ``any``, and nothing draws it.
UNTYPED = {
    (
        "class",
        "other",
        "no imported shape and no label <type> gives it a geometry the domain holds; "
        "the class is not imported",
    ): 1
}


def _losses(dataset: ImportedDataset) -> dict[tuple[str, str, str], int]:
    return {(one.kind.value, one.subject, one.reason): one.count for one in dataset.losses}


# --- CVAT for images in -------------------------------------------------------


def test_an_image_task_reads_every_shape_the_domain_holds(tmp_path: Path) -> None:
    body = _image(
        "a.png",
        '<box label="car" source="manual" occluded="0" xtl="1.5" ytl="2" xbr="11.5" ybr="10" '
        'z_order="0"/>'
        '<polygon label="road" source="manual" occluded="0" points="0,0;10,0;10,10" z_order="0"/>'
        '<polyline label="lane" source="manual" occluded="0" points="1,1;5.25,5" z_order="0"/>'
        '<tag label="sunny" source="manual"/>',
    ) + _image("sub/b.png", "", identity=1)
    src = _images_source(tmp_path / "src", body, pictures=("a.png", "sub/b.png"))
    dataset = CvatImagesImporter().read(src)

    assert [(one.name, one.geometries) for one in dataset.classes] == [
        ("car", (GeometryType.BBOX,)),
        ("road", (GeometryType.POLYGON,)),
        ("lane", (GeometryType.POLYLINE,)),
        ("sunny", (GeometryType.CLASSIFICATION_TAG,)),
        ("spare", (GeometryType.BBOX,)),
    ]
    first, second = dataset.images
    assert (str(first.path), first.width, first.height) == ("images/a.png", *SIZE)
    assert [(label.class_name, label.geometry, label.track) for label in first.labels] == [
        ("car", BboxGeometry(x=1.5, y=2, width=10, height=8), None),
        ("road", PolygonGeometry(points=[(0, 0), (10, 0), (10, 10)]), None),
        ("lane", PolylineGeometry(points=[(1, 1), (5.25, 5)]), None),
        ("sunny", ClassificationGeometry(), None),
    ]
    assert (str(second.path), second.labels) == ("images/sub/b.png", ())
    assert _losses(dataset) == UNTYPED
    assert dataset.sequences == ()


def test_what_the_domain_cannot_hold_is_declared(tmp_path: Path) -> None:
    body = _image(
        "a.png",
        '<points label="car" occluded="0" points="1,1;2,2"/>'
        '<ellipse label="car" occluded="0" cx="5" cy="5" rx="2" ry="1"/>'
        '<cuboid label="car" occluded="0"/>'
        '<mask label="car" occluded="0" rle="1, 2" left="0" top="0" width="2" height="2"/>'
        '<skeleton label="car" occluded="0"><points label="car" points="1,1"/></skeleton>'
        '<box label="car" occluded="0" xtl="0" ytl="0" xbr="4" ybr="4" rotation="30"/>'
        '<box label="car" occluded="1" xtl="0" ytl="0" xbr="4" ybr="4" z_order="2" group_id="3">'
        '<attribute name="color">red</attribute></box>'
        '<tag label="sunny"/><tag label="sunny"/>',
        extra=' subset="Train"',
    )
    dataset = CvatImagesImporter().read(_images_source(tmp_path / "src", body))

    (image,) = dataset.images
    assert [(label.geometry.type, label.attributes) for label in image.labels] == [
        (GeometryType.BBOX, {"color": "red"}),
        (GeometryType.CLASSIFICATION_TAG, {}),
    ]
    no_geometry = "has no canonical geometry; it is not imported"
    assert _losses(dataset) == UNTYPED | {
        **{
            ("label", "car", f"a CVAT <{tag}> {no_geometry}"): 1
            for tag in ("points", "ellipse", "cuboid", "mask", "skeleton")
        },
        ("label", "car", "a rotated box has no canonical geometry; it is not imported"): 1,
        ("attribute", "car", "occluded is not carried; the shape is kept"): 1,
        ("attribute", "car", "z_order is not carried; the shape is kept"): 1,
        ("attribute", "car", "group_id is not carried; the shape is kept"): 1,
        ("attribute", "subset", "the subset is not imported; the picture is kept"): 1,
        (
            "label",
            "sunny",
            "a picture carries one tag of a class; the repeat cannot be represented",
        ): 1,
    }


_BILLION_LAUGHS = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>'


@pytest.mark.parametrize(
    ("body", "complaint", "kw"),
    [
        (
            _image("a.png", '<box label="car" xtl="4" ytl="0" xbr="4" ybr="4"/>'),
            "annotations.xml line 12: the box has no area",
            {},
        ),
        (_image("a.png", '<box label="car" xtl="x" ytl="0" xbr="4" ybr="4"/>'), "xtl 'x'", {}),
        (_image("a.png", '<box label="car" xtl="nan" ytl="0" xbr="4" ybr="4"/>'), "non-finite", {}),
        (_image("a.png", '<box label="truck" xtl="0" ytl="0" xbr="4" ybr="4"/>'), "'truck'", {}),
        (_image("a.png", '<box xtl="0" ytl="0" xbr="4" ybr="4"/>'), "names no label", {}),
        (_image("a.png", '<polygon label="road" points="0,0;1,1"/>'), "three points", {}),
        (_image("a.png", '<polyline label="lane" points="0,0;1"/>'), "not an x,y pair", {}),
        (_image("a.png", '<polyline label="lane" points="1,1;1,1"/>'), "no length", {}),
        (
            _image("a.png", '<box label="car" occluded="2" xtl="0" ytl="0" xbr="4" ybr="4"/>'),
            "occluded is '2'",
            {},
        ),
        (_image("a.png", '<circle label="car"/>'), "<circle> is not a CVAT shape", {}),
        (_image("a.png", "") + _image("a.png", "", identity=1), "listed more than once", {}),
        (_image("a.png", "") + _image("b.png", ""), "image id 0 is given twice", {}),
        (_image("../a.png", ""), "leaves the source", {}),
        (_image("/a.png", ""), "absolute", {}),
        ('<image id="0" name="a.png" width="0" height="3"/>', "width '0'", {}),
        ('<image id="-1" name="a.png" width="4" height="3"/>', "id '-1'", {}),
        ('<track id="0" label="car"/>', "cvat-video reads", {}),
        ("<frame/>", "<frame> is not a CVAT image element", {}),
        ("", "declares a DOCTYPE", {"head": _BILLION_LAUGHS}),
        ("<image>", "not readable XML", {}),
        ("&undefined;", "not readable XML", {}),
        (
            "",
            "label 'car' is declared twice",
            {"labels": "<label><name>car</name></label><label><name>car</name></label>"},
        ),
    ],
)
def test_a_malformed_image_task_is_refused_by_line(
    tmp_path: Path, body: str, complaint: str, kw: dict[str, str]
) -> None:
    src = _images_source(tmp_path / "src", body, **kw)
    with pytest.raises(ImportSourceUnreadable, match="annotations.xml") as refusal:
        CvatImagesImporter().read(src)
    assert complaint in str(refusal.value)
    assert " line " in str(refusal.value)


def test_a_version_other_than_1_1_is_refused(tmp_path: Path) -> None:
    src = _images_source(tmp_path / "src", "")
    path = src / "annotations.xml"
    path.write_text(path.read_text().replace("1.1", "2.0"), encoding="utf-8")
    with pytest.raises(ImportSourceUnreadable, match="version is 2.0"):
        CvatImagesImporter().read(src)


def test_a_source_without_a_document_is_refused(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    for importer in (CvatImagesImporter(), CvatVideoImporter()):
        with pytest.raises(ImportSourceUnreadable, match="holds no annotations.xml"):
            importer.read(tmp_path / "src")


# --- CVAT for video in --------------------------------------------------------

TRACKS = (
    # A box present at 0 and 1, outside at 2, back at 3 and carried to the end.
    '<track id="4" label="car" source="manual">'
    '<box frame="0" keyframe="1" outside="0" occluded="0" xtl="1" ytl="2" xbr="11" ybr="10"/>'
    '<box frame="1" keyframe="0" outside="0" occluded="0" xtl="2" ytl="2" xbr="12" ybr="10"/>'
    '<box frame="2" keyframe="1" outside="1" occluded="0" xtl="2" ytl="2" xbr="12" ybr="10"/>'
    '<box frame="3" keyframe="1" outside="0" occluded="1" xtl="3" ytl="2" xbr="13" ybr="10"/>'
    "</track>"
    # A polygon keyframed at 0 and 3: frames 1 and 2 are CVAT's interpolation.
    '<track id="0" label="road" source="manual">'
    '<polygon frame="0" keyframe="1" outside="0" occluded="0" points="0,0;4,0;4,4"/>'
    '<polygon frame="3" keyframe="1" outside="0" occluded="0" points="1,0;5,0;5,4"/>'
    '<polygon frame="4" keyframe="1" outside="1" occluded="0" points="1,0;5,0;5,4"/>'
    "</track>"
    '<track id="9" label="car"><points frame="0" outside="0" points="1,1"/></track>'
    '<tag frame="2" label="sunny" source="manual"/>'
)


def _tracks_by_frame(dataset: ImportedDataset) -> dict[int, list[tuple[object, ...]]]:
    (sequence,) = dataset.sequences
    by_path = {image.path: image for image in dataset.images}
    return {
        position: [
            (label.track, label.class_name, label.geometry) for label in by_path[f.path].labels
        ]
        for position, f in enumerate(sequence.frames)
    }


def test_a_video_task_is_a_sequence_and_its_tracks_keep_their_ids(tmp_path: Path) -> None:
    dataset = CvatVideoImporter().read(_video_source(tmp_path / "src", TRACKS, absent=(4,)))

    (sequence,) = dataset.sequences
    assert sequence.name == "drive"
    assert [str(frame.path) for frame in sequence.frames] == [
        f"images/frame_00000{n}.png" for n in range(5)
    ]
    assert {frame.timestamp for frame in sequence.frames} == {None}
    assert {(image.width, image.height) for image in dataset.images} == {SIZE}
    polygon = PolygonGeometry(points=[(0, 0), (4, 0), (4, 4)])
    assert _tracks_by_frame(dataset) == {
        0: [
            ("4", "car", BboxGeometry(x=1, y=2, width=10, height=8)),
            ("0", "road", polygon),
        ],
        1: [("4", "car", BboxGeometry(x=2, y=2, width=10, height=8))],
        2: [(None, "sunny", ClassificationGeometry())],
        3: [
            ("4", "car", BboxGeometry(x=3, y=2, width=10, height=8)),
            ("0", "road", PolygonGeometry(points=[(1, 0), (5, 0), (5, 4)])),
        ],
        4: [],
    }
    assert _losses(dataset) == UNTYPED | {
        (
            "attribute",
            "car",
            "keyframe=0 marks a frame CVAT interpolated; it is imported as an ordinary label "
            "and the mark is not kept",
        ): 1,
        ("attribute", "car", "occluded is not carried; the shape is kept"): 1,
        # Frame 4 after the box's last stored shape, and frames 1 and 2 of the polygon;
        # the point's track is not imported, so its frames are not counted.
        (
            "attribute",
            "car",
            "frames CVAT interpolates between stored shapes, or carries to the task's end, "
            "are not expanded",
        ): 1,
        (
            "attribute",
            "road",
            "frames CVAT interpolates between stored shapes, or carries to the task's end, "
            "are not expanded",
        ): 2,
        ("label", "car", "a CVAT <points> has no canonical geometry; it is not imported"): 1,
    }


@pytest.mark.parametrize(
    ("body", "complaint"),
    [
        (
            '<track id="0" label="car"><box frame="5" outside="0" xtl="0" ytl="0" xbr="4" ybr="4"/>'
            "</track>",
            "frame 5 is not one of the task's 5 frames (0 to 4)",
        ),
        (
            '<track id="0" label="car">'
            '<box frame="-1" outside="0" xtl="0" ytl="0" xbr="4" ybr="4"/></track>',
            "frame '-1'",
        ),
        (
            '<track id="0" label="car"><box frame="1" outside="0" xtl="0" ytl="0" xbr="4" ybr="4"/>'
            '<box frame="1" outside="0" xtl="0" ytl="0" xbr="4" ybr="4"/></track>',
            "two shapes at frame 1",
        ),
        (
            '<track id="0" label="car"><box frame="1" outside="0" xtl="0" ytl="0" xbr="4" ybr="4"/>'
            '<polygon frame="2" outside="0" points="0,0;1,0;1,1"/></track>',
            "mixes box, polygon",
        ),
        ('<track id="0" label="car"/><track id="0" label="car"/>', "track id 0 is given twice"),
        (
            '<track id="0" label="car"><box frame="1" outside="yes" xtl="0" ytl="0" xbr="4" '
            'ybr="4"/></track>',
            "outside is 'yes'",
        ),
        ('<track id="0" label="truck"/>', "'truck' is not one"),
        ('<track label="car"/>', "gives no id"),
        ('<tag frame="9" label="sunny"/>', "frame 9 is not one of"),
        (_image("a.png", ""), "cvat-images reads"),
    ],
)
def test_a_malformed_video_task_is_refused_by_line(
    tmp_path: Path, body: str, complaint: str
) -> None:
    with pytest.raises(ImportSourceUnreadable, match="annotations.xml line") as refusal:
        CvatVideoImporter().read(_video_source(tmp_path / "src", body))
    assert complaint in str(refusal.value)


def test_frames_count_from_the_task_start_frame_every_step(tmp_path: Path) -> None:
    """CVAT numbers a video task's frames in its source: start_frame, then every step."""
    root = tmp_path / "src"
    root.mkdir()
    task = (
        "<name>clip</name><size>3</size><start_frame>10</start_frame>"
        "<stop_frame>16</stop_frame><frame_filter>step=3</frame_filter>"
    )
    body = (
        '<track id="0" label="car">'
        '<box frame="10" outside="0" xtl="0" ytl="0" xbr="4" ybr="4"/>'
        '<box frame="13" outside="1" xtl="0" ytl="0" xbr="4" ybr="4"/>'
        '<box frame="16" outside="0" xtl="1" ytl="0" xbr="4" ybr="4"/></track>'
    )
    (root / "annotations.xml").write_text(_document(body, task=task), encoding="utf-8")
    for frame in (10, 16):
        write_image(root / "images" / f"frame_{frame:06d}.png", size=SIZE, seed=frame)
    dataset = CvatVideoImporter().read(root)

    (sequence,) = dataset.sequences
    assert [str(frame.path) for frame in sequence.frames] == [
        f"images/frame_0000{n}.png" for n in (10, 13, 16)
    ]
    assert _tracks_by_frame(dataset) == {
        0: [("0", "car", BboxGeometry(x=0, y=0, width=4, height=4))],
        1: [],
        2: [("0", "car", BboxGeometry(x=1, y=0, width=3, height=4))],
    }
    assert _losses(dataset) == UNTYPED

    for frame, complaint in (
        (11, "frame 11 is not one of the task's 3 frames (10 to 16 every 3)"),
        (19, "frame 19 is not one of"),
    ):
        (root / "annotations.xml").write_text(
            _document(body.replace('frame="16"', f'frame="{frame}"'), task=task), encoding="utf-8"
        )
        with pytest.raises(ImportSourceUnreadable, match="line") as refusal:
            CvatVideoImporter().read(root)
        assert complaint in str(refusal.value)
    (root / "annotations.xml").write_text(
        _document(body, task=task.replace("step=3", "range=1")), encoding="utf-8"
    )
    with pytest.raises(ImportSourceUnreadable, match="not step=<n>"):
        CvatVideoImporter().read(root)


def test_a_shape_with_an_empty_label_is_declared_not_refused(tmp_path: Path) -> None:
    body = _image(
        "a.png",
        '<polygon label="" points="1,2;3,4;6,5"/>'
        '<box label="car" xtl="0" ytl="0" xbr="4" ybr="4"/>',
    )
    dataset = CvatImagesImporter().read(_images_source(tmp_path / "src", body))
    assert [label.class_name for label in dataset.images[0].labels] == ["car"]
    assert _losses(dataset) == UNTYPED | {
        ("label", "unlabelled", "a shape with an empty label has no class; it is not imported"): 1
    }


def test_a_project_export_keeps_each_subset_in_its_own_directory(tmp_path: Path) -> None:
    """A project's pictures sit under images/<subset>/, and ids repeat across subsets."""
    root = tmp_path / "src"
    root.mkdir()
    labels = "<label><name>car</name></label>"
    document = (
        _document(
            _image(
                "a.png",
                '<box label="car" xtl="0" ytl="0" xbr="4" ybr="4"/>',
                extra=' subset="Train"',
            )
            + _image("a.png", "", extra=' subset="Test"'),
            labels=labels,
        )
        .replace("<meta><task>", "<meta><project>")
        .replace("</task></meta>", "</project></meta>")
    )
    (root / "annotations.xml").write_text(document, encoding="utf-8")
    dataset = CvatImagesImporter().read(root)

    assert [(str(i.path), len(i.labels)) for i in dataset.images] == [
        ("images/Train/a.png", 1),
        ("images/Test/a.png", 0),
    ]
    assert _losses(dataset) == {
        ("attribute", "subset", "the subset is not imported; the picture is kept"): 2
    }
    (root / "annotations.xml").write_text(
        document.replace('subset="Test"', 'subset="Train"'), encoding="utf-8"
    )
    with pytest.raises(ImportSourceUnreadable, match="image id 0 is given twice"):
        CvatImagesImporter().read(root)


def test_a_video_task_without_its_frames_is_refused(tmp_path: Path) -> None:
    src = _video_source(tmp_path / "src", "", absent=range(5))
    with pytest.raises(ImportSourceUnreadable, match="there is no images/ beside it"):
        CvatVideoImporter().read(src)
    (src / "images").mkdir()
    (src / "images" / "frame_000000.txt").write_text("not a frame", encoding="utf-8")
    with pytest.raises(ImportSourceUnreadable, match="holds no frame_<n:06d> picture"):
        CvatVideoImporter().read(src)
    write_image(src / "images" / "frame_000000.png", size=SIZE)
    write_image(src / "images" / "frame_000001.jpg", size=SIZE)
    with pytest.raises(ImportSourceUnreadable, match="of 2 types"):
        CvatVideoImporter().read(src)


def test_two_tasks_naming_one_sequence_are_refused(tmp_path: Path) -> None:
    _video_source(tmp_path / "src" / "a", "")
    _video_source(tmp_path / "src" / "b", "")
    with pytest.raises(ImportSourceUnreadable, match="both name the sequence 'drive'"):
        CvatVideoImporter().read(tmp_path / "src")


# --- through a workspace ------------------------------------------------------


class World:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.workspace = WorkspaceService.init(root / "ws")
        self.projects = ProjectService(self.workspace)
        self.imports = ImportService(self.workspace)
        self.sources = SourceService(self.workspace)
        self.tracks = TrackService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.releases = ReleaseService(self.workspace)

    def run(self, name: str, importer: Importer, src: Path) -> tuple[UUID, ImportRun]:
        project = self.projects.create(name)
        consent = ImportConsent(kinds=frozenset(EVERY_LOSS))
        return project.id, self.imports.commit(project.id, importer, src, consent=consent)

    def release(self, project_id: UUID, run: ImportRun) -> UUID:
        batch_id = run.batch_id
        assert batch_id is not None
        self.batches.start(batch_id)
        for job in self.batches.jobs(batch_id):
            self.jobs.start(job.id)
            for asset_id, progress in self.jobs.get(job.id).progress.items():
                if progress is not AssetProgress.ANNOTATED:
                    self.jobs.mark(job.id, asset_id, AssetProgress.ANNOTATED)
            self.jobs.complete(job.id)
        self.batches.complete(batch_id)
        DatasetService(self.workspace).promote(batch_id)
        dataset_id = self.projects.get_dataset(project_id).id
        return self.releases.publish(dataset_id, "v1").id

    def attributes(self, run: ImportRun) -> list[dict[str, object]]:
        with self.workspace.unit_of_work() as uow:
            return [
                dict(annotation.attributes)
                for asset_id in run.asset_ids
                for annotation in uow.annotations.list(asset_id)
            ]

    def sequences(self, run: ImportRun) -> dict[str, dict[str, list[tuple[object, ...]]]]:
        found: dict[str, dict[str, list[tuple[object, ...]]]] = {}
        for source_id in run.source_ids:
            tracks = found.setdefault(self.sources.get(source_id).name, {})
            for detail in self.tracks.list(source_id):
                assert detail.track.external_id is not None
                tracks[detail.track.external_id] = [
                    (
                        frame.position,
                        self.annotations.get(frame.annotation_id).label_class,
                        self.annotations.get(frame.annotation_id).geometry,
                    )
                    for frame in detail.observations
                ]
        return found


@pytest.fixture
def world(tmp_path: Path) -> Iterator[World]:
    made = World(tmp_path)
    yield made
    made.workspace.close()


def _read_video(dest: Path) -> dict[str, dict[str, object]]:
    """Each exported task through ElementTree alone, as CVAT for video 1.1 lays it out.

    Written from the published format rather than the importer: the root, its
    version, the task's size and labels, and per track its frames with their
    ``outside`` and ``keyframe`` flags and coordinates.
    """
    found: dict[str, dict[str, object]] = {}
    for path in sorted(dest.glob("*/annotations.xml")):
        root = ElementTree.parse(path).getroot()
        assert root.tag == "annotations"
        assert [child.tag for child in root][:2] == ["version", "meta"]
        assert root.findtext("version") == "1.1"
        task = root.find("meta/task")
        assert task is not None
        assert task.findtext("mode") == "interpolation"
        size = int(task.findtext("size") or "0")
        assert task.findtext("stop_frame") == str(size - 1)
        assert {child.tag for child in root[2:]} <= {"track"}
        tracks = {}
        for track in root.findall("track"):
            assert set(track.attrib) == {"id", "label", "source"}
            rows = []
            for shape in track:
                assert shape.tag in ("box", "polygon", "polyline")
                assert {"frame", "outside", "occluded", "keyframe", "z_order"} <= set(shape.attrib)
                coordinates = (
                    tuple(float(shape.attrib[key]) for key in ("xtl", "ytl", "xbr", "ybr"))
                    if shape.tag == "box"
                    else shape.attrib["points"]
                )
                rows.append(
                    (
                        int(shape.attrib["frame"]),
                        shape.attrib["outside"],
                        shape.attrib["keyframe"],
                        coordinates,
                    )
                )
            assert [row[0] for row in rows] == sorted(row[0] for row in rows)
            tracks[track.attrib["id"]] = (track.attrib["label"], rows)
        found[task.findtext("name") or ""] = {
            "size": size,
            "labels": [label.findtext("name") for label in task.findall("labels/label")],
            "frames": sorted(p.name for p in (path.parent / "images").iterdir()),
            "tracks": tracks,
        }
    return found


def test_a_video_task_round_trips_through_a_release(world: World) -> None:
    src = _video_source(world.root / "src", TRACKS)
    project_id, run = world.run("cvat", CvatVideoImporter(), src)
    assert world.sequences(run) == {
        "drive": {
            "4": [
                (0, "car", BboxGeometry(x=1, y=2, width=10, height=8)),
                (1, "car", BboxGeometry(x=2, y=2, width=10, height=8)),
                (3, "car", BboxGeometry(x=3, y=2, width=10, height=8)),
            ],
            "0": [
                (0, "road", PolygonGeometry(points=[(0, 0), (4, 0), (4, 4)])),
                (3, "road", PolygonGeometry(points=[(1, 0), (5, 0), (5, 4)])),
            ],
        }
    }

    release_id = world.release(project_id, run)
    dest = world.root / "out"
    report = world.releases.export(release_id, CvatVideoExporter(), dest, allow_lossy=True)
    (source_id,) = (str(one) for one in run.source_ids)
    tasks = _read_video(dest)
    assert list(tasks) == [source_id]
    task = tasks[source_id]
    assert task["size"] == 5
    assert task["frames"] == [f"frame_00000{n}.png" for n in range(5)]
    assert task["labels"] == ["car", "road", "lane", "sunny", "spare"]
    assert task["tracks"] == {
        "0": (
            "road",
            [
                (0, "0", "1", "0,0;4,0;4,4"),
                (1, "1", "1", "0,0;4,0;4,4"),
                (3, "0", "1", "1,0;5,0;5,4"),
                (4, "1", "1", "1,0;5,0;5,4"),
            ],
        ),
        "4": (
            "car",
            [
                (0, "0", "1", (1.0, 2.0, 11.0, 10.0)),
                (1, "0", "1", (2.0, 2.0, 12.0, 10.0)),
                (2, "1", "1", (2.0, 2.0, 12.0, 10.0)),
                (3, "0", "1", (3.0, 2.0, 13.0, 10.0)),
                (4, "1", "1", (3.0, 2.0, 13.0, 10.0)),
            ],
        ),
    }
    dropped = [
        (one.label_class, one.annotations)
        for one in report.compatibility.classes
        if one.status is ClassExportStatus.DROPPED
    ]
    assert dropped == [("sunny", 1)]

    _, again = world.run("again", CvatVideoImporter(), dest)
    assert world.sequences(again) == {source_id: world.sequences(run)["drive"]}
    assert not again.losses


def test_an_absent_frame_stays_a_gap_and_later_frames_keep_their_numbers(world: World) -> None:
    src = _video_source(world.root / "src", TRACKS, absent=(2,))
    project_id, run = world.run("cvat", CvatVideoImporter(), src)
    release_id = world.release(project_id, run)
    manifest = world.releases.manifest(release_id)
    (listed,) = manifest.sources
    assert [(o.position, o.timestamp) for o in listed.occurrences] == [
        (0, None),
        (1, None),
        (3, None),
        (4, None),
    ]

    dest = world.root / "out"
    world.releases.export(release_id, CvatVideoExporter(), dest, allow_lossy=True)
    (task,) = _read_video(dest).values()
    assert task["size"] == 5
    assert task["frames"] == [f"frame_00000{n}.png" for n in (0, 1, 3, 4)]
    _, again = world.run("again", CvatVideoImporter(), dest)
    (source_id,) = (str(one) for one in run.source_ids)
    assert world.sequences(again) == {source_id: world.sequences(run)["drive"]}
    (reread,) = again.source_ids
    assert [o.position for o in world.sources.occurrences(reread)] == [0, 1, 3, 4]


def test_unknown_timing_refuses_a_mot_export_by_name(world: World) -> None:
    project_id, run = world.run(
        "cvat", CvatVideoImporter(), _video_source(world.root / "src", TRACKS)
    )
    release_id = world.release(project_id, run)
    with pytest.raises(ExportSourceUnreadable, match="timing of frame 1 is unknown"):
        world.releases.export(release_id, MotExporter(), world.root / "out", allow_lossy=True)


def _read_images(dest: Path) -> tuple[list[str], list[tuple[object, ...]]]:
    """The exported task through ElementTree alone, as CVAT for images 1.1 lays it out."""
    root = ElementTree.parse(dest / "annotations.xml").getroot()
    assert (root.tag, root.findtext("version")) == ("annotations", "1.1")
    task = root.find("meta/task")
    assert task is not None
    assert task.findtext("mode") == "annotation"
    images = root.findall("image")
    assert task.findtext("size") == str(len(images))
    assert [int(image.attrib["id"]) for image in images] == list(range(len(images)))
    labels = [label.findtext("name") or "" for label in task.findall("labels/label")]
    rows: list[tuple[object, ...]] = []
    for image in images:
        assert (dest / "images" / image.attrib["name"]).is_file()
        with Image.open(dest / "images" / image.attrib["name"]) as opened:
            assert opened.size == (int(image.attrib["width"]), int(image.attrib["height"]))
        for shape in image:
            assert shape.attrib["label"] in labels
            values = {one.attrib["name"]: one.text for one in shape.findall("attribute")}
            if shape.tag == "box":
                where: object = tuple(float(shape.attrib[k]) for k in ("xtl", "ytl", "xbr", "ybr"))
            elif shape.tag == "tag":
                where = None
            else:
                where = [tuple(map(float, p.split(","))) for p in shape.attrib["points"].split(";")]
            rows.append(
                (
                    image.attrib["subset"],
                    shape.tag,
                    shape.attrib["label"],
                    shape.attrib["source"],
                    where,
                    values,
                )
            )
    return labels, rows


def test_an_image_task_round_trips_through_a_release(world: World) -> None:
    body = _image(
        "a.png",
        '<box label="car" source="manual" occluded="0" xtl="1.5" ytl="2" xbr="11.5" ybr="10"/>'
        '<polygon label="road" occluded="0" points="0,0;10,0;10,10"/>'
        '<polyline label="lane" occluded="0" points="1,1;5.25,5"/>'
        '<tag label="sunny"/>',
    ) + _image("b.png", '<box label="car" xtl="0" ytl="0" xbr="4" ybr="4"/>', identity=1)
    src = _images_source(world.root / "src", body, pictures=("a.png", "b.png"))
    project_id, run = world.run("cvat", CvatImagesImporter(), src)
    dest = world.root / "out"
    world.releases.export(
        world.release(project_id, run), CvatImagesExporter(), dest, allow_lossy=True
    )

    labels, rows = _read_images(dest)
    assert labels == ["car", "road", "lane", "sunny", "spare"]
    assert sorted(rows, key=repr) == sorted(
        [
            ("default", "box", "car", "file", (1.5, 2.0, 11.5, 10.0), {}),
            ("default", "polygon", "road", "file", [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], {}),
            ("default", "polyline", "lane", "file", [(1.0, 1.0), (5.25, 5.0)], {}),
            ("default", "tag", "sunny", "file", None, {}),
            ("default", "box", "car", "file", (0.0, 0.0, 4.0, 4.0), {}),
        ],
        key=repr,
    )

    _, again = world.run("again", CvatImagesImporter(), dest)
    assert again.annotations_written == run.annotations_written == 5
    assert again.losses == ()
    assert _drawn(CvatImagesImporter().read(dest)) == _drawn(CvatImagesImporter().read(src))


SPECS = """
<label><name>car</name><type>rectangle</type><attributes>
<attribute><name>color</name><mutable>False</mutable><input_type>radio</input_type>
<default_value>red</default_value><values>red
blue</values></attribute>
<attribute><name>speed</name><mutable>True</mutable><input_type>number</input_type>
<default_value>0</default_value><values>0
100
1</values></attribute>
<attribute><name>parked</name><input_type>checkbox</input_type>
<default_value>false</default_value><values>false</values></attribute>
<attribute><name>note</name><input_type>text</input_type><default_value></default_value>
<values></values></attribute>
<attribute><name>kind</name><input_type>select</input_type><default_value>van</default_value>
<values>sedan
truck</values></attribute>
<attribute><name>size</name><input_type>slider</input_type></attribute>
<attribute><name>Color</name><input_type>text</input_type></attribute>
</attributes></label>
"""

VALUES = (
    '<attribute name="color">blue</attribute><attribute name="speed">12.5</attribute>'
    '<attribute name="parked">True</attribute><attribute name="note"> as typed </attribute>'
    '<attribute name="kind">sedan</attribute><attribute name="weight">3</attribute>'
    '<attribute name="speed">7</attribute>'
)


def test_attribute_definitions_and_values_are_read_as_their_kinds(tmp_path: Path) -> None:
    body = _image("a.png", f'<box label="car" xtl="0" ytl="0" xbr="4" ybr="4">{VALUES}</box>')
    dataset = CvatImagesImporter().read(_images_source(tmp_path / "src", body, labels=SPECS))

    (car,) = dataset.classes
    assert car.attributes == (
        Attribute(name="color", kind="select", options=("red", "blue"), default="red"),
        Attribute(name="speed", kind="number", default=0.0),
        Attribute(name="parked", kind="boolean", default=False),
        Attribute(name="note", kind="string"),
        Attribute(name="kind", kind="select", options=("sedan", "truck")),
    )
    ((label,),) = [image.labels for image in dataset.images]
    assert label.attributes == {
        "color": "blue",
        "speed": 12.5,
        "parked": True,
        "note": " as typed ",
        "kind": "sedan",
        "weight": "3",
    }
    assert _losses(dataset) == {
        (
            "attribute",
            "car",
            "attribute 'speed''s range and step are not carried; the attribute is kept",
        ): 1,
        (
            "attribute",
            "car",
            "attribute 'kind''s default is not one it accepts; the default is not imported",
        ): 1,
        ("attribute", "car", "attribute 'size' is a slider input, which is not imported"): 1,
        ("attribute", "car", "attribute 'Color' is defined twice; the first definition is kept"): 1,
        ("attribute", "car", "attribute 'speed' is given twice on one shape; the first is kept"): 1,
    }


def test_a_value_the_definition_cannot_read_is_judged_by_the_import(world: World) -> None:
    values = (
        '<attribute name="speed">fast</attribute><attribute name="parked">yes</attribute>'
        '<attribute name="weight">3</attribute><attribute name="color">blue</attribute>'
    )
    body = _image("a.png", f'<box label="car" xtl="0" ytl="0" xbr="4" ybr="4">{values}</box>')
    src = _images_source(world.root / "src", body, labels=SPECS)
    project_id, run = world.run("cvat", CvatImagesImporter(), src)

    (schema,) = SchemaService(world.workspace).list_versions(project_id)
    assert [one.name for one in schema.classes[0].attributes] == [
        "color",
        "speed",
        "parked",
        "note",
        "kind",
    ]
    assert world.attributes(run) == [{"color": "blue"}]
    judged = {(one.subject, one.reason) for one in run.losses if one.kind == "attribute"}
    assert {
        (
            "car",
            "attribute 'speed' holds a value its number definition rejects; "
            "the value is not imported",
        ),
        (
            "car",
            "attribute 'parked' holds a value its boolean definition rejects; "
            "the value is not imported",
        ),
        ("car", "attribute 'weight' is not one its class declares; the value is not imported"),
    } <= judged


def test_attribute_values_round_trip_through_an_image_release(world: World) -> None:
    body = _image(
        "a.png",
        f'<box label="car" xtl="0" ytl="0" xbr="4" ybr="4">{VALUES}</box>'
        '<box label="car" xtl="1" ytl="1" xbr="5" ybr="5">'
        '<attribute name="parked">false</attribute><attribute name="note"></attribute></box>',
    )
    src = _images_source(world.root / "src", body, labels=SPECS)
    project_id, run = world.run("cvat", CvatImagesImporter(), src)
    written = world.attributes(run)
    assert sorted(written, key=len) == sorted(
        [
            {"color": "blue", "speed": 12.5, "parked": True, "note": " as typed ", "kind": "sedan"},
            {"parked": False, "note": ""},
        ],
        key=len,
    )

    dest = world.root / "out"
    world.releases.export(
        world.release(project_id, run), CvatImagesExporter(), dest, allow_lossy=True
    )
    again_id, again = world.run("again", CvatImagesImporter(), dest)
    assert sorted(world.attributes(again), key=len) == sorted(written, key=len)
    assert not [one for one in again.losses if one.kind is ImportLossKind.ATTRIBUTE]
    (first,) = SchemaService(world.workspace).list_versions(project_id)
    (second,) = SchemaService(world.workspace).list_versions(again_id)
    assert second.classes[0].attributes == first.classes[0].attributes


def test_a_schema_s_attributes_round_trip_through_cvat_except_what_cvat_cannot_hold(
    world: World,
) -> None:
    schema = SchemaService(world.workspace)
    color = Attribute(name="color", kind="select", options=(" red", "blue "), required=True)
    defined = (
        color,
        Attribute(name="note", kind="string", default=""),
        Attribute(name="tag", kind="string", default=" x "),
        Attribute(name="speed", kind="number", default=2.5),
        Attribute(name="lit", kind="boolean", default=True),
    )
    project = world.projects.create("authored")
    schema.create_version(
        project.id,
        [LabelClass(name="car", geometries=(GeometryType.BBOX,), attributes=defined)],
    )
    values = (
        '<attribute name="color"> red</attribute><attribute name="tag">  </attribute>'
        '<attribute name="speed">4</attribute><attribute name="lit">false</attribute>'
    )
    body = _image("a.png", f'<box label="car" xtl="0" ytl="0" xbr="4" ybr="4">{values}</box>')
    labels = (
        "<label><name>car</name><type>rectangle</type><attributes>"
        "<attribute><name>speed</name><input_type>number</input_type></attribute>"
        "<attribute><name>lit</name><input_type>checkbox</input_type></attribute>"
        "</attributes></label>"
    )
    src = _images_source(world.root / "src", body, labels=labels)
    run = world.imports.commit(
        project.id, CvatImagesImporter(), src, consent=ImportConsent(kinds=frozenset(EVERY_LOSS))
    )
    written = world.attributes(run)
    assert written == [{"color": " red", "tag": "  ", "speed": 4.0, "lit": False}]

    dest = world.root / "out"
    world.releases.export(
        world.release(project.id, run), CvatImagesExporter(), dest, allow_lossy=True
    )
    again_id, again = world.run("again", CvatImagesImporter(), dest)
    assert world.attributes(again) == written
    assert not [one for one in again.losses if one.kind is ImportLossKind.ATTRIBUTE]
    (read,) = schema.list_versions(again_id)
    assert read.classes[0].attributes == (
        color.model_copy(update={"required": False}),
        Attribute(name="note", kind="string"),
        *defined[2:],
    )


def test_an_option_cvat_cannot_hold_refuses_the_export(tmp_path: Path) -> None:
    for option in ("two\nlines", ""):
        car = LabelClass(
            name="car",
            geometries=(GeometryType.BBOX,),
            attributes=(Attribute(name="color", kind="select", options=("red", option)),),
        )
        manifest = Manifest(schema_version=1, classes=(car,), assets=())
        with pytest.raises(ExportSourceUnreadable, match="cannot be written"):
            CvatImagesExporter().export(
                _release(), manifest, tmp_path / "out", content=_content({}), assignment=None
            )
        assert not (tmp_path / "out").exists()


def test_attribute_values_round_trip_through_a_video_release(world: World) -> None:
    labels = (
        "<label><name>car</name><type>rectangle</type><attributes>"
        "<attribute><name>speed</name><mutable>True</mutable><input_type>number</input_type>"
        "<default_value></default_value><values></values></attribute>"
        "<attribute><name>parked</name><mutable>False</mutable><input_type>checkbox</input_type>"
        "<default_value>false</default_value><values>false\ntrue</values></attribute>"
        "</attributes></label>"
    )
    tracks = (
        '<track id="3" label="car" source="manual">'
        '<box frame="0" keyframe="1" outside="0" occluded="0" xtl="1" ytl="2" xbr="11" ybr="10">'
        '<attribute name="speed">1</attribute><attribute name="parked">false</attribute></box>'
        '<box frame="1" keyframe="1" outside="0" occluded="0" xtl="2" ytl="2" xbr="12" ybr="10">'
        '<attribute name="speed">2.5</attribute><attribute name="parked">true</attribute></box>'
        '<box frame="2" keyframe="1" outside="1" occluded="0" xtl="2" ytl="2" xbr="12" ybr="10"/>'
        "</track>"
    )
    src = world.root / "src"
    _video_source(src, tracks, size=3)
    document = src / "annotations.xml"
    document.write_text(
        document.read_text(encoding="utf-8").replace(LABELS, labels), encoding="utf-8"
    )
    project_id, run = world.run("cvat", CvatVideoImporter(), src)
    written = world.attributes(run)
    assert sorted(written, key=lambda one: str(one["speed"])) == [
        {"speed": 1.0, "parked": False},
        {"speed": 2.5, "parked": True},
    ]

    dest = world.root / "out"
    world.releases.export(
        world.release(project_id, run), CvatVideoExporter(), dest, allow_lossy=True
    )
    _, again = world.run("again", CvatVideoImporter(), dest)
    assert sorted(world.attributes(again), key=lambda one: str(one["speed"])) == written
    assert not [one for one in again.losses if one.kind is ImportLossKind.ATTRIBUTE]


def _drawn(dataset: ImportedDataset) -> list[str]:
    return sorted(repr((one.class_name, one.geometry)) for i in dataset.images for one in i.labels)


# --- the writers against a hand-built manifest --------------------------------


def _png(size: tuple[int, int] = SIZE) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size).save(buffer, format="PNG")
    return buffer.getvalue()


def _release() -> Release:
    return Release(
        dataset_id=uuid4(),
        tag="v1",
        manifest_hash="0" * 64,
        schema_version=1,
        asset_count=0,
        annotation_count=0,
    )


CAR = LabelClass(
    name="car",
    geometries=(GeometryType.BBOX, GeometryType.POLYGON),
    attributes=(
        Attribute(name="color", kind="select", options=("red", "blue"), default="red"),
        Attribute(name="parked", kind="boolean"),
        Attribute(name="speed", kind="number"),
        Attribute(name="note", kind="string"),
    ),
)


def _annotation(geometry: object, **attributes: object) -> ManifestAnnotation:
    return ManifestAnnotation.model_validate(
        {
            "id": uuid4(),
            "label_class": "car",
            "schema_version": 1,
            "geometry": geometry,
            "attributes": attributes,
            "provenance": "human",
        }
    )


def _content(blobs: dict[str, bytes]) -> ContentReader:
    def content(content_hash: str) -> BinaryIO:
        return BytesIO(blobs[content_hash])

    return content


def test_attribute_values_and_their_definitions_are_written(tmp_path: Path) -> None:
    annotation = _annotation(
        BboxGeometry(x=0.125, y=1, width=2, height=3),
        color="blue",
        parked=True,
        speed=2.5,
        note="a & <b>",
    )
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="a" * 64,
        uri="/a.png",
        width=SIZE[0],
        height=SIZE[1],
        annotations=(annotation,),
    )
    manifest = Manifest(schema_version=1, classes=(CAR,), assets=(asset,))
    CvatImagesExporter().export(
        _release(), manifest, tmp_path, content=_content({"a" * 64: _png()}), assignment=None
    )

    root = ElementTree.parse(tmp_path / "annotations.xml").getroot()
    specs = {
        spec.findtext("name"): (
            spec.findtext("input_type"),
            spec.findtext("default_value") or "",
            spec.findtext("values") or "",
        )
        for spec in root.findall("meta/task/labels/label/attributes/attribute")
    }
    assert specs == {
        "color": ("select", "red", "red\nblue"),
        "parked": ("checkbox", "", "false\ntrue"),
        "speed": ("number", "", ""),
        "note": ("text", "", ""),
    }
    assert root.findtext("meta/task/labels/label/type") == "any"
    (box,) = root.findall("image/box")
    assert (box.attrib["source"], box.attrib["xtl"], box.attrib["xbr"]) == (
        "manual",
        "0.125",
        "2.125",
    )
    assert {one.attrib["name"]: one.text for one in box.findall("attribute")} == {
        "color": "blue",
        "note": "a & <b>",
        "parked": "true",
        "speed": "2.5",
    }

    dataset = CvatImagesImporter().read(tmp_path)
    assert dataset.losses == ()
    (car,) = dataset.classes
    assert car.attributes == CAR.attributes
    (image,) = dataset.images
    assert [label.attributes for label in image.labels] == [annotation.attributes]


def _tracked(
    observed: Sequence[tuple[str | None, Sequence[tuple[int, object]]]],
) -> tuple[Manifest, dict[str, bytes]]:
    source_id = uuid4()
    positions = sorted({position for _, shapes in observed for position, _ in shapes})
    ids = {position: uuid4() for position in positions}
    drawn: dict[int, list[ManifestAnnotation]] = {position: [] for position in positions}
    tracks = []
    for external_id, shapes in observed:
        observations = []
        for position, geometry in shapes:
            annotation = _annotation(geometry)
            drawn[position].append(annotation)
            observations.append(
                ManifestObservation(
                    position=position,
                    timestamp=float(position),
                    asset_id=ids[position],
                    annotation_id=annotation.id,
                )
            )
        tracks.append(
            ManifestTrack(
                id=uuid4(),
                source_id=source_id,
                label_class="car",
                external_id=external_id,
                observations=tuple(observations),
            )
        )
    assets = tuple(
        ManifestAsset(
            asset_id=ids[position],
            content_hash=f"{index:064x}",
            uri=f"/frames/{position}.png",
            width=SIZE[0],
            height=SIZE[1],
            annotations=tuple(drawn[position]),
        )
        for index, position in enumerate(positions)
    )
    manifest = Manifest(
        manifest_version=TRACKED_MANIFEST_VERSION,
        schema_version=1,
        classes=(CAR,),
        assets=assets,
        tracks=tuple(tracks),
    )
    return manifest, {asset.content_hash: _png() for asset in assets}


BOX = BboxGeometry(x=1, y=1, width=4, height=4)


def test_a_track_id_that_is_no_integer_is_numbered_after_the_largest(tmp_path: Path) -> None:
    manifest, blobs = _tracked(
        [
            ("lane_a", [(0, BOX)]),
            ("7", [(0, BOX), (2, BOX)]),
            (None, [(1, BOX)]),
            ("07", [(2, BOX)]),
        ]
    )
    CvatVideoExporter().export(
        _release(), manifest, tmp_path, content=_content(blobs), assignment=None
    )
    (task,) = _read_video(tmp_path).values()
    tracks = task["tracks"]
    assert isinstance(tracks, dict)
    assert sorted(tracks, key=int) == ["7", "8", "9", "10"]
    # Track 7 is absent at 1 and back at 2; the task ends at 2, so nothing closes it.
    assert [row[:2] for row in tracks["7"][1]] == [(0, "0"), (1, "1"), (2, "0")]


def test_a_track_of_two_shape_types_is_refused(tmp_path: Path) -> None:
    polygon = PolygonGeometry(points=[(0, 0), (4, 0), (4, 4)])
    manifest, blobs = _tracked([("1", [(0, BOX), (1, polygon)])])
    with pytest.raises(ExportSourceUnreadable, match="a CVAT track holds one shape type"):
        CvatVideoExporter().export(
            _release(), manifest, tmp_path, content=_content(blobs), assignment=None
        )


def test_a_mixed_track_refuses_before_any_task_is_written(tmp_path: Path) -> None:
    polygon = PolygonGeometry(points=[(0, 0), (4, 0), (4, 4)])
    good, good_blobs = _tracked([("1", [(0, BOX)])])
    bad, bad_blobs = _tracked([("2", [(0, BOX), (1, polygon)])])
    manifest = Manifest(
        manifest_version=TRACKED_MANIFEST_VERSION,
        schema_version=1,
        classes=(CAR,),
        assets=good.assets + bad.assets,
        tracks=good.tracks + bad.tracks,
    )
    with pytest.raises(ExportSourceUnreadable, match="one shape type"):
        CvatVideoExporter().export(
            _release(),
            manifest,
            tmp_path,
            content=_content(good_blobs | bad_blobs),
            assignment=None,
        )
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("exporter", [CvatImagesExporter(), CvatVideoExporter()])
def test_a_control_character_refuses_the_export_before_anything_is_written(
    tmp_path: Path, exporter: CvatImagesExporter | CvatVideoExporter
) -> None:
    manifest, blobs = _tracked([("1", [(0, BOX)])])
    (asset,) = manifest.assets
    (annotation,) = asset.annotations
    dirty = asset.model_copy(
        update={"annotations": (annotation.model_copy(update={"attributes": {"note": "a\x01b"}}),)}
    )
    manifest = manifest.model_copy(update={"assets": (dirty,)})
    with pytest.raises(ExportSourceUnreadable, match="control character"):
        exporter.export(_release(), manifest, tmp_path, content=_content(blobs), assignment=None)
    assert list(tmp_path.iterdir()) == []


def test_skeleton_sub_labels_and_unknown_track_fields(tmp_path: Path) -> None:
    labels = (
        "<label><name>car</name><type>rectangle</type></label>"
        "<label><name>hand</name><type>skeleton</type></label>"
        "<label><name>1</name><type>points</type><parent>hand</parent></label>"
        "<label><name>foot</name><type>skeleton</type></label>"
        "<label><name>1</name><type>points</type><parent>foot</parent></label>"
    )
    root = _video_source(
        tmp_path / "src",
        '<track id="0" label="car" subset="Train">'
        '<box frame="0" outside="0" xtl="0" ytl="0" xbr="4" ybr="4"/></track>',
        size=1,
    )
    path = root / "annotations.xml"
    path.write_text(path.read_text(encoding="utf-8").replace(LABELS, labels), encoding="utf-8")
    dataset = CvatVideoImporter().read(root)
    assert [one.name for one in dataset.classes] == ["car"]
    reason = (
        "no imported shape and no label <type> gives it a geometry the domain holds; "
        "the class is not imported"
    )
    assert _losses(dataset) == {
        ("attribute", "car", "the track's subset field is not imported; the track is kept"): 1,
        ("class", "hand", reason): 1,
        ("class", "foot", reason): 1,
    }


def test_a_task_beyond_the_frame_bound_or_a_shifted_job_is_refused(tmp_path: Path) -> None:
    root = _video_source(tmp_path / "src", "", size=1)
    path = root / "annotations.xml"
    text = path.read_text(encoding="utf-8")
    path.write_text(text.replace("<size>1</size>", "<size>1000001</size>"), encoding="utf-8")
    with pytest.raises(ImportSourceUnreadable, match="more than the 1000000 frames read"):
        CvatVideoImporter().read(root)
    job = text.replace("<task>", "<job>").replace("</task>", "</job>")
    path.write_text(
        job.replace("<size>1</size>", "<size>1</size><start_frame>5</start_frame>"),
        encoding="utf-8",
    )
    with pytest.raises(ImportSourceUnreadable, match="a job export starting past frame 0"):
        CvatVideoImporter().read(root)
