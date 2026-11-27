"""MOTChallenge sequences in and out, with their ground-truth ids as tracks (#1170)."""

from __future__ import annotations

import configparser
import csv
from collections.abc import Iterator, Sequence
from io import BytesIO
from pathlib import Path
from typing import BinaryIO
from uuid import UUID, uuid4

import pytest
from PIL import Image
from tests.fixtures.media import write_image

from visionset.formats.mot import MotExporter, MotImporter
from visionset.kernel import ExportSourceUnreadable, ImportSourceUnreadable
from visionset.kernel.domain import (
    TRACKED_MANIFEST_VERSION,
    AssetProgress,
    BboxGeometry,
    ClassExportStatus,
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
    Release,
    ResizeStrategy,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    DatasetService,
    ImportService,
    JobService,
    ProjectService,
    ReleaseService,
    SourceService,
    TrackService,
    WorkspaceService,
)
from visionset.kernel.services.release_service import _compatibility, _Cropping

SIZE = (40, 30)
RATE = 10
EVERY_LOSS = (ImportLossKind.IMAGE, ImportLossKind.LABEL, ImportLossKind.ATTRIBUTE)


def _sequence(
    root: Path,
    name: str,
    rows: Sequence[str] | None,
    *,
    length: int = 3,
    absent: Sequence[int] = (),
    labels: Sequence[str] | None = ("person", "car"),
    seed: int = 0,
    info: dict[str, str] | None = None,
) -> Path:
    directory = root / name
    settings = {
        "name": name,
        "imDir": "img1",
        "frameRate": str(RATE),
        "seqLength": str(length),
        "imWidth": str(SIZE[0]),
        "imHeight": str(SIZE[1]),
        "imExt": ".png",
    } | (info or {})
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "seqinfo.ini").write_text(
        "[Sequence]\n" + "".join(f"{key}={value}\n" for key, value in settings.items()),
        encoding="utf-8",
    )
    for frame in range(1, length + 1):
        if frame not in absent:
            write_image(directory / "img1" / f"{frame:06d}.png", size=SIZE, seed=seed + frame)
    if rows is not None:
        (directory / "gt").mkdir(exist_ok=True)
        (directory / "gt" / "gt.txt").write_text("".join(f"{r}\n" for r in rows), encoding="utf-8")
    if labels is not None:
        (directory / "gt").mkdir(exist_ok=True)
        (directory / "gt" / "labels.txt").write_text(
            "".join(f"{one}\n" for one in labels), encoding="utf-8"
        )
    return root


def _labels_by_frame(dataset: ImportedDataset, name: str) -> dict[int, list[tuple[object, ...]]]:
    (sequence,) = [one for one in dataset.sequences if one.name == name]
    by_path = {image.path: image for image in dataset.images}
    return {
        position + 1: [
            (label.track, label.class_name, label.confidence, label.geometry)
            for label in by_path[frame.path].labels
        ]
        for position, frame in enumerate(sequence.frames)
    }


# --- reading ------------------------------------------------------------------


def test_a_sequence_is_its_frames_in_order_and_its_ids_are_tracks(tmp_path: Path) -> None:
    src = _sequence(
        tmp_path,
        "walk",
        ["2,7,1,2,10,8,1,2,-1", "1,7,1,2,10,8,1,2,-1", "1,3,0.5,4,6,6,0.25,1,-1"],
    )
    dataset = MotImporter().read(src)

    (sequence,) = dataset.sequences
    assert sequence.name == "walk"
    assert [str(frame.path) for frame in sequence.frames] == [
        f"walk/img1/00000{n}.png" for n in (1, 2, 3)
    ]
    assert [frame.timestamp for frame in sequence.frames] == [0.0, 0.1, 0.2]
    assert [(one.name, one.geometries) for one in dataset.classes] == [
        ("person", (GeometryType.BBOX,)),
        ("car", (GeometryType.BBOX,)),
    ]
    assert _labels_by_frame(dataset, "walk") == {
        1: [
            ("7", "car", None, BboxGeometry(x=1, y=2, width=10, height=8)),
            ("3", "person", 0.25, BboxGeometry(x=0.5, y=4, width=6, height=6)),
        ],
        2: [("7", "car", None, BboxGeometry(x=1, y=2, width=10, height=8))],
        3: [],
    }
    assert {(image.width, image.height) for image in dataset.images} == {SIZE}
    assert dataset.losses == ()


def test_without_a_class_table_a_class_is_named_by_its_number(tmp_path: Path) -> None:
    src = _sequence(tmp_path, "walk", ["1,1,1,1,4,4,1,3,-1"], labels=None)
    dataset = MotImporter().read(src)

    assert [one.name for one in dataset.classes] == ["3"]


def test_a_missing_frame_is_still_listed_so_its_position_stays_a_gap(tmp_path: Path) -> None:
    src = _sequence(tmp_path, "walk", ["3,1,1,1,4,4,1,1,-1"], absent=(2,))
    (sequence,) = MotImporter().read(src).sequences

    assert [str(frame.path).rsplit("/", 1)[1] for frame in sequence.frames] == [
        "000001.png",
        "000002.png",
        "000003.png",
    ]


def test_ignored_untracked_and_visible_rows_are_each_declared(tmp_path: Path) -> None:
    src = _sequence(
        tmp_path,
        "walk",
        [
            "1,1,1,1,4,4,0,1,-1",
            "1,-1,1,1,4,4,1,1,-1",
            "1,0,2,2,4,4,1,2,-1",
            "2,1,1,1,4,4,1,1,0.4",
            "3,1,1,1,4,4,1,1,0",
        ],
    )
    dataset = MotImporter().read(src)

    assert _labels_by_frame(dataset, "walk") == {
        1: [
            (None, "person", None, BboxGeometry(x=1, y=1, width=4, height=4)),
            (None, "car", None, BboxGeometry(x=2, y=2, width=4, height=4)),
        ],
        2: [("1", "person", None, BboxGeometry(x=1, y=1, width=4, height=4))],
        3: [("1", "person", None, BboxGeometry(x=1, y=1, width=4, height=4))],
    }
    assert sorted((loss.kind, loss.subject, loss.count) for loss in dataset.losses) == [
        (ImportLossKind.ATTRIBUTE, "car", 1),
        (ImportLossKind.ATTRIBUTE, "person", 1),
        (ImportLossKind.ATTRIBUTE, "person", 2),
        (ImportLossKind.LABEL, "person", 1),
    ]
    reasons = {(loss.kind, loss.count): loss.reason for loss in dataset.losses}
    assert "evaluation ignores" in reasons[(ImportLossKind.LABEL, 1)]
    assert "visibility" in reasons[(ImportLossKind.ATTRIBUTE, 2)]


def test_equal_ids_in_two_sequences_stay_in_their_own(tmp_path: Path) -> None:
    src = _sequence(tmp_path, "one", ["1,1,1,1,4,4,1,1,-1"])
    _sequence(src, "two", ["1,1,1,1,4,4,1,1,-1"], seed=10)
    dataset = MotImporter().read(src)

    assert [one.name for one in dataset.sequences] == ["one", "two"]
    assert _labels_by_frame(dataset, "one")[1][0][0] == "1"
    assert _labels_by_frame(dataset, "two")[1][0][0] == "1"


@pytest.mark.parametrize(
    ("row", "complaint"),
    [
        ("1,1,1,1,4,4,1,1", "has 8 fields"),
        ("1,1,1,1,4,4,1,-1,-1,-1", "has 10 fields"),
        ("1,1,a,1,4,4,1,1,-1", "bb_left 'a' is not a number"),
        ("1,1,nan,1,4,4,1,1,-1", "non-finite"),
        ("0,1,1,1,4,4,1,1,-1", "frame 0 is not a frame"),
        ("4,1,1,1,4,4,1,1,-1", "frame 4 is not a frame"),
        ("1.5,1,1,1,4,4,1,1,-1", "frame 1.5 is not a frame"),
        ("1,1.5,1,1,4,4,1,1,-1", "id 1.5 is not an integer"),
        ("1,1,1,1,0,4,1,1,-1", "no area"),
        ("1,1,1,1,4,-4,1,1,-1", "no area"),
        ("1,1,1,1,4,4,1.5,1,-1", "conf 1.5 is outside"),
        ("1,1,1,1,4,4,-1,1,-1", "conf -1 is outside"),
        ("1,1,1,1,4,4,1,1,2", "visibility 2"),
        ("1,1,1,1,4,4,1,1,-0.5", "visibility -0.5"),
        ("1,1,1,1,4,4,1,-1,-1", "class -1 is not a positive integer"),
        ("1,1,1,1,4,4,1,3,-1", "class 3 is not one of the 2"),
    ],
)
def test_a_malformed_row_is_refused_by_line(tmp_path: Path, row: str, complaint: str) -> None:
    src = _sequence(tmp_path, "walk", ["1,1,1,1,4,4,1,1,-1", row])
    with pytest.raises(ImportSourceUnreadable, match="walk/gt/gt.txt line 2") as refusal:
        MotImporter().read(src)
    assert complaint in str(refusal.value)


@pytest.mark.parametrize(
    ("info", "complaint"),
    [
        ({"seqLength": ""}, "does not give seqLength"),
        ({"seqLength": "0"}, "seqLength is '0'"),
        ({"seqLength": "2.5"}, "seqLength is '2.5'"),
        ({"frameRate": "0"}, "frameRate is '0'"),
        ({"imWidth": "wide"}, "imWidth is 'wide'"),
        ({"imExt": "png"}, "not a file suffix"),
        ({"imDir": "../img1"}, "leaves the source"),
        ({"name": "a\tb"}, "control characters"),
    ],
)
def test_a_malformed_seqinfo_is_refused(
    tmp_path: Path, info: dict[str, str], complaint: str
) -> None:
    src = _sequence(tmp_path, "walk", None, info=info)
    with pytest.raises(ImportSourceUnreadable, match="walk/seqinfo.ini") as refusal:
        MotImporter().read(src)
    assert complaint in str(refusal.value)


def test_a_seqinfo_without_its_section_is_refused(tmp_path: Path) -> None:
    src = _sequence(tmp_path, "walk", None)
    (src / "walk" / "seqinfo.ini").write_text("[Other]\nname=walk\n", encoding="utf-8")
    with pytest.raises(ImportSourceUnreadable, match=r"no \[Sequence\] section"):
        MotImporter().read(src)


def test_a_source_without_a_sequence_is_refused(tmp_path: Path) -> None:
    write_image(tmp_path / "img1" / "000001.png", size=SIZE)
    with pytest.raises(ImportSourceUnreadable, match="holds no seqinfo.ini"):
        MotImporter().read(tmp_path)


def test_two_directories_naming_one_sequence_are_refused(tmp_path: Path) -> None:
    src = _sequence(tmp_path, "a", None, info={"name": "walk"})
    _sequence(src, "b", None, info={"name": "walk"})
    with pytest.raises(ImportSourceUnreadable, match="both name the sequence 'walk'"):
        MotImporter().read(src)


@pytest.mark.parametrize(
    ("labels", "complaint"),
    [(["person", "", "car"], "line 2 names no class"), (["car", "car"], "given twice")],
)
def test_a_malformed_class_table_is_refused(
    tmp_path: Path, labels: list[str], complaint: str
) -> None:
    src = _sequence(tmp_path, "walk", ["1,1,1,1,4,4,1,1,-1"], labels=labels)
    with pytest.raises(ImportSourceUnreadable, match=complaint):
        MotImporter().read(src)


# --- importing, releasing and exporting --------------------------------------


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

    def run(self, name: str, src: Path, *kinds: ImportLossKind) -> tuple[UUID, ImportRun]:
        project = self.projects.create(name)
        consent = ImportConsent(kinds=frozenset(kinds))
        return project.id, self.imports.commit(project.id, MotImporter(), src, consent=consent)

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

    def sequences(self, run: ImportRun) -> dict[str, dict[str, list[tuple[object, ...]]]]:
        """Every track of the run, by sequence name and external id, as what it observes."""
        found: dict[str, dict[str, list[tuple[object, ...]]]] = {}
        for source_id in run.source_ids:
            name = self.sources.get(source_id).name
            timing = {o.position: o.timestamp for o in self.sources.occurrences(source_id)}
            tracks = found.setdefault(name, {})
            for detail in self.tracks.list(source_id):
                assert detail.track.external_id is not None
                observed: list[tuple[object, ...]] = []
                for frame in detail.observations:
                    annotation = self.annotations.get(frame.annotation_id)
                    observed.append(
                        (
                            frame.position,
                            timing[frame.position],
                            annotation.label_class,
                            annotation.geometry,
                            annotation.confidence,
                        )
                    )
                tracks[detail.track.external_id] = observed
        return found


@pytest.fixture
def world(tmp_path: Path) -> Iterator[World]:
    made = World(tmp_path)
    yield made
    made.workspace.close()


def _two_sequences(root: Path) -> Path:
    """Two sequences sharing id 1, a missing frame, an occlusion, and three rows no track keeps."""
    _sequence(
        root,
        "MOT-01",
        [
            "1,1,1,2,10,8,1,1,-1",
            "1,2,20,4,8,12,1,2,-1",
            "1,5,3,3,4,4,0,1,-1",
            "2,1,2,2,10,8,1,1,0.75",
            "2,2,21,4,8,12,1,2,-1",
            "2,-1,30,20,5,5,1,1,-1",
            "4,1,4.5,2.25,10,8,1,1,-1",
            "4,3,5,5,6,6,0.625,2,-1",
            "5,1,5,2,10,8,1,1,-1",
            "5,2,24,4,8,12,1,2,-1",
        ],
        length=5,
        absent=(3,),
    )
    return _sequence(
        root,
        "MOT-02",
        ["1,1,6,6,7,7,1,2,-1", "3,1,8,6,7,7,1,2,-1", "3,9,1,1,3,3,1,1,-1"],
        seed=50,
    )


def test_ids_land_as_tracks_and_a_gap_or_occlusion_is_reappearance(world: World) -> None:
    _, run = world.run("mot", _two_sequences(world.root / "src"), *EVERY_LOSS)

    tracks = world.sequences(run)
    assert {name: sorted(found) for name, found in tracks.items()} == {
        "MOT-01": ["1", "2", "3"],
        "MOT-02": ["1", "9"],
    }
    assert [o[0] for o in tracks["MOT-01"]["1"]] == [0, 1, 3, 4]
    assert [o[0] for o in tracks["MOT-01"]["2"]] == [0, 1, 4]
    assert [o[0] for o in tracks["MOT-02"]["1"]] == [0, 2]
    assert tracks["MOT-01"]["3"][0][2:] == ("car", BboxGeometry(x=5, y=5, width=6, height=6), 0.625)
    first, second = run.source_ids
    ours, theirs = (
        {d.track.external_id: d.track.id for d in world.tracks.list(one)} for one in (first, second)
    )
    assert ours["1"] != theirs["1"]
    assert [o.position for o in world.sources.occurrences(first)] == [0, 1, 3, 4]


def _read_back(dest: Path) -> dict[str, tuple[dict[str, str], list[tuple[object, ...]]]]:
    """The exported layout through ``configparser`` and ``csv`` alone, as a MOT tool reads it."""
    found = {}
    for seqinfo in sorted(dest.glob("*/seqinfo.ini")):
        parser = configparser.ConfigParser()
        parser.optionxform = str  # type: ignore[assignment,method-assign]
        parser.read(seqinfo, encoding="utf-8")
        info = dict(parser["Sequence"])
        directory = seqinfo.parent
        names = (directory / "gt" / "labels.txt").read_text(encoding="utf-8").splitlines()
        with (directory / "gt" / "gt.txt").open(encoding="utf-8", newline="") as handle:
            rows = [
                (
                    int(row[0]),
                    int(row[1]),
                    *(float(value) for value in row[2:7]),
                    names[int(row[7]) - 1],
                    float(row[8]),
                )
                for row in csv.reader(handle)
            ]
        frames = sorted(path.name for path in (directory / info["imDir"]).iterdir())
        info["frames"] = ",".join(frames)
        found[info["name"]] = (info, rows)
    return found


def test_an_export_is_a_mot_layout_an_independent_reader_takes(world: World) -> None:
    project_id, run = world.run("mot", _two_sequences(world.root / "src"), *EVERY_LOSS)
    release_id = world.release(project_id, run)
    assert world.releases.manifest(release_id).manifest_version == TRACKED_MANIFEST_VERSION
    dest = world.root / "out"
    report = world.releases.export(release_id, MotExporter(), dest, allow_lossy=True).compatibility

    first, second = (str(one) for one in run.source_ids)
    sequences = _read_back(dest)
    assert sorted(sequences) == sorted([first, second])
    info, rows = sequences[first]
    assert info == {
        "name": first,
        "imDir": "img1",
        "frameRate": "10",
        "seqLength": "5",
        "imWidth": "40",
        "imHeight": "30",
        "imExt": ".png",
        "frames": "000001.png,000002.png,000004.png,000005.png",
    }
    assert rows == [
        (1, 1, 1.0, 2.0, 10.0, 8.0, 1.0, "person", -1.0),
        (1, 2, 20.0, 4.0, 8.0, 12.0, 1.0, "car", -1.0),
        (2, 1, 2.0, 2.0, 10.0, 8.0, 1.0, "person", -1.0),
        (2, 2, 21.0, 4.0, 8.0, 12.0, 1.0, "car", -1.0),
        (4, 1, 4.5, 2.25, 10.0, 8.0, 1.0, "person", -1.0),
        (4, 3, 5.0, 5.0, 6.0, 6.0, 0.625, "car", -1.0),
        (5, 1, 5.0, 2.0, 10.0, 8.0, 1.0, "person", -1.0),
        (5, 2, 24.0, 4.0, 8.0, 12.0, 1.0, "car", -1.0),
    ]
    info, rows = sequences[second]
    assert (info["seqLength"], info["frames"]) == ("3", "000001.png,000003.png")
    assert [row[:2] for row in rows] == [(1, 1), (3, 1), (3, 9)]

    # The one box no track observes is the one the report drops.
    assert (report.excluded_annotations, report.excluded_assets) == (1, 1)
    dropped = [one for one in report.classes if one.status is ClassExportStatus.DROPPED]
    assert [(one.label_class, one.annotations) for one in dropped] == [("person", 1)]
    assert dropped[0].reason is not None
    assert "no track observes" in dropped[0].reason
    supported = {
        one.label_class: one.annotations
        for one in report.classes
        if one.status is ClassExportStatus.SUPPORTED
    }
    assert supported == {"person": 5, "car": 6}
    assert sum(supported.values()) == sum(len(rows) for _, rows in sequences.values())


def test_import_release_export_reimport_keeps_every_track_where_it_was(world: World) -> None:
    project_id, run = world.run("mot", _two_sequences(world.root / "src"), *EVERY_LOSS)
    dest = world.root / "out"
    world.releases.export(world.release(project_id, run), MotExporter(), dest, allow_lossy=True)
    _, again = world.run("again", dest, ImportLossKind.IMAGE)

    before, after = world.sequences(run), world.sequences(again)
    names = {world.sources.get(one).name: str(one) for one in run.source_ids}
    assert after == {names[name]: tracks for name, tracks in before.items()}
    assert len(again.source_ids) == 2
    assert {loss.kind for loss in again.losses} == {ImportLossKind.IMAGE}


def test_a_static_sequence_keeps_every_track_through_a_round_trip(world: World) -> None:
    src = _sequence(
        world.root / "src",
        "still",
        [
            "1,7,1,2,10,8,1,2,-1",
            "2,7,1,2,10,8,1,2,-1",
            "3,7,3,2,10,8,1,2,-1",
            "1,4,20,4,8,12,1,1,-1",
        ],
    )
    pictures = sorted((src / "still" / "img1").iterdir())
    for later in pictures[1:]:
        later.write_bytes(pictures[0].read_bytes())
    project_id, run = world.run("still", src)

    assert run.losses == ()
    assert len(run.created_asset_ids) == 1
    before = world.sequences(run)
    assert {key: [seen[0] for seen in one] for key, one in before["still"].items()} == {
        "7": [0, 1, 2],
        "4": [0],
    }

    dest = world.root / "out"
    world.releases.export(world.release(project_id, run), MotExporter(), dest, allow_lossy=True)
    _, again = world.run("again", dest)
    (source_id,) = run.source_ids
    assert world.sequences(again) == {str(source_id): before["still"]}


def test_a_release_with_no_track_writes_nothing_and_drops_every_box(world: World) -> None:
    src = _sequence(world.root / "src", "walk", ["1,-1,1,1,4,4,1,1,-1"])
    project_id, run = world.run("mot", src, ImportLossKind.ATTRIBUTE)
    dest = world.root / "out"
    result = world.releases.export(
        world.release(project_id, run), MotExporter(), dest, allow_lossy=True
    )

    assert result.compatibility.excluded_annotations == 1
    assert not result.compatibility.compatible
    assert [path.name for path in dest.iterdir()] == ["visionset-export-report.json"]


# --- the writer against a hand-built manifest ---------------------------------


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


def _manifest(
    tracks: Sequence[tuple[str | None, Sequence[tuple[int, float]]]],
    *,
    sizes: Sequence[tuple[int, int]] = (),
    confidence: float | None = None,
) -> tuple[Manifest, dict[str, bytes]]:
    """One asset per position, one box per observation, and the bytes behind each asset."""
    source_id = uuid4()
    positions = sorted({position for _, observed in tracks for position, _ in observed})
    ids = {position: uuid4() for position in positions}
    boxes: dict[int, list[ManifestAnnotation]] = {position: [] for position in positions}
    manifest_tracks = []
    for external_id, observed in tracks:
        observations = []
        for position, timestamp in observed:
            annotation = ManifestAnnotation(
                id=uuid4(),
                label_class="person",
                schema_version=1,
                geometry=BboxGeometry(x=1, y=1, width=4, height=4),
                provenance="import",
                confidence=confidence,
            )
            boxes[position].append(annotation)
            observations.append(
                ManifestObservation(
                    position=position,
                    timestamp=timestamp,
                    asset_id=ids[position],
                    annotation_id=annotation.id,
                )
            )
        manifest_tracks.append(
            ManifestTrack(
                id=uuid4(),
                source_id=source_id,
                label_class="person",
                external_id=external_id,
                observations=tuple(observations),
            )
        )
    sized = list(sizes) or [SIZE] * len(positions)
    assets = tuple(
        ManifestAsset(
            asset_id=ids[position],
            content_hash=f"{index:064x}",
            uri=f"/frames/{position}.png",
            width=size[0],
            height=size[1],
            annotations=tuple(boxes[position]),
        )
        for index, (position, size) in enumerate(zip(positions, sized, strict=True))
    )
    manifest = Manifest(
        manifest_version=TRACKED_MANIFEST_VERSION,
        schema_version=1,
        classes=(LabelClass(name="person", geometries=(GeometryType.BBOX,)),),
        assets=assets,
        tracks=tuple(manifest_tracks),
    )
    return manifest, {asset.content_hash: _png() for asset in assets}


def _export(manifest: Manifest, blobs: dict[str, bytes], dest: Path) -> None:
    def content(content_hash: str) -> BinaryIO:
        return BytesIO(blobs[content_hash])

    MotExporter().export(_release(), manifest, dest, content=content, assignment=None)


def _ids(dest: Path) -> dict[int, list[int]]:
    (gt,) = dest.glob("*/gt/gt.txt")
    found: dict[int, list[int]] = {}
    for row in gt.read_text(encoding="utf-8").splitlines():
        frame, identity = row.split(",")[:2]
        found.setdefault(int(frame), []).append(int(identity))
    return found


def test_an_id_that_is_no_positive_integer_is_numbered_after_the_largest(tmp_path: Path) -> None:
    manifest, blobs = _manifest(
        [("4", [(0, 0.0)]), ("walker", [(0, 0.0)]), (None, [(1, 0.1)]), ("007", [(1, 0.1)])]
    )
    _export(manifest, blobs, tmp_path)

    by_external = {track.external_id: track.observations[0].position for track in manifest.tracks}
    ids = _ids(tmp_path)
    assert sorted(ids[1]) == [4, 5]
    assert sorted(ids[2]) == [6, 7]
    assert by_external["4"] == 0


def test_a_confidence_is_written_as_conf(tmp_path: Path) -> None:
    manifest, blobs = _manifest([("1", [(0, 0.0), (2, 0.5)])], confidence=0.375)
    _export(manifest, blobs, tmp_path)

    (gt,) = tmp_path.glob("*/gt/gt.txt")
    assert gt.read_text(encoding="utf-8") == "1,1,1,1,4,4,0.375,1,-1\n3,1,1,1,4,4,0.375,1,-1\n"
    (seqinfo,) = tmp_path.glob("*/seqinfo.ini")
    assert "frameRate=4\n" in seqinfo.read_text(encoding="utf-8")


def test_a_sequence_of_two_sizes_is_refused(tmp_path: Path) -> None:
    manifest, blobs = _manifest([("1", [(0, 0.0), (1, 0.1)])], sizes=[SIZE, (20, 10)])
    with pytest.raises(ExportSourceUnreadable, match="2 sizes"):
        _export(manifest, blobs, tmp_path)


@pytest.mark.parametrize("observed", [[(0, 0.0)], [(0, 0.0), (1, 1e7)]])
def test_a_frame_rate_nothing_observed_can_give_is_refused(
    tmp_path: Path, observed: list[tuple[int, float]]
) -> None:
    manifest, blobs = _manifest([("1", observed)])
    with pytest.raises(ExportSourceUnreadable, match="frame rate cannot be derived"):
        _export(manifest, blobs, tmp_path)


def test_a_cropped_away_untracked_label_is_counted_once(tmp_path: Path) -> None:
    manifest, _ = _manifest([("1", [(0, 0.0), (1, 0.1)])])
    first, second = manifest.assets
    loose = [
        ManifestAnnotation(
            id=uuid4(),
            label_class="person",
            schema_version=1,
            geometry=BboxGeometry(x=2, y=2, width=3, height=3),
            provenance="human",
        )
        for _ in range(3)
    ]
    tracked = first.annotations[0]
    manifest = manifest.model_copy(
        update={
            "assets": (
                first.model_copy(update={"annotations": (*first.annotations, *loose)}),
                second,
            )
        }
    )
    cropping = _Cropping(
        strategy=ResizeStrategy.FILL,
        dropped=frozenset({loose[0].id, tracked.id}),
        clipped=frozenset({loose[1].id}),
    )
    report = _compatibility(_release(), manifest, MotExporter(), cropping=cropping)

    rows = sorted(
        (one.status.value, one.annotations, one.cropped_by is not None) for one in report.classes
    )
    assert rows == [("dropped", 2, False), ("dropped", 2, True), ("supported", 1, False)]
    assert report.excluded_annotations == 4
