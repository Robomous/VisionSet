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

Composition follows the rule in ``docs/content/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and reaches the ports through
it. It never names an adapter.
"""

from __future__ import annotations

from uuid import UUID

from visionset.kernel.domain import ClassCount, Dataset, Project, ProjectStats
from visionset.kernel.errors import (
    ConfirmationRequired,
    ConstraintViolated,
    ProjectNameTaken,
    ProjectNotFound,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.workspace_service import WorkspaceService

#: SQLite's own wording when ``uq_project_workspace_name`` refuses a write. The
#: adapter hands the message through verbatim, and it is the only way to tell a
#: name collision apart from any other constraint — see ``_as_name_collision``.
_NAME_INDEX_MESSAGE = "project.workspace_id, project.name"


class ProjectService:
    """Create, read, rename and delete projects in one workspace."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._schemas = SchemaService(workspace)

    # --- reading -----------------------------------------------------------

    def get(self, project_id: UUID) -> Project:
        """The project with that id.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self._require(uow, project_id)

    def get_by_name(self, name: str) -> Project:
        """The project an operator would name, resolved case-insensitively.

        Here rather than in a surface, on ``TokenService.get_by_name``'s
        precedent, because the comparison is not obvious and it is not the only
        one: a project name is unique **case-insensitively** while a release tag
        is case-sensitive. A CLI or an MCP tool that re-derived either rule from
        prose would be a second spelling of it, free to drift from the index that
        actually enforces it.

        Raises:
            InvalidName: the name is blank once stripped.
            ProjectNotFound: no project in this workspace holds that name.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_project_named(uow, name)

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
            return self.require_dataset(uow, project.id)

    def stats(self, project_id: UUID) -> ProjectStats:
        """What the project holds, counted — overall and per label class.

        The sibling of ``DatasetService.stats``, and the difference is the *set*
        being counted. That one walks the curated trunk, which an asset reaches
        only by being promoted out of a completed batch; this one walks every
        asset in the project. A project mid-annotation has a full first number
        and a zero second one, and both are true.

        Derived on every call, never cached, for the reason ``DatasetStats``
        gives: a stored aggregate is a second source of truth for something a
        walk already answers. There is no caching layer here and none is
        warranted yet — the cost below is one indexed read plus one per asset,
        and a cache would need invalidating on every annotation write, which is
        the hottest path in the product.

        ``class_count`` comes off the **schema**, not off the annotations. Which
        classes exist is a fact about the ontology, and a project that has just
        declared five classes and labeled nothing has five of them.

        ``last_ingest_at`` comes off the assets this walk has already read, so it
        costs no extra query. It is NULL when no asset records an arrival, which
        means *unknown* rather than *never* — see the field's own note.

        One walk per asset — the N+1 ``DatasetService.stats`` and
        ``JobService.project_progress`` already accept at this scale, and for the
        same reason: keeping a query language out of ``Repository`` is worth more
        than the round trips cost. When it does start to cost, the fix is a
        method on the port (``annotations.count_for_project``) implemented in the
        adapter, never a SQLAlchemy import in a service.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            project = self._require(uow, project_id)
            active = self._schemas.active(uow, project.id)
            assets = uow.assets.list(project.id)
            annotations = 0
            annotated_assets = 0
            per_class: dict[str, list[int]] = {}
            for asset in assets:
                found = uow.annotations.list(asset.id)
                if not found:
                    continue
                annotated_assets += 1
                annotations += len(found)
                # Distinct classes first, so the per-asset tally counts each
                # class once however many times it was drawn on this asset.
                for label_class in {annotation.label_class for annotation in found}:
                    per_class.setdefault(label_class, [0, 0])[1] += 1
                for annotation in found:
                    per_class[annotation.label_class][0] += 1
        # Off the assets already read, so "when did data last arrive" costs no
        # round trip. ``max`` of an empty sequence raises, and an asset with no
        # recorded arrival is filtered out rather than defaulted, so a project
        # holding only those reads NULL — unknown, not the epoch.
        arrivals = [asset.ingested_at for asset in assets if asset.ingested_at is not None]
        return ProjectStats(
            project_id=project.id,
            asset_count=len(assets),
            annotated_asset_count=annotated_assets,
            annotation_count=annotations,
            class_count=0 if active is None else len(active.classes),
            per_class=tuple(
                ClassCount(label_class=name, annotations=counts[0], assets=counts[1])
                for name, counts in per_class.items()
            ),
            last_ingest_at=max(arrivals) if arrivals else None,
        )

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
                dataset = self.require_dataset(uow, project.id)
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

    def require_project_named(self, uow: UnitOfWork, name: str) -> Project:
        """The project holding that name, compared the way the index compares.

        Unicode case folding here, ASCII ``COLLATE NOCASE`` in the index — the
        service is where the normalized string is in hand, so it is the stricter
        of the two. ``require_project_name`` is its opposite number and answers a
        different question: that one refuses a name because it is *taken*, this
        one resolves a name because it is.

        Public, and taking a ``uow``, for the reason ``JobService.require_job``
        is: a caller resolving a project inside its own transaction must not have
        to spell the comparison a second time.
        """
        wanted = self._workspace.normalize_project_name(name).casefold()
        for project in uow.projects.list(self._workspace.workspace_id):
            if project.name.casefold() == wanted:
                return project
        raise ProjectNotFound(
            f"no project named {name!r} in workspace {self._workspace.workspace.name!r}"
        )

    def require_dataset(self, uow: UnitOfWork, project_id: UUID) -> Dataset:
        """The project's one dataset.

        Anything other than exactly one row means the 1:1 invariant was broken on
        disk. Picking the first would hide that, so it is reported instead.

        Public, and taking a ``uow``, for the reason ``JobService.require_job``
        is: ``DatasetService`` has to resolve project to dataset *inside its own
        transaction* before it writes membership, and a second spelling of the
        1:1 rule is a second place for it to be got wrong.

        Raises:
            WorkspaceCorrupt: the project has no dataset, or more than one.
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
            return ProjectNameTaken(f"a project named {name!r} already exists")
        return exc
