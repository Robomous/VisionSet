# usage: from visionset.kernel.services import PreprocessingRecipeService
"""Pre-processing recipes: the named, editable resource an export snapshots.

A recipe is a project resource with no state of its own — no lifecycle, no
``allowed_actions`` — because nothing depends on it once an export has run: the
export keeps the spec by value, so editing or deleting the recipe afterwards
changes no artifact anybody already produced. That is what lets every write
here be unconditional where a schema draft's has to name a revision.

The name is the identifier. It is a path segment on the REST surface and an
argument on the command line, so it is held to a slug rather than to the loose
rule a project name follows, and it is compared exactly and refused twice on
collision — the ``ReleaseService`` shape: the service checks before writing so
the caller gets a sentence, and ``uq_preprocessing_recipe_project_name``
refuses the loser of a race the check let through.

Composition follows the rule in ``docs/content/workspaces.md``: this service
takes an open :class:`WorkspaceService` and nothing else.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Final
from uuid import UUID

from visionset.kernel.domain import PreprocessingRecipe, Project, RecipeSpec, normalize_name
from visionset.kernel.errors import (
    ConstraintViolated,
    InvalidName,
    PreprocessingRecipeNameTaken,
    PreprocessingRecipeNotFound,
    ProjectNotFound,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.dataset_service import DatasetService
from visionset.kernel.services.release_service import ReleaseService
from visionset.kernel.services.workspace_service import WorkspaceService

#: What a recipe name may look like: a slug, because it travels as a path
#: segment and a command-line argument and is compared exactly.
_SLUG: Final = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

#: How SQLite words the name index's refusal — matched exactly, the
#: ``ReleaseService`` precedent, so another constraint is never mistaken for it.
_NAME_INDEX_MESSAGE: Final = "preprocessing_recipes.project_id, preprocessing_recipes.name"


class PreprocessingRecipeService:
    """Create, read, edit and delete the recipes of one project."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._datasets = DatasetService(workspace)
        self._releases = ReleaseService(workspace)

    def create(self, project_id: UUID, name: str, spec: RecipeSpec) -> PreprocessingRecipe:
        """Store a new recipe under ``name``.

        Raises:
            ProjectNotFound: no such project in this workspace.
            InvalidName: the name is not a slug.
            PreprocessingRecipeNameTaken: the project already has a recipe of
                that name.
        """
        cleaned = _slug(name)
        now = datetime.now(UTC)
        try:
            with self._workspace.unit_of_work() as uow:
                self._require_project(uow, project_id)
                self._require_name_free(uow, project_id, cleaned)
                return uow.preprocessing_recipes.add(
                    PreprocessingRecipe(
                        project_id=project_id,
                        name=cleaned,
                        spec=spec,
                        created_at=now,
                        updated_at=now,
                    )
                )
        except ConstraintViolated as exc:
            raise _as_name_collision(exc, cleaned) from exc

    def get(self, project_id: UUID, name: str) -> PreprocessingRecipe:
        """The project's recipe under that name.

        Raises:
            ProjectNotFound: no such project in this workspace.
            PreprocessingRecipeNotFound: the project has no recipe of that name.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            return self._require(uow, project_id, name)

    def for_release(self, release_id: UUID, name: str) -> PreprocessingRecipe:
        """The recipe a release's own project stores under that name.

        The export surfaces address a release, not a project, and a recipe
        belongs to the project the release's dataset hangs off. Resolved here
        so the three surfaces agree on the walk rather than each spelling it.

        Raises:
            ReleaseNotFound: no such release in this workspace.
            PreprocessingRecipeNotFound: the release's project has no recipe of
                that name.
        """
        release = self._releases.get(release_id)
        with self._workspace.unit_of_work() as uow:
            dataset = self._datasets.require_dataset(uow, release.dataset_id)
            return self._require(uow, dataset.project_id, name)

    def update(
        self, project_id: UUID, name: str, *, spec: RecipeSpec, new_name: str | None = None
    ) -> PreprocessingRecipe:
        """Replace the recipe's spec, and rename it when ``new_name`` differs.

        Whole-value, like a schema draft: the spec is one value with
        cross-field rules, and a field-at-a-time edit would need a merge rule.
        No revision is asked for, because nothing downstream depends on the
        stored value — an export keeps its own copy.

        Raises:
            ProjectNotFound: no such project in this workspace.
            PreprocessingRecipeNotFound: the project has no recipe of that name.
            InvalidName: ``new_name`` is not a slug.
            PreprocessingRecipeNameTaken: ``new_name`` belongs to another recipe
                of the project.
        """
        renamed = None if new_name is None else _slug(new_name)
        try:
            with self._workspace.unit_of_work() as uow:
                self._require_project(uow, project_id)
                stored = self._require(uow, project_id, name)
                if renamed is not None and renamed != stored.name:
                    self._require_name_free(uow, project_id, renamed)
                return uow.preprocessing_recipes.update(
                    stored.model_copy(
                        update={
                            "name": stored.name if renamed is None else renamed,
                            "spec": spec,
                            "updated_at": datetime.now(UTC),
                        }
                    )
                )
        except ConstraintViolated as exc:
            raise _as_name_collision(exc, renamed or name) from exc

    def delete(self, project_id: UUID, name: str) -> PreprocessingRecipe:
        """Remove the recipe, and answer what was removed.

        No ``confirm=``: a recipe is a few lines of configuration, and every
        export that used it kept its own copy, so nothing that exists is lost.

        Raises:
            ProjectNotFound: no such project in this workspace.
            PreprocessingRecipeNotFound: the project has no recipe of that name.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            stored = self._require(uow, project_id, name)
            uow.preprocessing_recipes.delete(stored.id)
            return stored

    def list(self, project_id: UUID) -> list[PreprocessingRecipe]:
        """Every recipe of the project, oldest first.

        Last in the class on purpose: an annotation after a method named
        ``list`` would resolve it to this method rather than to the builtin.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            return uow.preprocessing_recipes.list(project_id)

    def _require_project(self, uow: UnitOfWork, project_id: UUID) -> Project:
        """The project, or refuse because this workspace does not have it."""
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )
        return project

    def _require(self, uow: UnitOfWork, project_id: UUID, name: str) -> PreprocessingRecipe:
        for recipe in uow.preprocessing_recipes.list(project_id):
            if recipe.name == name:
                return recipe
        raise PreprocessingRecipeNotFound(
            f"project {project_id} has no pre-processing recipe named {name!r}; "
            f"list the project's recipes to see which exist"
        )

    def _require_name_free(self, uow: UnitOfWork, project_id: UUID, name: str) -> None:
        if any(recipe.name == name for recipe in uow.preprocessing_recipes.list(project_id)):
            raise PreprocessingRecipeNameTaken(
                f"project {project_id} already has a pre-processing recipe named {name!r}; "
                f"choose another name or update that one"
            )


def _slug(name: str) -> str:
    cleaned = normalize_name(name, what="recipe")
    if not _SLUG.match(cleaned):
        raise InvalidName(
            f"{cleaned!r} is not a recipe name: use lowercase letters, digits, dots, "
            f"hyphens and underscores, starting with a letter or digit, at most 64 characters"
        )
    return cleaned


def _as_name_collision(
    exc: ConstraintViolated, name: str
) -> PreprocessingRecipeNameTaken | ConstraintViolated:
    if _NAME_INDEX_MESSAGE in str(exc):
        return PreprocessingRecipeNameTaken(
            f"another writer created a recipe named {name!r} first; choose another name"
        )
    return exc
