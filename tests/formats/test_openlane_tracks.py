"""OpenLane segments import as image sequences, and their lane track ids as tracks (#1182)."""

from __future__ import annotations

import json
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from tests.fixtures.media import write_image

from visionset.formats.lanes import OpenLane2dImporter
from visionset.kernel import AssetNotInJob, ImportSourceUnreadable
from visionset.kernel.domain import (
    SEQUENCED_MANIFEST_VERSION,
    AnnotationJob,
    AssetProgress,
    BatchState,
    ImportConsent,
    ImportLossKind,
    ImportRun,
    SourceKind,
    TrackDetail,
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

TICK = 100_000_000
SIZE = (32, 24)
LEFT = [[1.0, 20.0], [5.0, 12.0], [9.0, 4.0]]
RIGHT = [[20.0, 20.0], [22.0, 12.0], [24.0, 4.0]]

#: One frame: its number, the seed of its picture (``None`` writes no picture), its lanes.
Frame = tuple[int, int | None, list[dict[str, Any]]]


def _lane(track_id: object, *, category: int = 1, uv: list[list[float]] = LEFT) -> dict[str, Any]:
    return {
        "category": category,
        "visibility": [1] * len(uv),
        "uv": uv,
        "track_id": track_id,
    }


def _segment(root: Path, name: str, frames: Sequence[Frame], *, split: str = "training") -> Path:
    for number, seed, lanes in frames:
        picture = f"images/{split}/{name}/{number}.png"
        if seed is not None:
            write_image(root / picture, size=SIZE, seed=seed)
        document = root / "labels" / split / name / f"{number}.json"
        document.parent.mkdir(parents=True, exist_ok=True)
        document.write_text(
            json.dumps(
                {"intrinsic": None, "extrinsic": None, "file_path": picture, "lane_lines": lanes}
            ),
            encoding="utf-8",
        )
    return root


def _three(seeds: Sequence[int | None] = (1, 2, 3)) -> list[Frame]:
    return [
        (number * TICK, seed, [_lane(7), _lane(8, category=8, uv=RIGHT)])
        for number, seed in enumerate(seeds)
    ]


# --- reading ------------------------------------------------------------------


def test_a_segment_is_a_sequence_ordered_by_its_frame_numbers(tmp_path: Path) -> None:
    src = _segment(
        tmp_path,
        "segment-1",
        [(3 * TICK, 3, [_lane(7)]), (TICK, 1, [_lane(7)]), (2 * TICK + TICK // 2, 2, [_lane(7)])],
    )
    dataset = OpenLane2dImporter().read(src)

    (sequence,) = dataset.sequences
    assert sequence.name == "segment-1"
    assert [str(frame.path) for frame in sequence.frames] == [
        f"images/training/segment-1/{n}.png" for n in (TICK, 2 * TICK + TICK // 2, 3 * TICK)
    ]
    assert [frame.timestamp for frame in sequence.frames] == [0.0, 1.5, 2.0]
    assert {label.track for image in dataset.images for label in image.labels} == {"7"}
    assert dataset.losses == ()


def test_the_exporter_s_lane_echo_is_no_identity_even_in_a_segment(tmp_path: Path) -> None:
    src = _segment(tmp_path, "segment-1", [(0, 1, [_lane("lane_0"), _lane("road")])])
    (image,) = OpenLane2dImporter().read(src).images

    assert [label.track for label in image.labels] == [None, "road"]


@pytest.mark.parametrize("track_id", [1.5, True, "  ", [1]])
def test_a_track_id_that_is_no_integer_or_name_is_an_attribute_loss(
    tmp_path: Path, track_id: object
) -> None:
    dataset = OpenLane2dImporter().read(
        _segment(tmp_path, "segment-1", [(0, 1, [_lane(track_id)])])
    )

    assert dataset.images[0].labels[0].track is None
    assert [(loss.kind, loss.count) for loss in dataset.losses] == [(ImportLossKind.ATTRIBUTE, 1)]


def test_a_name_spelling_an_integer_id_of_its_segment_is_a_loss(tmp_path: Path) -> None:
    frames: list[Frame] = [(0, 1, [_lane(7), _lane("7", uv=RIGHT)]), (TICK, 2, [_lane("8")])]
    dataset = OpenLane2dImporter().read(_segment(tmp_path, "segment-1", frames))

    first, second = sorted(dataset.images, key=lambda image: str(image.path))
    assert [label.track for label in first.labels] == ["7", None]
    assert [label.track for label in second.labels] == ["8"]
    (loss,) = dataset.losses
    assert (loss.kind, loss.count) == (ImportLossKind.ATTRIBUTE, 1)
    assert "spelling an integer" in loss.reason


def test_a_segment_name_no_source_can_carry_is_refused_on_reading(tmp_path: Path) -> None:
    src = _segment(tmp_path, "segment-\t1", [(0, 1, [_lane(7)])])
    with pytest.raises(ImportSourceUnreadable, match="control characters"):
        OpenLane2dImporter().read(src)


@pytest.mark.parametrize("directory", ["train", "segment-1"])
def test_no_sequence_without_a_segment_of_numbered_frames_and_its_ids_are_a_loss(
    tmp_path: Path, directory: str
) -> None:
    frames: list[Frame] = [(0, 1, [_lane(7)])]
    src = _segment(tmp_path, directory, frames)
    if directory.startswith("segment-"):
        (src / "labels" / "training" / directory / "cover.json").write_text(
            json.dumps({"file_path": "images/training/x.png", "lane_lines": []}), encoding="utf-8"
        )
    dataset = OpenLane2dImporter().read(src)

    assert dataset.sequences == ()
    (loss,) = dataset.losses
    assert (loss.kind, loss.count) == (ImportLossKind.ATTRIBUTE, 1)
    assert "outside a segment-* sequence" in loss.reason


# --- importing ----------------------------------------------------------------


class Imported:
    def __init__(self, tmp_path: Path) -> None:
        self.root = tmp_path
        self.workspace = WorkspaceService.init(tmp_path / "ws")
        self.project = ProjectService(self.workspace).create("lanes")
        self.imports = ImportService(self.workspace)
        self.sources = SourceService(self.workspace)
        self.tracks = TrackService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.annotations = AnnotationService(self.workspace)

    def run(self, src: Path, *kinds: ImportLossKind) -> ImportRun:
        consent = ImportConsent(kinds=frozenset(kinds))
        return self.imports.commit(self.project.id, OpenLane2dImporter(), src, consent=consent)

    def tracked(self, source_id: UUID) -> dict[str, TrackDetail]:
        found = {d.track.external_id: d for d in self.tracks.list(source_id)}
        assert None not in found
        return {key: value for key, value in found.items() if key is not None}

    def working(self, batch_id: UUID) -> AnnotationJob:
        if self.batches.get(batch_id).state is BatchState.DRAFT:
            self.batches.approve(batch_id)
        self.batches.start(batch_id)
        (job,) = self.batches.jobs(batch_id)
        self.jobs.start(job.id)
        return self.jobs.get(job.id)

    def settle(self, job: AnnotationJob, batch_id: UUID) -> None:
        for asset_id, progress in self.jobs.get(job.id).progress.items():
            if progress is not AssetProgress.ANNOTATED:
                self.jobs.mark(job.id, asset_id, AssetProgress.ANNOTATED)
        self.jobs.complete(job.id)
        self.batches.complete(batch_id)


@pytest.fixture
def imported(tmp_path: Path) -> Iterator[Imported]:
    made = Imported(tmp_path)
    yield made
    made.workspace.close()


def _positions(detail: TrackDetail) -> list[int]:
    return [frame.position for frame in detail.observations]


def test_track_ids_land_as_tracks_over_a_new_image_sequence(imported: Imported) -> None:
    run = imported.run(_segment(imported.root / "src", "segment-1", _three()))

    assert run.losses == ()
    assert run.tracks_written == 2
    (source_id,) = run.source_ids
    source = imported.sources.get(source_id)
    assert (source.kind, source.name, source.video, source.frame) == (
        SourceKind.IMAGE_SEQUENCE,
        "segment-1",
        None,
        None,
    )
    occurrences = imported.sources.occurrences(source_id)
    assert [(o.position, o.timestamp) for o in occurrences] == [(0, 0.0), (1, 1.0), (2, 2.0)]
    assert [o.asset_id for o in occurrences] == list(run.created_asset_ids)

    tracks = imported.tracked(source_id)
    assert {key: d.track.label_class for key, d in tracks.items()} == {
        "7": "white-dash",
        "8": "yellow-solid",
    }
    for detail in tracks.values():
        assert _positions(detail) == [0, 1, 2]
        for frame in detail.observations:
            annotation = imported.annotations.get(frame.annotation_id)
            assert (annotation.asset_id, annotation.label_class, annotation.provenance) == (
                frame.asset_id,
                detail.track.label_class,
                "import",
            )
    with imported.workspace.unit_of_work() as uow:
        assert {uow.assets.get(a).source_id for a in run.created_asset_ids} == {source_id}  # type: ignore[union-attr]


def test_duplicate_content_frames_are_two_occurrences_of_one_asset(imported: Imported) -> None:
    run = imported.run(_segment(imported.root / "src", "segment-1", _three(seeds=(1, 1, 3))))

    assert run.losses == ()
    (source_id,) = run.source_ids
    first, second, third = imported.sources.occurrences(source_id)
    assert first.asset_id == second.asset_id != third.asset_id
    tracks = imported.tracked(source_id).values()
    assert [_positions(d) for d in tracks] == [[0, 1, 2], [0, 1, 2]]
    on_shared = [f.annotation_id for d in tracks for f in d.observations if f.position < 2]
    assert len(set(on_shared)) == 4
    assert {imported.annotations.get(one).asset_id for one in on_shared} == {first.asset_id}


def test_a_repeated_frame_is_judged_in_frame_order_not_path_order(imported: Imported) -> None:
    early, late = 9 * TICK, 10 * TICK
    frames: list[Frame] = [(early, 1, [_lane(7)]), (late, 1, [_lane(7)]), (11 * TICK, 2, [])]
    run = imported.run(_segment(imported.root / "src", "segment-1", frames))

    assert run.losses == ()
    (source_id,) = run.source_ids
    first, second, _ = imported.sources.occurrences(source_id)
    assert first.asset_id == second.asset_id
    with imported.workspace.unit_of_work() as uow:
        asset = uow.assets.get(first.asset_id)
    assert asset is not None
    assert asset.uri.endswith(f"/{early}.png")
    assert _positions(imported.tracked(source_id)["7"]) == [0, 1]


def test_a_missing_frame_is_a_gap_the_tracks_reappear_after(imported: Imported) -> None:
    run = imported.run(
        _segment(imported.root / "src", "segment-1", _three(seeds=(1, None, 3))),
        ImportLossKind.IMAGE,
    )

    (source_id,) = run.source_ids
    assert [o.position for o in imported.sources.occurrences(source_id)] == [0, 2]
    assert [_positions(d) for d in imported.tracked(source_id).values()] == [[0, 2], [0, 2]]
    assert [loss.kind for loss in run.losses] == [ImportLossKind.IMAGE]


def test_two_segments_with_one_id_are_two_sources_and_two_tracks(imported: Imported) -> None:
    src = _segment(imported.root / "src", "segment-1", _three())
    _segment(src, "segment-2", _three(seeds=(4, 5, 6)), split="validation")
    run = imported.run(src)

    first, second = run.source_ids
    assert first != second
    ours, theirs = imported.tracked(first)["7"], imported.tracked(second)["7"]
    assert ours.track.id != theirs.track.id
    assert {f.asset_id for f in ours.observations}.isdisjoint(
        {f.asset_id for f in theirs.observations}
    )


def test_a_second_import_never_merges_into_the_first(imported: Imported) -> None:
    first = imported.run(_segment(imported.root / "one", "segment-1", _three()))
    second = imported.run(_segment(imported.root / "two", "segment-1", _three(seeds=(4, 5, 6))))

    (ours,), (theirs,) = first.source_ids, second.source_ids
    assert ours != theirs
    assert imported.tracked(ours)["7"].track.id != imported.tracked(theirs)["7"].track.id
    assert _positions(imported.tracked(ours)["7"]) == [0, 1, 2]


def test_running_the_same_source_again_writes_no_source_and_no_track(imported: Imported) -> None:
    src = _segment(imported.root / "src", "segment-1", _three())
    first = imported.run(src)
    plan = imported.imports.inspect(imported.project.id, OpenLane2dImporter(), src)
    assert (plan.sequences, plan.tracks, plan.new_annotations) == (0, 0, 0)
    again = imported.run(src)

    assert (again.batch_id, again.source_ids, again.tracks_written) == (None, (), 0)
    assert [s.id for s in imported.sources.list(imported.project.id)] == list(first.source_ids)


def test_a_new_frame_in_a_rerun_is_a_new_sequence_over_only_the_new_labels(
    imported: Imported,
) -> None:
    src = _segment(imported.root / "src", "segment-1", _three())
    _segment(src, "segment-2", _three(seeds=(5, 6, 7)), split="validation")
    ours, untouched = imported.run(src).source_ids
    _segment(src, "segment-1", [(3 * TICK, 4, [_lane(7)])])
    plan = imported.imports.inspect(imported.project.id, OpenLane2dImporter(), src)
    assert (plan.sequences, plan.tracks) == (1, 1)
    (theirs,) = imported.run(src).source_ids

    assert len(imported.sources.list(imported.project.id)) == 3
    assert untouched != theirs
    assert imported.sources.get(theirs).name == "segment-1"

    assert [o.position for o in imported.sources.occurrences(theirs)] == [0, 1, 2, 3]
    assert {key: _positions(d) for key, d in imported.tracked(theirs).items()} == {"7": [3]}
    assert _positions(imported.tracked(ours)["7"]) == [0, 1, 2]


def test_an_id_a_track_cannot_hold_stays_a_label_and_is_declared(imported: Imported) -> None:
    frames: list[Frame] = [
        (0, 1, [_lane(7), _lane(7, uv=RIGHT)]),
        (TICK, 2, [_lane(7, category=8)]),
    ]
    src = _segment(imported.root / "src", "segment-1", frames)
    plan = imported.imports.inspect(imported.project.id, OpenLane2dImporter(), src)
    assert (plan.sequences, plan.tracks, plan.new_annotations) == (1, 1, 3)
    assert sorted((loss.kind, loss.subject, loss.count) for loss in plan.losses) == [
        (ImportLossKind.ATTRIBUTE, "white-dash", 1),
        (ImportLossKind.ATTRIBUTE, "yellow-solid", 1),
    ]

    run = imported.run(src, ImportLossKind.ATTRIBUTE)
    (source_id,) = run.source_ids
    (track,) = imported.tracked(source_id).values()
    assert (track.track.label_class, _positions(track)) == ("white-dash", [0])
    assert run.annotations_written == 3


def test_a_pasted_copy_of_an_imported_label_is_untracked(imported: Imported) -> None:
    run = imported.run(_segment(imported.root / "src", "segment-1", _three()))
    (source_id,) = run.source_ids
    job = imported.working(run.batch_id)  # type: ignore[arg-type]
    detail = imported.tracked(source_id)["7"]
    copied = imported.annotations.get(detail.observations[0].annotation_id)
    (pasted,) = imported.annotations.add(
        job.id,
        [
            copied.model_copy(
                update={"id": uuid4(), "provenance": "human", "confidence": None, "job_id": None}
            )
        ],
    )

    with imported.workspace.unit_of_work() as uow:
        assert uow.observation_of(pasted.id) is None
    assert imported.tracks.get(detail.track.id) == detail


def test_a_correction_batch_cannot_restructure_an_imported_track(imported: Imported) -> None:
    run = imported.run(_segment(imported.root / "src", "segment-1", _three()))
    batch_id = run.batch_id
    assert batch_id is not None
    (source_id,) = run.source_ids
    imported.settle(imported.working(batch_id), batch_id)
    detail = imported.tracked(source_id)["7"]
    first = detail.observations[0]

    correction = imported.batches.create_correction(batch_id, "fix", [first.asset_id])
    fix = imported.working(correction.id)
    with pytest.raises(AssetNotInJob):
        imported.tracks.split(fix.id, detail.track.id, detail.observations[1].occurrence_id)
    with pytest.raises(AssetNotInJob):
        imported.tracks.change_class(fix.id, detail.track.id, "yellow-solid")
    assert _positions(imported.tracks.unobserve(fix.id, detail.track.id, first.occurrence_id)) == [
        1,
        2,
    ]


def test_an_imported_track_releases_and_a_rerun_keeps_the_hash(imported: Imported) -> None:
    src = _segment(imported.root / "src", "segment-1", _three())
    run = imported.run(src)
    batch_id = run.batch_id
    assert batch_id is not None
    imported.settle(imported.working(batch_id), batch_id)
    DatasetService(imported.workspace).promote(batch_id)
    dataset_id = ProjectService(imported.workspace).get_dataset(imported.project.id).id
    releases = ReleaseService(imported.workspace)
    first = releases.publish(dataset_id, "v1")
    manifest = releases.manifest(first.id)

    assert manifest.manifest_version == SEQUENCED_MANIFEST_VERSION
    (listed,) = manifest.sources
    assert [o.position for o in listed.occurrences] == [0, 1, 2]
    assert sorted(
        (t.external_id, [o.position for o in t.observations]) for t in manifest.tracks
    ) == [
        ("7", [0, 1, 2]),
        ("8", [0, 1, 2]),
    ]
    assert imported.run(src).batch_id is None
    assert releases.publish(dataset_id, "v2").manifest_hash == first.manifest_hash
