# usage: from visionset.mcp import formats
"""The format listings: ``list_formats``, ``list_export_targets`` and ``format_matrix``.

Discovery is over the ``visionset.formats`` entry-point group, so a third-party
distribution's exporter is indistinguishable from a built-in here. Nothing is
cached: the alternative is a server that has to be restarted after an install.
"""

from __future__ import annotations

from visionset import wire
from visionset.formats.matrix import format_matrix as build_format_matrix
from visionset.formats.registry import exporters
from visionset.wire import shapes


def list_formats() -> shapes.Page[shapes.ExportFormat]:
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


def list_export_targets() -> shapes.Page[shapes.ExportTarget]:
    """List the models a release can be exported for, each with the format that writes for it.

    Call this before `export_release` when you know what will be trained — the
    `name` here is exactly what that tool's `target` parameter takes, and it
    resolves to `format` without you naming it. `list_formats` is the same
    installation seen from the format's side.

    `geometries` is what an export addressed to the target carries — never
    wider than its format writes, and narrower where the trainer has no task
    for a shape. `tasks` is the trainer's own vocabulary and may name tasks
    nothing here can feed. `hints` is what the trainer expects of its images:
    a recommended size and resize strategy, whether the trainer resizes on its
    own, and whether augmentation is the ordinary practice.
    """
    return wire.page(wire.export_targets(exporters()))


def format_matrix() -> shapes.FormatMatrix:
    """List every installed format once per direction, with the tests that back it.

    One row per installed exporter and per installed importer. `geometries` and
    `degraded_geometries` are what the plugin carries intact and reduced, and
    `unsupported_geometries` is every other geometry an annotation can hold. An
    importer declares no capability of its own, so its geometries are the
    verification descriptor's record and `lossy` is null.

    `status` is not a compatibility promise: `validated` means a test CI runs
    backs the row, and `evidence` names each test and its kind (`fixture`,
    `schema`, `round_trip` or `independent_reader`). A plugin the descriptor does
    not cover, such as a third-party one, is `no_recorded_evidence`.
    """
    return wire.format_matrix(build_format_matrix())
