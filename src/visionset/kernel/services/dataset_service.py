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

Composition follows the rule in ``docs/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and never names an adapter.
"""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID

from visionset.kernel.domain import (
    PROMOTABLE_PROGRESS,
    AnnotationJob,
    Asset,
    Batch,
    BatchState,
    Dataset,
    DatasetChange,
    DatasetMember,
    DatasetOperation,
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
            return self._require_dataset(uow, dataset_id)

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
            dataset = self._require_dataset(uow, dataset_id)
            return [
                _require_asset(uow, dataset, member.asset_id)
                for member in uow.dataset_members.list(dataset.id)
            ]

    def changes(self, dataset_id: UUID) -> list[DatasetChange]:
        """The mutation log, oldest entry first.

        Empty for a dataset nobody has promoted into yet — the ordinary starting
        state of every project, not an error.

        Raises:
            DatasetNotFound: no such dataset in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            dataset = self._require_dataset(uow, dataset_id)
            return uow.dataset_changes.list(dataset.id)

    # --- mutating the trunk ------------------------------------------------

    def promote(self, batch_id: UUID, *, actor: str | None = None) -> list[Asset]:
        """Move a completed batch's labeled assets into its project's dataset.

        Which assets: those whose progress is in ``PROMOTABLE_PROGRESS`` —
        ``annotated`` or ``accepted``. A ``skipped`` asset is left behind, and
        that is the point of the batch having recorded the decision instead of
        dropping the asset from its membership.

        Their annotations come too, without being named here: a label hangs off
        its asset, so admitting the asset admits everything drawn on it.

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
            if batch.state is not BatchState.COMPLETED:
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
            dataset = self._require_dataset(uow, dataset_id)
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

    def _require_dataset(self, uow: UnitOfWork, dataset_id: UUID) -> Dataset:
        """The dataset, checked through its project so workspaces stay separate.

        A dataset belonging to another workspace reads as missing rather than as
        forbidden — the rule every other service here follows. A *stored* dataset
        whose project is gone is neither: that is an ``ON DELETE CASCADE``
        guarantee failing, so it is reported as corruption.
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
