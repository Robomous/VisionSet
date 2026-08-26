# usage: from visionset.mcp import preprocessing
"""Pre-processing recipe tools: create, list, read, update, delete.

A recipe is a project resource an agent creates once and names on
``export_release`` and ``check_export``; the export keeps the spec by value, so
nothing an agent does to a recipe afterwards changes an export that already ran.
That is what makes ``update_preprocessing_recipe`` safe to offer: replacing a
spec, or renaming, touches the stored value and never a past export, and the
five tools are the same five operations REST and the CLI offer, so an agent
edits the recipe a person named rather than leaving a near-duplicate beside
it. ``delete_preprocessing_recipe`` is offered only under
``--allow-destructive``, with ``confirm``, on the terms every other delete
follows — a recipe is small, but it is shared, named work.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field

from visionset import wire
from visionset.kernel.domain import RecipeSpec
from visionset.kernel.errors import ConfirmationRequired
from visionset.kernel.services import PreprocessingRecipeService
from visionset.mcp._resolve import ProjectRef, resolve_project
from visionset.mcp._workspace import opened_workspace

NameRef = Annotated[
    str,
    Field(
        description=(
            "The recipe's name: lowercase letters, digits, dots, hyphens and underscores, "
            "unique within the project."
        )
    ),
]
"""Module-level for the ``inspect.signature`` reason."""


def create_preprocessing_recipe(
    project: ProjectRef,
    name: NameRef,
    spec: Annotated[
        RecipeSpec,
        Field(
            description=(
                "What the recipe does. `steps` is a list of `{kind: 'resize', strategy: "
                "'letterbox'|'stretch', width, height, pad_value?}` (at most one, first) and "
                "`{kind: 'augment', op: 'hflip'|'brightness_contrast'|'rot90', amount?}` "
                "(each at most once); `variants_per_asset` (0 to 8) is how many augmented "
                "variants each train-fold image gets and requires an augment step; `target` "
                "records which export target's hints the recipe was written from."
            )
        ),
    ],
) -> dict[str, Any]:
    """Store a named pre-processing recipe on a project, for `export_release` to apply.

    A recipe resizes every exported image and, with `variants_per_asset` above
    0, writes augmented variants of the train-fold images beside their sources.
    Read `list_export_targets` first: each target's `hints` say what its trainer
    expects — a recommended size and strategy, whether the trainer resizes on
    its own, and whether augmentation is the ordinary practice — and `target`
    records which one this recipe was written from.

    Refuses a name the project already uses, a name that is not a slug, and a
    spec that breaks the grammar: at most one resize step and it comes first,
    an augment step needs `variants_per_asset` of at least 1, and variants need
    at least one augment step. Augmentation runs on the train fold only, so an
    augmenting recipe can be exported only from a release published with a
    split.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        created = PreprocessingRecipeService(workspace).create(resolved.id, name, spec)
    return wire.preprocessing_recipe(created)


def get_preprocessing_recipe(project: ProjectRef, name: NameRef) -> dict[str, Any]:
    """Read one pre-processing recipe by name, with its whole spec.

    The same row `list_preprocessing_recipes` shows, addressed by the name
    `export_release` and `check_export` take as `recipe`. An unknown project or
    recipe is reported as missing.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        found = PreprocessingRecipeService(workspace).get(resolved.id, name)
    return wire.preprocessing_recipe(found)


def update_preprocessing_recipe(
    project: ProjectRef,
    name: NameRef,
    spec: Annotated[
        RecipeSpec,
        Field(description="The whole spec, replaced. Same shape as on create."),
    ],
    new_name: Annotated[
        str | None,
        Field(description="Rename the recipe. Omit to keep its name."),
    ] = None,
) -> dict[str, Any]:
    """Replace a pre-processing recipe's spec whole, and rename it when `new_name` is given.

    Whole-value: the spec is one value with cross-field rules, so there is no
    field-at-a-time edit; send every step. Nothing downstream moves — an export
    that already ran kept its own copy of the spec, so editing changes only
    what the next export with this name applies. Refuses an unknown project or
    recipe, a `new_name` another recipe of the project already uses, a
    `new_name` that is not a slug, and a spec that breaks the grammar
    `create_preprocessing_recipe` describes.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        updated = PreprocessingRecipeService(workspace).update(
            resolved.id, name, spec=spec, new_name=new_name
        )
    return wire.preprocessing_recipe(updated)


def list_preprocessing_recipes(project: ProjectRef) -> dict[str, Any]:
    """List a project's pre-processing recipes, oldest first, each with its whole spec.

    `name` is exactly what `export_release` and `check_export` take as `recipe`.
    The spec is the value an export snapshots; an export that already ran keeps
    the spec it ran with whatever happens to the recipe afterwards.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        found = PreprocessingRecipeService(workspace).list(resolved.id)
    return wire.page([wire.preprocessing_recipe(one) for one in found])


def delete_preprocessing_recipe(
    project: ProjectRef,
    name: NameRef,
    confirm: Annotated[
        bool,
        Field(
            description=(
                "Must be true to actually delete. False returns a refusal and changes nothing."
            )
        ),
    ] = False,
) -> dict[str, Any]:
    """Delete a pre-processing recipe. Destructive; requires `confirm=true`.

    Removes the named recipe and nothing else: every export that used it kept
    its own copy of the spec, and their reports still name it. Called without
    `confirm=true` it changes nothing and tells you so. An unknown project or
    recipe is reported as missing whether or not `confirm` was passed.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        recipes = PreprocessingRecipeService(workspace)
        if not confirm:
            stored = recipes.get(resolved.id, name)
            raise ConfirmationRequired(
                f"deleting recipe {stored.name!r} needs confirm=true; nothing was changed"
            )
        removed = recipes.delete(resolved.id, name)
    return {"deleted": wire.preprocessing_recipe(removed)}
