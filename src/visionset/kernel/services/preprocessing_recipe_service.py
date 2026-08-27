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
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Final
from uuid import UUID

from visionset.kernel.domain import (
    Annotation,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PreprocessingPreview,
    PreprocessingRecipe,
    Project,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    SplitAssignment,
    fit_within,
    normalize_name,
    transform_manifest,
)
from visionset.kernel.errors import (
    AssetNotFound,
    ConstraintViolated,
    ExportSourceUnreadable,
    InvalidName,
    PreprocessingRecipeNameTaken,
    PreprocessingRecipeNotFound,
    ProjectNotFound,
    UnsupportedMedia,
)
from visionset.kernel.ports import PreprocessingDriver, UnitOfWork, driver_for
from visionset.kernel.services.dataset_service import DatasetService
from visionset.kernel.services.release_service import ReleaseService, transformed_bytes
from visionset.kernel.services.workspace_service import WorkspaceService

#: What a recipe name may look like: a slug, because it travels as a path
#: segment and a command-line argument and is compared exactly.
_SLUG: Final = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

#: The longest edge a preview is rendered at. A preview is for looking, and a
#: 4K frame pushed through base64 for a thumbnail-sized cell is bandwidth
#: spent on pixels nobody sees.
PREVIEW_MAX_EDGE: Final = 512

#: What the first bytes of a rendered preview say it is, for ``media_type``.
_MEDIA_TYPES: Final[tuple[tuple[bytes, str], ...]] = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"RIFF", "image/webp"),
)

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

    def preview(
        self,
        project_id: UUID,
        spec: RecipeSpec,
        asset_id: UUID,
        *,
        variant: int,
        drivers: Mapping[str, PreprocessingDriver],
        max_edge: int = PREVIEW_MAX_EDGE,
        showcase: bool = False,
    ) -> PreprocessingPreview:
        """One asset through ``spec``, as the export would write it, sized for a screen.

        The same kernel path as an export — ``transform_manifest`` for the
        geometry, ``transformed_bytes`` for the pixels — over a one-asset
        manifest with the asset in the train fold, so every variant the spec
        declares can be looked at whether or not any release exists. The
        result is then capped to ``max_edge`` on its longer side, labels and
        pixels scaled together, which is the one step an export does not take.

        ``variant`` 0 is the base image; ``1..variants_per_asset`` are the
        augmented outputs. Asking for a variant the spec does not make is a
        caller's error and is refused by the surface before it reaches here.
        ``showcase`` fixes the variant's draws at each step's declared strength
        — hflip mirrors, rot90 makes one quarter turn, brightness and contrast
        use the full ``amount`` — so the picture shows what a step does rather
        than one seeded draw of it; an export never uses it.

        Raises:
            ProjectNotFound: no such project in this workspace.
            AssetNotFound: the asset is not in this project.
            PreprocessingStepUnsupportedGeometry: a step cannot transform a
                geometry the asset carries.
            ExportSourceUnreadable: a step needs a source size the asset never
                recorded, or the asset's bytes are not in the blob store.
            PreprocessingDriverNotFound: no driver in ``drivers`` applies a step.
            UnsupportedMedia: the rendered bytes are not a JPEG, PNG or WebP.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            asset = uow.assets.get(asset_id)
            if asset is None or asset.project_id != project_id:
                raise AssetNotFound(f"no asset {asset_id} in project {project_id}")
            manifest_asset = ManifestAsset(
                asset_id=asset.id,
                content_hash=asset.content_hash,
                uri=asset.uri,
                width=asset.width,
                height=asset.height,
                annotations=tuple(
                    _manifest_annotation(one) for one in uow.annotations.list(asset.id)
                ),
            )
        manifest = Manifest(schema_version=1, assets=(manifest_asset,))
        view = transform_manifest(
            manifest, spec, SplitAssignment(train=(asset.id,)), showcase=showcase
        )
        file = next(one for one in view.files if one.variant == variant)
        try:
            with self._workspace.blob_store.get(asset.content_hash) as stream:
                source = stream.read()
        except FileNotFoundError as exc:
            raise ExportSourceUnreadable(
                f"asset {asset.id} ({asset.content_hash}) is not in the blob store"
            ) from exc
        image = transformed_bytes(
            spec,
            drivers,
            source,
            content_hash=asset.content_hash,
            variant=variant,
            showcase=showcase,
        )
        fitted = fit_within(file, max_edge)
        if (fitted.width, fitted.height) != (file.width, file.height):
            assert fitted.width is not None and fitted.height is not None
            cap = ResizeStep(
                strategy=ResizeStrategy.STRETCH, width=fitted.width, height=fitted.height
            )
            image = driver_for(drivers, cap.kind).apply(cap, image, seed=b"", variant=variant)
        return PreprocessingPreview(
            asset_id=asset.id,
            variant=variant,
            width=fitted.width,
            height=fitted.height,
            annotations=fitted.annotations,
            image=image,
            media_type=_media_type(image),
        )

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


def _manifest_annotation(annotation: Annotation) -> ManifestAnnotation:
    return ManifestAnnotation(
        id=annotation.id,
        label_class=annotation.label_class,
        schema_version=annotation.schema_version,
        geometry=annotation.geometry,
        attributes=dict(annotation.attributes),
        provenance=annotation.provenance,
        model_ref=annotation.model_ref,
        confidence=annotation.confidence,
    )


def _media_type(image: bytes) -> str:
    for signature, media_type in _MEDIA_TYPES:
        if image.startswith(signature):
            return media_type
    raise UnsupportedMedia("the rendered preview is not a JPEG, PNG or WebP")
