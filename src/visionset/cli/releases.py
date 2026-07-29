# usage: from visionset.cli.releases import release_app
"""``visionset release`` — freezing a dataset, and proving it is still frozen.

Three commands: ``publish``, ``list``, ``verify``. A release is the one truly
immutable artifact here, so there is no ``edit`` and no ``delete`` — the fix for
a wrong release is another release under another tag.

``--split "0.7,0.15,0.15"`` is **one** option rather than three, because a split
is one concept, that is how it is written everywhere, and one flag means one
refusal to word. ``--seed`` stays separate; it is not a fraction. The recipe is
*stored*, not applied — folds are computed on demand from the frozen asset set,
keyed on content hash, which is why they come out the same on every machine.

**``verify`` exits 1 when the answer is no.** Not because anything refused —
nothing did, the check ran and reported damage — but because that is the only way
a script branches on the result without grepping output, and it is what ``grep``
and ``diff`` already mean by a non-zero exit. See ``EXIT_ANSWER_IS_NO`` in
``_errors.py``, where the two meanings of code 1 are written down.

A tag is **case-sensitive** where a project name is not. Both rules live in the
kernel beside the index that enforces them, and neither is restated here.
"""

from __future__ import annotations

from typing import Annotated, Final

import typer

from visionset import wire
from visionset.cli._errors import EXIT_ANSWER_IS_NO
from visionset.cli._output import JsonOption, document, moment, note, table
from visionset.cli._resolve import ProjectOption, resolve_project, resolve_release
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.kernel.domain import SplitRecipe
from visionset.kernel.services import ProjectService, ReleaseService

release_app = typer.Typer(help="Publish and verify releases.", no_args_is_help=True)

_COLUMNS: Final = ("ID", "TAG", "ASSETS", "ANNOTATIONS", "SCHEMA", "CREATED")

_SPLIT_PARTS: Final = 3
"""``--split`` is train, val and test — exactly three numbers, in that order."""


def _split_of(value: str | None, seed: int) -> SplitRecipe | None:
    """``"0.7,0.15,0.15"`` as a recipe, or a usage error saying what is wrong.

    ``SplitRecipe`` refuses fractions that do not add up, with a pydantic
    ``ValidationError`` — not a ``VisionSetError``, so it would print a traceback
    rather than a sentence. Caught here and re-raised as Click's own refusal,
    which is what exit 2 is for.
    """
    if value is None:
        return None
    parts = value.split(",")
    if len(parts) != _SPLIT_PARTS:
        raise typer.BadParameter("--split takes three fractions: TRAIN,VAL,TEST")
    try:
        train, val, test = (float(part) for part in parts)
    except ValueError as exc:
        raise typer.BadParameter(f"--split takes three numbers, not {value!r}") from exc
    try:
        return SplitRecipe(train=train, val=val, test=test, seed=seed)
    except ValueError as exc:
        raise typer.BadParameter(f"--split {value!r}: {exc}") from exc


@release_app.command("publish")
def release_publish(
    tag: Annotated[str, typer.Option("--tag", help="The release's name in this dataset.")],
    project: ProjectOption,
    split: Annotated[
        str | None,
        typer.Option(
            "--split",
            metavar="TRAIN,VAL,TEST",
            help="Fractions adding up to 1.0, e.g. 0.7,0.15,0.15.",
        ),
    ] = None,
    seed: Annotated[int, typer.Option("--seed", help="Fixes the fold assignment.")] = 0,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Freeze the project's dataset as it stands, under a tag.

    What is frozen: every asset in the trunk by content hash, every annotation on
    those assets copied rather than referenced, and the active schema version.
    What is not: the time, the tag and the release id, which live on the row —
    so publishing twice from an unchanged dataset produces byte-identical
    manifests that share one blob.
    """
    recipe = _split_of(split, seed)
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        dataset = ProjectService(service).get_dataset(resolved.id)
        published = ReleaseService(service).publish(dataset.id, tag, split=recipe)
    if json_out:
        document(wire.release(published))
        return
    note(
        f"Published {published.tag!r}: {published.asset_count} asset(s), "
        f"{published.annotation_count} annotation(s), schema version "
        f"{published.schema_version}."
    )
    typer.echo(str(published.id))


@release_app.command("list")
def release_list(
    project: ProjectOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """List a project's releases, oldest first."""
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        dataset = ProjectService(service).get_dataset(resolved.id)
        releases = ReleaseService(service).list(dataset.id)
    if json_out:
        document(wire.page([wire.release(r) for r in releases]))
        return
    table(
        _COLUMNS,
        [
            (
                str(r.id),
                r.tag,
                str(r.asset_count),
                str(r.annotation_count),
                str(r.schema_version),
                moment(r.created_at),
            )
            for r in releases
        ],
    )
    if not releases:
        note(f"Project {resolved.name!r} has published no releases.")


@release_app.command("verify")
def release_verify(
    tag: Annotated[str, typer.Argument(help="The release tag, case-sensitively.")],
    project: ProjectOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Re-read and re-hash everything a release names.

    Exits 0 when the release is intact and **1 when it is not** — the answer is
    the exit code, so `visionset release verify v1.0 -p road && train.sh` is a
    sensible thing to write.

    A manifest that fails its own hash stops the walk: reporting assets missing
    on the strength of a tampered inventory would be worse than saying nothing.
    """
    with opened_workspace(workspace) as service:
        release = resolve_release(service, project, tag)
        report = ReleaseService(service).verify(release.id)
    if json_out:
        document(wire.release_verification(report))
    elif report.ok:
        note(f"Release {release.tag!r} verifies: {report.checked} blob(s) intact.")
    else:
        if not report.manifest_intact:
            note(f"Release {release.tag!r}: the manifest itself does not match its hash.")
        for label, hashes in (
            ("missing", report.missing),
            ("corrupt", report.corrupt),
            ("stale in the row's cache", report.cache_mismatches),
        ):
            for value in hashes:
                note(f"  {label}: {value}")
    if not report.ok:
        raise typer.Exit(code=EXIT_ANSWER_IS_NO)
