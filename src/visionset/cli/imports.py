# usage: from visionset.cli.imports import import_dataset
"""``visionset import`` — an external dataset in, one approved batch out.

The kernel takes an ``Importer`` instance, as ``ReleaseService.export`` takes an
exporter, so the name on the command line is resolved here through
``registry.pick_importer``.

**Consent is per loss kind.** Whether an import loses anything depends on the
file in hand, so ``--consent-lossy`` names the kinds the caller accepts, one
flag each, and a commit that would drop a kind it does not name is refused.

**``--dry-run`` takes the same arguments as the commit and writes nothing.** It
prints the loss report and exits 1 when the same command without it would be
refused, so ``visionset import --dry-run ... && visionset import ...`` means
something — ``export --check``'s rule, with consent taken into account here
because consent is what decides the answer.

The batch id goes to stdout alone, as ``ingest`` prints it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from visionset import wire
from visionset.cli._errors import EXIT_ANSWER_IS_NO
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._resolve import ProjectOption
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.formats import registry
from visionset.kernel.domain import ImportConsent, ImportLossKind, ImportPlan, ImportRun
from visionset.kernel.ports import Importer
from visionset.kernel.services import ImportService, ProjectService


def import_dataset(
    format_name: Annotated[
        str,
        typer.Argument(metavar="FORMAT", help="The format the dataset is in, such as coco."),
    ],
    source: Annotated[
        Path,
        typer.Argument(metavar="PATH", help="The dataset's directory on this machine."),
    ],
    project: ProjectOption,
    consent_lossy: Annotated[
        list[ImportLossKind] | None,
        typer.Option(
            "--consent-lossy",
            help="Accept dropping this kind of thing. Repeat for each kind --dry-run reports.",
        ),
    ] = None,
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run",
            help="Report what the import would do and drop, and write nothing. "
            "Exits 1 if the same command without it would be refused.",
        ),
    ] = False,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Import an external dataset into a project as one approved batch.

    The images, or a dataset's point-cloud scans, are ingested by content, the
    dataset's classes become schema version 1 when the project has none, and
    every label is written with `import` provenance. The batch is approved and
    stops there: review the labels and promote them as with any other batch.

    Anything the import cannot carry is reported, never dropped silently. A
    commit that would drop a kind of thing not named by `--consent-lossy` is
    refused; `--dry-run` says which kinds and how many.
    """
    consent = ImportConsent(kinds=frozenset(consent_lossy or ()))
    src = source.expanduser().absolute()
    with opened_workspace(workspace) as service:
        plugin = _resolve(format_name)
        resolved = ProjectService(service).resolve(project)
        imports = ImportService(service)
        if dry_run:
            plan = imports.inspect(resolved.id, plugin, src)
            _report(plan, consent, json_out=json_out)
            if plan.conflicts or consent.uncovered(plan.losses):
                raise typer.Exit(code=EXIT_ANSWER_IS_NO)
            return
        note(f"Importing {plugin.format_name} dataset {src}…")
        run = imports.commit(resolved.id, plugin, src, consent=consent)
    if json_out:
        document(wire.import_run(run))
        return
    _summary(run)
    if run.batch_id is not None:
        typer.echo(str(run.batch_id))


def _resolve(format_name: str) -> Importer:
    plugin, alias = registry.pick_importer(registry.importers(), format_name)
    if alias is not None:
        note(
            f"{alias} is deprecated and will be removed in the next release; "
            f"use {plugin.format_name}."
        )
    return plugin


def _summary(run: ImportRun) -> None:
    if run.batch_id is None:
        note(
            f"Nothing new: {run.annotations_already_present} label(s) were already "
            "on their assets, so no batch was created."
        )
        return
    note(
        f"Imported {len(run.asset_ids)} asset(s), {len(run.created_asset_ids)} new, and "
        f"{run.annotations_written} label(s) into approved batch {run.batch_id} "
        f"(schema version {run.schema_version})."
    )
    if run.losses:
        dropped = ", ".join(sorted({loss.kind.value for loss in run.losses}))
        note(f"Dropped with consent: {dropped}.")


def _report(plan: ImportPlan, consent: ImportConsent, *, json_out: bool) -> None:
    """The loss report as columns on stdout; the verdict on stderr."""
    if json_out:
        document(wire.import_plan(plan))
        return
    table(
        ["KIND", "SUBJECT", "COUNT", "REASON"],
        [[loss.kind.value, loss.subject, str(loss.count), loss.reason] for loss in plan.losses],
    )
    if plan.dataset.frame is None:
        items = f"{len(plan.images)} image(s)"
        labels = sum(len(image.labels) for image in plan.images)
    else:
        items = f"{len(plan.scans)} scan(s) in the {plan.dataset.frame.value} frame"
        labels = sum(len(scan.labels) for scan in plan.scans)
    note(
        f"{plan.format_name}: {items} and {labels} label(s) to import; "
        f"{plan.new_assets} new asset(s), {plan.new_annotations} new label(s), "
        f"{plan.annotations_already_present} already present."
    )
    if plan.creates_schema:
        note(f"Schema version 1 would be created from {len(plan.dataset.classes)} class(es).")
    for conflict in plan.conflicts:
        note(f"Refused whatever is consented: {conflict}")
    uncovered = consent.uncovered(plan.losses)
    if uncovered:
        flags = " ".join(f"--consent-lossy {kind.value}" for kind in sorted(uncovered))
        note(f"Re-run with {flags} to accept these losses.")
