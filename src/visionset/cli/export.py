# usage: from visionset.cli.export import export
"""``visionset export`` — a release, a target or an installed format, a directory.

The kernel takes a plugin instance; it does not find one. ``ReleaseService.export``
is handed an ``Exporter``, because import-linter forbids ``visionset.kernel``
importing ``visionset.formats`` — a plugin registry is discovery at runtime, and
the kernel is the part that must not do any. So resolving a *name* to a plugin is
the surface's job, and this module does it the one supported way:
``registry.pick`` for a format and ``resolve_target`` for a target, never a dict
lookup, because a ``KeyError`` is outside the ``VisionSetError`` tree and would
answer a typo with a traceback.

**``--target`` and ``--format`` are one choice, not two flags.** A target is the
model the release will train and resolves to the format that writes for it; a
format addresses no trainer. Giving both, or neither, is a usage error at exit
2, because the mistake is on the command line and nothing has been opened yet.

**``--allow-lossy`` is a third gate word, never folded into ``--yes``.** ``--yes``
guards destroying data and ``--allow-destructive`` guards narrowing a contract;
this guards emitting an incomplete *copy* of something that stays intact. Whether
a format is lossy is declared by the format, once, by whoever knows what it can
express — not asked per release, which would give a different answer as the data
drifts.

The destination is the caller's. It is created if missing and **never emptied**,
so a second export into the same directory leaves the first run's files there and
the counts describe the directory afterwards rather than this run alone.

**``--check`` answers the question without committing to it.** Without it the
only way to find out what an export would cost at a terminal is to attempt one
and read a refusal that names neither the classes nor the counts. It is a flag on
this command rather than a command of its own because the
arguments that decide the answer are exactly these — a ``release compatibility``
would restate every one of them — and because that is what makes
``visionset export --check … && visionset export …`` a thing somebody can write.

Under ``--check`` nothing is written, ``--out`` is not required, and
``--allow-lossy`` is accepted and does nothing: consent has nothing to apply to
when there is no output, and refusing the combination would break the one property
the flag was chosen for, that the two invocations take the same arguments.

It exits **1 when the answer is no**, on ``release verify``'s precedent — the
check ran, and it found loss. See ``EXIT_ANSWER_IS_NO`` in ``_errors.py``, where
the two meanings of code 1 are written down.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from visionset import wire
from visionset.cli._errors import EXIT_ANSWER_IS_NO
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._resolve import ProjectOption, resolve_release
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.formats import registry
from visionset.kernel.domain import ExportCompatibility, ExportTarget
from visionset.kernel.ports import Exporter, resolve_target
from visionset.kernel.services import EXPORT_REPORT_FILENAME, ReleaseService


def export(
    project: ProjectOption,
    release: Annotated[str, typer.Option("--release", help="The release tag.")],
    # ``format_name``, not ``format``: the builtin would be shadowed for the rest
    # of the module. Typer takes the flag's spelling from the option, not the
    # parameter, so ``--format`` is unaffected.
    format_name: Annotated[
        str | None,
        typer.Option(
            "--format",
            "-f",
            help="An installed format's name. `visionset format list` says which.",
        ),
    ] = None,
    target: Annotated[
        str | None,
        typer.Option(
            "--target",
            "-t",
            help="The model to train, resolved to its format. `visionset target list` says which.",
        ),
    ] = None,
    out: Annotated[
        Path | None,
        typer.Option(
            "--out",
            "-o",
            file_okay=False,
            help="Where to write. Created if missing; never emptied. Not used by --check.",
        ),
    ] = None,
    check: Annotated[
        bool,
        typer.Option(
            "--check",
            help="Report what this format would lose and write nothing. Exits 1 if it would.",
        ),
    ] = False,
    allow_lossy: Annotated[
        bool,
        typer.Option(
            "--allow-lossy",
            help="Accept a format that cannot carry everything the release holds.",
        ),
    ] = False,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Write a release out for a target, or in an installed format.

    Exactly one of `--target` and `--format`. `visionset target list` says which
    models can be trained on what this installation writes, and
    `visionset format list` which formats are installed; a name that is not
    among them is refused with the list, at exit 1.

    With `--check` nothing is written: it prints the per-class compatibility
    report — what is carried, what arrives coarser, what is dropped and why — and
    exits 1 if the format would lose anything, so
    `visionset export --check ... && visionset export ...` means something.
    """
    # A usage error rather than a domain one, so Click formats it and it exits 2:
    # nothing has been resolved yet, no workspace has been opened, and the mistake
    # is in the command line rather than in the workspace.
    if not check and out is None:
        raise typer.BadParameter("Required unless --check is given.", param_hint="--out")
    if (target is None) == (format_name is None):
        raise typer.BadParameter(
            "Give exactly one of --target and --format.", param_hint="--target / --format"
        )

    with opened_workspace(workspace) as service:
        # Inside the block on purpose: ``ExportFormatNotFound`` and
        # ``ExportTargetNotFound`` are ``VisionSetError``s naming every installed
        # name, and ``opened_workspace`` is what turns one into a sentence and exit 1.
        plugin, addressed = _resolve(target, format_name)
        found = resolve_release(service, project, release)
        if check:
            report = ReleaseService(service).check_export(found.id, plugin, target=addressed)
            _report(report, json_out=json_out)
            # **The same predicate `ReleaseService.export` gates on**, and not
            # `report.compatible` alone: a format that declares itself lossy asks
            # for consent even over a release whose every class it can carry,
            # because the declaration covers attributes, confidence and
            # provenance — none of which is a class and none of which the
            # per-class table can show. Exiting 0 there would make
            # `--check && export` promise something the export then refuses,
            # which is the one thing this flag exists to prevent.
            if plugin.lossy or not report.compatible:
                raise typer.Exit(code=EXIT_ANSWER_IS_NO)
            return
        # `out` is not None here — the guard above is what makes that true, and
        # mypy cannot see through it across the `with`.
        assert out is not None
        result = ReleaseService(service).export(
            found.id, plugin, out, allow_lossy=allow_lossy, target=addressed
        )
    if json_out:
        document(wire.export_result(result))
        return
    note(
        f"Exported {found.tag!r} as {result.format_name}: "
        f"{result.file_count} file(s), {result.total_bytes} byte(s)."
    )
    # On stderr with the rest of the prose, so `visionset export ... | xargs`
    # still gets exactly the directory. Named classes with a count rather than a
    # total, because "polygon, 1204" is what somebody acts on and a bare total is
    # not; the file in the output has the rest.
    #
    # Two lines, not one: a single "Not carried" line would also cover classes the
    # exporter goes on to write as boxes, so the one sentence a user reads about
    # their export would be wrong about half of what it listed. What disappears
    # and what arrives coarser are different decisions.
    excluded = result.compatibility.excluded
    if excluded:
        listed = ", ".join(f"{one.label_class} ({one.annotations})" for one in excluded)
        note(f"Not carried by {result.format_name}: {listed}. See {EXPORT_REPORT_FILENAME}.")
    degraded = result.compatibility.degraded
    if degraded:
        listed = ", ".join(f"{one.label_class} ({one.annotations})" for one in degraded)
        note(
            f"Written in a reduced form by {result.format_name}: {listed}. "
            f"See {EXPORT_REPORT_FILENAME}."
        )
    typer.echo(str(result.directory))


def _resolve(target: str | None, format_name: str | None) -> tuple[Exporter, ExportTarget | None]:
    """The plugin the command line named, and the target when it named one.

    A format reached through a former name still works, and says so on stderr:
    the alias is honoured for one release, and a script that types it should
    learn that here rather than from the release that removes it.
    """
    # Through the module, so a test can substitute the scan the way the job handler lets it.
    installed = registry.exporters()
    if target is not None:
        return resolve_target(installed, target)
    assert format_name is not None
    plugin, alias = registry.pick(installed, format_name)
    if alias is not None:
        note(
            f"--format {alias} is deprecated and will be removed in the next release; "
            f"use --format {plugin.format_name}."
        )
    return plugin, None


def _report(report: ExportCompatibility, *, json_out: bool) -> None:
    """The per-class answer, as `--json` or as columns.

    Columns rather than ``rich.table``: box drawing pads to ``COLUMNS`` and wraps,
    which makes the output width-dependent and neither ``cut``-able nor testable.
    The header prints even with no rows, so ``| tail -n +2`` is stable.

    The class name is first for the same reason every listing leads with its id:
    ``awk '{print $1}'`` has to be the identifier. A class has no id, and its name
    is normalized so it can hold internal whitespace — which is exactly why the
    summary line beneath repeats the counts rather than asking anybody to add up
    a column.
    """
    if json_out:
        document(wire.export_compatibility(report))
        return

    table(
        ["CLASS", "GEOMETRY", "STATUS", "ANNOTATIONS", "ASSETS", "REASON"],
        [
            [
                one.label_class,
                one.geometry.value,
                one.status.value,
                str(one.annotations),
                str(one.assets),
                one.reason or "",
            ]
            for one in report.classes
        ],
    )

    # On stderr with the rest of the prose, so the table alone is what a pipe
    # gets. Both numbers, always, and never added together: "gone" and "coarser"
    # are different things to consent to, and one total covering both is a
    # sentence that is wrong about half of what it counts.
    if report.compatible and not report.format_is_lossy:
        note(f"{report.format_name} carries everything this release holds.")
        return
    if not report.compatible:
        note(
            f"{report.format_name} would drop {report.excluded_annotations} annotation(s) "
            f"across {report.excluded_assets} asset(s), and write "
            f"{report.degraded_annotations} annotation(s) across "
            f"{report.degraded_assets} asset(s) in a reduced form."
        )
    if report.format_is_lossy:
        # The format's blanket declaration, which the per-class table structurally
        # cannot show: it covers attributes, confidence and provenance, none of
        # which is a class. Without this line a clean table over a format that
        # still asks for consent reads as a bug in the report.
        note(
            f"{report.format_name} declares itself lossy, so it asks for consent even "
            "where the table above is clean — attributes, confidence and provenance "
            "are not classes."
        )
    note("Re-run without --check and with --allow-lossy to export anyway.")
