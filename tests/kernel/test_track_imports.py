"""TrackService.add_imported_in: an import's tracks, under every rule a person's track obeys."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from pathlib import Path
from uuid import UUID

import pytest
from tests.kernel.test_track_service import CAR, World

from visionset.kernel import (
    AnnotationAlreadyObserved,
    AnnotationNotAtOccurrence,
    AssetNotInBatch,
    InvalidAnnotation,
    OccurrenceAlreadyObserved,
    SourceNotFound,
    SourceNotSequence,
    TrackClassMismatch,
    TrackExternalIdTaken,
)
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    Cuboid3DGeometry,
    FrameOccurrence,
    Geometry,
    Track,
    TrackDetail,
    TrackObservation,
)
from visionset.kernel.services import ProjectService, SchemaService, SourceService

BOX = BboxGeometry(x=1.0, y=1.0, width=5.0, height=5.0)


class Sequenced:
    def __init__(self, source_id: UUID, batch_id: UUID, occurrences: list[FrameOccurrence]):
        self.source_id = source_id
        self.batch_id = batch_id
        self.occurrences = occurrences


class Importing(World):
    def __init__(self, tmp_path: Path) -> None:
        super().__init__(tmp_path)
        self.sources = SourceService(self.workspace)

    def sequence(
        self, seeds: Sequence[int] = (0, 1, 2), project_id: UUID | None = None
    ) -> Sequenced:
        clip = self.clip(seeds)
        with self.workspace.unit_of_work() as uow:
            source = self.sources.add_image_sequence_in(
                uow, project_id or self.project.id, "segment-1"
            )
            occurrences = self.sources.add_occurrences_in(
                uow, source, [(o.position, o.timestamp, o.asset_id) for o in clip.occurrences]
            )
        return Sequenced(source.id, clip.batch_id, occurrences)

    def label(
        self,
        batch_id: UUID,
        asset_id: UUID,
        label_class: str = "car",
        *,
        provenance: str = "import",
        geometry: Geometry = BOX,
    ) -> Annotation:
        annotation = Annotation(
            asset_id=asset_id,
            label_class=label_class,
            schema_version=1,
            geometry=geometry,
            provenance=provenance,
        )
        with self.workspace.unit_of_work() as uow:
            if provenance == "import" and geometry == BOX:
                (written,) = self.annotations.add_imported_in(uow, batch_id, [annotation])
                return written
            return uow.annotations.add(annotation)

    def write(
        self,
        batch_id: UUID,
        source_id: UUID,
        pairs: Sequence[tuple[FrameOccurrence, Annotation]],
        *,
        label_class: str = "car",
        external_id: str | None = "7",
    ) -> tuple[TrackDetail, ...]:
        track = Track(source_id=source_id, label_class=label_class, external_id=external_id)
        observations = [
            TrackObservation(track_id=track.id, occurrence_id=o.id, annotation_id=a.id)
            for o, a in pairs
        ]
        with self.workspace.unit_of_work() as uow:
            return self.tracks.add_imported_in(uow, batch_id, [(track, observations)])


@pytest.fixture
def world(tmp_path: Path) -> Iterator[Importing]:
    made = Importing(tmp_path)
    yield made
    made.workspace.close()


def _each(world: Importing, seq: Sequenced) -> list[tuple[FrameOccurrence, Annotation]]:
    return [(o, world.label(seq.batch_id, o.asset_id)) for o in seq.occurrences]


def test_an_imported_track_observes_each_position_on_an_image_sequence(world: Importing) -> None:
    seq = world.sequence()
    (detail,) = world.write(seq.batch_id, seq.source_id, _each(world, seq))

    assert [f.position for f in detail.observations] == [0, 1, 2]
    assert world.tracks.list(seq.source_id) == [detail]
    assert detail.track.external_id == "7"


def test_a_video_source_takes_an_imported_track_as_well(world: Importing) -> None:
    clip = world.clip()
    pairs = [(o, world.label(clip.batch_id, o.asset_id)) for o in clip.occurrences]
    (detail,) = world.write(clip.batch_id, clip.source_id, pairs)
    assert len(detail.observations) == 3


def test_an_annotation_of_another_class_is_refused(world: Importing) -> None:
    seq = world.sequence()
    van = world.label(seq.batch_id, seq.occurrences[0].asset_id, "van")
    with pytest.raises(TrackClassMismatch):
        world.write(seq.batch_id, seq.source_id, [(seq.occurrences[0], van)])
    assert world.tracks.list(seq.source_id) == []


def test_one_occurrence_is_observed_once(world: Importing) -> None:
    seq = world.sequence()
    first = seq.occurrences[0]
    pairs = [(first, world.label(seq.batch_id, first.asset_id)) for _ in range(2)]
    with pytest.raises(OccurrenceAlreadyObserved):
        world.write(seq.batch_id, seq.source_id, pairs)


def test_one_annotation_is_observed_once(world: Importing) -> None:
    seq = world.sequence(seeds=(9, 9, 4))
    first, second, _ = seq.occurrences
    assert first.asset_id == second.asset_id
    shared = world.label(seq.batch_id, first.asset_id)
    with pytest.raises(AnnotationAlreadyObserved):
        world.write(seq.batch_id, seq.source_id, [(first, shared), (second, shared)])
    world.write(seq.batch_id, seq.source_id, [(first, shared)])
    with pytest.raises(AnnotationAlreadyObserved):
        world.write(seq.batch_id, seq.source_id, [(second, shared)], external_id="8")


def test_an_asset_the_batch_does_not_hold_is_refused(world: Importing) -> None:
    ours, theirs = world.sequence(), world.sequence(seeds=(5, 6, 7))
    elsewhere = theirs.occurrences[0]
    label = world.label(theirs.batch_id, elsewhere.asset_id)
    with pytest.raises(AssetNotInBatch):
        world.write(ours.batch_id, theirs.source_id, [(elsewhere, label)])


@pytest.mark.parametrize(
    ("provenance", "geometry", "message"),
    [
        ("human", BOX, "observes only the labels it wrote"),
        (
            "import",
            Cuboid3DGeometry(center=(0.0, 0.0, 5.0), size=(1.0, 1.0, 1.0), yaw=0.0),
            "an image.s 2D labels only",
        ),
    ],
)
def test_only_the_import_s_own_2d_labels_are_observed(
    world: Importing, provenance: str, geometry: Geometry, message: str
) -> None:
    seq = world.sequence()
    first = seq.occurrences[0]
    label = world.label(seq.batch_id, first.asset_id, provenance=provenance, geometry=geometry)
    with pytest.raises(InvalidAnnotation, match=message):
        world.write(seq.batch_id, seq.source_id, [(first, label)])


def test_a_source_that_is_no_sequence_is_refused(world: Importing, tmp_path: Path) -> None:
    seq = world.sequence()
    (tmp_path / "stills").mkdir()
    stills = world.sources.register_images(world.project.id, tmp_path / "stills")
    with pytest.raises(SourceNotSequence):
        world.write(seq.batch_id, stills.id, [])


def test_a_source_of_another_project_is_not_found(world: Importing) -> None:
    other = ProjectService(world.workspace).create("other")
    SchemaService(world.workspace).create_version(other.id, [CAR])
    seq = world.sequence()
    foreign = world.sequence(seeds=(5, 6, 7), project_id=other.id)
    with pytest.raises(SourceNotFound):
        world.write(seq.batch_id, foreign.source_id, [])


def test_an_annotation_must_sit_on_its_occurrence_s_asset(world: Importing) -> None:
    seq = world.sequence()
    first, second, _ = seq.occurrences
    misplaced = world.label(seq.batch_id, second.asset_id)
    with pytest.raises(AnnotationNotAtOccurrence):
        world.write(seq.batch_id, seq.source_id, [(first, misplaced)])


def test_an_external_id_is_taken_once_per_source(world: Importing) -> None:
    seq = world.sequence()
    first, second, _ = seq.occurrences
    world.write(seq.batch_id, seq.source_id, [(first, world.label(seq.batch_id, first.asset_id))])
    with pytest.raises(TrackExternalIdTaken):
        world.write(
            seq.batch_id, seq.source_id, [(second, world.label(seq.batch_id, second.asset_id))]
        )


def test_occurrences_are_written_only_onto_an_image_sequence(
    world: Importing, tmp_path: Path
) -> None:
    clip = world.clip()
    (tmp_path / "stills").mkdir()
    stills = world.sources.register_images(world.project.id, tmp_path / "stills")
    asset_id = clip.occurrences[0].asset_id
    with world.workspace.unit_of_work() as uow:
        with pytest.raises(SourceNotSequence):
            world.sources.add_occurrences_in(uow, stills, [(0, 0.0, asset_id)])
        video = world.sources.require_source(uow, clip.source_id)
        with pytest.raises(ValueError, match="its import writes"):
            world.sources.add_occurrences_in(uow, video, [(9, 9.0, asset_id)])
