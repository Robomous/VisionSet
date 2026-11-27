"""A frame whose bytes repeat another keeps its labels when it is in a sequence (#1197).

See ``docs/content/architecture/decisions/a-track-observes-frame-occurrences.md``:
an asset at several occurrences needs one annotation per occurrence it is tracked at.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from pathlib import Path, PurePosixPath
from uuid import UUID

import pytest
from tests.fixtures.media import write_image

from visionset import wire
from visionset.kernel import AssetNotWritable, CalibrationMissing, InvalidAnnotation
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    Cuboid3DGeometry,
    GeometryType,
    ImportConsent,
    ImportedClass,
    ImportedDataset,
    ImportedFrame,
    ImportedImage,
    ImportedLabel,
    ImportedSequence,
    ImportLossKind,
    ImportPlan,
    ImportRun,
)
from visionset.kernel.services import (
    BatchService,
    ImportService,
    ProjectService,
    SourceService,
    TrackService,
    WorkspaceService,
)

SIZE = (32, 24)
BOX = BboxGeometry(x=2, y=2, width=10, height=8)
MOVED = BboxGeometry(x=4, y=3, width=10, height=8)
OTHER = BboxGeometry(x=14, y=10, width=6, height=6)
OUTSIDE = BboxGeometry(x=100, y=100, width=4, height=4)
CLASSES = (
    ImportedClass(name="car", geometries=(GeometryType.BBOX, GeometryType.CUBOID_3D)),
    ImportedClass(name="person", geometries=(GeometryType.BBOX,)),
)

#: One frame: its file name, the seed of its picture, its labels.
Frame = tuple[str, int, Sequence[ImportedLabel]]


class FakeImporter:
    format_name = "fake"

    def __init__(self, dataset: ImportedDataset) -> None:
        self.dataset = dataset

    def read(self, src: Path) -> ImportedDataset:
        return self.dataset


def _car(geometry: BboxGeometry = BOX, track: str | None = None) -> ImportedLabel:
    return ImportedLabel(class_name="car", geometry=geometry, track=track)


class World:
    def __init__(self, root: Path) -> None:
        self.src = root / "src"
        self.workspace = WorkspaceService.init(root / "ws")
        self.project = ProjectService(self.workspace).create("repeats")
        self.imports = ImportService(self.workspace)
        self.sources = SourceService(self.workspace)
        self.tracks = TrackService(self.workspace)
        self.batches = BatchService(self.workspace)

    def dataset(
        self,
        *sequences: tuple[str, Sequence[Frame]],
        loose: Sequence[Frame] = (),
        classes: tuple[ImportedClass, ...] = CLASSES,
    ) -> ImportedDataset:
        images: list[ImportedImage] = []
        made: list[ImportedSequence] = []
        for name, frames in sequences:
            for file, seed, labels in frames:
                images.append(self._image(f"{name}/{file}", seed, labels))
            made.append(
                ImportedSequence(
                    name=name,
                    frames=tuple(
                        ImportedFrame(path=PurePosixPath(name, file), timestamp=float(index))
                        for index, (file, _, _) in enumerate(frames)
                    ),
                )
            )
        for file, seed, labels in loose:
            images.append(self._image(f"loose/{file}", seed, labels))
        return ImportedDataset(classes=classes, images=tuple(images), sequences=tuple(made))

    def _image(self, path: str, seed: int, labels: Sequence[ImportedLabel]) -> ImportedImage:
        write_image(self.src / path, size=SIZE, seed=seed)
        return ImportedImage(path=PurePosixPath(path), labels=tuple(labels))

    def inspect(self, dataset: ImportedDataset) -> ImportPlan:
        return self.imports.inspect(self.project.id, FakeImporter(dataset), self.src)

    def run(self, dataset: ImportedDataset, *kinds: ImportLossKind) -> ImportRun:
        return self.imports.commit(
            self.project.id,
            FakeImporter(dataset),
            self.src,
            consent=ImportConsent(kinds=frozenset(kinds)),
        )

    def on(self, asset_id: UUID) -> list[Annotation]:
        with self.workspace.unit_of_work() as uow:
            return uow.annotations.list(asset_id)

    def observed(self, source_id: UUID) -> dict[str, list[tuple[int, UUID, UUID]]]:
        """Each track by external id, as (position, asset, annotation) per observation."""
        return {
            str(detail.track.external_id): [
                (frame.position, frame.asset_id, frame.annotation_id)
                for frame in detail.observations
            ]
            for detail in self.tracks.list(source_id)
        }


@pytest.fixture
def world(tmp_path: Path) -> Iterator[World]:
    made = World(tmp_path)
    yield made
    made.workspace.close()


def _static(*labels: ImportedLabel, length: int = 3) -> list[Frame]:
    return [(f"{index}.png", 1, labels) for index in range(length)]


def test_a_static_clip_keeps_every_track_as_one_annotation_per_occurrence(world: World) -> None:
    dataset = world.dataset(("clip", _static(_car(track="1"), _car(OTHER, track="2"))))
    plan = world.inspect(dataset)
    assert (plan.new_assets, plan.new_annotations, plan.tracks, plan.losses) == (1, 6, 2, ())
    assert wire.import_plan(plan)["labels"] == 6

    run = world.run(dataset)

    assert (run.annotations_written, run.tracks_written, run.losses) == (6, 2, ())
    (asset_id,) = run.created_asset_ids
    (source_id,) = run.source_ids
    occurrences = world.sources.occurrences(source_id)
    assert [(o.position, o.asset_id) for o in occurrences] == [(i, asset_id) for i in range(3)]
    observed = world.observed(source_id)
    assert {key: [p for p, _, _ in seen] for key, seen in observed.items()} == {
        "1": [0, 1, 2],
        "2": [0, 1, 2],
    }
    annotations = {a.id: a for a in world.on(asset_id)}
    seen = [annotation for one in observed.values() for _, _, annotation in one]
    assert sorted(seen) == sorted(annotations)
    assert {key: {annotations[a].geometry for _, _, a in one} for key, one in observed.items()} == {
        "1": {BOX},
        "2": {OTHER},
    }


def test_running_a_static_clip_again_writes_nothing(world: World) -> None:
    dataset = world.dataset(("clip", _static(_car(track="1"))))
    world.run(dataset)

    plan = world.inspect(dataset)
    assert (plan.new_annotations, plan.annotations_already_present, plan.tracks) == (0, 3, 0)
    again = world.run(dataset)
    assert (again.batch_id, again.annotations_written, again.source_ids) == (None, 0, ())


def test_an_untracked_label_on_a_repeat_is_kept_once_and_never_stacks(world: World) -> None:
    frames: list[Frame] = [
        ("0.png", 1, [_car()]),
        ("1.png", 1, [_car(), ImportedLabel(class_name="person", geometry=OTHER)]),
        ("2.png", 1, [_car()]),
    ]
    run = world.run(world.dataset(("clip", frames)))

    assert (run.annotations_written, run.annotations_already_present, run.losses) == (2, 2, ())
    (asset_id,) = run.created_asset_ids
    assert sorted((a.label_class, a.geometry.model_dump_json()) for a in world.on(asset_id)) == [
        ("car", BOX.model_dump_json()),
        ("person", OTHER.model_dump_json()),
    ]
    (source_id,) = run.source_ids
    assert world.observed(source_id) == {}


def test_an_untracked_repeat_of_a_tracked_box_adds_nothing(world: World) -> None:
    frames: list[Frame] = [("0.png", 1, [_car(track="1")]), ("1.png", 1, [_car()])]
    run = world.run(world.dataset(("clip", frames)))

    assert (run.annotations_written, run.annotations_already_present) == (1, 1)
    (source_id,) = run.source_ids
    assert [p for p, _, _ in world.observed(source_id)["1"]] == [0]


def test_a_track_that_starts_on_a_repeat_observes_it_beside_an_untracked_twin(
    world: World,
) -> None:
    frames: list[Frame] = [("0.png", 1, [_car()]), ("1.png", 1, [_car(track="1")])]
    dataset = world.dataset(("clip", frames))
    run = world.run(dataset)

    (asset_id,) = run.created_asset_ids
    assert len(world.on(asset_id)) == 2
    (source_id,) = run.source_ids
    ((position, _, annotation),) = world.observed(source_id)["1"]
    assert position == 1
    assert annotation in {a.id for a in world.on(asset_id)}
    assert world.inspect(dataset).new_annotations == 0


def test_mixed_repeats_return_a_track_to_the_asset_it_left(world: World) -> None:
    frames: list[Frame] = [
        ("0.png", 1, [_car(track="1")]),
        ("1.png", 2, [_car(MOVED, track="1")]),
        ("2.png", 1, [_car(track="1")]),
        ("3.png", 2, [_car(MOVED, track="1")]),
    ]
    run = world.run(world.dataset(("clip", frames)))

    assert (len(run.created_asset_ids), run.annotations_written, run.losses) == (2, 4, ())
    (source_id,) = run.source_ids
    (track,) = world.observed(source_id).values()
    assert [p for p, _, _ in track] == [0, 1, 2, 3]
    assert track[0][1] == track[2][1] != track[1][1] == track[3][1]
    assert len({annotation for _, _, annotation in track}) == 4


def test_a_track_id_a_repeat_cannot_hold_stays_a_label_and_is_declared(world: World) -> None:
    person = ImportedLabel(class_name="person", geometry=OTHER, track="1")
    frames: list[Frame] = [
        ("0.png", 1, [_car(track="1")]),
        ("1.png", 1, [person, _car(track="2"), _car(MOVED, track="2")]),
    ]
    run = world.run(world.dataset(("clip", frames)), ImportLossKind.ATTRIBUTE)

    assert sorted((loss.subject, loss.count) for loss in run.losses) == [("car", 1), ("person", 1)]
    assert {loss.kind for loss in run.losses} == {ImportLossKind.ATTRIBUTE}
    (source_id,) = run.source_ids
    assert {k: [p for p, _, _ in v] for k, v in world.observed(source_id).items()} == {
        "1": [0],
        "2": [1],
    }
    (asset_id,) = run.created_asset_ids
    assert len(world.on(asset_id)) == 4


def test_a_label_outside_a_repeat_is_a_label_loss(world: World) -> None:
    frames: list[Frame] = [("0.png", 1, [_car(track="1")]), ("1.png", 1, [_car(OUTSIDE)])]
    run = world.run(world.dataset(("clip", frames)), ImportLossKind.LABEL)

    assert [(loss.kind, loss.count) for loss in run.losses] == [(ImportLossKind.LABEL, 1)]
    assert run.annotations_written == 1


def test_a_repeat_outside_any_sequence_still_loses_its_labels(world: World) -> None:
    dataset = world.dataset(
        ("clip", _static(_car(track="1"), length=2)),
        loose=[("copy.png", 1, [_car(MOVED)])],
    )
    plan = world.inspect(dataset)
    assert [(loss.kind, loss.subject) for loss in plan.losses] == [
        (ImportLossKind.IMAGE, "loose/copy.png")
    ]
    run = world.run(dataset, ImportLossKind.IMAGE)

    (asset_id,) = run.created_asset_ids
    assert {a.geometry for a in world.on(asset_id)} == {BOX}
    assert run.annotations_written == 2


def test_a_sequenced_repeat_of_a_loose_image_labels_that_image_s_asset(world: World) -> None:
    dataset = world.dataset(
        ("walk", [("0.png", 1, [_car(track="1")])]), loose=[("a.png", 1, [_car(MOVED)])]
    )
    run = world.run(dataset)

    assert run.losses == ()
    (asset_id,) = run.created_asset_ids
    assert {a.geometry for a in world.on(asset_id)} == {BOX, MOVED}
    (source_id,) = run.source_ids
    ((_, observed_on, _),) = world.observed(source_id)["1"]
    assert observed_on == asset_id


def test_a_new_track_on_a_repeat_of_held_work_is_refused(world: World) -> None:
    world.run(world.dataset(("clip", _static(_car(track="1"), length=2))))
    frames: list[Frame] = [
        ("0.png", 1, [_car(track="1")]),
        ("1.png", 1, [_car(track="1")]),
        ("2.png", 1, [_car(track="1")]),
    ]
    dataset = world.dataset(("clip", frames))

    plan = world.inspect(dataset)
    assert plan.new_annotations == 1
    assert any("one-shot" in conflict for conflict in plan.conflicts)
    assert any("clip/2.png" in conflict for conflict in plan.conflicts)
    with pytest.raises(AssetNotWritable, match="one-shot"):
        world.run(dataset)


def test_a_repeat_s_label_is_judged_against_the_active_schema(world: World) -> None:
    only_car = CLASSES[:1]
    world.run(world.dataset(("first", [("0.png", 5, [_car()])]), classes=only_car))
    person = ImportedLabel(class_name="person", geometry=OTHER)
    dataset = world.dataset(("clip", [("0.png", 1, [_car()]), ("1.png", 1, [person])]))

    assert world.inspect(dataset).conflicts
    with pytest.raises(InvalidAnnotation):
        world.run(dataset)


def test_a_partly_present_asset_takes_only_the_occurrences_it_lacks_and_then_nothing(
    world: World,
) -> None:
    first = world.run(world.dataset(loose=[("a.png", 1, [_car()])]))
    assert first.batch_id is not None
    world.batches.delete(first.batch_id, confirm=True)
    dataset = world.dataset(("clip", _static(_car(track="1"))))

    plan = world.inspect(dataset)
    assert (plan.new_annotations, plan.annotations_already_present, plan.conflicts) == (2, 1, ())
    run = world.run(dataset)
    (source_id,) = run.source_ids
    assert [p for p, _, _ in world.observed(source_id)["1"]] == [1, 2]
    assert world.inspect(dataset).new_annotations == 0


def test_a_3d_label_only_on_a_repeat_still_needs_a_calibration(world: World) -> None:
    cuboid = Cuboid3DGeometry(center=(0.0, 0.0, 5.0), size=(1.0, 1.0, 1.0), yaw=0.0)
    frames: list[Frame] = [
        ("0.png", 1, []),
        ("1.png", 1, [ImportedLabel(class_name="car", geometry=cuboid)]),
    ]
    dataset = world.dataset(("clip", frames))

    assert any("calibration" in conflict for conflict in world.inspect(dataset).conflicts)
    with pytest.raises(CalibrationMissing):
        world.run(dataset)
