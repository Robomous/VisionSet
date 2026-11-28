# usage: from visionset.mcp import settings
"""The read-only settings of the MCP server process.

The same object ``GET /settings`` and ``visionset settings --json`` publish,
built by ``visionset.jobs.settings.workspace_settings``. No workspace is opened:
these are facts about the process, not about any project.
"""

from __future__ import annotations

from visionset import wire
from visionset.jobs.settings import workspace_settings
from visionset.wire import shapes


def get_workspace_settings() -> shapes.WorkspaceSettings:
    """Read the version, MLflow tracking status and job executor values. No secrets.

    Use this to learn why tracking is not recording runs or why jobs run one at
    a time. `tracking.problem` is the refusal a run would meet, worded as its
    remedy. Authentication is reported only as which mode is configured, and
    the tracking server only as scheme, host and port. The values describe this
    MCP server's own process and are read from the environment it started
    with, so changing one takes a restart, and nothing here edits them.
    """
    return wire.workspace_settings(workspace_settings())
