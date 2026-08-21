# usage: from visionset.kernel.services import DatasetService
"""The Dataset: a project's curated trunk, and the log of everything done to it.

Every other service in the kernel produces work. This one *keeps* it. A project's
Dataset is the running answer to "which of our assets are training data?", and it
is mutable by design — assets arrive from batch after batch, and a curator takes
them back out again. What makes that safe to trust is not immutability but the
record: every mutation appends an entry nobody can edit or remove.

Three things shape this module:

- **Work gets in through one gate: a ``completed`` batch.** Not an approved one,
  not one that is merely finished-looking. ``BatchService.complete`` derives
  completion from the jobs rather than taking a caller's word, and this service
  leans on that derivation instead of re-deriving it — promotion asks only
  whether the batch reached ``completed``, because reaching it already meant
  every job was done and every asset settled.
- **The trunk carries assets, and the annotations ride along.** There is no
  membership row for a label, deliberately. An ``Annotation`` hangs off its
  ``asset_id``, so promoting an asset brings everything drawn on it — and a
  second table would be a second thing to keep in step with the first, with
  nothing gained. ``DatasetMember`` is ``(dataset_id, asset_id)`` and that is all
  it will ever be.
- **The log records mutations, not calls.** A ``promote`` that adds nothing —
  the second one, over the same batch — writes no entry, because nothing
  happened. That is what keeps the log worth reading: every line in it is a
  change somebody can point at.

What this service does *not* do is name a dataset. ``Dataset.name`` mirrors its
project's and moves with it; ``ProjectService`` owns both, and the 1:1 relation
is created in the same transaction as the project.

Composition follows the rule in ``docs/content/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and never names an adapter.
"""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID

from visionset.kernel.domain import (
    PROMOTABLE_PROGRESS,
    PROMOTABLE_STATES,
    AnnotationJob,
    Asset,
    Batch,
    BatchState,
    ClassCount,
    Dataset,
    DatasetChange,
    DatasetMember,
    DatasetOperation,
    DatasetStats,
)
from visionset.kernel.errors import (
    BatchNotComplete,
    DatasetNotFound,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.batch_service import BatchService, jobs_of
from visionset.kernel.services.project_service import ProjectService
from visionset.kernel.services.workspace_service import WorkspaceService


class DatasetService:
    """Promote finished work into a project's dataset, and curate what is there."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._batches = BatchService(workspace)
        self._projects = ProjectService(workspace)

    # --- reading -----------------------------------------------------------

    def get(self, dataset_id: UUID) -> Dataset:
        """The dataset with that id.

        Raises:
            DatasetNotFound: no such dataset in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_dataset(uow, dataset_id)

    def assets(self, dataset_id: UUID) -> list[Asset]:
        """Everything currently in the trunk, in the order it was promoted.

        Order is the stored insertion order, so a caller paging through the
        dataset sees the same sequence twice, and promoting a new batch appends
        rather than reshuffles.

        Raises:
            DatasetNotFound: no such dataset in this workspace.
            WorkspaceCorrupt: a member names an asset that is not stored.
        """
        with self._workspace.unit_of_work() as uow:
            return assets_of(uow, self.require_dataset(uow, dataset_id))

    def member_asset_ids(self, dataset_id: UUID) -> frozenset[UUID]:
        """Which assets are in the trunk right now, as a set to test against.

        The cheap half of :meth:`assets`. That one resolves every member to an
        ``Asset`` because its callers render them; this one answers *is this in
        the trunk*, which needs the id alone — so it skips one lookup per member,
        and over a dataset of fifty thousand that is the whole cost of the call.

        A **set**, and returned rather than answered per id, because the caller
        that wanted this asks about a batch's worth of assets at once: how much of
        a completed batch has reached the trunk is a question about an
        intersection, and asking it one id at a time is the shape that turns one
        read into N.

        Current membership, not a history. A curator removing an asset takes it
        out of this answer, which is right for every question anybody asks it —
        "is my work in the dataset" is about now.

        Raises:
            DatasetNotFound: no such dataset in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return member_asset_ids_of(uow, self.require_dataset(uow, dataset_id))

    def changes(self, dataset_id: UUID) -> list[DatasetChange]:
        """The mutation log, oldest entry first.

        Empty for a dataset nobody has promoted into yet — the ordinary starting
        state of every project, not an error.

        Raises:
            DatasetNotFound: no such dataset in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            dataset = self.require_dataset(uow, dataset_id)
            return uow.dataset_changes.list(dataset.id)

    def stats(self, dataset_id: UUID) -> DatasetStats:
        """What the trunk currently holds, counted — overall and per label class.

        Derived on every call rather than cached on the row. The counts are of
        the *live* set, and a stored aggregate would be a second source of truth
        for something a walk already answers; the frozen counterpart exists and
        belongs to a release, which is a different question ("what did we train
        on?") asked of a different artifact.

        Per class, both the annotations and the distinct assets carrying them,
        because those tell apart a thousand labels over a thousand images from a
        thousand over ten. Classes nobody has used do not appear: which classes
        *exist* is a fact about the schema, and reading it off the trunk would be
        reading it off the wrong document.

        One walk per member asset, the N+1 ``ReleaseService._manifest_assets``
        and ``JobService.project_progress`` already accept at this scale. The fix
        when it bites is a method on the port (``annotations.list_for_dataset``),
        never a SQLAlchemy import in a service.

        Raises:
            DatasetNotFound: no such dataset in this workspace.
            WorkspaceCorrupt: a member names an asset that is not stored.
        """
        with self._workspace.unit_of_work() as uow:
            dataset = self.require_dataset(uow, dataset_id)
            assets = assets_of(uow, dataset)
            annotations = 0
            annotated_assets = 0
            per_class: dict[str, list[int]] = {}
            for asset in assets:
                found = uow.annotations.list(asset.id)
                if not found:
                    continue
                annotated_assets += 1
                annotations += len(found)
                for label_class in {annotation.label_class for annotation in found}:
                    per_class.setdefault(label_class, [0, 0])[1] += 1
                for annotation in found:
                    per_class[annotation.label_class][0] += 1
        return DatasetStats(
            dataset_id=dataset.id,
            asset_count=len(assets),
            annotated_asset_count=annotated_assets,
            annotation_count=annotations,
            per_class=tuple(
                ClassCount(label_class=name, annotations=counts[0], assets=counts[1])
                for name, counts in per_class.items()
            ),
        )

    # --- mutating the trunk ------------------------------------------------

    def promote(self, batch_id: UUID, *, actor: str | None = None) -> list[Asset]:
        """Move a completed batch's labeled assets into its project's dataset.

        Which assets: those whose progress is in ``PROMOTABLE_PROGRESS`` —
        ``annotated`` or ``accepted``. A ``skipped`` asset is left behind, and
        that is the point of the batch having recorded the decision instead of
        dropping the asset from its membership.

        Their annotations come too, without being named here: a label hangs off
        its asset, so admitting the asset admits everything drawn on it.

        **What the trunk projects for an asset is that asset's whole current
        annotation set — one set per asset, never one per round** (audit G5,
        settled 2026-08; ``docs/content/batches.md`` has the worked example). Promotion
        moves membership and nothing else, and the replacement semantics fall
        out of that rather than being implemented on top of it: a correction
        batch cut over a promoted asset opens on the labels that are already
        there, edits them in place, and the trunk projects whatever it left.
        Deleting a box in a correction deletes it from the trunk; two completed
        batches over one asset do not accumulate two rounds, because there was
        only ever one set for them to write into. What the trunk holds for a
        given asset is therefore whoever wrote last, which is observable and
        defined rather than a race.

        The corollary worth stating plainly, because it is the one that
        surprises: **that projection is live.** An edit inside an open batch
        reaches the trunk when it is saved, not when the batch is promoted —
        membership is the thing promotion gates, and an asset already in the
        trunk needs no second admission for its labels to move. A snapshot would
        need the trunk to name annotations as well as assets, which is the
        second source of truth ``DatasetMember``'s docstring exists to refuse.

        **Idempotent.** Promoting the same batch twice adds nothing the second
        time, returns ``[]``, and appends no entry to the log — an append-only
        record of mutations should not fill up with calls that changed nothing.
        That is also what makes a re-run after a partial failure safe.

        The idempotency is a union against what is *currently* in the trunk, and
        it has no memory of removals: promoting a batch again does put back an
        asset a curator took out of it. That is the documented way back, and the
        alternative is worse — filtering promotions through the change log would
        make the audit record load-bearing for behaviour, so that reading it
        wrong and doing the wrong thing become the same bug. Promotion answers
        only "what does this batch have that the trunk does not".

        Membership lands in the batch's own asset order rather than in the order
        the jobs happen to be walked, so a partition into segments does not
        decide how the trunk reads.

        Args:
            batch_id: the batch to promote from. It must be ``completed``.
            actor: recorded on the log entry. A placeholder until identities
                exist — the kernel writes down what a surface hands it.

        Returns:
            The assets this call added, empty if there was nothing new.

        Raises:
            BatchNotFound: no such batch in this workspace.
            BatchNotComplete: the batch has not reached ``completed``.
            WorkspaceCorrupt: the project has no dataset, or a job tracks an
                asset that is not stored.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self._batches.require_batch(uow, batch_id)
            if batch.state not in PROMOTABLE_STATES:
                raise BatchNotComplete(
                    f"batch {batch.name!r} is {batch.state.value!r}, not "
                    f"{BatchState.COMPLETED.value!r}; only finished work is promoted, and "
                    f"completion is derived from the jobs rather than declared"
                )
            dataset = self._projects.require_dataset(uow, batch.project_id)

            promotable = _promotable(batch, jobs_of(uow, batch))
            already = {member.asset_id for member in uow.dataset_members.list(dataset.id)}
            fresh = [asset_id for asset_id in promotable if asset_id not in already]
            if not fresh:
                return []

            for asset_id in fresh:
                uow.dataset_members.add(DatasetMember(dataset_id=dataset.id, asset_id=asset_id))
            uow.dataset_changes.add(
                DatasetChange(
                    dataset_id=dataset.id,
                    operation=DatasetOperation.PROMOTE,
                    subject_ids=[batch.id, *fresh],
                    actor=actor,
                )
            )
            return [_require_asset(uow, dataset, asset_id) for asset_id in fresh]

    def remove_asset(self, dataset_id: UUID, asset_id: UUID, *, actor: str | None = None) -> bool:
        """Take one asset out of the trunk, and say whether it was in there.

        Removing an asset the dataset does not hold is a no-op returning
        ``False``, and writes no log entry — the same reading
        ``BatchService.remove_assets`` gives a membership edit that changes
        nothing.

        Membership is all that goes. The asset stays, its annotations stay, and
        its blob stays — content is hash-addressed and shared, so no dataset can
        know whether it is the last owner, and ``BlobStore`` has no ``delete``
        at all. A Release that already named the asset is untouched: a release is
        a snapshot, and curating the trunk afterwards does not reach back into it.

        There is no ``confirm=`` here, and that is written down in
        ``ConfirmationRequired``'s own docstring as the second exemption beside
        ``AnnotationService.delete``. Curation is a curator's edit loop, nothing
        is destroyed, and the entry this appends is what makes the removal a
        thing on the record rather than an undo nobody kept.

        Args:
            dataset_id: the dataset to curate.
            asset_id: the asset to drop from it.
            actor: recorded on the log entry, as in :meth:`promote`.

        Returns:
            Whether a membership row went.

        Raises:
            DatasetNotFound: no such dataset in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            dataset = self.require_dataset(uow, dataset_id)
            member = next(
                (m for m in uow.dataset_members.list(dataset.id) if m.asset_id == asset_id),
                None,
            )
            if member is None:
                return False

            uow.dataset_members.delete(member.id)
            uow.dataset_changes.add(
                DatasetChange(
                    dataset_id=dataset.id,
                    operation=DatasetOperation.REMOVE_ASSET,
                    subject_ids=[asset_id],
                    actor=actor,
                )
            )
            return True

    # --- lookups shared by the operations above ----------------------------

    def require_dataset(self, uow: UnitOfWork, dataset_id: UUID) -> Dataset:
        """The dataset, checked through its project so workspaces stay separate.

        A dataset belonging to another workspace reads as missing rather than as
        forbidden — the rule every other service here follows. A *stored* dataset
        whose project is gone is neither: that is an ``ON DELETE CASCADE``
        guarantee failing, so it is reported as corruption.

        Public, and taking a ``uow``, for the reason ``BatchService.require_batch``
        is: ``ReleaseService`` resolves a dataset id inside its own transaction
        before reading the trunk out of it. Note that this is a *different*
        question from ``ProjectService.require_dataset``, which goes the other
        way — from a project to the one dataset it must have.
        """
        dataset = uow.datasets.get(dataset_id)
        if dataset is None:
            raise DatasetNotFound(
                f"no dataset {dataset_id} in workspace {self._workspace.workspace.name!r}"
            )
        project = uow.projects.get(dataset.project_id)
        if project is None:
            raise WorkspaceCorrupt(
                f"dataset {dataset.id} points at project {dataset.project_id}, which does not exist"
            )
        if project.workspace_id != self._workspace.workspace_id:
            raise DatasetNotFound(
                f"no dataset {dataset_id} in workspace {self._workspace.workspace.name!r}"
            )
        return dataset


def assets_of(uow: UnitOfWork, dataset: Dataset) -> list[Asset]:
    """Everything in a dataset's trunk, in the order it was promoted.

    Module-level and public, beside the service that owns membership, for the
    reason ``jobs_of`` sits beside ``BatchService``: ``ReleaseService`` has to
    read the trunk inside its own transaction, and a second walk of
    ``dataset_member`` would be a second chance to disagree with this one about
    order — or about what to do with a member whose asset is gone.
    """
    return [
        _require_asset(uow, dataset, member.asset_id)
        for member in uow.dataset_members.list(dataset.id)
    ]


def member_asset_ids_of(uow: UnitOfWork, dataset: Dataset) -> frozenset[UUID]:
    """The trunk's membership as a set of ids, inside a caller's own transaction.

    Module-level and public beside :func:`assets_of` for the reason that one is:
    a second walk of ``dataset_member`` written somewhere else is a second chance
    to disagree with this one. Unlike ``assets_of`` it does **not** resolve the
    assets, so it cannot raise ``WorkspaceCorrupt`` — a member naming an asset
    that is gone is still a member, and answering "which ids are in" honestly does
    not require the rows behind them.
    """
    return frozenset(member.asset_id for member in uow.dataset_members.list(dataset.id))


def _promotable(batch: Batch, jobs: Iterable[AnnotationJob]) -> list[UUID]:
    """The batch's assets that earned a place in the trunk, in the batch's order.

    Driven from ``batch.asset_ids`` rather than from the jobs, even though the
    progress being filtered on lives on the jobs. The batch's order is ingest
    order; walking the jobs instead would hand back the partition's order, which
    is an implementation detail of how the work was cut up and has no business
    deciding how the dataset reads.

    An asset the partition somehow left out of every job simply is not
    promotable — the partition is exact (``domain/partition.py``), so that cannot
    happen, and reading it as "not promotable" is the safe way for it to fail.
    """
    progress = {asset_id: state for job in jobs for asset_id, state in job.progress.items()}
    return [
        asset_id for asset_id in batch.asset_ids if progress.get(asset_id) in PROMOTABLE_PROGRESS
    ]


def _require_asset(uow: UnitOfWork, dataset: Dataset, asset_id: UUID) -> Asset:
    """The asset, or report that the dataset is holding one that is not there.

    ``dataset_member.asset_id`` cascades from ``asset``, so a deleted asset takes
    its membership row with it and this cannot happen while foreign keys are on.
    Dropping the id quietly would turn that guarantee failing into a dataset that
    silently holds less than it says — and a Release built from it would be short
    without anything saying so.
    """
    asset = uow.assets.get(asset_id)
    if asset is None:
        raise WorkspaceCorrupt(
            f"dataset {dataset.name!r} holds asset {asset_id}, which is not stored"
        )
    return asset
