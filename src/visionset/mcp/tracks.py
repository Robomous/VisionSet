# usage: from visionset.mcp import tracks
"""Track tools: follow one object through the frame occurrences of a sequence source.

There is no ``get_track``: every write answers the whole track, and
``list_tracks`` reads them all for a source, which is where an agent finds a
track id in the first place.

``delete_track`` has no ``confirm``, on ``delete_annotations``' rationale: the
job write gate is the guard, so once the batch holding a track's observations
closes nothing here can touch that track. A track with no observations touches
no asset, so any open job of its project may still delete it.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import Field

from visionset import wire
from visionset.kernel.services import SourceService, TrackService
from visionset.mcp._resolve import identifier
from visionset.mcp._workspace import opened_workspace
from visionset.wire import shapes

SourceRef = Annotated[
    str,
    Field(description="The video or image-sequence source, by id (from `list_sources`)."),
]
TrackRef = Annotated[str, Field(description="The track, by id (from `list_tracks`).")]
JobRef = Annotated[
    str,
    Field(description="The annotation job acting, by id. It must carry the observed assets."),
]
OccurrenceRef = Annotated[
    str, Field(description="The frame occurrence, by id (from `list_frame_occurrences`).")
]
LabelClassRef = Annotated[
    str, Field(min_length=1, description="A class the batch's pinned schema declares.")
]


def list_frame_occurrences(source_id: SourceRef) -> shapes.Page[shapes.FrameOccurrence]:
    """List a sequence source's frame occurrences, in position order.

    An occurrence is one position of the clip and the asset it decoded to;
    identical frames at two positions are one asset at two occurrences, and a
    track observes occurrences, not assets. A source that is no video or image sequence has none.
    """
    with opened_workspace() as workspace:
        found = SourceService(workspace).occurrences(identifier(source_id, what="source_id"))
    return wire.page([wire.frame_occurrence(o) for o in found])


def list_tracks(source_id: SourceRef) -> shapes.Page[shapes.Track]:
    """List a sequence source's tracks, in creation order, each with its observations."""
    with opened_workspace() as workspace:
        found = TrackService(workspace).list(identifier(source_id, what="source_id"))
    return wire.page([wire.track(t) for t in found])


def get_track_status(
    track_id: TrackRef,
    batch_id: Annotated[str, Field(description="The batch whose work to count, by id.")],
) -> shapes.TrackStatus:
    """Count a track's observations by the progress their assets hold in one batch.

    `outside` counts observations on assets the batch does not hold. `settled`
    is true when the track has at least one observation, the batch holds every
    one (`outside` is 0), and each sits on a settled asset.
    """
    with opened_workspace() as workspace:
        found = TrackService(workspace).status(
            identifier(track_id, what="track_id"), identifier(batch_id, what="batch_id")
        )
    return wire.track_status(found)


def create_track(
    source_id: SourceRef,
    label_class: LabelClassRef,
    external_id: Annotated[
        str | None,
        Field(
            min_length=1,
            description="An identity the track keeps, unique within the source. Optional.",
        ),
    ] = None,
) -> shapes.Track:
    """Start an empty track of one class on a video or image-sequence source.

    The class must be declared by the project's active schema version. Then
    attach annotations with `observe_track`. Refused on a source that is not a
    video, and for an `external_id` another track of the source carries.
    """
    with opened_workspace() as workspace:
        created = TrackService(workspace).create(
            identifier(source_id, what="source_id"), label_class, external_id=external_id
        )
    return wire.track(created)


def observe_track(
    job_id: JobRef,
    track_id: TrackRef,
    occurrence_id: OccurrenceRef,
    annotation_id: Annotated[
        str, Field(description="The annotation drawn at that occurrence, by id.")
    ],
) -> shapes.Track:
    """Record that the track is seen at an occurrence, as an annotation drawn there.

    Draw the annotation first with `add_annotations` on the occurrence's asset.
    It must carry the track's class and be 2D, the job must carry that asset at
    a writable progress other than `pre_labeled` (edit or confirm a model's
    labels first), the track may observe an occurrence once, and an annotation
    belongs to at most one observation.
    """
    with opened_workspace() as workspace:
        found = TrackService(workspace).observe(
            identifier(job_id, what="job_id"),
            identifier(track_id, what="track_id"),
            identifier(occurrence_id, what="occurrence_id"),
            identifier(annotation_id, what="annotation_id"),
        )
    return wire.track(found)


def unobserve_track(
    job_id: JobRef, track_id: TrackRef, occurrence_id: OccurrenceRef
) -> shapes.Track:
    """Remove the track's observation at an occurrence. The annotation stays."""
    with opened_workspace() as workspace:
        found = TrackService(workspace).unobserve(
            identifier(job_id, what="job_id"),
            identifier(track_id, what="track_id"),
            identifier(occurrence_id, what="occurrence_id"),
        )
    return wire.track(found)


def set_track_class(job_id: JobRef, track_id: TrackRef, label_class: LabelClassRef) -> shapes.Track:
    """Give a track and every annotation it observes a new class, in one transaction.

    The batch's pinned schema version must declare the class, and the job must
    carry every observed asset at a writable progress. The same class again
    changes nothing.
    """
    with opened_workspace() as workspace:
        found = TrackService(workspace).change_class(
            identifier(job_id, what="job_id"), identifier(track_id, what="track_id"), label_class
        )
    return wire.track(found)


def merge_tracks(
    job_id: JobRef,
    track_id: TrackRef,
    absorbed_track_id: Annotated[str, Field(description="The track to absorb and delete, by id.")],
) -> shapes.Track:
    """Move every observation of `absorbed_track_id` onto `track_id`, and delete the absorbed one.

    The tracks share a source and a class and observe disjoint occurrences, and
    the job must carry every observed asset of both. The kept track keeps its
    external id, and takes the absorbed one's when it has none.
    """
    with opened_workspace() as workspace:
        found = TrackService(workspace).merge(
            identifier(job_id, what="job_id"),
            identifier(track_id, what="track_id"),
            identifier(absorbed_track_id, what="absorbed_track_id"),
        )
    return wire.track(found)


def split_track(
    job_id: JobRef, track_id: TrackRef, occurrence_id: OccurrenceRef
) -> shapes.TrackSplit:
    """Cut a track at an occurrence: it and every later observation move to a new track.

    Answers the shortened track as `kept` and the new one as `created`. Refused
    when the cut would leave either track empty.
    """
    with opened_workspace() as workspace:
        kept, created = TrackService(workspace).split(
            identifier(job_id, what="job_id"),
            identifier(track_id, what="track_id"),
            identifier(occurrence_id, what="occurrence_id"),
        )
    return wire.track_split(kept, created)


def delete_track(
    job_id: JobRef,
    track_id: TrackRef,
    with_annotations: Annotated[
        bool,
        Field(description="Also delete every annotation the track observes."),
    ] = False,
) -> shapes.TrackDeletion:
    """Delete a track and its observations; the annotations stay unless `with_annotations`.

    No confirmation is required, as for `delete_annotations`: the guard is that
    the job must carry every observed asset at a writable progress, inside a
    batch still open for annotation. `annotations_deleted` says how many went.
    """
    with opened_workspace() as workspace:
        tracks = TrackService(workspace)
        job, track = identifier(job_id, what="job_id"), identifier(track_id, what="track_id")
        if with_annotations:
            removed = tracks.delete_with_annotations(job, track)
        else:
            tracks.delete(job, track)
            removed = 0
    return wire.track_deletion(track, removed)
