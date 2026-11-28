# usage: from visionset.server.routes import settings
"""The read-only settings this server process runs with.

One route, serializing ``visionset.jobs.settings.workspace_settings()`` — the
same object ``visionset settings --json`` and the ``get_workspace_settings``
MCP tool publish. Nothing here writes: the values are read once at startup.
"""

from __future__ import annotations

from visionset.jobs.settings import workspace_settings
from visionset.server.dependencies import protected_router
from visionset.server.models import WorkspaceSettingsOut

router = protected_router(prefix="/settings", tags=["settings"])


@router.get("")
def get_workspace_settings() -> WorkspaceSettingsOut:
    """The version, the MLflow tracking status and the job executor's values.

    Read-only, and read once when the process started, so a change takes a
    restart. No secret is returned: tracking reports which authentication mode
    is configured and whether certificates are, never their values, and the
    tracking server only as scheme, host and port.
    """
    return WorkspaceSettingsOut.of(workspace_settings())
