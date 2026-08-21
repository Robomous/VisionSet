# usage: from visionset.kernel.services import BatchService
"""Batches: the unit of annotation work, and the moment a schema stops moving.

A batch is a curated slice of a project's assets that goes through annotation
together. Its whole reason to exist is that annotation needs a *frozen* target:
which assets, under which version of the schema, cut into which jobs. Approval
is where that freezing happens, and four things follow from it:

- **Membership is editable in ``draft`` and nowhere else.** After approval the
  batch has been partitioned into jobs against a pinned schema; adding an asset
  would leave it in no job, and removing one would leave a job describing work
  that no longer exists. Excluding an asset from that point on is a per-asset
  ``skipped`` decision — recorded, not erased — which lands with the job service.
- **The schema version is pinned at approval, and moves only when asked.**
  ``Batch.schema_version`` is ``None`` while a draft and set at approval from the
  project's active version. It never *follows* the active version — a schema that
  evolved mid-batch would change the rules under work already in flight, which is
  exactly what versioning exists to prevent. :meth:`BatchService.repin` is the one
  way it moves, and somebody has to ask for it; see that method for the gates.
- **The partition is exact.** Disjoint segments whose union is the batch — see
  ``domain/partition.py`` for why both halves are load-bearing.
- **Completion is derived.** ``complete`` recomputes from the jobs rather than
  taking the caller's word, because a completed batch is what lets its annotated
  assets be promoted into the Dataset.

The lifecycle is one-way; ``BATCH_TRANSITIONS`` in ``domain/batch.py`` is the
whole of what is legal, and this service consults that table rather than
restating it.

Composition follows the rule in ``docs/content/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and never names an adapter.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import NoReturn
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from visionset.kernel.domain import (
    BATCH_JOB_KEY,
    BATCH_TRANSITIONS,
    CORRECTABLE_STATES,
    DELETABLE_STATES,
    EDITABLE_STATES,
    LIVE_JOB_STATES,
    PRE_LABEL_JOB_TYPE,
    PRE_LABELABLE_STATES,
    REPINNABLE_STATES,
    AnnotationJob,
    AnnotationJobState,
    AnnotationSchema,
    AnnotationSummary,
    Asset,
    AssetProgress,
    AssetSort,
    BackgroundJob,
    Batch,
    BatchApproved,
    BatchCompleted,
    BatchState,
    ChangeKind,
    ClassCount,
    MembershipChange,
    OrphanGuard,
    Partition,
    PreLabelRun,
    Project,
    SchemaDiff,
    SingleJob,
    TaskGroup,
    diff_classes,
    initial_progress,
    normalize_name,
    partition_assets,
    require_move,
    require_state,
)
from visionset.kernel.errors import (
    AssetNotFound,
    AssetNotInBatch,
    BatchImmutable,
    BatchNotComplete,
    BatchNotEditable,
    BatchNotFound,
    BatchNotInAnnotation,
    ConfirmationRequired,
    DestructiveSchemaChange,
    EmptyBatch,
    ProjectNotFound,
    SchemaChangeWouldOrphan,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.workspace_service import WorkspaceService

#: What ``approve`` calls the task group it creates. One group is one round of
#: work over the batch; a later review round would be a second group beside it.
FIRST_ROUND = "round 1"


class BatchService:
    """Create, curate, approve and retire the batches of one workspace."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._schemas = SchemaService(workspace)

    # --- reading -----------------------------------------------------------

    def get(self, batch_id: UUID) -> Batch:
        """The batch with that id.

        Raises:
            BatchNotFound: no such batch in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_batch(uow, batch_id)

    def jobs(self, batch_id: UUID) -> list[AnnotationJob]:
        """Every annotation job the batch was partitioned into, in segment order.

        Empty until the batch is approved: a draft has no jobs yet.

        Raises:
            BatchNotFound: no such batch in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return jobs_of(uow, self.require_batch(uow, batch_id))

    def live_job(self, batch_id: UUID, *, job_type: str) -> BackgroundJob | None:
        """That kind of work already under way against this batch, if any.

        ``InferenceConnectionService.live_job``'s counterpart, over
        :data:`~visionset.kernel.domain.inference.BATCH_JOB_KEY` instead of a
        connection's. What a route asks so that a second request joins the run
        already in flight instead of paying for the same inference twice — see
        that method for the coalescing it does and does not promise.
        """
        for job in self._workspace.job_queue.list(states=LIVE_JOB_STATES, types={job_type}):
            if job.payload.get(BATCH_JOB_KEY) == str(batch_id):
                return job
        return None

    def latest_pre_label_job(self, batch_id: UUID) -> PreLabelRun | None:
        """That batch's most recent pre-labeling run, live or settled, if it has one.

        ``live_job``'s sibling: the same question about the same job type, asked
        over every state rather than only the live ones — a dialog reopened
        after a cancelled run or a failure needs the *last* thing that happened
        here, not only one still in flight. Delegates to :meth:`pre_label_runs`
        rather than repeating its payload match: the queue read costs the same
        either way, so a second body here would only be a second place for that
        match to drift from the first.
        """
        return self.pre_label_runs().get(batch_id)

    def pre_label_runs(self) -> Mapping[UUID, PreLabelRun]:
        """Every batch's most recent pre-labeling run, read from the queue at once.

        ``InferenceConnectionService.connection_jobs``'s reasoning, one resource
        over: a caller listing batches needs this for every row, and reading the
        queue once for the whole page is what keeps a listing from costing a
        query per batch — the ``promoted`` parameter's cost model, applied here
        instead of to trunk membership.

        The newest per batch, because both questions get asked: *is something
        running now* and *what happened last time*. The queue answers
        newest-first, so the first job seen for a batch is that batch's latest.

        A job whose payload names no batch is skipped rather than raised over:
        it cannot be a run this method is about, and a batch listing is the
        wrong place to discover a malformed row.
        """
        latest: dict[UUID, PreLabelRun] = {}
        for job in self._workspace.job_queue.list(types={PRE_LABEL_JOB_TYPE}):
            named = job.payload.get(BATCH_JOB_KEY)
            if not isinstance(named, str):
                continue
            batch_id = UUID(named)
            if batch_id not in latest:
                latest[batch_id] = PreLabelRun.of(job)
        return latest

    def assets(self, batch_id: UUID) -> list[Asset]:
        """Everything in the batch, in membership order.

        The read behind "what did that ingest actually gather" — membership
        order is the stored ``batch_asset.position``, so a caller reading the
        batch twice sees the same sequence and an ``add_assets`` appends rather
        than reshuffles. ``DatasetService.assets`` is the same method over the
        trunk, and answers to the same rule about a member that is not there.

        Raises:
            BatchNotFound: no such batch in this workspace.
            WorkspaceCorrupt: the batch holds an asset that is not stored.
        """
        with self._workspace.unit_of_work() as uow:
            return assets_of(uow, self.require_batch(uow, batch_id))

    def asset_page(
        self,
        batch_id: UUID,
        *,
        progress: frozenset[AssetProgress] | None = None,
        sort: AssetSort = AssetSort.MEMBERSHIP,
        limit: int | None = None,
        offset: int = 0,
    ) -> tuple[list[PlacedAsset], int]:
        """A window of the batch's assets with placement and label summary, and the filtered total.

        Placement is read once off the jobs, the summary once off the store, and only
        the window's assets are hydrated — the listing used to read every asset of
        the batch for every page. ``confidence`` orders by the lowest model score,
        unscored last, ties in membership order.

        Raises:
            BatchNotFound: no such batch in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            placement = {
                asset_id: (job.id, job.state, state)
                for job in jobs_of(uow, batch)
                for asset_id, state in job.progress.items()
            }
            summary = uow.annotation_summary(batch.id)
            nothing = AnnotationSummary(count=0)
            ids = [
                asset_id
                for asset_id in batch.asset_ids
                if progress is None or placement.get(asset_id, (None, None, None))[2] in progress
            ]
            if sort is AssetSort.CONFIDENCE:
                position = {asset_id: at for at, asset_id in enumerate(batch.asset_ids)}
                ids.sort(
                    key=lambda asset_id: (
                        summary.get(asset_id, nothing).min_model_confidence is None,
                        summary.get(asset_id, nothing).min_model_confidence or 0.0,
                        position[asset_id],
                    )
                )
            window = ids[offset:] if limit is None else ids[offset : offset + limit]
            items = []
            for asset_id in window:
                asset = uow.assets.get(asset_id)
                if asset is None:
                    raise WorkspaceCorrupt(
                        f"batch {batch.name!r} holds asset {asset_id}, which is not stored"
                    )
                job_id, job_state, state = placement.get(asset_id, (None, None, None))
                items.append(
                    PlacedAsset(
                        asset=asset,
                        job_id=job_id,
                        job_state=job_state,
                        progress=state,
                        summary=summary.get(asset_id, nothing),
                    )
                )
            return items, len(ids)

    # ``list`` shadows the builtin for every annotation after it in this class
    # body, so it comes last here and the helpers that need ``list[...]`` live
    # at module level.
    def holding(self, asset_id: UUID) -> list[Batch]:
        """Every batch that carries this asset, oldest membership first.

        Declared **above** ``list``, and that is a language constraint rather
        than taste: a method named ``list`` shadows the builtin for every
        annotation after it in the class body, so ``-> list[Batch]`` below this
        point is read as a reference to that method and fails to typecheck. The
        module docstring's ordering note owns the rule.

        The edge ``Repository`` cannot walk: membership is a join table and every
        scoped read it serves runs the other way, from a batch to its assets.

        Answers ``[]`` for an asset in no batch, which is the ordinary state of
        anything ingested without a target — not an error, and deliberately not a
        refusal about the asset's existence either: this is a question about
        membership, and an id nothing holds is honestly held by nothing.
        """
        with self._workspace.unit_of_work() as uow:
            found = [uow.batches.get(one) for one in uow.batches_holding(asset_id)]
            # A membership row whose batch is gone would be a cascade guarantee
            # failing, which is `WorkspaceCorrupt` territory rather than a hole to
            # paper over — but `batch_asset` carries `ON DELETE CASCADE`, so the
            # row cannot outlive the batch and this filter is unreachable. Kept
            # because `get` is typed optional and asserting would be worse.
            return [batch for batch in found if batch is not None]

    def list(self, project_id: UUID) -> list[Batch]:
        """Every batch of that project, in the order they were created.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            return uow.batches.list(project_id)

    # --- membership: draft only --------------------------------------------

    def create(self, project_id: UUID, name: str, asset_ids: Sequence[UUID] = ()) -> Batch:
        """Start a draft batch, optionally with its first assets.

        Raises:
            ProjectNotFound: no such project in this workspace.
            InvalidName: the name is blank once stripped.
            AssetNotFound: an asset id is not in this project.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            members = _require_assets(uow, project_id, asset_ids)
            return uow.batches.add(
                Batch(
                    project_id=project_id,
                    name=normalize_name(name, what="batch"),
                    asset_ids=_deduplicated(members),
                )
            )

    def create_correction(self, batch_id: UUID, name: str, asset_ids: Sequence[UUID] = ()) -> Batch:
        """Start a draft batch that corrects a completed one.

        **The forward-only answer to "this needs fixing".** A ``completed`` batch
        is immutable as a workflow unit — ``BATCH_TRANSITIONS`` gives it no exit
        and none is coming — so the legitimate intent behind wanting to reopen
        one is served by a new batch over the same assets, carrying lineage back
        to it.

        Only from ``completed``, which is what ``CORRECTABLE_STATES`` says and
        what the wire declares as ``create_correction``. Correcting a batch that
        is still open is not a correction; it is the work, and it happens in the
        batch that is already there.

        ``asset_ids`` defaults to **the parent's whole membership**, because
        "correct this batch" is the ordinary ask and re-listing forty-eight ids
        to say so is a worse API than a default. A subset is the other ordinary
        ask — the three frames somebody found wrong — and any id given must be
        one the parent actually carried: a correction of a batch is a correction
        *of what was in it*, and admitting an unrelated asset would make lineage
        a claim about nothing.

        The child is an ordinary draft in every other respect. It pins the
        **active** schema at its own approval, not the parent's pin, which is the
        point of correcting under a contract that has since moved on.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the parent is not ``completed``.
            InvalidName: the name is blank once stripped.
            AssetNotInBatch: an asset id is not one the parent carried.
        """
        with self._workspace.unit_of_work() as uow:
            parent = self.require_batch(uow, batch_id)
            require_state(
                CORRECTABLE_STATES,
                parent.state,
                _subject(parent),
                refusal="it cannot be corrected — correcting an open batch is the work itself",
            )
            members = list(asset_ids) if asset_ids else list(parent.asset_ids)
            carried = set(parent.asset_ids)
            for asset_id in members:
                if asset_id not in carried:
                    raise AssetNotInBatch(
                        f"asset {asset_id} is not in batch {parent.id}, so a correction "
                        "of that batch cannot include it"
                    )
            return uow.batches.add(
                Batch(
                    project_id=parent.project_id,
                    name=normalize_name(name, what="batch"),
                    asset_ids=_deduplicated(members),
                    parent_batch_id=parent.id,
                )
            )

    def add_assets(self, batch_id: UUID, asset_ids: Sequence[UUID]) -> MembershipChange:
        """Put assets in the batch. Adding one it already holds changes nothing.

        Membership is a set, so repeating an asset is not new information. Order
        is the order assets were first added.

        **Written one row at a time**, through ``UnitOfWork.add_batch_assets``
        rather than by replacing the batch. Two callers adding different assets
        to one draft used to write the whole entity and lose one of the two — see
        that method for the mechanism. The consequence worth stating here is what
        it buys: this method no longer has an opinion about the members it was not
        given, so it cannot undo a concurrent edit even in principle.

        Returns what actually changed, not just the batch: ``changed`` excludes
        every id the batch already held, which is the number a surface reports
        and the only way "added 3" can be told from "3 were already there".

        Raises:
            BatchNotFound: no such batch in this workspace.
            BatchNotEditable: the batch is past ``draft``.
            AssetNotFound: an asset id is not in this project.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_draft(uow, batch_id)
            wanted = _require_assets(uow, batch.project_id, asset_ids)
            added = uow.add_batch_assets(batch.id, _deduplicated(wanted))
            return MembershipChange(batch=self.require_batch(uow, batch_id), changed=tuple(added))

    def remove_assets(self, batch_id: UUID, asset_ids: Sequence[UUID]) -> MembershipChange:
        """Take assets out of the batch. Removing one it does not hold is a no-op.

        Only while the batch is a draft. Once it is approved, an asset that
        should not be labeled is marked ``skipped`` instead — a decision the
        record keeps, rather than a membership edit that erases it.

        A draft has no jobs — they are cut at approval — so nothing downstream
        describes the asset being removed and there is nothing to reconcile. That
        is the reason the gate is ``draft`` and not a matter of taste, and
        ``test_removing_from_a_draft_leaves_no_job_behind_because_there_are_none``
        asserts it rather than leaving it to this paragraph.

        Row-at-a-time like :meth:`add_assets`, and returning the ids it actually
        removed for the same reason.

        Raises:
            BatchNotFound: no such batch in this workspace.
            BatchNotEditable: the batch is past ``draft``.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_draft(uow, batch_id)
            removed = uow.remove_batch_assets(batch.id, list(asset_ids))
            return MembershipChange(batch=self.require_batch(uow, batch_id), changed=tuple(removed))

    # --- lifecycle ---------------------------------------------------------

    def approve(self, batch_id: UUID, partition: Partition | None = None) -> Batch:
        """Freeze the batch: pin its schema version and cut it into jobs.

        ``partition`` defaults to :class:`SingleJob` — one job for the whole
        batch, which is the common case.

        Everything lands in one transaction, so a refusal anywhere leaves a
        ``draft`` batch with no task group and no jobs — never a half-partitioned
        one. :class:`BatchApproved` is announced once that transaction has
        committed, so a subscriber can never see a partition that was rolled
        back, and one that raises cannot roll this one back.

        **An asset that already carries labels starts ``annotated``, not
        ``unannotated``** (:func:`initial_progress`). That is how a correction
        batch comes out *seeded*: annotations hang off an ``asset_id``, so a
        batch cut over an already-labeled asset opens with the earlier round's
        boxes already drawn on it, and filing such an asset under "nothing
        labeled here" would be a lie the gallery's filters repeat. Nothing here
        asks whether this batch is a correction — the rule reads the asset, not
        the lineage. One exception reads the asset too: an asset whose every
        label is a model's opens ``pre_labeled``, because nobody has judged
        those labels and a second batch must not be the thing that makes them
        promotable — its consequence is that such a frame is confirmed again in
        the new batch. Its honest consequence is that a correction whose every
        asset seeded ``annotated`` is already *settled*, so it can be completed
        with no edits at all; a correction is opt-in per asset, and the
        alternative is to make a reviewer re-declare work nobody disputed.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the batch is not a ``draft``.
            EmptyBatch: the batch holds no assets.
            SchemaNotFound: the project has no schema to pin.
            InvalidPartition: the segments are not an exact partition.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            require_move(BATCH_TRANSITIONS, batch.state, BatchState.APPROVED, _subject(batch))
            if not batch.asset_ids:
                raise EmptyBatch(
                    f"batch {batch.name!r} has no assets; an approved empty batch has no jobs "
                    f"and could never complete"
                )

            # Not created here if it is missing: SchemaService is the only door to
            # a schema version, and inventing one would be a second.
            pinned = self._schemas.get_active(batch.project_id).version
            segments = partition_assets(
                batch.asset_ids, SingleJob() if partition is None else partition
            )

            seeding = _seeding(uow, batch.asset_ids)
            group = uow.task_groups.add(TaskGroup(batch_id=batch.id, name=FIRST_ROUND))
            job_ids = [
                uow.annotation_jobs.add(
                    AnnotationJob(
                        task_group_id=group.id,
                        progress={
                            asset_id: initial_progress(
                                has_annotations=asset_id in seeding,
                                judged=not seeding.get(asset_id, False),
                            )
                            for asset_id in segment
                        },
                    )
                ).id
                for segment in segments
            ]
            approved = uow.batches.update(
                batch.model_copy(update={"state": BatchState.APPROVED, "schema_version": pinned})
            )

        self._workspace.event_bus.publish(
            BatchApproved(
                batch_id=approved.id,
                project_id=approved.project_id,
                schema_version=pinned,
                job_ids=tuple(job_ids),
                asset_count=len(approved.asset_ids),
            )
        )
        return approved

    def start(self, batch_id: UUID) -> Batch:
        """Open the batch for annotation.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the batch is not ``approved``.
        """
        return self._move(batch_id, BatchState.IN_ANNOTATION)

    def require_pre_labelable(self, batch_id: UUID) -> Batch:
        """The batch, if a model may pre-label it right now.

        ``require_downloadable``'s construction: the gate a caller consults
        before it commits to anything, so a route or the orchestration behind it
        refuses in the same breath rather than after resolving a connection or
        reading a schema. Everything else pre-labeling can be refused for — the
        connection's prompt kind, the pinned schema's classes, the local runtime
        — is a fact this service cannot see; this checks only what
        :data:`PRE_LABELABLE_STATES` decides.

        Raises :class:`BatchNotInAnnotation` rather than ``InvalidTransition``,
        on ``JobService.require_open_batch``'s precedent: pre-labeling is a
        write, made through the same jobs an annotator writes through, so it is
        refused in the one vocabulary every other write into a closed batch
        already uses.

        Raises:
            BatchNotFound: no such batch in this workspace.
            BatchNotInAnnotation: the batch is not ``in_annotation``, so a model
                cannot pre-label it.
        """
        batch = self.get(batch_id)
        if batch.state not in PRE_LABELABLE_STATES:
            raise BatchNotInAnnotation(
                f"batch {batch.name!r} is {batch.state.value!r}, not "
                f"{BatchState.IN_ANNOTATION.value!r}; a model cannot pre-label a batch "
                f"nobody opened"
            )
        return batch

    def repin(self, batch_id: UUID, *, allow_destructive: bool = False) -> Batch:
        """Move the batch's schema pin onto the project's current active version.

        Explicit, never automatic. The pin protects two things — a stable
        validation target mid-batch, and jobs already partitioned against it —
        and neither is harmed by *adding* a class, which is the overwhelmingly
        common change and the one that otherwise forces somebody to abandon a
        batch to use a label they just created. What the pin does not protect is
        release reproducibility: ``ReleaseService.publish`` already stamps the
        manifest with the *active* version while annotations carry their
        batch-pinned ones, so the system already tolerates mixed versions.

        The gate is the schema classifier, not a new rule: ``diff_classes`` judges
        the pinned classes against the active ones, an additive verdict goes
        through untouched, and a narrowing one needs ``allow_destructive`` — the
        same two refusals ``SchemaService.create_version`` makes, in the same
        order and with the same vocabulary, because it is the same question asked
        from the other end. The orphan refusal is scoped to **this batch**: only
        labels written into it are at stake, so a class removed project-wide is
        still re-pinnable here if nobody in this batch used it.

        Annotations already written keep the version they were stamped with; only
        new writes are judged against the new pin. That is the mixed-version
        posture releases already have, not a new one.

        Re-pinning onto the version already pinned is a no-op: the same batch
        comes back, nothing is written, and nothing is announced.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the batch is not ``approved`` or ``in_annotation``
                — a draft has no pin yet and a completed batch's pin is history.
            SchemaNotFound: the project has no schema at all.
            WorkspaceCorrupt: the pinned version is not stored.
            DestructiveSchemaChange: the active version narrows what the pinned
                one allowed, and ``allow_destructive`` was not ``True``.
            SchemaChangeWouldOrphan: annotations in *this batch* sit under a class
                the change would break. No flag overrides this.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            require_state(
                REPINNABLE_STATES,
                batch.state,
                _subject(batch),
                refusal="its schema pin cannot move",
            )

            active = self._schemas.require_active(uow, batch.project_id)
            # A draft cannot reach here, so the pin is set — but the read is a
            # lookup either way, and a pin naming a version nobody stored is the
            # cascade guarantee failing rather than a caller's mistake.
            pinned = self._pinned_schema(uow, batch)
            if pinned.version == active.version:
                return batch

            diff = diff_classes(pinned.classes, active.classes)
            guarded: frozenset[OrphanGuard] = frozenset()
            if diff.is_destructive:
                self._refuse_narrowing(uow, batch, diff, allow_destructive)
                # The change's grain, not the class name — the same the publish
                # gate uses, and for the same reason: this batch's `car` boxes
                # survive a version that only takes `car`'s polygon away.
                guarded = diff.guards

            if not uow.repin_batch_unless_annotated(batch.id, active.version, guarded):
                self._refuse_orphaning(uow, batch, guarded)
            return batch.model_copy(update={"schema_version": active.version})

    def complete(self, batch_id: UUID) -> Batch:
        """Close the batch, if every one of its jobs is done.

        Completion is derived rather than declared: this reads the jobs and
        refuses if any is outstanding. A completed batch is what lets its
        annotated assets be promoted into the Dataset, so the kernel does not
        take a caller's word for it. :class:`BatchCompleted` follows the commit,
        and is the announcement that this batch is now promotable.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the batch is not ``in_annotation``.
            BatchNotComplete: a job has not finished.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            require_move(BATCH_TRANSITIONS, batch.state, BatchState.COMPLETED, _subject(batch))
            jobs = jobs_of(uow, batch)
            outstanding = [j for j in jobs if j.state is not AnnotationJobState.COMPLETED]
            if outstanding:
                raise BatchNotComplete(
                    f"batch {batch.name!r} has {len(outstanding)} of {len(jobs)} jobs still "
                    f"unfinished; a batch completes only when all of its jobs do"
                )
            completed = uow.batches.update(batch.model_copy(update={"state": BatchState.COMPLETED}))

        self._workspace.event_bus.publish(
            BatchCompleted(
                batch_id=completed.id,
                project_id=completed.project_id,
                asset_count=len(completed.asset_ids),
            )
        )
        return completed

    def delete(self, batch_id: UUID, *, confirm: bool = False) -> None:
        """Remove a batch, its task groups, its jobs and its membership rows.

        The cascade is the database's: every foreign key into the batch subtree
        is ``ON DELETE CASCADE``. **Annotations are not touched** — they hang off
        assets, not off batches, so deleting the unit of work never deletes the
        work. Neither are the assets themselves, nor any blob.

        A ``completed`` batch cannot be deleted at all, and no flag lifts it. The
        state check comes **before** the confirmation one, because a refusal
        naming ``confirm=True`` as the remedy would be naming a flag that does
        not work — the ``NotAWorkspace`` mistake, one service over.

        Raises:
            BatchNotFound: no such batch in this workspace.
            BatchImmutable: the batch is ``completed``.
            ConfirmationRequired: ``confirm`` was not ``True``.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            if batch.state not in DELETABLE_STATES:
                raise BatchImmutable(
                    f"batch {batch.name!r} is {batch.state.value!r} and cannot be deleted; a "
                    f"completed batch is the record of what was labeled, against which schema "
                    f"version, and what was deliberately skipped"
                )
            if not confirm:
                raise ConfirmationRequired(
                    f"deleting batch {batch.name!r} destroys its task groups and jobs, including "
                    f"their progress; pass confirm=True to proceed"
                )
            uow.batches.delete(batch.id)

    # --- the re-pin gates, mirroring SchemaService's ------------------------

    def _pinned_schema(self, uow: UnitOfWork, batch: Batch) -> AnnotationSchema:
        """The version this batch is judged against, read inside the caller's transaction.

        ``WorkspaceCorrupt`` rather than ``SchemaNotFound`` for the reason
        ``assets_of`` gives about a member that is not stored: schema versions are
        never deleted except by their project's cascade, which takes this batch
        with them, so a pin naming nothing is a guarantee failing rather than
        anybody's mistake.
        """
        for schema in uow.schemas.list(batch.project_id):
            if schema.version == batch.schema_version:
                return schema
        raise WorkspaceCorrupt(
            f"batch {batch.name!r} is pinned to schema version {batch.schema_version}, "
            f"which is not stored"
        )

    def _refuse_narrowing(
        self, uow: UnitOfWork, batch: Batch, diff: SchemaDiff, allow_destructive: bool
    ) -> None:
        """Let a narrowing re-pin through only if it was asked for.

        ``SchemaService._refuse_narrowing``'s sibling, and split the same way:
        intent is asked here, facts on disk are asked by the write itself. What
        differs between the two is only the scope of the second question — there
        it is every annotation in the project, here only the ones written into
        this batch, since a re-pin cannot orphan a label that is not judged by
        this pin.
        """
        if not allow_destructive:
            raise DestructiveSchemaChange(
                f"re-pinning batch {batch.name!r} onto the active schema version narrows what "
                f"it allows ({diff.describe(ChangeKind.DESTRUCTIVE)}); pass "
                f"allow_destructive=True to proceed",
                classes=tuple(sorted(diff.destructive_classes)),
            )

    def _refuse_orphaning(
        self, uow: UnitOfWork, batch: Batch, guarded: frozenset[OrphanGuard]
    ) -> NoReturn:
        """Name the classes the guarded re-pin refused over, and their counts.

        ``SchemaService._refuse_orphaning`` over one batch's labels — see it for
        why the counting happens after the guard rather than before it, and why
        an empty count still refuses.
        """
        annotated = _annotated_classes(uow, batch, guarded)
        affected = sorted(annotated.keys()) or sorted({guard.label_class for guard in guarded})
        counted = ", ".join(
            f"{name!r} ({annotated[name].annotations})" if name in annotated else repr(name)
            for name in affected
        )
        raise SchemaChangeWouldOrphan(
            f"cannot re-pin batch {batch.name!r}: it already holds annotations under "
            f"{counted}. Migrating them onto a new version is not supported yet, and "
            f"the kernel will not orphan them",
            blockers=tuple(annotated[name] for name in affected if name in annotated),
        )

    # --- the transition table, consulted rather than restated ---------------
    # ``require_move`` lives in ``domain/transitions.py``; every machine in this
    # kernel asks it the same question, so the refusal reads the same way.

    def _move(self, batch_id: UUID, to: BatchState) -> Batch:
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            require_move(BATCH_TRANSITIONS, batch.state, to, _subject(batch))
            return uow.batches.update(batch.model_copy(update={"state": to}))

    # --- lookups shared by the operations above ----------------------------

    def _require_project(self, uow: UnitOfWork, project_id: UUID) -> Project:
        """The project, or refuse because this workspace does not have it."""
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )
        return project

    def require_batch(self, uow: UnitOfWork, batch_id: UUID) -> Batch:
        """The batch, checked through its project so workspaces stay separate.

        A batch belonging to another workspace reads as missing rather than as
        forbidden — this service speaks for one workspace, and anything outside
        it is not its to describe.

        Public, and taking a ``uow``, for the reason ``JobService.require_job``
        is: ``JobService`` and ``DatasetService`` both need this exact ladder
        *inside their own transaction*, and three spellings of "no batch {id} in
        workspace {name}" is the drift this codebase refuses.

        Raises:
            BatchNotFound: no such batch in this workspace.
        """
        batch = uow.batches.get(batch_id)
        if batch is None:
            raise BatchNotFound(
                f"no batch {batch_id} in workspace {self._workspace.workspace.name!r}"
            )
        self._require_project(uow, batch.project_id)
        return batch

    def require_draft(self, uow: UnitOfWork, batch_id: UUID) -> Batch:
        """The batch, refusing it if its membership is already frozen.

        Public, and taking a ``uow``, for the reason :meth:`require_batch` is:
        ``IngestService`` has to know a target batch will accept members
        *before* it decodes five thousand files, and discovering that inside a
        later ``add_assets`` would mean finding out after the work.

        Raises:
            BatchNotFound: no such batch in this workspace.
            BatchNotEditable: the batch is past ``draft``.
        """
        batch = self.require_batch(uow, batch_id)
        if batch.state not in EDITABLE_STATES:
            raise BatchNotEditable(
                f"batch {batch.name!r} is {batch.state.value!r}, so its membership is frozen; "
                f"after approval an asset is excluded by marking it skipped, never by removing it"
            )
        return batch


def _subject(batch: Batch) -> str:
    """How a refused move names the batch. One spelling, so refusals read alike."""
    return f"batch {batch.name!r}"


def _annotated_classes(
    uow: UnitOfWork, batch: Batch, guarded: frozenset[OrphanGuard]
) -> dict[str, ClassCount]:
    """How much of this batch is at risk from ``guarded``, per class.

    ``SchemaService._annotated_classes`` over one batch's membership rather than
    a whole project, and N + 1 for the same reason: ``Repository.list`` takes a
    single ``parent_id`` and an Annotation's parent is its Asset. When it starts
    to cost, the fix is a method on the port, never a SQLAlchemy import here.

    Reads ``batch.asset_ids`` directly rather than through ``assets_of``: the
    asset rows themselves are not wanted, only their annotations, and a missing
    membership row would refuse a re-pin over a fact this question does not need.
    """
    annotations: dict[str, int] = {}
    assets: dict[str, set[UUID]] = {}
    for asset_id in batch.asset_ids:
        for annotation in uow.annotations.list(asset_id):
            # Only the annotations a guard would orphan, never the whole class.
            # ``SchemaService._guarded_annotations`` makes the argument.
            if not any(guard.matches(annotation) for guard in guarded):
                continue
            annotations[annotation.label_class] = annotations.get(annotation.label_class, 0) + 1
            assets.setdefault(annotation.label_class, set()).add(asset_id)
    return {
        name: ClassCount(label_class=name, annotations=count, assets=len(assets[name]))
        for name, count in annotations.items()
    }


def _seeding(uow: UnitOfWork, asset_ids: Iterable[UUID]) -> dict[UUID, bool]:
    """Which of these assets already carry labels, and whether every one is a model's.

    What :func:`initial_progress` is asked, for the whole batch at once rather
    than per asset inside the partition loop — the segments are a partition of
    the same membership, so asking per segment would be the same reads in a
    shape that makes the count depend on how the work was cut up.

    N + 1 walks, and the ``_annotated_classes`` note above applies verbatim: an
    Annotation's parent is its Asset and ``Repository.list`` takes one
    ``parent_id``. Paid once per batch, at approval. When it starts to cost, the
    fix is a method on the port, never a SQLAlchemy import here.
    """
    seeding: dict[UUID, bool] = {}
    for asset_id in asset_ids:
        labels = uow.annotations.list(asset_id)
        if labels:
            seeding[asset_id] = all(label.provenance == "model" for label in labels)
    return seeding


class PlacedAsset(BaseModel):
    """One asset seen from inside its batch: the asset, where its work stands, and
    its labels in two numbers.
    """

    model_config = ConfigDict(frozen=True)

    asset: Asset
    job_id: UUID | None
    job_state: AnnotationJobState | None
    progress: AssetProgress | None
    summary: AnnotationSummary


def assets_of(uow: UnitOfWork, batch: Batch) -> list[Asset]:
    """Every asset in the batch, in membership order.

    Module-level and public beside ``jobs_of``, for the same reason: the read is
    one line and the *rule about a member that is not stored* is the part worth
    having one copy of. ``batch_asset.asset_id`` cascades from ``asset``, so a
    deleted asset takes its membership row with it and this cannot happen while
    foreign keys are on — dropping the id quietly would turn that guarantee
    failing into a batch that silently holds less than it says.
    """
    assets = []
    for asset_id in batch.asset_ids:
        asset = uow.assets.get(asset_id)
        if asset is None:
            raise WorkspaceCorrupt(
                f"batch {batch.name!r} holds asset {asset_id}, which is not stored"
            )
        assets.append(asset)
    return assets


def jobs_of(uow: UnitOfWork, batch: Batch) -> list[AnnotationJob]:
    """Every job under the batch, task group by task group, in segment order.

    Public and at module level, beside :meth:`BatchService.require_batch` and for
    the same reason: ``JobService`` tallies these and ``DatasetService`` reads
    their progress, so the walk from batch to jobs lives here — where
    :meth:`BatchService.approve` writes it — rather than once per reader.
    """
    return [
        job
        for group in uow.task_groups.list(batch.id)
        for job in uow.annotation_jobs.list(group.id)
    ]


def _require_assets(uow: UnitOfWork, project_id: UUID, asset_ids: Iterable[UUID]) -> list[UUID]:
    """The ids, once every one of them is known to belong to this project."""
    wanted = list(asset_ids)
    known = {asset.id for asset in uow.assets.list(project_id)}
    if strangers := sorted(str(a) for a in set(wanted) - known):
        raise AssetNotFound(f"these assets are not in project {project_id}: {', '.join(strangers)}")
    return wanted


def _deduplicated(asset_ids: Iterable[UUID]) -> list[UUID]:
    """The ids with repeats dropped, keeping the position of the first of each."""
    return list(dict.fromkeys(asset_ids))
