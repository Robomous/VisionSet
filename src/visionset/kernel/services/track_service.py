# usage: from visionset.kernel.services import TrackService
"""Tracks: one object followed through the frame occurrences of one source.

A track is a set of observations, each naming an occurrence and an existing
annotation on the asset that occurrence decoded to. The annotation stays an
ordinary asset annotation; the observation is the only link, and deleting the
annotation deletes it.

**Writes follow the annotation.** Every write except ``create`` names the job
acting, and passes the same gates an annotation write does: the job's batch is
open for annotation, the job is not finished, and every observation the
operation touches sits on an asset that job carries at a writable progress
(``require_writable``). A structural operation touches every observation of
every track it names, so a job holding some of a track's assets cannot
restructure the rest, and a settled batch is never reopened.

Status is derived from the observed assets' progress on every read and never
stored.

Composition follows ``AnnotationService``: an open ``WorkspaceService`` and
nothing else.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from uuid import UUID

from visionset.kernel.domain import (
    SEQUENCE_KINDS,
    AnnotationJob,
    AnnotationOperation,
    AnnotationSchema,
    AssetProgress,
    Batch,
    FrameOccurrence,
    ObservedFrame,
    Source,
    Track,
    TrackDetail,
    TrackObservation,
    TrackStatus,
)
from visionset.kernel.errors import (
    AnnotationAlreadyObserved,
    AnnotationNotAtOccurrence,
    AssetNotInBatch,
    AssetNotJudged,
    BatchNotFound,
    FrameOccurrenceNotFound,
    InvalidAnnotation,
    InvalidName,
    LabelClassNotInSchema,
    ObservationNotFound,
    OccurrenceAlreadyObserved,
    SourceNotFound,
    SourceNotSequence,
    TrackClassMismatch,
    TrackExternalIdTaken,
    TrackMergeWithItself,
    TrackNotFound,
    TrackSourceMismatch,
    TrackSplitEmpty,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.annotation_service import (
    AnnotationService,
    require_trackable,
    require_writable,
)
from visionset.kernel.services.batch_service import BatchService, jobs_of
from visionset.kernel.services.job_service import JobService
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.source_service import SourceService
from visionset.kernel.services.workspace_service import WorkspaceService


class TrackService:
    """Read and write the tracks of one workspace."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._jobs = JobService(workspace)
        self._batches = BatchService(workspace)
        self._sources = SourceService(workspace)
        self._annotations = AnnotationService(workspace)
        self._schemas = SchemaService(workspace)

    # --- reading -----------------------------------------------------------

    def get(self, track_id: UUID) -> TrackDetail:
        """The track and its observations, in position order.

        Raises:
            TrackNotFound: no such track in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return _detail(uow, self._require_track(uow, track_id))

    def list(self, source_id: UUID) -> list[TrackDetail]:
        """Every track of the source, in creation order.

        Raises:
            SourceNotFound: no such source in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._sources.require_source(uow, source_id)
            return [_detail(uow, track) for track in uow.tracks.list(source_id)]

    def status(self, track_id: UUID, batch_id: UUID) -> TrackStatus:
        """How far the batch's work on the track's observed assets has got.

        Each observation counts once, under the progress its asset holds in the
        batch's job carrying it, or under ``outside`` when the batch does not
        hold that asset.

        Raises:
            TrackNotFound: no such track in this workspace.
            BatchNotFound: no such batch in the track's project.
        """
        with self._workspace.unit_of_work() as uow:
            track = self._require_track(uow, track_id)
            batch = self._batches.require_batch(uow, batch_id)
            if batch.project_id != self._project_of(uow, track):
                raise BatchNotFound(f"no batch {batch_id} in the project of track {track.id}")
            held = {
                asset_id: progress
                for job in jobs_of(uow, batch)
                for asset_id, progress in job.progress.items()
            }
            counts = dict.fromkeys(AssetProgress, 0)
            outside = 0
            for frame in _detail(uow, track).observations:
                progress = held.get(frame.asset_id)
                if progress is None:
                    outside += 1
                else:
                    counts[progress] += 1
            return TrackStatus(
                track_id=track.id, batch_id=batch.id, progress=counts, outside=outside
            )

    # --- writing -----------------------------------------------------------

    def create(
        self, source_id: UUID, label_class: str, *, external_id: str | None = None
    ) -> TrackDetail:
        """Start an empty track of one class on a sequence source.

        Raises:
            InvalidName: the class or the external id is blank.
            SourceNotFound: no such source in this workspace.
            SourceNotSequence: the source is neither a video nor an image sequence.
            SchemaNotFound: the project has no schema yet.
            LabelClassNotInSchema: the active schema version does not declare the class.
            TrackExternalIdTaken: another track of the source carries ``external_id``.
        """
        _require_text(label_class, what="class")
        if external_id is not None:
            _require_text(external_id, what="external id")
        track = Track(source_id=source_id, label_class=label_class, external_id=external_id)
        with self._workspace.unit_of_work() as uow:
            uow.hold_writes()
            source = _require_sequence(self._sources.require_source(uow, source_id))
            _require_declared(self._schemas.require_active(uow, source.project_id), label_class)
            _require_external_id_free(uow, source_id, external_id)
            uow.tracks.add(track)
            return _detail(uow, track)

    def add_imported_in(
        self,
        uow: UnitOfWork,
        batch_id: UUID,
        tracks: Sequence[tuple[Track, Sequence[TrackObservation]]],
    ) -> tuple[TrackDetail, ...]:
        """Write an import's tracks and their observations, inside the import's transaction.

        No job acts yet: the import's batch is still a draft, and the gate is that
        it holds every observed asset and each observed annotation is the
        import's own. Every other rule of :meth:`create` and :meth:`observe` holds.

        Raises:
            BatchNotFound: no such batch in this workspace.
            BatchNotEditable: the batch is past ``draft``.
            InvalidName: a class or an external id is blank.
            SourceNotFound: no such source in the batch's project.
            SourceNotSequence: a source is neither a video nor an image sequence.
            SchemaNotFound: the project has no schema yet.
            LabelClassNotInSchema: the active schema version does not declare a class.
            TrackExternalIdTaken: another track of the source carries an external id.
            FrameOccurrenceNotFound: no such occurrence in this workspace.
            TrackSourceMismatch: an occurrence belongs to another source.
            AnnotationNotFound: no such annotation in this workspace.
            AnnotationNotAtOccurrence: an annotation sits on another asset.
            AssetNotInBatch: the batch does not hold an observed asset.
            InvalidAnnotation: an annotation is not an import's, or is a 3D label.
            TrackClassMismatch: an annotation's class is not its track's.
            OccurrenceAlreadyObserved: a track observes one occurrence twice.
            AnnotationAlreadyObserved: an annotation is observed twice.
        """
        batch = self._batches.hold_draft(uow, batch_id)
        schema = self._schemas.require_active(uow, batch.project_id)
        members = set(batch.asset_ids)
        for track, observations in tracks:
            _require_text(track.label_class, what="class")
            if track.external_id is not None:
                _require_text(track.external_id, what="external id")
            source = self._sources.require_source(uow, track.source_id)
            if source.project_id != batch.project_id:
                raise SourceNotFound(f"no source {source.id} in project {batch.project_id}")
            _require_sequence(source)
            _require_declared(schema, track.label_class)
            _require_external_id_free(uow, track.source_id, track.external_id)
            uow.tracks.add(track)
            seen: set[UUID] = set()
            for observation in observations:
                occurrence = self._require_occurrence(uow, track, observation.occurrence_id)
                annotation = self._annotations.require_annotation(uow, observation.annotation_id)
                if annotation.asset_id != occurrence.asset_id:
                    raise AnnotationNotAtOccurrence(
                        f"annotation {annotation.id} is on asset {annotation.asset_id}, and "
                        f"occurrence {occurrence.id} decoded to asset {occurrence.asset_id}"
                    )
                if occurrence.asset_id not in members:
                    raise AssetNotInBatch(
                        f"batch {batch.id} does not hold asset {occurrence.asset_id}"
                    )
                if annotation.provenance != "import":
                    raise InvalidAnnotation(
                        f"annotation {annotation.id} is {annotation.provenance!r}, and an "
                        f"import observes only the labels it wrote"
                    )
                if annotation.label_class != track.label_class:
                    raise TrackClassMismatch(
                        f"annotation {annotation.id} is {annotation.label_class!r} and track "
                        f"{track.id} is {track.label_class!r}"
                    )
                require_trackable(uow, annotation)
                if occurrence.id in seen:
                    raise OccurrenceAlreadyObserved(
                        f"track {track.id} observes occurrence {occurrence.id} twice"
                    )
                seen.add(occurrence.id)
                if uow.observation_of(annotation.id) is not None:
                    raise AnnotationAlreadyObserved(
                        f"annotation {annotation.id} is already observed by a track"
                    )
                uow.track_observations.add(observation.model_copy(update={"track_id": track.id}))
        return tuple(_detail(uow, track) for track, _ in tracks)

    def observe(
        self, job_id: UUID, track_id: UUID, occurrence_id: UUID, annotation_id: UUID
    ) -> TrackDetail:
        """Record that the track is seen at the occurrence, as the annotation drawn there.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            JobFinished: the job is already completed.
            TrackNotFound: no such track in the job's project.
            FrameOccurrenceNotFound: no such occurrence in this workspace.
            TrackSourceMismatch: the occurrence belongs to another source.
            AnnotationNotFound: no such annotation in this workspace.
            AnnotationNotAtOccurrence: the annotation sits on another asset.
            AssetNotInJob: the job does not carry the occurrence's asset.
            AssetNotWritable: that asset's progress says its labeling is over.
            AssetNotJudged: that asset is ``pre_labeled``; nobody has judged its labels.
            TrackClassMismatch: the annotation's class is not the track's.
            InvalidAnnotation: the annotation is a 3D label; tracks follow 2D ones.
            OccurrenceAlreadyObserved: the track already observes the occurrence.
            AnnotationAlreadyObserved: another observation names the annotation.
        """
        with self._workspace.unit_of_work() as uow:
            job, batch = self._open(uow, job_id)
            track = self._require_track(uow, track_id, project_id=batch.project_id)
            occurrence = self._require_occurrence(uow, track, occurrence_id)
            annotation = self._annotations.require_annotation(uow, annotation_id)
            if annotation.asset_id != occurrence.asset_id:
                raise AnnotationNotAtOccurrence(
                    f"annotation {annotation.id} is on asset {annotation.asset_id}, and "
                    f"occurrence {occurrence.id} decoded to asset {occurrence.asset_id}"
                )
            require_writable(job, occurrence.asset_id)
            if job.progress[occurrence.asset_id] is AssetProgress.PRE_LABELED:
                raise AssetNotJudged(
                    f"asset {occurrence.asset_id} in job {job.id} is 'pre_labeled', and a "
                    f"replacing pre-label run would delete what the track observes; edit or "
                    f"confirm the asset first"
                )
            if annotation.label_class != track.label_class:
                raise TrackClassMismatch(
                    f"annotation {annotation.id} is {annotation.label_class!r} and track "
                    f"{track.id} is {track.label_class!r}"
                )
            require_trackable(uow, annotation)
            if any(o.occurrence_id == occurrence.id for o in uow.track_observations.list(track.id)):
                raise OccurrenceAlreadyObserved(
                    f"track {track.id} already observes occurrence {occurrence.id} "
                    f"(position {occurrence.position})"
                )
            if uow.observation_of(annotation.id) is not None:
                raise AnnotationAlreadyObserved(
                    f"annotation {annotation.id} is already observed by a track; an asset at two "
                    f"occurrences needs one annotation per occurrence"
                )
            uow.track_observations.add(
                TrackObservation(
                    track_id=track.id, occurrence_id=occurrence.id, annotation_id=annotation.id
                )
            )
            return _detail(uow, track)

    def unobserve(self, job_id: UUID, track_id: UUID, occurrence_id: UUID) -> TrackDetail:
        """Remove the track's observation at the occurrence. The annotation stays.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            JobFinished: the job is already completed.
            TrackNotFound: no such track in the job's project.
            ObservationNotFound: the track observes nothing at that occurrence.
            AssetNotInJob: the job does not carry the observed asset.
            AssetNotWritable: that asset's progress says its labeling is over.
        """
        with self._workspace.unit_of_work() as uow:
            job, batch = self._open(uow, job_id)
            track = self._require_track(uow, track_id, project_id=batch.project_id)
            frame = next(
                (f for f in _detail(uow, track).observations if f.occurrence_id == occurrence_id),
                None,
            )
            if frame is None:
                raise ObservationNotFound(
                    f"track {track.id} observes nothing at occurrence {occurrence_id}"
                )
            require_writable(job, frame.asset_id)
            observation = uow.observation_of(frame.annotation_id)
            if observation is None:
                raise WorkspaceCorrupt(
                    f"track {track.id} lists annotation {frame.annotation_id}, which no "
                    f"observation names"
                )
            uow.track_observations.delete(observation.id)
            return _detail(uow, track)

    def change_class(self, job_id: UUID, track_id: UUID, label_class: str) -> TrackDetail:
        """Give the track and every annotation it observes a new class, or refuse.

        The annotations are rewritten through the same rules as an annotation
        edit, against the batch's pinned version, in one transaction with the
        track; the same class again changes nothing.

        Raises:
            InvalidName: the class is blank.
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            JobFinished: the job is already completed.
            TrackNotFound: no such track in the job's project.
            AssetNotInJob: the job does not carry an observed asset.
            AssetNotWritable: an observed asset's progress says its labeling is over.
            LabelClassNotInSchema: the batch's pinned version does not declare the class.
            DisallowedGeometry: the class does not accept an observed annotation's geometry.
            MissingRequiredAttribute: the class requires an attribute an observed
                annotation does not carry.
            UnknownAttribute: an observed annotation carries an attribute the class
                does not declare.
            InvalidAttributeValue: an observed annotation's attribute value does not
                fit the class's declaration of it.
            DuplicateClassificationTag: an observed tag's asset already carries a tag
                of the class.
            InvalidAnnotation: a rewritten annotation does not satisfy the pinned version.
            StaleWrite: an asset moved between this call's read and its write.
            WorkspaceCorrupt: the open batch has no pinned schema version.
        """
        _require_text(label_class, what="class")
        with self._workspace.unit_of_work() as uow:
            job, batch = self._open(uow, job_id)
            track = self._require_track(uow, track_id, project_id=batch.project_id)
            renamed = Track.model_validate({**track.model_dump(), "label_class": label_class})
            _require_declared(self._annotations.pinned_schema(batch), label_class)
            frames = _detail(uow, track).observations
            _require_scope(job, frames)
            if renamed == track:
                return _detail(uow, track)
            replacements = []
            for frame in frames:
                annotation = uow.annotations.get(frame.annotation_id)
                if annotation is None:
                    raise WorkspaceCorrupt(
                        f"track {track.id} observes annotation {frame.annotation_id}, "
                        f"which does not exist"
                    )
                replacements.append(annotation.model_copy(update={"label_class": label_class}))
            uow.tracks.update(renamed)
            stored = self._annotations.update_in(uow, job, batch, replacements)
            detail = _detail(uow, renamed)
        if stored:
            self._annotations.announce(job.id, batch.id, AnnotationOperation.UPDATE, stored)
        return detail

    def merge(self, job_id: UUID, track_id: UUID, absorbed_id: UUID) -> TrackDetail:
        """Move every observation of ``absorbed_id`` onto the track, and delete it.

        The tracks share a source and a class and observe disjoint occurrences.
        The track keeps its own external id, and takes the absorbed one's when it
        has none.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            JobFinished: the job is already completed.
            TrackMergeWithItself: the two ids are the same track.
            TrackNotFound: either track is not in the job's project.
            TrackSourceMismatch: the tracks belong to different sources.
            TrackClassMismatch: the tracks have different classes.
            AssetNotInJob: the job does not carry an observed asset of either track.
            AssetNotWritable: an observed asset's progress says its labeling is over.
            OccurrenceAlreadyObserved: both tracks observe one occurrence.
        """
        if track_id == absorbed_id:
            raise TrackMergeWithItself(f"track {track_id} cannot be merged with itself")
        with self._workspace.unit_of_work() as uow:
            job, batch = self._open(uow, job_id)
            track = self._require_track(uow, track_id, project_id=batch.project_id)
            absorbed = self._require_track(uow, absorbed_id, project_id=batch.project_id)
            if absorbed.source_id != track.source_id:
                raise TrackSourceMismatch(
                    f"track {track.id} is of source {track.source_id} and track {absorbed.id} "
                    f"of source {absorbed.source_id}; a track never spans two sources"
                )
            if absorbed.label_class != track.label_class:
                raise TrackClassMismatch(
                    f"track {track.id} is {track.label_class!r} and track {absorbed.id} is "
                    f"{absorbed.label_class!r}; change one track's class first"
                )
            kept = _detail(uow, track).observations
            moved = _detail(uow, absorbed).observations
            _require_scope(job, (*kept, *moved))
            shared = {f.occurrence_id for f in kept} & {f.occurrence_id for f in moved}
            if shared:
                position = min(f.position for f in moved if f.occurrence_id in shared)
                raise OccurrenceAlreadyObserved(
                    f"tracks {track.id} and {absorbed.id} both observe {len(shared)} "
                    f"occurrence(s), the first at position {position}"
                )
            for observation in uow.track_observations.list(absorbed.id):
                uow.track_observations.update(observation.model_copy(update={"track_id": track.id}))
            uow.tracks.delete(absorbed.id)
            if track.external_id is None and absorbed.external_id is not None:
                track = uow.tracks.update(
                    track.model_copy(update={"external_id": absorbed.external_id})
                )
            return _detail(uow, track)

    def split(
        self, job_id: UUID, track_id: UUID, occurrence_id: UUID
    ) -> tuple[TrackDetail, TrackDetail]:
        """Cut the track at the occurrence: it and every later observation move to a new track.

        The new track has the same source and class and no external id. Answers
        the shortened track, then the new one.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            JobFinished: the job is already completed.
            TrackNotFound: no such track in the job's project.
            FrameOccurrenceNotFound: no such occurrence in this workspace.
            TrackSourceMismatch: the occurrence belongs to another source.
            AssetNotInJob: the job does not carry an observed asset.
            AssetNotWritable: an observed asset's progress says its labeling is over.
            TrackSplitEmpty: the cut would leave either track with no observation.
        """
        with self._workspace.unit_of_work() as uow:
            job, batch = self._open(uow, job_id)
            track = self._require_track(uow, track_id, project_id=batch.project_id)
            cut = self._require_occurrence(uow, track, occurrence_id)
            frames = _detail(uow, track).observations
            _require_scope(job, frames)
            later = {f.annotation_id for f in frames if f.position >= cut.position}
            if not later or len(later) == len(frames):
                raise TrackSplitEmpty(
                    f"a cut at position {cut.position} leaves track {track.id} or the new track "
                    f"empty; cut after its first observation and at or before its last"
                )
            created = uow.tracks.add(
                Track(source_id=track.source_id, label_class=track.label_class)
            )
            for observation in uow.track_observations.list(track.id):
                if observation.annotation_id in later:
                    uow.track_observations.update(
                        observation.model_copy(update={"track_id": created.id})
                    )
            return _detail(uow, track), _detail(uow, created)

    def delete(self, job_id: UUID, track_id: UUID) -> None:
        """Delete the track and its observations. Every annotation it observed stays.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            JobFinished: the job is already completed.
            TrackNotFound: no such track in the job's project.
            AssetNotInJob: the job does not carry an observed asset.
            AssetNotWritable: an observed asset's progress says its labeling is over.
        """
        with self._workspace.unit_of_work() as uow:
            job, batch = self._open(uow, job_id)
            track = self._require_track(uow, track_id, project_id=batch.project_id)
            _require_scope(job, _detail(uow, track).observations)
            uow.tracks.delete(track.id)

    def delete_with_annotations(self, job_id: UUID, track_id: UUID) -> int:
        """Delete the track and every annotation it observed; answers how many annotations went.

        The annotations are removed through the same rules as an annotation
        delete, in one transaction with the track.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            JobFinished: the job is already completed.
            TrackNotFound: no such track in the job's project.
            AssetNotInJob: the job does not carry an observed asset.
            AssetNotWritable: an observed asset's progress says its labeling is over.
            StaleWrite: an asset moved between this call's read and its write.
        """
        with self._workspace.unit_of_work() as uow:
            job, batch = self._open(uow, job_id)
            track = self._require_track(uow, track_id, project_id=batch.project_id)
            frames = _detail(uow, track).observations
            _require_scope(job, frames)
            doomed = self._annotations.delete_in(uow, job, [f.annotation_id for f in frames])
            uow.tracks.delete(track.id)
        if doomed:
            self._annotations.announce(job.id, batch.id, AnnotationOperation.DELETE, doomed)
        return len(doomed)

    # --- lookups -----------------------------------------------------------

    def _open(self, uow: UnitOfWork, job_id: UUID) -> tuple[AnnotationJob, Batch]:
        """The job and its batch, past the gates every annotation write passes, held open.

        The job is read again once held: its progress is what ``require_writable``
        judges, and a mark committed before the lock would otherwise be judged
        stale and written over.
        """
        job = self._jobs.require_job(uow, job_id)
        batch = self._jobs.require_open_batch(uow, job)
        self._jobs.hold_open_job(uow, job)
        return self._jobs.require_job(uow, job_id), batch

    def _project_of(self, uow: UnitOfWork, track: Track) -> UUID:
        return self._sources.require_source(uow, track.source_id).project_id

    def _require_track(
        self, uow: UnitOfWork, track_id: UUID, *, project_id: UUID | None = None
    ) -> Track:
        track = uow.tracks.get(track_id)
        if track is not None:
            try:
                source = self._sources.require_source(uow, track.source_id)
            except SourceNotFound:
                pass
            else:
                if project_id is None or source.project_id == project_id:
                    return track
        where = (
            f"workspace {self._workspace.workspace.name!r}"
            if project_id is None
            else f"project {project_id}"
        )
        raise TrackNotFound(f"no track {track_id} in {where}")

    def _require_occurrence(
        self, uow: UnitOfWork, track: Track, occurrence_id: UUID
    ) -> FrameOccurrence:
        occurrence = uow.frame_occurrences.get(occurrence_id)
        if occurrence is not None and occurrence.source_id == track.source_id:
            return occurrence
        if occurrence is not None:
            try:
                self._sources.require_source(uow, occurrence.source_id)
            except SourceNotFound:
                pass
            else:
                raise TrackSourceMismatch(
                    f"occurrence {occurrence.id} belongs to source {occurrence.source_id} and "
                    f"track {track.id} to source {track.source_id}"
                )
        raise FrameOccurrenceNotFound(
            f"no frame occurrence {occurrence_id} in workspace {self._workspace.workspace.name!r}"
        )


def _detail(uow: UnitOfWork, track: Track) -> TrackDetail:
    frames = []
    for observation in uow.track_observations.list(track.id):
        occurrence = uow.frame_occurrences.get(observation.occurrence_id)
        if occurrence is None:
            raise WorkspaceCorrupt(
                f"track {track.id} observes occurrence {observation.occurrence_id}, "
                f"which does not exist"
            )
        frames.append(
            ObservedFrame(
                occurrence_id=occurrence.id,
                position=occurrence.position,
                timestamp=occurrence.timestamp,
                asset_id=occurrence.asset_id,
                annotation_id=observation.annotation_id,
            )
        )
    frames.sort(key=lambda frame: frame.position)
    return TrackDetail(track=track, observations=tuple(frames))


def _require_sequence(source: Source) -> Source:
    if source.kind not in SEQUENCE_KINDS:
        raise SourceNotSequence(
            f"source {source.id} is a {source.kind.value}, and only a video or an image "
            f"sequence has frame occurrences for a track to observe"
        )
    return source


def _require_declared(schema: AnnotationSchema, label_class: str) -> None:
    if not any(declared.name == label_class for declared in schema.classes):
        raise LabelClassNotInSchema(
            f"class {label_class!r} is not in schema version {schema.version}, so no "
            f"annotation of it could be observed"
        )


def _require_text(value: str, *, what: str) -> None:
    if not value.strip():
        raise InvalidName(f"a track's {what} must contain at least one non-blank character")


def _require_scope(job: AnnotationJob, frames: Iterable[ObservedFrame]) -> None:
    """Refuse unless the job may write every observed asset, by the annotation write rule."""
    for frame in frames:
        require_writable(job, frame.asset_id)


def _require_external_id_free(uow: UnitOfWork, source_id: UUID, external_id: str | None) -> None:
    if external_id is None:
        return
    if any(track.external_id == external_id for track in uow.tracks.list(source_id)):
        raise TrackExternalIdTaken(
            f"source {source_id} already has a track with external id {external_id!r}"
        )
