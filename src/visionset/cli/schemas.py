# usage: from visionset.cli.schemas import schema_app
"""``visionset schema`` — applying a schema version from a file.

The document is **JSON**, read with the standard library, and it is
byte-for-byte the same document ``POST /projects/{id}/schema/versions`` takes::

    {"classes": [{"name": "sign", "geometries": ["bbox", "polygon"],
                  "color": "#ff0000",
                  "attributes": [{"name": "occluded", "kind": "boolean",
                                  "required": true, "options": null,
                                  "default": false}]}]}

``geometries`` is a set: a class labeled as a box on some frames and as a polygon
on others is one class. A document written before that was plural may still spell
it ``"geometry": "bbox"``, and ``LabelClass`` reads one — so an old schema file
still applies.

No YAML, and the reason is not taste: a second file format means a runtime
dependency in every wheel, a second parser to keep honest, and two shapes that
can disagree — while the surface a schema file has to interoperate with, the REST
API, speaks JSON already. ``yq . schema.yaml`` is one pipe away for whoever wants
one.

**The document parses through the domain, not through a hand-written reader.**
``TypeAdapter(tuple[LabelClass, ...])`` runs ``LabelClass``'s and ``Attribute``'s
own validators — the same ones ``AttributeBody._the_domain_accepts_it`` calls on
the server side — so a ``select`` with no options, a duplicate attribute name or a
blank class name is refused in the kernel's own wording and nothing is restated
here.

Two failures on the way in are **not** ``VisionSetError``: a file that is not JSON
(``json.JSONDecodeError``) and a document that is JSON but not this shape (a
pydantic ``ValidationError``). ``domain_errors()`` deliberately does not catch
either, so both become ``typer.BadParameter`` at **exit 2** — the CLI's 422,
matching the call the server makes when it moves the same failure into request
parsing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Final

import typer
from pydantic import TypeAdapter, ValidationError

from visionset import wire
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._resolve import ProjectOption, resolve_project
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.kernel.domain import DraftLabelClass, LabelClass, SchemaProvenance
from visionset.kernel.services import SchemaDraftService, SchemaService

schema_app = typer.Typer(help="Apply and inspect annotation schemas.", no_args_is_help=True)

_COLUMNS: Final = ("VERSION", "CLASSES", "GEOMETRIES")

_DRAFT_COLUMNS: Final = ("REVISION", "CLASSES", "NOTE")

_CLASSES: Final = TypeAdapter(tuple[LabelClass, ...])
"""The document's one field, parsed by the domain models themselves."""


def _read_classes(file: Path) -> tuple[LabelClass, ...]:
    """The classes in that file, or a usage error naming what is wrong with it."""
    try:
        loaded = json.loads(file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise typer.BadParameter(f"{file} is not valid JSON: {exc}") from exc
    if not isinstance(loaded, dict) or "classes" not in loaded:
        raise typer.BadParameter(f'{file} must be an object with a "classes" list')
    try:
        return _CLASSES.validate_python(loaded["classes"])
    except ValidationError as exc:
        details = "; ".join(
            f"classes.{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        raise typer.BadParameter(f"{file}: {details}") from exc


draft_app = typer.Typer(
    help="The schema version this project is still writing.", no_args_is_help=True
)
schema_app.add_typer(draft_app, name="draft")

_DRAFT_CLASSES: Final = TypeAdapter(tuple[DraftLabelClass, ...])
"""The draft document's one field. Permissive, unlike ``_CLASSES`` beside it."""

KindOption = Annotated[
    SchemaProvenance,
    typer.Option(
        "--kind",
        help="Which draft: 'curated' for one you are designing, 'annotation' for the "
        "one an annotator accumulates.",
    ),
]


def _read_draft_classes(file: Path) -> tuple[DraftLabelClass, ...]:
    """The classes in that file, tolerating everything a draft is allowed to be.

    ``_read_classes``'s shape and deliberately not its strictness: this document
    describes work in progress, so a class with no name or no geometry is
    accepted here and refused at ``publish``.
    """
    try:
        loaded = json.loads(file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise typer.BadParameter(f"{file} is not valid JSON: {exc}") from exc
    if not isinstance(loaded, dict) or "classes" not in loaded:
        raise typer.BadParameter(f'{file} must be an object with a "classes" list')
    try:
        return _DRAFT_CLASSES.validate_python(loaded["classes"])
    except ValidationError as exc:
        details = "; ".join(
            f"classes.{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        raise typer.BadParameter(f"{file}: {details}") from exc


@draft_app.command("show")
def schema_draft_show(
    project: ProjectOption,
    kind: KindOption = SchemaProvenance.CURATED,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Print the draft, or say there is none.

    The draft is shared: one per project per kind, visible to everyone with
    access to the workspace. `revision` is what `set` and `publish` must name.
    """
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        draft = SchemaDraftService(service).get(resolved.id, kind)
    if draft is None:
        if json_out:
            document({"draft": None})
            return
        note(f"{resolved.name!r} has no {kind.value} draft.")
        return
    if json_out:
        document(wire.schema_draft(draft))
        return
    note(f"Revision {draft.revision}, {len(draft.classes)} class(es), based on {draft.based_on}.")
    table(_DRAFT_COLUMNS, [(str(draft.revision), str(len(draft.classes)), draft.note or "-")])


@draft_app.command("set")
def schema_draft_set(
    file: Annotated[
        Path,
        typer.Argument(
            exists=True,
            dir_okay=False,
            readable=True,
            help='A JSON document: {"classes": [...]}. Classes may be incomplete.',
        ),
    ],
    project: ProjectOption,
    kind: KindOption = SchemaProvenance.CURATED,
    note_text: Annotated[
        str, typer.Option("--note", help="The version message this draft will publish under.")
    ] = "",
    revision: Annotated[
        int | None,
        typer.Option(
            "--revision",
            help="The revision this write was decided against. Omit to write over "
            "whatever is stored now, or to create when nothing is.",
        ),
    ] = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Write the whole draft, creating it when there is none.

    The document replaces the draft entirely — there is no partial edit, as there
    is none of a version. Classes are stored exactly as given, so a class with no
    name or no geometry survives; publishing is where that is refused.

    Naming `--revision` explicitly makes the write conditional: it is refused
    when the draft has moved past it, because somebody else wrote in between and
    merging two sittings would be guessing. Omitting it reads the current
    revision first and writes over exactly that — the ordinary script, where
    nobody else is touching this draft.
    """
    classes = _read_draft_classes(file)
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        drafts = SchemaDraftService(service)
        at = revision
        if at is None:
            current = drafts.get(resolved.id, kind)
            at = None if current is None else current.revision
        saved = drafts.save(
            resolved.id,
            kind,
            classes=classes,
            note=note_text,
            expected_revision=at,
        )
    if json_out:
        document(wire.schema_draft(saved))
        return
    note(f"Saved the {kind.value} draft of {resolved.name!r} at revision {saved.revision}.")
    typer.echo(str(saved.revision))


@draft_app.command("clear")
def schema_draft_clear(
    project: ProjectOption,
    kind: KindOption = SchemaProvenance.CURATED,
    workspace: WorkspaceOption = None,
) -> None:
    """Throw the draft away. Clearing one that is not there is not an error."""
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        removed = SchemaDraftService(service).discard(resolved.id, kind)
    note(
        f"Cleared the {kind.value} draft of {resolved.name!r}."
        if removed
        else f"{resolved.name!r} had no {kind.value} draft."
    )


@draft_app.command("publish")
def schema_draft_publish(
    project: ProjectOption,
    kind: KindOption = SchemaProvenance.CURATED,
    revision: Annotated[
        int | None,
        typer.Option(
            "--revision",
            help="The revision to publish. Omitted, the draft as it stands now is published.",
        ),
    ] = None,
    allow_destructive: Annotated[
        bool,
        typer.Option(
            "--allow-destructive",
            help="Accept a change that narrows the contract by removing something.",
        ),
    ] = False,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Turn the draft into the next schema version, and clear it.

    The classes published are the draft's own, so nothing here can publish
    something other than what `show` prints. The draft's note becomes the
    version's commit message and its kind becomes the version's provenance.

    A class that is not finished — a blank name, no geometry, a select with no
    options — is refused here, named by its position. Everything `schema apply`
    can refuse, this can refuse, with the same `--allow-destructive` and the same
    orphan refusal that no flag overrides.
    """
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        drafts = SchemaDraftService(service)
        # Read to learn the revision when the caller did not name one. Publishing
        # "whatever is there now" is the ordinary script, and making every script
        # carry a revision would be ceremony over a draft nobody else is touching.
        at = revision
        if at is None:
            current = drafts.get(resolved.id, kind)
            if current is None:
                raise typer.BadParameter(f"{resolved.name!r} has no {kind.value} draft to publish")
            at = current.revision
        published = drafts.publish(
            resolved.id, kind, expected_revision=at, allow_destructive=allow_destructive
        )
    if json_out:
        document(wire.schema_publication(published))
        return
    note(f"Published schema version {published.published.version} of {resolved.name!r}.")
    if published.advanced_batches:
        moved = len(published.advanced_batches)
        note(f"Moved {moved} open batch{'es' if moved != 1 else ''} onto it.")
    typer.echo(str(published.published.version))


@schema_app.command("apply")
def schema_apply(
    file: Annotated[
        Path,
        typer.Argument(
            exists=True,
            dir_okay=False,
            readable=True,
            help='A JSON document: {"classes": [...]}.',
        ),
    ],
    project: ProjectOption,
    allow_destructive: Annotated[
        bool,
        typer.Option(
            "--allow-destructive",
            help="Accept a change that narrows the contract by removing something.",
        ),
    ] = False,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Add the next schema version from a JSON file.

    Versions are 1..N and none of them ever changes, so this *adds* one — there
    is no edit and no rollback. Applying the document already in force adds
    nothing and prints the version that was already there, so re-running this in
    a script is free.

    A change that removes a class or an attribute, or narrows one, is refused
    until `--allow-destructive`. A change that would orphan annotations already
    written under an affected class has **no** override, deliberately.
    """
    classes = _read_classes(file)
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        published = SchemaService(service).create_version(
            resolved.id,
            classes,
            # Applying a whole authored document from a file is the curated act
            # by construction — there is no way to reach this command mid-job
            # with one class in hand. Stated here rather than left to the
            # service's ``None`` default, because "nobody said" and "a person
            # designed this" are different facts and only the surface knows which.
            provenance=SchemaProvenance.CURATED,
            allow_destructive=allow_destructive,
        )
    if json_out:
        document(wire.schema_publication(published))
        return
    note(f"Applied schema version {published.published.version} to {resolved.name!r}.")
    # Said only when it happened. A line reading "0 batches" on every ordinary
    # apply would be noise in front of the one number this command exists to
    # print, and stdout stays one datum so `$(visionset schema apply …)` is still
    # exactly the version.
    if published.advanced_batches:
        moved = len(published.advanced_batches)
        note(f"Moved {moved} open batch{'es' if moved != 1 else ''} onto it.")
    typer.echo(str(published.published.version))


@schema_app.command("list")
def schema_list(
    project: ProjectOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """List a project's schema versions, oldest first. The last one is active."""
    with opened_workspace(workspace) as service:
        resolved = resolve_project(service, project)
        versions = SchemaService(service).list_versions(resolved.id)
    if json_out:
        document(wire.page([wire.schema_version(v) for v in versions]))
        return
    table(
        _COLUMNS,
        [
            (
                str(v.version),
                str(len(v.classes)),
                ",".join(sorted({g.value for c in v.classes for g in c.geometries})),
            )
            for v in versions
        ],
    )
    if not versions:
        note(f"Project {resolved.name!r} has no schema yet.")
