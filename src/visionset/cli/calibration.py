# usage: from visionset.cli.calibration import calibration_app
"""``visionset calibration`` — the camera behind a source, or one asset's override.

Every command names its target with exactly one of ``--source`` and ``--asset``.
``set`` reads the whole calibration from a JSON file in the wire's own shape —
what ``show --json`` prints under ``calibration`` (a source) or ``override`` (an
asset) — and replaces whatever was stated, unless 3D labels were drawn against
it. A file that does not parse as one is refused at exit 2, before the
workspace is opened.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID

import typer
from pydantic import ValidationError

from visionset import wire
from visionset.cli._errors import validation_summary
from visionset.cli._output import JsonOption, document, note
from visionset.cli._resolve import ProjectOption
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.kernel.domain import AssetCalibration, Calibration
from visionset.kernel.services import CalibrationService, ProjectService

calibration_app = typer.Typer(
    help="Read, set and clear camera calibration on a source or an asset.",
    no_args_is_help=True,
)

SourceOption = Annotated[
    UUID | None, typer.Option("--source", help="The source, by id. Give this or --asset.")
]
AssetOption = Annotated[
    UUID | None,
    typer.Option("--asset", help="The asset whose own override this is, by id. Or --source."),
]
FileArgument = Annotated[
    Path,
    typer.Argument(
        exists=True,
        dir_okay=False,
        help="A JSON file holding the whole calibration.",
    ),
]


def _one_target(source: UUID | None, asset: UUID | None) -> None:
    if (source is None) == (asset is None):
        raise typer.BadParameter("Give exactly one of --source and --asset.")


def _read(path: Path) -> Calibration:
    try:
        loaded: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise typer.BadParameter(f"{path} is not readable JSON: {exc}") from exc
    try:
        return Calibration.model_validate(loaded)
    except ValidationError as exc:
        raise typer.BadParameter(validation_summary(exc)) from exc


def _summary(calibration: Calibration | None) -> str:
    if calibration is None:
        return "none"
    i = calibration.intrinsics
    return f"fx={i.fx:g} fy={i.fy:g} cx={i.cx:g} cy={i.cy:g} at {i.width}x{i.height}"


def _print_source(source_id: UUID, calibration: Calibration | None, *, json_out: bool) -> None:
    if json_out:
        document(wire.source_calibration(source_id, calibration))
        return
    typer.echo(f"source {source_id}: {_summary(calibration)}")


def _print_asset(value: AssetCalibration, *, json_out: bool) -> None:
    if json_out:
        document(wire.asset_calibration(value))
        return
    typer.echo(
        f"asset {value.asset_id}: override {_summary(value.override)}; "
        f"effective {_summary(value.effective)}"
    )


@calibration_app.command("show")
def calibration_show(
    project: ProjectOption,
    source: SourceOption = None,
    asset: AssetOption = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Print a source's calibration, or an asset's override and the one that applies."""
    _one_target(source, asset)
    with opened_workspace(workspace) as service:
        resolved = ProjectService(service).resolve(project)
        calibrations = CalibrationService(service)
        if source is not None:
            found = calibrations.source_calibration(source, project_id=resolved.id)
            _print_source(source, found, json_out=json_out)
            return
        assert asset is not None
        _print_asset(calibrations.asset_calibration(resolved.id, asset), json_out=json_out)


@calibration_app.command("set")
def calibration_set(
    file: FileArgument,
    project: ProjectOption,
    source: SourceOption = None,
    asset: AssetOption = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """State a source's calibration, or override it for one asset, replacing any already set.

    The intrinsics' `width` and `height` must be the size of every asset it would
    apply to. Replacing a calibration with a different one is refused while 3D
    labels resolve to it, including a first asset override other than the source
    calibration it inherits; setting the identical one again changes nothing.
    Registering the same directory again keeps the calibration.
    """
    _one_target(source, asset)
    stated = _read(file)
    with opened_workspace(workspace) as service:
        resolved = ProjectService(service).resolve(project)
        calibrations = CalibrationService(service)
        if source is not None:
            stored = calibrations.set_source_calibration(source, stated, project_id=resolved.id)
            _print_source(stored.id, stored.calibration, json_out=json_out)
            return
        assert asset is not None
        _print_asset(
            calibrations.set_asset_calibration(resolved.id, asset, stated), json_out=json_out
        )


@calibration_app.command("clear")
def calibration_clear(
    project: ProjectOption,
    source: SourceOption = None,
    asset: AssetOption = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Remove a source's calibration, or an asset's override. Clearing none is not an error.

    Refused while 3D labels would be left with no calibration to resolve to, or
    when an asset holding them would fall back to a different one, and when an
    asset would fall back to a source calibration of another size.
    """
    _one_target(source, asset)
    with opened_workspace(workspace) as service:
        resolved = ProjectService(service).resolve(project)
        calibrations = CalibrationService(service)
        if source is not None:
            cleared = calibrations.clear_source_calibration(source, project_id=resolved.id)
            _print_source(cleared.id, cleared.calibration, json_out=json_out)
        else:
            assert asset is not None
            value = calibrations.clear_asset_calibration(resolved.id, asset)
            _print_asset(value, json_out=json_out)
    if not json_out:
        note("Cleared.")
