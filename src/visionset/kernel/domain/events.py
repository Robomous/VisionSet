# usage: from visionset.kernel.domain import DomainEvent, BatchApproved
"""Domain events: what happened, announced once, after it has happened.

An event is a **statement about the past**, not a request. Nothing in the kernel
reads one back, and no operation waits on a subscriber: events exist so that the
things which will want to react later — indexing, notifications, webhooks, the
background ingest of M2 — have somewhere to attach without a service growing a
dependency on them.

Every event is **frozen**, like a Release and for the same reason: an announcement
that a subscriber could edit before the next subscriber sees it would not be a
statement about the past. Collections are tuples, so the immutability is in the
type rather than in a convention.

``name`` is the wire discriminator, and it is split the same way
:class:`~visionset.kernel.domain.dataset.DatasetChange` splits ``operation``: a
plain ``str`` on the base, narrowed to a ``Literal`` default on each subclass. A
*writer* therefore cannot misspell one, while a *reader* holding a payload some
later VisionSet emitted can still load it as a ``DomainEvent`` and see what it
was called. Every event dumps to JSON with no custom encoder, which is what makes
a webhook a subscriber rather than a rewrite.

Which service emits which event, and the after-commit and at-most-once rules that
govern the emission, are in ``docs/content/events.md`` — those are the bus's business, not
the models'.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator


class AnnotationOperation(StrEnum):
    """Which shape of write on ``AnnotationService`` produced an event.

    Three members for four writes: ``enter_unreviewed`` publishes ``ADD`` when
    rows landed and ``DELETE`` when a replacing call only removed rows —
    the same two members ``add`` and ``delete`` publish, because what differs
    between them is the progress the write leaves behind, which this enum
    does not carry.

    The counterpart of :class:`~visionset.kernel.domain.dataset.DatasetOperation`:
    an enum so an emitter cannot misspell one, and so a subscriber has somewhere
    to look up what an :class:`AnnotationsWritten` can be about.
    """

    ADD = "add"
    UPDATE = "update"
    DELETE = "delete"


class DomainEvent(BaseModel):
    """The base of every event the kernel announces.

    Subscribing to *this* is subscribing to everything: the bus matches an
    event against a subscription with ``isinstance``, so the base type is the
    catch-all and a concrete type is a filter. That is why the base is an
    ordinary model rather than an abstract one.

    ``occurred_at`` is timezone-aware UTC, and a naive value is rejected rather
    than read as local time — the same rule every timestamp in the domain
    follows. It is when the event was *constructed*, which is a moment after the
    transaction it describes committed; the kernel has no need for a finer
    distinction and does not pretend to one.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID = Field(default_factory=uuid4)
    #: The wire name, unique across the events this build knows. See the module
    #: docstring for why it is a ``str`` here and a ``Literal`` on each subclass.
    name: str
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("occurred_at")
    @classmethod
    def _occurred_at_is_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("occurred_at must be timezone-aware (UTC)")
        return value.astimezone(UTC)


class BatchApproved(DomainEvent):
    """A batch was frozen: its schema version pinned, its assets cut into jobs.

    Carries ``job_ids`` because the partition is the interesting part of an
    approval and a subscriber that had to go and read it back would need a
    transaction of its own to learn what this call already knew.
    """

    name: Literal["batch_approved"] = "batch_approved"
    batch_id: UUID
    project_id: UUID
    schema_version: int = Field(ge=1)
    job_ids: tuple[UUID, ...] = ()
    asset_count: int = Field(ge=0)


class BatchCompleted(DomainEvent):
    """A batch closed, every one of its jobs having finished.

    This is the event that says annotated work is now promotable into the
    project's dataset — the gate ``DatasetService.promote`` checks.
    """

    name: Literal["batch_completed"] = "batch_completed"
    batch_id: UUID
    project_id: UUID
    asset_count: int = Field(ge=0)


class AnnotationsWritten(DomainEvent):
    """Labels were added, replaced or removed in one job, in one call.

    Plural and one per *call*, not per annotation: ``AnnotationService``'s three
    writes are all-or-nothing over a whole payload, so one call is one thing that
    happened. ``annotation_ids`` are the ones written or removed, and
    ``asset_ids`` the assets they sit on — which is what a subscriber recomputing
    progress or re-indexing an image actually needs.
    """

    name: Literal["annotations_written"] = "annotations_written"
    job_id: UUID
    batch_id: UUID
    operation: AnnotationOperation
    asset_ids: tuple[UUID, ...] = ()
    annotation_ids: tuple[UUID, ...] = ()


class ReleasePublished(DomainEvent):
    """A dataset was frozen under a tag.

    ``manifest_hash`` names the document in the blob store, so a subscriber can
    read the whole snapshot without being handed it — and two publications of an
    unchanged dataset carry the same hash here, exactly as they share one blob.
    """

    name: Literal["release_published"] = "release_published"
    release_id: UUID
    dataset_id: UUID
    project_id: UUID
    tag: str
    manifest_hash: str
    schema_version: int = Field(ge=1)
    asset_count: int = Field(ge=0)
    annotation_count: int = Field(ge=0)


class BackgroundJobSucceeded(DomainEvent):
    """A queued unit of machine work finished, and finished cleanly.

    **Announced by the dispatcher, not by the handler**, and that is the point of
    it rather than an implementation detail. A handler runs in another process,
    where the bus is a different object with no subscribers — so an event it
    published would be delivered to nobody. The dispatcher is in the API process,
    watching the future resolve, which makes this the one announcement about
    background work that an API-side subscriber can actually receive.
    ``ports/event_bus.py`` records the consequence for the other direction.

    ``result`` is the handler's own answer, carried so that a subscriber does not
    have to read the row back to learn where the work put its output.
    """

    name: Literal["background_job_succeeded"] = "background_job_succeeded"
    job_id: UUID
    job_type: str
    processed: int = Field(ge=0)
    result: dict[str, JsonValue] = Field(default_factory=dict)


class BackgroundJobFailed(DomainEvent):
    """A queued unit of machine work stopped, and said why.

    Its sibling above, on the same terms. ``cancelled`` deliberately announces
    **nothing**: a cancellation is something a person just did through an API that
    already answered them, so an event for it would be telling the caller what
    they asked for. This is for the outcome nobody asked for.
    """

    name: Literal["background_job_failed"] = "background_job_failed"
    job_id: UUID
    job_type: str
    error: str
    attempt: int = Field(ge=0)


class IngestCompleted(DomainEvent):
    """An ingestion run finished and its assets are in the project.

    **Declared here, emitted by nobody.** Ingest is M2's; this exists now so that
    the event vocabulary is settled in one pass rather than one service at a
    time, and so a subscriber written against the bus today already compiles
    against the shape it will be handed. A test asserts nothing in M1 emits it,
    so it cannot quietly acquire a caller before M2 wires one deliberately.
    """

    name: Literal["ingest_completed"] = "ingest_completed"
    ingest_job_id: UUID
    project_id: UUID
    source_id: UUID | None = None
    asset_count: int = Field(ge=0)
