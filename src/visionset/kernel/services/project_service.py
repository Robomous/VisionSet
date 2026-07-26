# usage: from visionset.kernel.services import ProjectService
"""Projects: the aggregate root, and the dataset that is inseparable from it.

A project owns everything downstream of it — schema, sources, assets, batches,
task groups, annotations — and exactly one Dataset, which *is* the curated state
of the project rather than a thing kept beside it. That 1:1 relation is the
invariant this module exists to keep, and it shapes three decisions:

- **Creation is atomic.** The project row and its dataset row are written in one
  transaction, so a failure on either leaves neither. This service is also the
  *only* way to create a project; ``WorkspaceService`` deliberately has no
  ``create_project``, because a second door would be a door to a dataset-less
  project.
- **The dataset mirrors the project's name**, and :meth:`ProjectService.rename`
  moves both together. Letting them drift would make "the dataset is the
  project's curated state" a claim the data no longer supports.
- **Deletion cascades metadata and stops there.** The blob store is never
  touched — see :meth:`ProjectService.delete`.

Composition follows the rule in ``docs/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and reaches the ports through
it. It never names an adapter.
"""

from __future__ import annotations

from uuid import UUID

from visionset.kernel.domain import Dataset, Project
from visionset.kernel.errors import (
    ConfirmationRequired,
    ConstraintViolated,
    ProjectNameTaken,
    ProjectNotFound,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.workspace_service import WorkspaceService

#: SQLite's own wording when ``uq_project_workspace_name`` refuses a write. The
#: adapter hands the message through verbatim, and it is the only way to tell a
#: name collision apart from any other constraint — see ``_as_name_collision``.
_NAME_INDEX_MESSAGE = "project.workspace_id, project.name"


class ProjectService:
    """Create, read, rename and delete projects in one workspace."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace

    # --- reading -----------------------------------------------------------

    def get(self, project_id: UUID) -> Project:
        """The project with that id.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self._require(uow, project_id)

    def list(self) -> list[Project]:
        """Every project in this workspace, in the order they were created."""
        with self._workspace.unit_of_work() as uow:
            return uow.projects.list(self._workspace.workspace_id)

    def get_dataset(self, project_id: UUID) -> Dataset:
        """The one dataset belonging to that project.

        Raises:
            ProjectNotFound: no such project in this workspace.
            WorkspaceCorrupt: the project has no dataset, or more than one.
        """
        with self._workspace.unit_of_work() as uow:
            project = self._require(uow, project_id)
            return self._dataset_of(uow, project.id)

    # --- writing -----------------------------------------------------------

    def create(self, name: str, description: str | None = None) -> Project:
        """Add a project and its empty dataset, both or neither.

        Raises:
            InvalidName: the name is blank once stripped.
            ProjectNameTaken: another project in this workspace holds it.
        """
        try:
            with self._workspace.unit_of_work() as uow:
                resolved = self._workspace.require_project_name(uow, name)
                project = uow.projects.add(
                    Project(
                        workspace_id=self._workspace.workspace_id,
                        name=resolved,
                        description=description,
                    )
                )
                uow.datasets.add(Dataset(project_id=project.id, name=resolved))
                return project
        except ConstraintViolated as exc:
            raise self._as_name_collision(exc, name) from exc

    def rename(self, project_id: UUID, name: str) -> Project:
        """Give a project a new name, and its dataset the same one.

        Renaming to the name it already has is not a collision, so correcting
        only the case of a name works.

        Raises:
            ProjectNotFound: no such project in this workspace.
            InvalidName: the name is blank once stripped.
            ProjectNameTaken: a *different* project in this workspace holds it.
        """
        try:
            with self._workspace.unit_of_work() as uow:
                project = self._require(uow, project_id)
                resolved = self._workspace.require_project_name(uow, name, exclude=project.id)
                dataset = self._dataset_of(uow, project.id)
                renamed = uow.projects.update(project.model_copy(update={"name": resolved}))
                uow.datasets.update(dataset.model_copy(update={"name": resolved}))
                return renamed
        except ConstraintViolated as exc:
            raise self._as_name_collision(exc, name) from exc

    def delete(self, project_id: UUID, *, confirm: bool = False) -> None:
        """Remove a project and everything downstream of it. Metadata only.

        The cascade is the database's: every foreign key into the project
        subtree is ``ON DELETE CASCADE``, so one statement takes the schema,
        sources, ingest jobs, assets, annotations, batches, task groups, the
        dataset, its members, its change log and its releases.

        **Blobs are never destroyed.** Content is addressed by hash and shared
        across projects — the same bytes ingested twice are one blob — so no
        project can know whether it is the last owner. A release that named a
        hash keeps its bytes on disk even after the release row is gone; a
        reclaim pass needs workspace-wide reachability and does not exist in M1.

        Raises:
            ProjectNotFound: no such project in this workspace.
            ConfirmationRequired: ``confirm`` was not ``True``.
        """
        with self._workspace.unit_of_work() as uow:
            project = self._require(uow, project_id)
            if not confirm:
                raise ConfirmationRequired(
                    f"deleting project {project.name!r} destroys its dataset, annotations and "
                    f"releases; pass confirm=True to proceed"
                )
            uow.projects.delete(project.id)

    # --- lookups shared by the operations above ----------------------------

    def _require(self, uow: UnitOfWork, project_id: UUID) -> Project:
        """The project, or refuse because this workspace does not have it.

        A project belonging to another workspace reads as missing rather than as
        forbidden: this service speaks for one workspace, and anything outside it
        is not its to describe.
        """
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )
        return project

    def _dataset_of(self, uow: UnitOfWork, project_id: UUID) -> Dataset:
        """The project's one dataset.

        Anything other than exactly one row means the 1:1 invariant was broken on
        disk. Picking the first would hide that, so it is reported instead.
        """
        datasets = uow.datasets.list(project_id)
        if len(datasets) != 1:
            raise WorkspaceCorrupt(
                f"project {project_id} has {len(datasets)} datasets; expected exactly one"
            )
        return datasets[0]

    def _as_name_collision(
        self, exc: ConstraintViolated, name: str
    ) -> ProjectNameTaken | ConstraintViolated:
        """Re-raise the name index's complaint in the vocabulary callers expect.

        Two processes can both pass ``require_project_name`` and then race to
        insert; the loser is refused by the unique index, one layer below where
        the pre-check runs. The violation ends its transaction, so this can only
        happen outside the ``with`` block — see ``ConstraintViolated``. Any other
        constraint is not this service's to reinterpret and travels on unchanged.
        """
        if _NAME_INDEX_MESSAGE in str(exc):
            return ProjectNameTaken(
                f"a project named {name!r} already exists in workspace "
                f"{self._workspace.workspace.name!r}"
            )
        return exc
