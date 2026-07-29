# usage: from visionset.mcp import formats
"""``list_formats`` — which exporters are installed, and which of them lose things.

Discovery is over the ``visionset.formats`` entry-point group, so a third-party
distribution's exporter is indistinguishable from a built-in here. Nothing is
cached: the alternative is a server that has to be restarted after an install.
"""

from __future__ import annotations

from typing import Any

from visionset import wire
from visionset.formats.registry import exporters


def list_formats() -> dict[str, Any]:
    """List the export formats installed in this VisionSet, and whether each is lossy.

    Call this before `export_release` — the `name` here is exactly the string
    that tool's `format` parameter takes, and a name that is not in this list is
    refused.

    `lossy` is declared by the format itself, not measured against your data: it
    says the format cannot express everything VisionSet can hold, whether or not
    today's release happens to use the part that would be lost. Exporting in one
    requires `allow_lossy=true`.
    """
    installed = exporters()
    return wire.page([wire.export_format(installed[name]) for name in sorted(installed)])
