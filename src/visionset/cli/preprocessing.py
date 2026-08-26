# usage: from visionset.cli.preprocessing import recipe_app, spec_options
"""``visionset recipe`` — a project's pre-processing recipes, by name.

A recipe is a named ``RecipeSpec``: what an export does to every image and how
many augmented variants it makes. Nothing here transforms a pixel; a recipe is
applied by ``visionset export --recipe``, and the export keeps the spec by value,
so editing or deleting a recipe afterwards changes no export that already ran.

**Two ways to say what a recipe does, never both.** ``--spec FILE`` reads the
whole spec as JSON in the wire's own shape — what ``recipe show --json`` prints
— and is the one a script uses. The flag form builds the same value at the
prompt: ``--resize letterbox:640x640``, ``--augment hflip,brightness_contrast``,
``--variants 2``, ``--target yolo11``. Mixing the file with a flag is a usage
error at exit 2, because the file already says everything and a flag beside it
would either repeat it or contradict it.

The recipe grammar is the kernel's — at most one resize and it comes first,
augmentation needs variants and variants need augmentation — and a spec that
breaks it is refused with the rule, at exit 2: the mistake is on the command
line, and nothing has been opened yet.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Final

import typer
from pydantic import ValidationError

from visionset import wire
from visionset.cli._output import JsonOption, document, moment, note, table
from visionset.cli._resolve import ProjectOption, resolve_project
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.kernel.domain import (
    AugmentOp,
    AugmentStep,
    PreprocessingRecipe,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    Step,
)
from visionset.kernel.services import PreprocessingRecipeService

recipe_app = typer.Typer(help="Manage a project's pre-processing recipes.", no_args_is_help=True)

_COLUMNS: Final = ("NAME", "TARGET", "STEPS", "VARIANTS", "UPDATED")

NameArgument = Annotated[str, typer.Argument(help="The recipe's name, unique within the project.")]

SpecOption = Annotated[
    Path | None,
    typer.Option(
        "--spec",
        exists=True,
        dir_okay=False,
        help="A JSON file holding the whole spec, in the shape `recipe show --json` prints.",
    ),
]
ResizeOption = Annotated[
    str | None,
    typer.Option(
        "--resize",
        metavar="STRATEGY:WxH",
        help="Resize every image: `letterbox:640x640` or `stretch:640x480`.",
    ),
]
PadOption = Annotated[
    int, typer.Option("--pad", help="The grey a letterbox pads with, 0 to 255.", min=0, max=255)
]
AugmentOption = Annotated[
    str | None,
    typer.Option(
        "--augment",
        metavar="OPS",
        help="Comma-separated augmentations: hflip, brightness_contrast, rot90.",
    ),
]
AmountOption = Annotated[
    float,
    typer.Option("--amount", help="How far brightness and contrast may move, 0 to 0.5."),
]
VariantsOption = Annotated[
    int | None,
    typer.Option("--variants", help="Augmented variants per train-fold image, 0 to 8."),
]
TargetOption = Annotated[
    str | None,
    typer.Option("--target", help="The export target whose hints this recipe was written from."),
]


def spec_of(
    spec: Path | None,
    *,
    resize: str | None,
    pad: int,
    augment: str | None,
    amount: float,
    variants: int | None,
    target: str | None,
) -> RecipeSpec:
    """The spec the command line describes, or a usage error saying what is wrong.

    ``RecipeSpec`` refuses a spec that breaks the grammar with a pydantic
    ``ValidationError`` — not a ``VisionSetError``, so it would print a traceback
    rather than a sentence. Caught here and re-raised as Click's own refusal,
    which is what exit 2 is for.
    """
    flagged = any(one is not None for one in (resize, augment, variants, target))
    if spec is not None and flagged:
        raise typer.BadParameter(
            "Give either --spec or the flag form (--resize, --augment, --variants, --target)."
        )
    if spec is None and not flagged:
        raise typer.BadParameter("Say what the recipe does: --spec FILE, or --resize/--augment.")
    try:
        if spec is not None:
            return RecipeSpec.model_validate(json.loads(spec.read_text(encoding="utf-8")))
        steps: list[Step] = []
        if resize is not None:
            steps.append(_resize_of(resize, pad))
        for name in _augment_names(augment):
            steps.append(AugmentStep(op=AugmentOp(name), amount=amount))
        return RecipeSpec(target=target, steps=tuple(steps), variants_per_asset=variants or 0)
    except (ValidationError, ValueError) as exc:
        raise typer.BadParameter(_one_line(exc)) from exc


def _resize_of(value: str, pad: int) -> ResizeStep:
    strategy, _, size = value.partition(":")
    width, _, height = size.partition("x")
    if not (strategy and width.isdigit() and height.isdigit()):
        raise typer.BadParameter(
            f"--resize takes STRATEGY:WxH, e.g. letterbox:640x640, not {value!r}"
        )
    try:
        chosen = ResizeStrategy(strategy)
    except ValueError as exc:
        known = ", ".join(one.value for one in ResizeStrategy)
        raise typer.BadParameter(
            f"--resize strategy must be one of {known}, not {strategy!r}"
        ) from exc
    return ResizeStep(strategy=chosen, width=int(width), height=int(height), pad_value=pad)


def _augment_names(value: str | None) -> list[str]:
    if value is None:
        return []
    names = [part.strip() for part in value.split(",") if part.strip()]
    known = {one.value for one in AugmentOp}
    for name in names:
        if name not in known:
            raise typer.BadParameter(
                f"--augment names must be among {', '.join(sorted(known))}, not {name!r}"
            )
    return names


def _one_line(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "; ".join(str(error["msg"]).removeprefix("Value error, ") for error in exc.errors())
    return str(exc)


def _steps_summary(spec: RecipeSpec) -> str:
    parts = []
    for step in spec.steps:
        if isinstance(step, ResizeStep):
            parts.append(f"{step.strategy.value} {step.width}x{step.height}")
        else:
            parts.append(step.op.value)
    return ", ".join(parts) or "none"


def _row(recipe: PreprocessingRecipe) -> tuple[str, ...]:
    return (
        recipe.name,
        recipe.spec.target or "",
        _steps_summary(recipe.spec),
        str(recipe.spec.variants_per_asset),
        moment(recipe.updated_at),
    )


def _print(recipe: PreprocessingRecipe, *, json_out: bool, verb: str) -> None:
    if json_out:
        document(wire.preprocessing_recipe(recipe))
        return
    note(
        f"{verb} recipe {recipe.name!r}: {_steps_summary(recipe.spec)}, "
        f"{recipe.spec.variants_per_asset} variant(s) per train image."
    )
    typer.echo(recipe.name)


@recipe_app.command("create")
def recipe_create(
    name: NameArgument,
    project: ProjectOption,
    spec: SpecOption = None,
    resize: ResizeOption = None,
    pad: PadOption = 114,
    augment: AugmentOption = None,
    amount: AmountOption = 0.2,
    variants: VariantsOption = None,
    target: TargetOption = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Store a new recipe under a name.

    Either `--spec FILE` or the flag form. Augmentation runs on the train fold
    only, so `--variants` above 0 needs a release published with a split.
    """
    built = spec_of(
        spec,
        resize=resize,
        pad=pad,
        augment=augment,
        amount=amount,
        variants=variants,
        target=target,
    )
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        created = PreprocessingRecipeService(service).create(resolved.id, name, built)
    _print(created, json_out=json_out, verb="Created")


@recipe_app.command("list")
def recipe_list(
    project: ProjectOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """List a project's recipes, oldest first."""
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        recipes = PreprocessingRecipeService(service).list(resolved.id)
    if json_out:
        document(wire.page([wire.preprocessing_recipe(one) for one in recipes]))
        return
    table(_COLUMNS, [_row(one) for one in recipes])
    if not recipes:
        note(f"Project {resolved.name!r} has no pre-processing recipes.")


@recipe_app.command("show")
def recipe_show(
    name: NameArgument,
    project: ProjectOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Print one recipe. `--json` is the shape `--spec` reads back, under `spec`."""
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        recipe = PreprocessingRecipeService(service).get(resolved.id, name)
    if json_out:
        document(wire.preprocessing_recipe(recipe))
        return
    table(_COLUMNS, [_row(recipe)])


@recipe_app.command("update")
def recipe_update(
    name: NameArgument,
    project: ProjectOption,
    spec: SpecOption = None,
    resize: ResizeOption = None,
    pad: PadOption = 114,
    augment: AugmentOption = None,
    amount: AmountOption = 0.2,
    variants: VariantsOption = None,
    target: TargetOption = None,
    rename: Annotated[
        str | None, typer.Option("--rename", help="A new name for the recipe.")
    ] = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Replace a recipe whole, and rename it with `--rename`.

    The spec is one value, so there is no field-at-a-time edit: say all of it
    again. Exports that already ran keep the spec they ran with.
    """
    built = spec_of(
        spec,
        resize=resize,
        pad=pad,
        augment=augment,
        amount=amount,
        variants=variants,
        target=target,
    )
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        updated = PreprocessingRecipeService(service).update(
            resolved.id, name, spec=built, new_name=rename
        )
    _print(updated, json_out=json_out, verb="Updated")


@recipe_app.command("delete")
def recipe_delete(
    name: NameArgument,
    project: ProjectOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Remove a recipe. No prompt: every export that used it kept its own copy."""
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        removed = PreprocessingRecipeService(service).delete(resolved.id, name)
    if json_out:
        document({"deleted": wire.preprocessing_recipe(removed)})
        return
    note(f"Deleted recipe {removed.name!r}.")
