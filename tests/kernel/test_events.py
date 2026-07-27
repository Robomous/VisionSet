"""The event bus: who hears what, and what a bad subscriber cannot do.

Two things are being tested and they are worth keeping apart. The first is the
bus itself — dispatch by type, delivery order, and the isolation of a handler
that raises — and those tests need no workspace, because the bus needs none.

The second is the emission, and every one of those goes through the real path:
a batch approved, annotated, completed, promoted and published. A service that
emitted the right event while doing the wrong thing would pass a test that
called ``publish`` directly, and the whole point of the after-commit rule is that
the two cannot come apart.

The serializability and naming sweeps read ``SAMPLES``, which is checked against
``DomainEvent.__subclasses__()`` — so a sixth event fails loudly here until
somebody says what one looks like, rather than quietly going uncovered.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from visionset.kernel import BatchNotComplete, ReleaseTagTaken
from visionset.kernel.adapters import InProcessEventBus
from visionset.kernel.domain import (
    Annotation,
    AnnotationOperation,
    AnnotationsWritten,
    Asset,
    BatchApproved,
    BatchCompleted,
    BatchState,
    BboxGeometry,
    BySize,
    DomainEvent,
    GeometryType,
    IngestCompleted,
    LabelClass,
    ReleasePublished,
)
from visionset.kernel.ports import EventBus
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    DatasetService,
    JobService,
    ProjectService,
    ReleaseService,
    SchemaService,
    WorkspaceService,
)

SIGN = LabelClass(name="sign", geometry=GeometryType.BBOX)

#: One of every event, for the sweeps below. Checked against the class tree by
#: ``test_every_event_has_a_sample``, which is what stops this drifting.
SAMPLES: dict[type[DomainEvent], DomainEvent] = {
    BatchApproved: BatchApproved(
        batch_id=uuid4(),
        project_id=uuid4(),
        schema_version=1,
        job_ids=(uuid4(), uuid4()),
        asset_count=2,
    ),
    BatchCompleted: BatchCompleted(batch_id=uuid4(), project_id=uuid4(), asset_count=2),
    AnnotationsWritten: AnnotationsWritten(
        job_id=uuid4(),
        batch_id=uuid4(),
        operation=AnnotationOperation.ADD,
        asset_ids=(uuid4(),),
        annotation_ids=(uuid4(),),
    ),
    ReleasePublished: ReleasePublished(
        release_id=uuid4(),
        dataset_id=uuid4(),
        project_id=uuid4(),
        tag="v1",
        manifest_hash="0" * 64,
        schema_version=1,
        asset_count=2,
        annotation_count=2,
    ),
    IngestCompleted: IngestCompleted(
        ingest_job_id=uuid4(),
        project_id=uuid4(),
        source_id=uuid4(),
        asset_count=2,
    ),
}


class Recorder[E: DomainEvent]:
    """A subscriber that only remembers what it was handed."""

    def __init__(self) -> None:
        self.seen: list[E] = []

    def __call__(self, event: E) -> None:
        self.seen.append(event)


class Exploder:
    """A subscriber that does the worst thing a subscriber can do."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, event: DomainEvent) -> None:
        self.calls += 1
        raise RuntimeError("subscriber went wrong")


def _approved(batch_id: UUID | None = None) -> BatchApproved:
    sample = SAMPLES[BatchApproved]
    assert isinstance(sample, BatchApproved)
    return sample if batch_id is None else sample.model_copy(update={"batch_id": batch_id})


# --- the bus, on its own ------------------------------------------------------


def test_a_subscription_to_a_concrete_type_hears_only_that_type() -> None:
    bus = InProcessEventBus()
    approvals: Recorder[BatchApproved] = Recorder()
    bus.subscribe(BatchApproved, approvals)

    bus.publish(SAMPLES[BatchApproved])
    bus.publish(SAMPLES[BatchCompleted])

    assert [type(event) for event in approvals.seen] == [BatchApproved]


def test_a_subscription_to_the_base_type_hears_everything() -> None:
    bus = InProcessEventBus()
    everything: Recorder[DomainEvent] = Recorder()
    bus.subscribe(DomainEvent, everything)

    for event in SAMPLES.values():
        bus.publish(event)

    assert {type(event) for event in everything.seen} == set(SAMPLES)


def test_an_event_nobody_subscribed_to_is_simply_dropped() -> None:
    bus = InProcessEventBus()
    approvals: Recorder[BatchApproved] = Recorder()
    bus.subscribe(BatchApproved, approvals)

    bus.publish(SAMPLES[ReleasePublished])

    assert approvals.seen == []


def test_subscribers_are_called_in_registration_order() -> None:
    bus = InProcessEventBus()
    order: list[str] = []
    for label in ("first", "second", "third"):
        bus.subscribe(DomainEvent, lambda _event, label=label: order.append(label))

    bus.publish(SAMPLES[BatchApproved])

    assert order == ["first", "second", "third"]


def test_the_same_handler_subscribed_twice_is_called_twice() -> None:
    bus = InProcessEventBus()
    recorder: Recorder[DomainEvent] = Recorder()
    bus.subscribe(DomainEvent, recorder)
    bus.subscribe(BatchApproved, recorder)

    bus.publish(SAMPLES[BatchApproved])

    assert len(recorder.seen) == 2


def test_a_handler_that_subscribes_while_being_called_does_not_get_that_event() -> None:
    """The loop reads a snapshot, so registering mid-dispatch is not retroactive."""
    bus = InProcessEventBus()
    latecomer: Recorder[DomainEvent] = Recorder()
    bus.subscribe(DomainEvent, lambda _event: bus.subscribe(DomainEvent, latecomer))

    bus.publish(SAMPLES[BatchApproved])
    assert latecomer.seen == []

    bus.publish(SAMPLES[BatchCompleted])
    assert [type(event) for event in latecomer.seen] == [BatchCompleted]


# --- a subscriber that raises -------------------------------------------------


def test_a_raising_subscriber_does_not_stop_the_ones_after_it() -> None:
    bus = InProcessEventBus()
    before: Recorder[DomainEvent] = Recorder()
    after: Recorder[DomainEvent] = Recorder()
    bus.subscribe(DomainEvent, before)
    bus.subscribe(DomainEvent, Exploder())
    bus.subscribe(DomainEvent, after)

    bus.publish(SAMPLES[BatchApproved])

    assert (len(before.seen), len(after.seen)) == (1, 1)


def test_a_raising_subscriber_does_not_reach_the_caller_of_publish() -> None:
    bus = InProcessEventBus()
    bus.subscribe(DomainEvent, Exploder())

    bus.publish(SAMPLES[BatchApproved])  # would raise if the isolation were missing


def test_a_swallowed_subscriber_failure_is_logged_with_its_traceback(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Isolated is not silent: the one thing a swallowed error must do is surface."""
    bus = InProcessEventBus()
    bus.subscribe(DomainEvent, Exploder())

    with caplog.at_level(logging.ERROR, logger="visionset.kernel.adapters.in_process_event_bus"):
        bus.publish(SAMPLES[BatchApproved])

    (record,) = caplog.records
    assert "batch_approved" in record.getMessage()
    assert record.exc_info is not None
    assert "subscriber went wrong" in caplog.text


def test_a_raising_subscriber_is_still_offered_the_next_event() -> None:
    """No circuit breaker: at-most-once is per event, not per subscriber."""
    bus = InProcessEventBus()
    exploder = Exploder()
    bus.subscribe(DomainEvent, exploder)

    bus.publish(SAMPLES[BatchApproved])
    bus.publish(SAMPLES[BatchCompleted])

    assert exploder.calls == 2


# --- the event models ---------------------------------------------------------


def test_every_event_has_a_sample() -> None:
    """The sweeps below are only as complete as ``SAMPLES``, so it is checked."""
    assert set(SAMPLES) == set(DomainEvent.__subclasses__())


@pytest.mark.parametrize("event", list(SAMPLES.values()), ids=lambda e: str(e.name))
def test_every_event_survives_a_round_trip_through_json(event: DomainEvent) -> None:
    """Webhook-readiness, stated as a test: no custom encoder, no lost field."""
    payload = json.loads(json.dumps(event.model_dump(mode="json")))
    assert type(event).model_validate(payload) == event


def test_every_event_name_is_unique_across_the_tree() -> None:
    names = [event.name for event in SAMPLES.values()]
    assert sorted(names) == sorted(set(names))


@pytest.mark.parametrize("event", list(SAMPLES.values()), ids=lambda e: str(e.name))
def test_an_event_cannot_be_edited_after_it_is_announced(event: DomainEvent) -> None:
    with pytest.raises(Exception, match="frozen"):
        event.id = uuid4()


def test_a_naive_occurred_at_is_refused() -> None:
    with pytest.raises(ValueError, match="occurred_at must be timezone-aware"):
        BatchCompleted(
            batch_id=uuid4(),
            project_id=uuid4(),
            asset_count=0,
            occurred_at=datetime(2026, 7, 27, 12, 0, 0),  # noqa: DTZ001
        )


def test_an_aware_occurred_at_is_normalized_to_utc() -> None:
    somewhere = timezone(timedelta(hours=-6))
    event = BatchCompleted(
        batch_id=uuid4(),
        project_id=uuid4(),
        asset_count=0,
        occurred_at=datetime(2026, 7, 27, 6, 0, 0, tzinfo=somewhere),
    )
    assert event.occurred_at == datetime(2026, 7, 27, 12, 0, 0, tzinfo=UTC)


def test_the_default_bus_satisfies_the_port() -> None:
    assert isinstance(InProcessEventBus(), EventBus)


# --- the services, emitting ---------------------------------------------------


class Fixture:
    """A workspace recording every event, walkable from draft to release."""

    def __init__(self, tmp_path: Path, name: str = "ws", *, assets: int = 3) -> None:
        self.root = tmp_path / name
        self.workspace = WorkspaceService.init(self.root)
        self.projects = ProjectService(self.workspace)
        self.schemas = SchemaService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.datasets = DatasetService(self.workspace)
        self.releases = ReleaseService(self.workspace)

        self.seen: list[DomainEvent] = []
        self.workspace.event_bus.subscribe(DomainEvent, self.seen.append)

        self.project = self.projects.create(f"{name}-project")
        self.schemas.create_version(self.project.id, [SIGN])
        self.asset_ids = [self._asset(f"{name}-{index}") for index in range(assets)]

    def _asset(self, seed: str) -> UUID:
        content_hash = self.workspace.blob_store.put(BytesIO(seed.encode()))
        with self.workspace.unit_of_work() as uow:
            return uow.assets.add(
                Asset(
                    project_id=self.project.id,
                    content_hash=content_hash,
                    uri=f"/tmp/{seed}.png",
                    width=640,
                    height=480,
                )
            ).id

    def of[E: DomainEvent](self, event_type: type[E]) -> list[E]:
        return [event for event in self.seen if isinstance(event, event_type)]

    def one[E: DomainEvent](self, event_type: type[E]) -> E:
        (event,) = self.of(event_type)
        return event

    def open_batch(self, *, name: str = "first") -> tuple[UUID, UUID]:
        """An approved, started batch and its single job."""
        batch = self.batches.create(self.project.id, name, self.asset_ids)
        self.batches.approve(batch.id)
        (job,) = self.batches.jobs(batch.id)
        self.batches.start(batch.id)
        self.jobs.start(job.id)
        return batch.id, job.id

    def to_release(self, tag: str = "v1") -> UUID:
        """Draft to published, the whole way, through the real doors."""
        batch_id, job_id = self.open_batch()
        for asset_id in self.asset_ids:
            self.annotations.add(job_id, [_box(asset_id)])
        self.jobs.complete(job_id)
        self.batches.complete(batch_id)
        self.datasets.promote(batch_id)
        dataset_id = self.projects.get_dataset(self.project.id).id
        return self.releases.publish(dataset_id, tag).id

    def close(self) -> None:
        self.workspace.close()


def _box(asset_id: UUID) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="sign",
        schema_version=1,
        geometry=BboxGeometry(x=1.0, y=2.0, width=30.0, height=40.0),
        provenance="human",
    )


def test_approving_a_batch_announces_its_pin_and_its_jobs(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.asset_ids)
    approved = fixture.batches.approve(batch.id, BySize(size=2))

    event = fixture.one(BatchApproved)
    assert (event.batch_id, event.project_id) == (batch.id, fixture.project.id)
    assert event.schema_version == approved.schema_version
    assert list(event.job_ids) == [job.id for job in fixture.batches.jobs(batch.id)]
    assert event.asset_count == len(fixture.asset_ids)
    fixture.close()


def test_completing_a_batch_announces_it(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch_id, job_id = fixture.open_batch()
    for asset_id in fixture.asset_ids:
        fixture.annotations.add(job_id, [_box(asset_id)])
    fixture.jobs.complete(job_id)
    fixture.batches.complete(batch_id)

    event = fixture.one(BatchCompleted)
    assert (event.batch_id, event.project_id) == (batch_id, fixture.project.id)
    assert event.asset_count == len(fixture.asset_ids)
    fixture.close()


def test_starting_a_batch_announces_nothing(tmp_path: Path) -> None:
    """Only the two transitions #13 names emit; ``start`` is not one of them."""
    fixture = Fixture(tmp_path)
    batch = fixture.batches.create(fixture.project.id, "first", fixture.asset_ids)
    fixture.batches.approve(batch.id)
    before = len(fixture.seen)
    fixture.batches.start(batch.id)

    assert len(fixture.seen) == before
    fixture.close()


@pytest.mark.parametrize(
    ("operation", "call"),
    [
        (AnnotationOperation.ADD, "add"),
        (AnnotationOperation.UPDATE, "update"),
        (AnnotationOperation.DELETE, "delete"),
    ],
    ids=lambda value: str(value),
)
def test_each_annotation_write_announces_its_own_operation(
    tmp_path: Path, operation: AnnotationOperation, call: str
) -> None:
    fixture = Fixture(tmp_path)
    batch_id, job_id = fixture.open_batch()
    asset_id = fixture.asset_ids[0]
    (stored,) = fixture.annotations.add(job_id, [_box(asset_id)])
    if call == "update":
        fixture.annotations.update(job_id, [stored.model_copy(update={"label_class": "sign"})])
    elif call == "delete":
        fixture.annotations.delete(job_id, [stored.id])

    event = fixture.of(AnnotationsWritten)[-1]
    assert event.operation is operation
    assert (event.job_id, event.batch_id) == (job_id, batch_id)
    assert (event.asset_ids, event.annotation_ids) == ((asset_id,), (stored.id,))
    fixture.close()


def test_one_event_per_call_however_many_boxes_it_carried(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    _batch_id, job_id = fixture.open_batch()
    stored = fixture.annotations.add(job_id, [_box(a) for a in fixture.asset_ids])

    event = fixture.one(AnnotationsWritten)
    assert set(event.annotation_ids) == {a.id for a in stored}
    assert set(event.asset_ids) == set(fixture.asset_ids)
    fixture.close()


def test_several_boxes_on_one_asset_name_that_asset_once(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    _batch_id, job_id = fixture.open_batch()
    asset_id = fixture.asset_ids[0]
    fixture.annotations.add(job_id, [_box(asset_id), _box(asset_id)])

    event = fixture.one(AnnotationsWritten)
    assert (len(event.asset_ids), len(event.annotation_ids)) == (1, 2)
    fixture.close()


def test_publishing_a_release_announces_what_it_froze(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release_id = fixture.to_release()
    release = fixture.releases.get(release_id)

    event = fixture.one(ReleasePublished)
    assert (event.release_id, event.dataset_id) == (release.id, release.dataset_id)
    assert event.project_id == fixture.project.id
    assert (event.tag, event.manifest_hash) == (release.tag, release.manifest_hash)
    assert (event.schema_version, event.asset_count, event.annotation_count) == (
        release.schema_version,
        release.asset_count,
        release.annotation_count,
    )
    fixture.close()


def test_nothing_in_m1_emits_ingest_completed(tmp_path: Path) -> None:
    """Declared in #13, wired in M2 — and not before, by anything, quietly."""
    fixture = Fixture(tmp_path)
    fixture.to_release()

    assert fixture.of(IngestCompleted) == []
    fixture.close()


# --- what a refusal, and a bad subscriber, do to the record -------------------


def test_a_refused_operation_announces_nothing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    batch_id, _job_id = fixture.open_batch()

    with pytest.raises(BatchNotComplete):
        fixture.batches.complete(batch_id)

    assert fixture.of(BatchCompleted) == []
    fixture.close()


def test_a_lost_tag_race_announces_nothing(tmp_path: Path) -> None:
    """``publish`` emits after its ``except``, so a refused tag is never announced."""
    fixture = Fixture(tmp_path)
    fixture.to_release("v1")
    dataset_id = fixture.projects.get_dataset(fixture.project.id).id

    with pytest.raises(ReleaseTagTaken):
        fixture.releases.publish(dataset_id, "v1")

    assert len(fixture.of(ReleasePublished)) == 1
    fixture.close()


def test_a_raising_subscriber_does_not_roll_back_the_operation(tmp_path: Path) -> None:
    """The acceptance criterion, said in the terms the domain uses."""
    fixture = Fixture(tmp_path)
    fixture.workspace.event_bus.subscribe(BatchApproved, Exploder())
    batch = fixture.batches.create(fixture.project.id, "first", fixture.asset_ids)

    approved = fixture.batches.approve(batch.id)

    assert approved.state is BatchState.APPROVED
    assert fixture.batches.get(batch.id).state is BatchState.APPROVED
    assert len(fixture.batches.jobs(batch.id)) == 1
    fixture.close()


def test_a_raising_subscriber_does_not_undo_a_published_release(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.workspace.event_bus.subscribe(ReleasePublished, Exploder())

    release_id = fixture.to_release()

    assert fixture.releases.verify(release_id).ok
    fixture.close()


def test_a_raising_subscriber_does_not_undo_written_annotations(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.workspace.event_bus.subscribe(AnnotationsWritten, Exploder())
    _batch_id, job_id = fixture.open_batch()
    asset_id = fixture.asset_ids[0]

    fixture.annotations.add(job_id, [_box(asset_id)])

    assert len(fixture.annotations.for_asset(job_id, asset_id)) == 1
    fixture.close()


# --- composition --------------------------------------------------------------


def test_each_open_workspace_gets_its_own_bus(tmp_path: Path) -> None:
    """No module-level singleton: a subscriber on one must not hear the other."""
    one = Fixture(tmp_path, "one")
    two = Fixture(tmp_path, "two")

    two.batches.approve(
        two.batches.create(two.project.id, "first", two.asset_ids).id,
    )

    assert one.of(BatchApproved) == []
    assert len(two.of(BatchApproved)) == 1
    one.close()
    two.close()


def test_a_bus_can_be_injected_at_open(tmp_path: Path) -> None:
    """The seam ``init``/``open`` carry, exercised the way an embedder would."""
    shared = InProcessEventBus()
    recorder: Recorder[BatchApproved] = Recorder()
    shared.subscribe(BatchApproved, recorder)

    fixture = Fixture(tmp_path)
    fixture.close()
    workspace = WorkspaceService.open(fixture.root, event_bus_factory=lambda: shared)

    batches = BatchService(workspace)
    project = ProjectService(workspace).list()[0]
    batches.approve(batches.create(project.id, "first", fixture.asset_ids).id)

    assert len(recorder.seen) == 1
    workspace.close()


def test_reopening_a_workspace_does_not_carry_subscribers_over(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.close()
    workspace = WorkspaceService.open(fixture.root)

    batches = BatchService(workspace)
    project = ProjectService(workspace).list()[0]
    batches.approve(batches.create(project.id, "first", fixture.asset_ids).id)

    assert fixture.of(BatchApproved) == []
    workspace.close()
