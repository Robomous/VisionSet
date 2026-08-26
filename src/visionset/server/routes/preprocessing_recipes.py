# usage: from visionset.server.routes import preprocessing_recipes
"""Pre-processing recipes: a project's named resize-and-augmentation specs, and a preview.

Two routers, the ``sources.py`` split: the recipes hang off the project and are
addressed by name, and the preview is a project operation that takes a spec
rather than a stored recipe — a person tuning a recipe wants to see it before
saving it, and a preview of a saved one is the same call with the saved spec.

Nothing here is state-gated. A recipe has no lifecycle and nothing depends on
the stored value — an export keeps its own copy — so there is no
``allowed_actions`` vocabulary to publish and every operation is always offered.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from typing import Annotated, Final
from uuid import UUID

from fastapi import Path, Response, status

from visionset.kernel.services import PreprocessingRecipeService
from visionset.server.dependencies import DriversDep, WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    PreprocessingPreviewBody,
    PreprocessingPreviewOut,
    PreprocessingRecipeCreate,
    PreprocessingRecipeOut,
    PreprocessingRecipePage,
    PreprocessingRecipeUpdate,
)

router = protected_router(
    prefix="/projects/{project_id}/preprocessing-recipes", tags=["preprocessing"]
)
preview_router = protected_router(prefix="/projects/{project_id}", tags=["preprocessing"])

NamePath = Annotated[str, Path(description="The recipe's name, unique within the project.")]

#: A preview is derived from a spec that is still being edited; a cached
#: answer would show yesterday's recipe under today's name.
_NO_STORE: Final = "no-store"


@router.post("", status_code=status.HTTP_201_CREATED, responses=documented(404, 409))
def create_preprocessing_recipe(
    workspace: WorkspaceDep, project_id: UUID, body: PreprocessingRecipeCreate
) -> PreprocessingRecipeOut:
    """Store a new recipe under a name.

    A recipe binds at export time, by name, and the export keeps the spec by
    value. An unknown project is 404 `PROJECT_NOT_FOUND`; a name the project
    already uses is 409 `PREPROCESSING_RECIPE_NAME_TAKEN`; a name that is not a
    slug is 422 `INVALID_NAME`, and a spec that breaks the recipe grammar is a
    422 `VALIDATION_ERROR` naming the rule.
    """
    created = PreprocessingRecipeService(workspace).create(
        project_id, body.name, body.spec.to_domain()
    )
    return PreprocessingRecipeOut.of(created)


@router.get("", responses=documented(404))
def list_preprocessing_recipes(
    workspace: WorkspaceDep, project_id: UUID
) -> PreprocessingRecipePage:
    """Every recipe of the project, oldest first. An unknown project is 404 `PROJECT_NOT_FOUND`."""
    found = PreprocessingRecipeService(workspace).list(project_id)
    return PreprocessingRecipePage(
        items=[PreprocessingRecipeOut.of(recipe) for recipe in found], total=len(found)
    )


@router.get("/{name}", responses=documented(404))
def get_preprocessing_recipe(
    workspace: WorkspaceDep, project_id: UUID, name: NamePath
) -> PreprocessingRecipeOut:
    """The recipe under that name.

    An unknown project is 404 `PROJECT_NOT_FOUND` and an unknown name 404
    `PREPROCESSING_RECIPE_NOT_FOUND`.
    """
    return PreprocessingRecipeOut.of(PreprocessingRecipeService(workspace).get(project_id, name))


@router.put("/{name}", responses=documented(404, 409))
def update_preprocessing_recipe(
    workspace: WorkspaceDep, project_id: UUID, name: NamePath, body: PreprocessingRecipeUpdate
) -> PreprocessingRecipeOut:
    """Replace the recipe whole, and rename it when the body's `name` differs.

    Whole-value: the spec is one value with cross-field rules, so there is no
    field-at-a-time edit. Nothing downstream depends on the stored value — an
    export keeps its own copy — so no revision is asked for. An unknown project
    is 404 `PROJECT_NOT_FOUND`, an unknown name 404
    `PREPROCESSING_RECIPE_NOT_FOUND`; a rename onto a name the project already
    uses is 409 `PREPROCESSING_RECIPE_NAME_TAKEN`, and a new name that is not
    a slug is 422 `INVALID_NAME`.
    """
    updated = PreprocessingRecipeService(workspace).update(
        project_id, name, spec=body.spec.to_domain(), new_name=body.name
    )
    return PreprocessingRecipeOut.of(updated)


@router.delete("/{name}", status_code=status.HTTP_204_NO_CONTENT, responses=documented(404))
def delete_preprocessing_recipe(workspace: WorkspaceDep, project_id: UUID, name: NamePath) -> None:
    """Remove the recipe.

    No confirmation: every export that used it kept its own copy, so nothing
    that exists is lost. An unknown project is 404 `PROJECT_NOT_FOUND` and an
    unknown name 404 `PREPROCESSING_RECIPE_NOT_FOUND`.
    """
    PreprocessingRecipeService(workspace).delete(project_id, name)


@preview_router.post("/preprocessing-preview", responses=documented(404, 409))
def preview_preprocessing(
    workspace: WorkspaceDep,
    drivers: DriversDep,
    response: Response,
    project_id: UUID,
    body: PreprocessingPreviewBody,
) -> PreprocessingPreviewOut:
    """Render one asset through a spec, the way an export would write it.

    The same kernel path as an export, over the one asset as if it were in the
    train fold, so every variant the spec declares can be seen whether or not a
    release exists. The image is capped to 512 pixels on its longer side, with
    the annotations scaled to match, and comes back base64-encoded beside its
    `media_type`. Never cached: the spec is the request's own.

    An unknown project is 404 `PROJECT_NOT_FOUND` and an asset outside it 404
    `ASSET_NOT_FOUND`. A step that cannot transform a geometry the asset carries
    is 409 `PREPROCESSING_STEP_UNSUPPORTED_GEOMETRY`, and a step needing a source
    size the asset never recorded, or an asset whose bytes are gone, is 409
    `EXPORT_SOURCE_UNREADABLE`. A rendered image in an encoding this server
    cannot name is 422 `UNSUPPORTED_MEDIA`, and a step kind no installed driver
    applies is 500 `PREPROCESSING_DRIVER_NOT_FOUND`.
    """
    preview = PreprocessingRecipeService(workspace).preview(
        project_id, body.spec.to_domain(), body.asset_id, variant=body.variant, drivers=drivers
    )
    response.headers["Cache-Control"] = _NO_STORE
    return PreprocessingPreviewOut.of(preview)
