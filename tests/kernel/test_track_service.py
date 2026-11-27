"""TrackService: tracks over frame occurrences, and the write scope that bounds them."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from PIL import Image

from visionset.kernel import (
    AnnotationAlreadyObserved,
    AnnotationNotAtOccurrence,
    AssetNotInJob,
    AssetNotJudged,
    AssetNotWritable,
    BatchNotFound,
    BatchNotInAnnotation,
    ConstraintViolated,
    DisallowedGeometry,
    DuplicateClassificationTag,
    FrameOccurrenceNotFound,
    InvalidAnnotation,
    InvalidAttributeValue,
    InvalidName,
    JobFinished,
    LabelClassNotInSchema,
    MissingRequiredAttribute,
    ObservationNotFound,
    OccurrenceAlreadyObserved,
    SourceNotSequence,
    TrackClassMismatch,
    TrackExternalIdTaken,
    TrackMergeWithItself,
    TrackNotFound,
    TrackSourceMismatch,
    TrackSplitEmpty,
    UnknownAttribute,
)
from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationOperation,
    AnnotationsWritten,
    Asset,
    AssetProgress,
    Attribute,
    BboxGeometry,
    BySize,
    ClassificationGeometry,
    Cuboid3DGeometry,
    FrameOccurrence,
    GeometryType,
    IncomingFrame,
    LabelClass,
    PolygonGeometry,
    TimeRange,
    Track,
    TrackDetail,
    TrackObservation,
    VideoMetadata,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    JobService,
    ProjectService,
    SchemaService,
    SourceService,
    TrackService,
    VideoImportService,
    WorkspaceService,
)

SIZE = (16, 12)
CAR = LabelClass(name="car", geometries=(GeometryType.BBOX,))
VAN = LabelClass(name="van", geometries=(GeometryType.BBOX,))
LANE = LabelClass(name="lane", geometries=(GeometryType.POLYGON,))


def _jpeg(seed: int) -> bytes:
    width, height = SIZE
    pixels = bytes(
        channel
        for y in range(height)
        for x in range(width)
        for channel in ((x * 7 + seed * 13) % 256, (y * 5 + seed * 29) % 256, (seed * 47) % 256)
    )
    buffer = BytesIO()
    Image.frombytes("RGB", SIZE, pixels).save(buffer, format="JPEG", quality=95)
    return buffer.getvalue()


def _frame(ordinal: int, seed: int, timestamp: float | None = None) -> IncomingFrame:
    return IncomingFrame(
        ordinal=ordinal,
        requested_timestamp=float(ordinal),
        source_timestamp=timestamp,
        width=SIZE[0],
        height=SIZE[1],
        content=BytesIO(_jpeg(seed)),
    )


class Clip:
    def __init__(self, source_id: UUID, batch_id: UUID, occurrences: list[FrameOccurrence]):
        self.source_id = source_id
        self.batch_id = batch_id
        self.occurrences = occurrences

    def at(self, position: int) -> FrameOccurrence:
        return next(o for o in self.occurrences if o.position == position)


class World:
    def __init__(self, tmp_path: Path) -> None:
        self.workspace = WorkspaceService.init(tmp_path / "ws")
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.tracks = TrackService(self.workspace)
        self.imports = VideoImportService(self.workspace)
        self.project = ProjectService(self.workspace).create("clips")
        SchemaService(self.workspace).create_version(self.project.id, [CAR, VAN, LANE])
        self._clips = 0

    def clip(
        self,
        seeds: Sequence[int] = (0, 1, 2),
        *,
        positions: Sequence[int] | None = None,
        duration: float | None = None,
        ranges: tuple[TimeRange, ...] | None = None,
    ) -> Clip:
        self._clips += 1
        extra = {} if ranges is None else {"ranges": ranges}
        session = self.imports.start(
            self.project.id,
            display_name=f"clip-{self._clips}.webm",
            metadata=VideoMetadata(
                width=SIZE[0],
                height=SIZE[1],
                fps=30.0,
                duration_seconds=float(len(seeds)) if duration is None else duration,
                codec="vp9",
            ),
            extraction_fps=1.0,
            materializer="mediabunny/1.56.1",
            batch_name=f"clip {self._clips}",
            **extra,  # type: ignore[arg-type]
        )
        ordinals = list(range(len(seeds))) if positions is None else list(positions)
        self.imports.append_frames(
            session.id, [_frame(o, s) for o, s in zip(ordinals, seeds, strict=True)]
        )
        batch = self.imports.commit(session.id)
        source_id = self.imports.get(session.id).source_id
        return Clip(source_id, batch.id, SourceService(self.workspace).occurrences(source_id))

    def working(self, batch_id: UUID, *, size: int | None = None) -> list[AnnotationJob]:
        self.batches.approve(batch_id, None if size is None else BySize(size=size))
        self.batches.start(batch_id)
        jobs = self.batches.jobs(batch_id)
        for job in jobs:
            self.jobs.start(job.id)
        return [self.jobs.get(job.id) for job in jobs]

    def box(self, job: AnnotationJob, asset_id: UUID, label_class: str = "car") -> Annotation:
        return self.annotations.add(
            job.id,
            [
                Annotation(
                    asset_id=asset_id,
                    label_class=label_class,
                    schema_version=1,
                    geometry=BboxGeometry(x=1.0, y=1.0, width=5.0, height=5.0),
                    provenance="human",
                )
            ],
        )[0]

    def observed(self, job: AnnotationJob, clip: Clip, positions: Sequence[int]) -> TrackDetail:
        """A car track observing a fresh box at each position."""
        track = self.tracks.create(clip.source_id, "car").track
        detail = None
        for position in positions:
            occurrence = clip.at(position)
            box = self.box(job, occurrence.asset_id)
            detail = self.tracks.observe(job.id, track.id, occurrence.id, box.id)
        return detail if detail is not None else self.tracks.get(track.id)

    def progress(self, job: AnnotationJob, asset_id: UUID) -> AssetProgress:
        return self.jobs.get(job.id).progress[asset_id]


@pytest.fixture
def world(tmp_path: Path) -> Iterator[World]:
    made = World(tmp_path)
    yield made
    made.workspace.close()


def _positions(detail: TrackDetail) -> list[int]:
    return [frame.position for frame in detail.observations]


# --- creating ----------------------------------------------------------------


def test_a_track_starts_empty_on_a_video_source(world: World) -> None:
    clip = world.clip()
    created = world.tracks.create(clip.source_id, "car", external_id="instance-7")
    assert created.observations == ()
    assert created.track.external_id == "instance-7"
    assert [d.track.id for d in world.tracks.list(clip.source_id)] == [created.track.id]


def test_a_track_is_refused_on_a_source_that_is_not_a_sequence(
    world: World, tmp_path: Path
) -> None:
    (tmp_path / "stills").mkdir()
    stills = SourceService(world.workspace).register_images(world.project.id, tmp_path / "stills")
    with pytest.raises(SourceNotSequence):
        world.tracks.create(stills.id, "car")


def test_an_external_id_is_unique_per_source_and_free_across_sources(world: World) -> None:
    first, second = world.clip(), world.clip()
    world.tracks.create(first.source_id, "car", external_id="t1")
    with pytest.raises(TrackExternalIdTaken):
        world.tracks.create(first.source_id, "van", external_id="t1")
    world.tracks.create(second.source_id, "car", external_id="t1")
    world.tracks.create(first.source_id, "car")
    world.tracks.create(first.source_id, "car")
    assert len(world.tracks.list(first.source_id)) == 3


def test_the_store_itself_refuses_a_colliding_external_id(world: World) -> None:
    clip = world.clip()
    with world.workspace.unit_of_work() as uow:
        uow.tracks.add(Track(source_id=clip.source_id, label_class="car", external_id="x"))
    with pytest.raises(ConstraintViolated), world.workspace.unit_of_work() as uow:
        uow.tracks.add(Track(source_id=clip.source_id, label_class="car", external_id="x"))


def test_an_unknown_track_is_not_found(world: World) -> None:
    with pytest.raises(TrackNotFound):
        world.tracks.get(uuid4())


# --- observing ---------------------------------------------------------------


def test_identical_frames_need_one_annotation_per_occurrence(world: World) -> None:
    clip = world.clip(seeds=(9, 9, 4))
    first, second = clip.at(0), clip.at(1)
    assert first.asset_id == second.asset_id
    (job,) = world.working(clip.batch_id)
    track = world.tracks.create(clip.source_id, "car").track
    box = world.box(job, first.asset_id)
    world.tracks.observe(job.id, track.id, first.id, box.id)

    with pytest.raises(AnnotationAlreadyObserved):
        world.tracks.observe(job.id, track.id, second.id, box.id)
    other = world.box(job, second.asset_id)
    detail = world.tracks.observe(job.id, track.id, second.id, other.id)

    assert _positions(detail) == [0, 1]
    assert {f.asset_id for f in detail.observations} == {first.asset_id}
    assert [f.annotation_id for f in detail.observations] == [box.id, other.id]


def test_a_track_observes_an_occurrence_once(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0])
    again = world.box(job, clip.at(0).asset_id)
    with pytest.raises(OccurrenceAlreadyObserved):
        world.tracks.observe(job.id, detail.track.id, clip.at(0).id, again.id)


def test_missing_frames_are_gaps_and_a_track_reappears_after_one(world: World) -> None:
    clip = world.clip(
        seeds=(0, 1, 5, 6),
        positions=(0, 1, 5, 6),
        duration=10.0,
        ranges=(
            TimeRange(start_seconds=0.0, end_seconds=2.0),
            TimeRange(start_seconds=5.0, end_seconds=7.0),
        ),
    )
    assert [o.position for o in clip.occurrences] == [0, 1, 5, 6]
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [6, 0, 5])
    assert _positions(detail) == [0, 5, 6]

    box = world.box(job, clip.at(1).asset_id)
    with pytest.raises(FrameOccurrenceNotFound):
        world.tracks.observe(job.id, detail.track.id, uuid4(), box.id)


def test_an_annotation_must_sit_on_the_occurrences_asset(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    track = world.tracks.create(clip.source_id, "car").track
    box = world.box(job, clip.at(1).asset_id)
    with pytest.raises(AnnotationNotAtOccurrence):
        world.tracks.observe(job.id, track.id, clip.at(0).id, box.id)


def test_an_observed_annotation_carries_the_tracks_class(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    track = world.tracks.create(clip.source_id, "car").track
    van = world.box(job, clip.at(0).asset_id, "van")
    with pytest.raises(TrackClassMismatch):
        world.tracks.observe(job.id, track.id, clip.at(0).id, van.id)


def test_a_3d_label_is_not_tracked(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    track = world.tracks.create(clip.source_id, "car").track
    cuboid = Annotation(
        asset_id=clip.at(0).asset_id,
        label_class="car",
        schema_version=1,
        geometry=Cuboid3DGeometry(center=(0.0, 0.0, 5.0), size=(1.0, 1.0, 1.0), yaw=0.0),
        provenance="human",
    )
    with world.workspace.unit_of_work() as uow:
        uow.annotations.add(cuboid)
    with pytest.raises(InvalidAnnotation):
        world.tracks.observe(job.id, track.id, clip.at(0).id, cuboid.id)


def test_a_track_never_spans_two_sources(world: World) -> None:
    first, second = world.clip(), world.clip()
    assert [o.asset_id for o in first.occurrences] == [o.asset_id for o in second.occurrences]
    (job,) = world.working(first.batch_id)
    ours = world.observed(job, first, [0])
    theirs = world.tracks.create(second.source_id, "car")
    box = world.box(job, second.at(1).asset_id)

    with pytest.raises(TrackSourceMismatch):
        world.tracks.observe(job.id, ours.track.id, second.at(1).id, box.id)
    with pytest.raises(TrackSourceMismatch):
        world.tracks.merge(job.id, ours.track.id, theirs.track.id)
    with pytest.raises(TrackSourceMismatch):
        world.tracks.split(job.id, ours.track.id, second.at(0).id)
    with pytest.raises(AnnotationAlreadyObserved):
        world.tracks.observe(
            job.id, theirs.track.id, second.at(0).id, ours.observations[0].annotation_id
        )


def test_a_pasted_annotation_is_never_observed(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0])
    source = world.annotations.get(detail.observations[0].annotation_id)
    pasted = world.annotations.add(
        job.id,
        [source.model_copy(update={"id": uuid4(), "asset_id": clip.at(1).asset_id})],
    )[0]

    assert pasted.id != source.id
    assert world.tracks.get(detail.track.id) == detail
    with world.workspace.unit_of_work() as uow:
        assert uow.observation_of(pasted.id) is None


def test_unobserving_keeps_the_annotation(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 1])
    kept = world.tracks.unobserve(job.id, detail.track.id, clip.at(0).id)
    assert _positions(kept) == [1]
    assert world.annotations.get(detail.observations[0].annotation_id)
    with pytest.raises(ObservationNotFound):
        world.tracks.unobserve(job.id, detail.track.id, clip.at(0).id)


# --- class -------------------------------------------------------------------


def test_a_class_change_rewrites_every_observed_annotation(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 2])
    untracked = world.box(job, clip.at(1).asset_id)
    heard: list[AnnotationsWritten] = []
    world.workspace.event_bus.subscribe(AnnotationsWritten, heard.append)

    changed = world.tracks.change_class(job.id, detail.track.id, "van")

    assert changed.track.label_class == "van"
    assert {world.annotations.get(f.annotation_id).label_class for f in detail.observations} == {
        "van"
    }
    assert world.annotations.get(untracked.id).label_class == "car"
    assert [(e.operation, len(e.annotation_ids)) for e in heard] == [
        (AnnotationOperation.UPDATE, 2)
    ]


@pytest.mark.parametrize(
    ("label_class", "refusal"),
    [("ghost", LabelClassNotInSchema), ("lane", DisallowedGeometry)],
)
def test_a_class_change_the_schema_refuses_changes_nothing(
    world: World, label_class: str, refusal: type[Exception]
) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 1])
    with pytest.raises(refusal):
        world.tracks.change_class(job.id, detail.track.id, label_class)
    assert world.tracks.get(detail.track.id) == detail
    assert {world.annotations.get(f.annotation_id).label_class for f in detail.observations} == {
        "car"
    }


@pytest.mark.parametrize(
    "refusal",
    [MissingRequiredAttribute, UnknownAttribute, InvalidAttributeValue, DuplicateClassificationTag],
)
def test_a_class_change_judges_attributes_and_tags_under_the_new_class(
    world: World, refusal: type[Exception]
) -> None:
    shapes = (GeometryType.BBOX, GeometryType.CLASSIFICATION_TAG)
    seats = Attribute(name="seats", kind="number", required=True)
    SchemaService(world.workspace).create_version(
        world.project.id,
        [
            LabelClass(
                name="car",
                geometries=shapes,
                attributes=(
                    Attribute(name="color", kind="string"),
                    Attribute(name="kind", kind="select", options=("a",)),
                ),
            ),
            LabelClass(
                name="van",
                geometries=shapes,
                attributes=(
                    Attribute(name="kind", kind="select", options=("b",)),
                    *((seats,) if refusal is MissingRequiredAttribute else ()),
                ),
            ),
        ],
        allow_destructive=True,
    )
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    asset_id = clip.at(0).asset_id

    def label(label_class: str, **fields: object) -> Annotation:
        return Annotation.model_validate(
            {
                "asset_id": asset_id,
                "label_class": label_class,
                "schema_version": 2,
                "geometry": BboxGeometry(x=1.0, y=1.0, width=5.0, height=5.0),
                "provenance": "human",
                **fields,
            }
        )

    if refusal is DuplicateClassificationTag:
        (observed, _) = world.annotations.add(
            job.id,
            [
                label("car", geometry=ClassificationGeometry()),
                label("van", geometry=ClassificationGeometry()),
            ],
        )
    else:
        attributes = {UnknownAttribute: {"color": "red"}, InvalidAttributeValue: {"kind": "a"}}
        (observed,) = world.annotations.add(
            job.id, [label("car", attributes=attributes.get(refusal, {}))]
        )
    track = world.tracks.create(clip.source_id, "car").track
    detail = world.tracks.observe(job.id, track.id, clip.at(0).id, observed.id)

    with pytest.raises(refusal):
        world.tracks.change_class(job.id, track.id, "van")
    assert world.tracks.get(track.id) == detail
    assert world.annotations.get(observed.id).label_class == "car"


# --- merge and split -----------------------------------------------------------


def test_a_merge_moves_every_observation_and_keeps_an_imported_id(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    kept = world.observed(job, clip, [0])
    absorbed_track = world.tracks.create(clip.source_id, "car", external_id="token-9").track
    box = world.box(job, clip.at(2).asset_id)
    world.tracks.observe(job.id, absorbed_track.id, clip.at(2).id, box.id)

    merged = world.tracks.merge(job.id, kept.track.id, absorbed_track.id)

    assert _positions(merged) == [0, 2]
    assert merged.track.external_id == "token-9"
    with pytest.raises(TrackNotFound):
        world.tracks.get(absorbed_track.id)


def test_a_merge_refuses_overlap_itself_and_another_class(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    one = world.observed(job, clip, [0, 1])
    two = world.observed(job, clip, [1, 2])
    van = world.tracks.create(clip.source_id, "van")

    with pytest.raises(OccurrenceAlreadyObserved):
        world.tracks.merge(job.id, one.track.id, two.track.id)
    with pytest.raises(TrackMergeWithItself):
        world.tracks.merge(job.id, one.track.id, one.track.id)
    with pytest.raises(TrackClassMismatch):
        world.tracks.merge(job.id, one.track.id, van.track.id)
    assert world.tracks.get(one.track.id) == one
    assert world.tracks.get(two.track.id) == two


def test_a_split_moves_the_cut_and_everything_after_it(world: World) -> None:
    clip = world.clip(seeds=(0, 1, 2, 3))
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 1, 3])

    kept, created = world.tracks.split(job.id, detail.track.id, clip.at(2).id)

    assert (_positions(kept), _positions(created)) == ([0, 1], [3])
    assert created.track.label_class == "car"
    assert created.track.source_id == clip.source_id


def test_a_split_at_the_last_observation_moves_only_it(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 1, 2])
    kept, created = world.tracks.split(job.id, detail.track.id, clip.at(2).id)
    assert (_positions(kept), _positions(created)) == ([0, 1], [2])


def test_a_split_that_would_empty_a_track_is_refused(world: World) -> None:
    clip = world.clip(seeds=(0, 1, 2, 3))
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [1, 2])
    for position in (0, 1, 3):
        with pytest.raises(TrackSplitEmpty):
            world.tracks.split(job.id, detail.track.id, clip.at(position).id)
    assert len(world.tracks.list(clip.source_id)) == 1


# --- write scope -----------------------------------------------------------------


def test_a_job_holding_part_of_a_track_cannot_restructure_it(world: World) -> None:
    clip = world.clip()
    first, second, _ = world.working(clip.batch_id, size=1)
    track = world.tracks.create(clip.source_id, "car").track
    for job, position in ((first, 0), (second, 1)):
        box = world.box(job, clip.at(position).asset_id)
        world.tracks.observe(job.id, track.id, clip.at(position).id, box.id)

    other = world.tracks.create(clip.source_id, "car").track
    for attempt in (
        lambda: world.tracks.merge(first.id, track.id, other.id),
        lambda: world.tracks.merge(first.id, other.id, track.id),
        lambda: world.tracks.change_class(first.id, track.id, "van"),
        lambda: world.tracks.split(first.id, track.id, clip.at(1).id),
        lambda: world.tracks.delete(first.id, track.id),
        lambda: world.tracks.delete_with_annotations(first.id, track.id),
        lambda: world.tracks.unobserve(first.id, track.id, clip.at(1).id),
    ):
        with pytest.raises(AssetNotInJob):
            attempt()
    assert _positions(world.tracks.unobserve(first.id, track.id, clip.at(0).id)) == [1]


def test_a_correction_batch_cannot_restructure_what_it_does_not_hold(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 2])
    for occurrence in clip.occurrences:
        if world.progress(job, occurrence.asset_id) is not AssetProgress.ANNOTATED:
            world.jobs.mark(job.id, occurrence.asset_id, AssetProgress.ANNOTATED)
    world.jobs.complete(job.id)
    world.batches.complete(clip.batch_id)

    with pytest.raises(BatchNotInAnnotation):
        world.tracks.unobserve(job.id, detail.track.id, clip.at(0).id)

    correction = world.batches.create_correction(clip.batch_id, "fix", [clip.at(0).asset_id])
    (fix,) = world.working(correction.id)
    with pytest.raises(AssetNotInJob):
        world.tracks.split(fix.id, detail.track.id, clip.at(2).id)
    with pytest.raises(AssetNotInJob):
        world.tracks.change_class(fix.id, detail.track.id, "van")
    assert world.tracks.get(detail.track.id) == detail
    assert _positions(world.tracks.unobserve(fix.id, detail.track.id, clip.at(0).id)) == [2]


def test_a_settled_asset_refuses_a_new_observation(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    track = world.tracks.create(clip.source_id, "car").track
    box = world.box(job, clip.at(0).asset_id)
    world.jobs.mark(job.id, clip.at(0).asset_id, AssetProgress.REVIEW_PENDING)
    world.jobs.mark(job.id, clip.at(0).asset_id, AssetProgress.ACCEPTED)
    with pytest.raises(AssetNotWritable):
        world.tracks.observe(job.id, track.id, clip.at(0).id, box.id)


def _pre_labeled(world: World, job: AnnotationJob, asset_id: UUID) -> Annotation:
    (stored,) = world.annotations.enter_unreviewed(
        job.id,
        [
            Annotation(
                asset_id=asset_id,
                label_class="car",
                schema_version=1,
                geometry=BboxGeometry(x=1.0, y=1.0, width=5.0, height=5.0),
                provenance="model",
                model_ref="acme/detector@abc123",
                confidence=0.6,
            )
        ],
    )
    assert world.progress(job, asset_id) is AssetProgress.PRE_LABELED
    return stored


def test_a_model_label_nobody_has_judged_is_not_observed(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    track = world.tracks.create(clip.source_id, "car").track
    model_box = _pre_labeled(world, job, clip.at(0).asset_id)
    with pytest.raises(AssetNotJudged):
        world.tracks.observe(job.id, track.id, clip.at(0).id, model_box.id)
    assert world.tracks.get(track.id).observations == ()


def test_a_model_label_a_person_edited_is_observed_and_survives_a_replacing_run(
    world: World,
) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    track = world.tracks.create(clip.source_id, "car").track
    asset_id = clip.at(0).asset_id
    model_box = _pre_labeled(world, job, asset_id)
    moved = model_box.geometry.model_copy(update={"x": 2.0})
    world.annotations.update(job.id, [model_box.model_copy(update={"geometry": moved})])
    assert world.progress(job, asset_id) is AssetProgress.ANNOTATED

    observed = world.tracks.observe(job.id, track.id, clip.at(0).id, model_box.id)
    assert _positions(observed) == [0]
    with pytest.raises(AssetNotWritable):
        world.annotations.enter_unreviewed(job.id, [], replacing=[asset_id])
    assert world.tracks.get(track.id) == observed


def test_a_label_confirmed_in_a_completed_batch_survives_a_replacing_run_in_the_next(
    world: World,
) -> None:
    """#1211: the next batch opens the frame ``pre_labeled``, but its labels were judged."""
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    track = world.tracks.create(clip.source_id, "car").track
    asset_id = clip.at(0).asset_id
    model_box = _pre_labeled(world, job, asset_id)
    world.jobs.mark(job.id, asset_id, AssetProgress.ANNOTATED)
    observed = world.tracks.observe(job.id, track.id, clip.at(0).id, model_box.id)
    for occurrence in clip.occurrences[1:]:
        world.jobs.mark(job.id, occurrence.asset_id, AssetProgress.SKIPPED)
    world.jobs.complete(job.id)
    world.batches.complete(clip.batch_id)

    second = world.batches.create(world.project.id, "second", [asset_id])
    (again,) = world.working(second.id)
    assert world.progress(again, asset_id) is AssetProgress.PRE_LABELED

    with pytest.raises(AssetNotWritable, match="confirmed in a completed batch"):
        world.annotations.enter_unreviewed(again.id, [], replacing=[asset_id])
    assert [a.id for a in world.annotations.for_asset(again.id, asset_id)] == [model_box.id]
    assert world.tracks.get(track.id) == observed


class _AcceptedAfterFirstRead(JobService):
    """Accepts ``asset_id`` from another workspace right after the call first reads the job.

    Single-threaded: the write has not taken its lock yet, so a second
    connection can still commit in the gap, which is all the race needs.
    """

    def __init__(self, workspace: WorkspaceService, job_id: UUID, asset_id: UUID) -> None:
        super().__init__(workspace)
        self._pending: tuple[UUID, UUID] | None = (job_id, asset_id)

    def require_job(self, uow: UnitOfWork, job_id: UUID) -> AnnotationJob:
        job = super().require_job(uow, job_id)
        pending, self._pending = self._pending, None
        if pending is not None:
            elsewhere = WorkspaceService.open(self._workspace.root)
            try:
                jobs = JobService(elsewhere)
                jobs.mark(*pending, AssetProgress.REVIEW_PENDING)
                jobs.mark(*pending, AssetProgress.ACCEPTED)
            finally:
                elsewhere.close()
        return job


def _prepared(world: World, job: AnnotationJob, clip: Clip, operation: str) -> Callable[[], object]:
    """The write, its tracks already in place, each touching the asset at position 0."""
    tracks = world.tracks
    if operation == "observe":
        track = world.observed(job, clip, [1]).track
        box = world.box(job, clip.at(0).asset_id)
        return lambda: tracks.observe(job.id, track.id, clip.at(0).id, box.id)
    if operation == "merge":
        kept = world.observed(job, clip, [1]).track
        absorbed = world.observed(job, clip, [0]).track
        return lambda: tracks.merge(job.id, kept.id, absorbed.id)
    track = world.observed(job, clip, [0, 1, 2]).track
    if operation == "unobserve":
        return lambda: tracks.unobserve(job.id, track.id, clip.at(0).id)
    if operation == "split":
        return lambda: tracks.split(job.id, track.id, clip.at(2).id)
    return lambda: tracks.delete(job.id, track.id)


@pytest.mark.parametrize("operation", ["observe", "unobserve", "merge", "split", "delete"])
def test_a_track_write_judges_the_progress_it_holds_the_lock_on(
    world: World, operation: str
) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    write = _prepared(world, job, clip, operation)
    world.tracks._jobs = _AcceptedAfterFirstRead(world.workspace, job.id, clip.at(0).asset_id)
    with pytest.raises(AssetNotWritable):
        write()
    assert world.progress(job, clip.at(0).asset_id) is AssetProgress.ACCEPTED


def test_a_track_of_another_project_is_not_found_through_this_job(
    world: World, tmp_path: Path
) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    track = world.tracks.create(clip.source_id, "car").track
    other = ProjectService(world.workspace).create("elsewhere")
    SchemaService(world.workspace).create_version(other.id, [CAR])
    batch = world.batches.create(other.id, "other")
    with world.workspace.unit_of_work() as uow:
        asset = uow.assets.get(clip.at(0).asset_id)
        assert asset is not None
        moved = uow.assets.add(
            Asset(project_id=other.id, content_hash=asset.content_hash, uri="/elsewhere.jpg")
        )
    world.batches.add_assets(batch.id, [moved.id])
    (foreign,) = world.working(batch.id)
    with pytest.raises(TrackNotFound):
        world.tracks.delete(foreign.id, track.id)


# --- derived status ----------------------------------------------------------------


def test_status_is_read_off_each_observed_assets_progress(world: World) -> None:
    clip = world.clip(seeds=(0, 1, 2))
    (job,) = world.working(clip.batch_id)
    track = world.tracks.create(clip.source_id, "car").track

    skipped = world.box(job, clip.at(0).asset_id)
    world.jobs.mark(job.id, clip.at(0).asset_id, AssetProgress.SKIPPED)
    world.jobs.mark(job.id, clip.at(0).asset_id, AssetProgress.UNANNOTATED)
    guessed = world.annotations.enter_unreviewed(
        job.id,
        [
            Annotation(
                asset_id=clip.at(1).asset_id,
                label_class="car",
                schema_version=1,
                geometry=BboxGeometry(x=1.0, y=1.0, width=5.0, height=5.0),
                provenance="model",
                model_ref="detector@1",
            )
        ],
    )[0]
    world.jobs.mark(job.id, clip.at(1).asset_id, AssetProgress.ANNOTATED)
    accepted = world.box(job, clip.at(2).asset_id)
    for annotation, position in ((skipped, 0), (guessed, 1), (accepted, 2)):
        world.tracks.observe(job.id, track.id, clip.at(position).id, annotation.id)
    world.jobs.mark(job.id, clip.at(2).asset_id, AssetProgress.REVIEW_PENDING)
    world.jobs.mark(job.id, clip.at(2).asset_id, AssetProgress.ACCEPTED)

    status = world.tracks.status(track.id, clip.batch_id)
    assert {k: v for k, v in status.progress.items() if v} == {
        AssetProgress.UNANNOTATED: 1,
        AssetProgress.ANNOTATED: 1,
        AssetProgress.ACCEPTED: 1,
    }
    assert status.outside == 0
    assert not status.settled

    world.jobs.mark(job.id, clip.at(0).asset_id, AssetProgress.SKIPPED)
    assert world.tracks.status(track.id, clip.batch_id).settled


def test_status_counts_observations_a_batch_does_not_hold_as_outside(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 1])
    elsewhere = world.batches.create(world.project.id, "subset", [clip.at(0).asset_id])

    status = world.tracks.status(detail.track.id, elsewhere.id)
    assert (sum(status.progress.values()), status.outside) == (0, 2)
    with pytest.raises(BatchNotFound):
        world.tracks.status(detail.track.id, uuid4())


# --- deletion and cascades -----------------------------------------------------------


def test_deleting_an_annotation_deletes_its_observation_only(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 1])
    world.annotations.delete(job.id, [detail.observations[0].annotation_id])
    assert _positions(world.tracks.get(detail.track.id)) == [1]


def test_deleting_a_track_keeps_every_annotation(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 1])
    world.tracks.delete(job.id, detail.track.id)
    with pytest.raises(TrackNotFound):
        world.tracks.get(detail.track.id)
    for frame in detail.observations:
        assert world.annotations.get(frame.annotation_id)
    with world.workspace.unit_of_work() as uow:
        assert uow.track_observations.list() == []


def test_deleting_a_track_with_its_annotations_moves_progress_back(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 1])
    assert world.tracks.delete_with_annotations(job.id, detail.track.id) == 2
    assert world.progress(job, clip.at(0).asset_id) is AssetProgress.UNANNOTATED
    with pytest.raises(TrackNotFound):
        world.tracks.get(detail.track.id)


def test_deleting_a_source_or_an_occurrence_cascades(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 1])
    with world.workspace.unit_of_work() as uow:
        uow.frame_occurrences.delete(clip.at(0).id)
    assert _positions(world.tracks.get(detail.track.id)) == [1]
    with world.workspace.unit_of_work() as uow:
        uow.sources.delete(clip.source_id)
        assert uow.tracks.list() == []
        assert uow.track_observations.list() == []


def test_the_store_holds_one_observation_per_annotation_and_per_occurrence(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0])
    frame = detail.observations[0]
    other = world.tracks.create(clip.source_id, "car").track
    second = world.box(job, clip.at(0).asset_id)
    for observation in (
        TrackObservation(
            track_id=other.id, occurrence_id=frame.occurrence_id, annotation_id=frame.annotation_id
        ),
        TrackObservation(
            track_id=detail.track.id, occurrence_id=frame.occurrence_id, annotation_id=second.id
        ),
    ):
        with pytest.raises(ConstraintViolated), world.workspace.unit_of_work() as uow:
            uow.track_observations.add(observation)


def test_a_track_follows_a_polygon_class_as_well_as_a_box(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    lane = world.annotations.add(
        job.id,
        [
            Annotation(
                asset_id=clip.at(0).asset_id,
                label_class="lane",
                schema_version=1,
                geometry=PolygonGeometry(points=[(1.0, 1.0), (5.0, 1.0), (5.0, 5.0)]),
                provenance="human",
            )
        ],
    )[0]
    track = world.tracks.create(clip.source_id, "lane").track
    detail = world.tracks.observe(job.id, track.id, clip.at(0).id, lane.id)
    assert [f.annotation_id for f in detail.observations] == [lane.id]


def test_an_observed_annotation_keeps_its_tracks_class_under_an_edit(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0])
    observed = world.annotations.get(detail.observations[0].annotation_id)
    with pytest.raises(TrackClassMismatch):
        world.annotations.update(job.id, [observed.model_copy(update={"label_class": "van"})])
    moved = observed.model_copy(
        update={"geometry": BboxGeometry(x=2.0, y=2.0, width=4.0, height=4.0)}
    )
    assert world.annotations.update(job.id, [moved])[0].label_class == "car"


def test_a_track_class_must_be_declared(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    with pytest.raises(LabelClassNotInSchema):
        world.tracks.create(clip.source_id, "ghost")
    empty = world.tracks.create(clip.source_id, "car")
    with pytest.raises(LabelClassNotInSchema):
        world.tracks.change_class(job.id, empty.track.id, "ghost")
    assert world.tracks.change_class(job.id, empty.track.id, "van").track.label_class == "van"


@pytest.mark.parametrize(
    ("label_class", "external_id"), [("", None), ("  ", None), ("car", ""), ("car", " ")]
)
def test_a_blank_class_or_external_id_is_an_invalid_name(
    world: World, label_class: str, external_id: str | None
) -> None:
    clip = world.clip()
    with pytest.raises(InvalidName):
        world.tracks.create(clip.source_id, label_class, external_id=external_id)
    assert world.tracks.list(clip.source_id) == []


@pytest.mark.parametrize("label_class", ["", "  "])
def test_a_class_change_to_a_blank_class_is_an_invalid_name(world: World, label_class: str) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0])
    with pytest.raises(InvalidName):
        world.tracks.change_class(job.id, detail.track.id, label_class)
    assert world.tracks.get(detail.track.id) == detail


def test_the_same_class_again_changes_nothing(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0])
    heard: list[AnnotationsWritten] = []
    world.workspace.event_bus.subscribe(AnnotationsWritten, heard.append)
    assert world.tracks.change_class(job.id, detail.track.id, "car") == detail
    assert heard == []


def test_a_merge_keeps_the_survivors_own_external_id(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    kept = world.tracks.create(clip.source_id, "car", external_id="a").track
    absorbed = world.tracks.create(clip.source_id, "car", external_id="b").track
    assert world.tracks.merge(job.id, kept.id, absorbed.id).track.external_id == "a"
    created = world.tracks.create(clip.source_id, "car", external_id="b")
    assert created.track.external_id == "b"


def test_a_finished_job_writes_no_track(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0])
    for occurrence in clip.occurrences:
        if world.progress(job, occurrence.asset_id) is not AssetProgress.ANNOTATED:
            world.jobs.mark(job.id, occurrence.asset_id, AssetProgress.ANNOTATED)
    world.jobs.complete(job.id)
    with pytest.raises(JobFinished):
        world.tracks.delete(job.id, detail.track.id)


def test_an_observed_annotation_is_not_edited_into_3d(world: World) -> None:
    SchemaService(world.workspace).create_version(
        world.project.id,
        [
            LabelClass(name="car", geometries=(GeometryType.BBOX, GeometryType.CUBOID_3D)),
            VAN,
            LANE,
        ],
    )
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0])
    observed = world.annotations.get(detail.observations[0].annotation_id)
    cuboid = Cuboid3DGeometry(center=(0.0, 0.0, 5.0), size=(1.0, 1.0, 1.0), yaw=0.0)
    with pytest.raises(InvalidAnnotation):
        world.annotations.update(job.id, [observed.model_copy(update={"geometry": cuboid})])


def test_settled_needs_every_observation_inside_the_batch(world: World) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0])
    assert world.tracks.status(detail.track.id, clip.batch_id).settled
    elsewhere = world.batches.create(world.project.id, "none")
    assert not world.tracks.status(detail.track.id, elsewhere.id).settled
    empty = world.tracks.create(clip.source_id, "car")
    assert not world.tracks.status(empty.track.id, clip.batch_id).settled
