# usage: from visionset.cli.schemas import schema_app
"""``visionset schema`` — applying a schema version from a file.

The document is **JSON**, read with the standard library, and it is
byte-for-byte the same document ``POST /projects/{id}/schema/versions`` takes::

    {"classes": [{"name": "sign", "geometry": "bbox", "color": "#ff0000",
                  "attributes": [{"name": "occluded", "kind": "boolean",
                                  "required": true, "options": null,
                                  "default": false}]}]}

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
from visionset.kernel.domain import LabelClass, SchemaProvenance
from visionset.kernel.services import SchemaService

schema_app = typer.Typer(help="Apply and inspect annotation schemas.", no_args_is_help=True)

_COLUMNS: Final = ("VERSION", "CLASSES", "GEOMETRIES")

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
                ",".join(sorted({c.geometry.value for c in v.classes})),
            )
            for v in versions
        ],
    )
    if not versions:
        note(f"Project {resolved.name!r} has no schema yet.")
