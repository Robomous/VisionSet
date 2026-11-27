# usage: from visionset.formats.matrix import FormatMatrix, build, format_matrix
"""What each installed format is known to do, and what proves it.

A plugin declares capability — the geometries it writes, whether it is lossy,
its targets — and discovery proves only that it is installed. Whether a test
backs any of that is recorded separately, in ``verification.json`` beside this
module: one entry per built-in format and direction, with the evidence that
covers it. The two are joined here, per installed plugin, and every surface
renders the result.

Evidence is attached only to a plugin implemented inside ``visionset.formats``.
A third-party plugin registering under a built-in's name inherits none of it,
and one with no entry answers ``no_recorded_evidence`` rather than anything
that reads as validated.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from typing import Any, Final

from visionset.formats.registry import ALIASES, exporters, importers
from visionset.kernel.domain import IMPLEMENTED_GEOMETRIES
from visionset.kernel.ports import Exporter, Importer, supported_modalities_of

DESCRIPTOR_FILENAME: Final = "verification.json"

EVIDENCE_KINDS: Final = ("fixture", "schema", "round_trip", "independent_reader")

#: Where a test runs: the default CI suite, CI's job with the optional format
#: groups installed, or only on a machine that opts in. Only the first two count
#: towards ``validated``.
GATES: Final = ("python", "format-smoke", "opt-in")
COUNTING_GATES: Final = frozenset({"python", "format-smoke"})

DIRECTIONS: Final = ("export", "import")

VALIDATED: Final = "validated"
IMPLEMENTED: Final = "implemented"
NO_RECORDED_EVIDENCE: Final = "no_recorded_evidence"

_BUILT_IN_PREFIX: Final = "visionset.formats."


@dataclass(frozen=True)
class Evidence:
    kind: str
    test: str
    gate: str
    reader: str | None = None
    external: bool | None = None
    requires: str | None = None


@dataclass(frozen=True)
class MatrixRow:
    format: str
    direction: str
    availability: str
    aliases: tuple[str, ...]
    task: str | None
    dialects: tuple[str, ...]
    geometries: tuple[str, ...]
    degraded_geometries: tuple[str, ...]
    unsupported_geometries: tuple[str, ...]
    modalities: tuple[str, ...]
    targets: tuple[str, ...]
    lossy: bool | None
    status: str
    evidence: tuple[Evidence, ...]
    notes: str | None


@dataclass(frozen=True)
class FormatMatrix:
    descriptor_version: int
    rows: tuple[MatrixRow, ...]


def load_descriptor() -> dict[str, Any]:
    """The checked-in descriptor, read from the installed package."""
    text = resources.files("visionset.formats").joinpath(DESCRIPTOR_FILENAME).read_text("utf-8")
    loaded: dict[str, Any] = json.loads(text)
    return loaded


def is_built_in(plugin: object) -> bool:
    """Whether ``plugin`` is implemented inside this distribution's format package."""
    return type(plugin).__module__.startswith(_BUILT_IN_PREFIX)


def format_matrix() -> FormatMatrix:
    """The matrix over every plugin installed in this process."""
    return build(exporters(), importers())


def build(
    installed_exporters: Mapping[str, Exporter],
    installed_importers: Mapping[str, Importer],
    descriptor: Mapping[str, Any] | None = None,
) -> FormatMatrix:
    """One row per installed plugin, export before import, sorted by format name."""
    recorded = load_descriptor() if descriptor is None else descriptor
    entries: Mapping[str, Any] = recorded.get("formats", {})
    rows: list[MatrixRow] = []
    for name in sorted(set(installed_exporters) | set(installed_importers)):
        availability = _availability(name, installed_exporters, installed_importers)
        if name in installed_exporters:
            plugin = installed_exporters[name]
            rows.append(_export_row(plugin, availability, _entry(entries, name, "export", plugin)))
        if name in installed_importers:
            reader = installed_importers[name]
            rows.append(_import_row(reader, availability, _entry(entries, name, "import", reader)))
    return FormatMatrix(descriptor_version=int(recorded.get("version", 0)), rows=tuple(rows))


def _availability(
    name: str, installed_exporters: Mapping[str, Any], installed_importers: Mapping[str, Any]
) -> str:
    if name in installed_exporters and name in installed_importers:
        return "both"
    return "export_only" if name in installed_exporters else "import_only"


def _entry(
    entries: Mapping[str, Any], name: str, direction: str, plugin: object
) -> tuple[Mapping[str, Any], Mapping[str, Any]] | None:
    """The format's entry and its direction's record, when they apply to this plugin."""
    if not is_built_in(plugin):
        return None
    entry = entries.get(name)
    if entry is None or entry.get(direction) is None:
        return None
    return entry, entry[direction]


def _evidence(record: Mapping[str, Any]) -> tuple[Evidence, ...]:
    return tuple(
        Evidence(
            kind=one["kind"],
            test=one["test"],
            gate=one["gate"],
            reader=one.get("reader"),
            external=one.get("external"),
            requires=one.get("requires"),
        )
        for one in record.get("evidence", ())
    )


def _status(evidence: tuple[Evidence, ...], has_entry: bool) -> str:
    if not has_entry:
        return NO_RECORDED_EVIDENCE
    if any(one.gate in COUNTING_GATES for one in evidence):
        return VALIDATED
    return IMPLEMENTED


def _unsupported(*known: tuple[str, ...]) -> tuple[str, ...]:
    carried = {one for group in known for one in group}
    return tuple(sorted(one.value for one in IMPLEMENTED_GEOMETRIES if one.value not in carried))


def _aliases(name: str) -> tuple[str, ...]:
    return tuple(sorted(alias for alias, canonical in ALIASES.items() if canonical == name))


def _export_row(
    plugin: Exporter,
    availability: str,
    found: tuple[Mapping[str, Any], Mapping[str, Any]] | None,
) -> MatrixRow:
    entry, record = found if found is not None else ({}, {})
    evidence = _evidence(record)
    geometries = tuple(sorted(one.value for one in plugin.supported_geometries))
    degraded = tuple(sorted(one.value for one in plugin.degraded_geometries))
    return MatrixRow(
        format=plugin.format_name,
        direction="export",
        availability=availability,
        aliases=_aliases(plugin.format_name),
        task=entry.get("task"),
        dialects=tuple(entry.get("dialects", ())),
        geometries=geometries,
        degraded_geometries=degraded,
        unsupported_geometries=_unsupported(geometries, degraded),
        modalities=tuple(sorted(supported_modalities_of(plugin))),
        targets=tuple(sorted(one.name for one in plugin.targets)),
        lossy=plugin.lossy,
        status=_status(evidence, found is not None),
        evidence=evidence,
        notes=record.get("notes"),
    )


def _import_row(
    plugin: Importer,
    availability: str,
    found: tuple[Mapping[str, Any], Mapping[str, Any]] | None,
) -> MatrixRow:
    """An importer declares no geometry, so what it reads is the descriptor's record.

    With no record there is nothing to say: the geometry lists stay empty and
    nothing is called unsupported, because unknown is not the same as absent.
    """
    entry, record = found if found is not None else ({}, {})
    evidence = _evidence(record)
    geometries = tuple(sorted(record.get("geometries", ())))
    return MatrixRow(
        format=plugin.format_name,
        direction="import",
        availability=availability,
        aliases=_aliases(plugin.format_name),
        task=entry.get("task"),
        dialects=tuple(entry.get("dialects", ())),
        geometries=geometries,
        degraded_geometries=(),
        unsupported_geometries=_unsupported(geometries) if found is not None else (),
        modalities=tuple(sorted(record.get("modalities", ()))),
        targets=(),
        lossy=None,
        status=_status(evidence, found is not None),
        evidence=evidence,
        notes=record.get("notes"),
    )
