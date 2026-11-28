# usage: from visionset.cli.settings import settings
"""``visionset settings`` — what this process is configured with, read-only.

The same object ``GET /settings`` and the ``get_workspace_settings`` MCP tool
publish, built by ``visionset.jobs.settings.workspace_settings``. It describes
the process running the command: tracking is what this command's own runs would
use, and the executor values are what ``visionset server`` started from the same
environment would use.
"""

from __future__ import annotations

from typing import Final

from visionset import wire
from visionset.cli._output import JsonOption, document, table
from visionset.jobs.settings import workspace_settings

_COLUMNS: Final = ("SETTING", "VALUE")

_NONE: Final = "-"


def _shown(value: object) -> str:
    if value is None:
        return _NONE
    if isinstance(value, bool):
        return "yes" if value else "no"
    return str(value)


def settings(json_out: JsonOption = False) -> None:
    """Show the version, MLflow tracking status and job executor values. No secrets."""
    found = workspace_settings()
    if json_out:
        document(wire.workspace_settings(found))
        return
    tracking = found.tracking
    server = tracking.server
    address = None
    if server is not None:
        address = f"{server.scheme}://{server.host or ''}"
        if server.port is not None:
            address += f":{server.port}"
    rows = [
        ("version", found.version),
        ("tracking.enabled", _shown(tracking.enabled)),
        ("tracking.experiment", _shown(tracking.experiment)),
        ("tracking.server", _shown(address)),
        ("tracking.auth", _shown(None if tracking.auth is None else tracking.auth.value)),
        ("tracking.ca_bundle_configured", _shown(tracking.ca_bundle_configured)),
        (
            "tracking.client_certificate_configured",
            _shown(tracking.client_certificate_configured),
        ),
        ("tracking.client_installed", _shown(tracking.client_installed)),
        ("tracking.problem", _shown(tracking.problem)),
        *(
            (variable.name, f"{_shown(variable.value)} (default {variable.default})")
            for variable in found.executor.variables
        ),
        ("executor.problem", _shown(found.executor.problem)),
    ]
    table(_COLUMNS, rows)
