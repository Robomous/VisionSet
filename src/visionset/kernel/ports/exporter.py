from collections.abc import Callable, Mapping
from pathlib import Path
from typing import BinaryIO, Protocol, runtime_checkable

from visionset.kernel.domain import ExportTarget, GeometryType, Manifest, Release
from visionset.kernel.errors import (
    ExportTargetConflict,
    ExportTargetNotFound,
    InvalidExportTarget,
)

ContentReader = Callable[[str], BinaryIO]
"""Resolve one content hash to the bytes behind it, for the duration of a call.

A :class:`Manifest` names every asset by ``content_hash`` and by a workspace-local
``uri``, and **neither of those is a file an exporter can open**. A ``uri`` is
where the bytes were first *seen*: the original ingest path, which may have been
deleted since, or — for a frame cut out of a clip — a locator like
``/clips/drive.mp4#frame=12`` that was never a file at all. The bytes live in the
blob store, under a layout only the blob store knows.

So a format that lays out images gets this, and nothing wider. It is a plain
callable rather than the :class:`~visionset.kernel.ports.BlobStore` port because
the difference is authority: a reader can read, where the port can also ``put``,
and a plugin that could write into the content store could give a release bytes
nobody published. ``ReleaseService.export`` composes it, so the plugin never sees
a workspace, a path layout or a port.

**It raises rather than returning ``None``** when the bytes are gone — a released
asset whose blob is missing is damage, and an exporter that swallowed it would
write a training set quietly missing images, which is why this signature has no
error branch to ignore.

The handle is open and positioned at the start; the caller closes it. A file
already read once must be re-requested rather than rewound, because nothing
promises two calls return the same object.
"""


@runtime_checkable
class Exporter(Protocol):
    """A dataset-format exporter plugin.

    Implementations are discovered via the ``visionset.formats`` entry-point
    group, so third-party distributions can plug in. Any coordinate
    normalization a format requires happens here — never in the domain.

    The manifest comes in beside the release rather than off it. A ``Release``
    only *names* its manifest, because the document lives in the blob store and
    can be megabytes; an exporter given the release alone would hold a hash and
    no way to resolve it, since the kernel hands its plugins domain values and
    never a port. ``ReleaseService.manifest`` is what a caller resolves it with.

    ``content`` is how a format that lays out images gets them; see
    :data:`ContentReader` for why a ``uri`` is not a file and why this is a
    callable rather than a port. A format writing only labels ignores it.

    ``export`` writes into ``dest``, which the caller has already created, and
    returns nothing. Counting what was written is ``ReleaseService.export``'s job
    precisely because it must not be the plugin's: a number reported by the thing
    it describes is not checkable.

    **``dest`` exists and may already hold an earlier run's output.** Nothing
    promises it is empty — the kernel will not delete files under a path a caller
    named — so an implementation laying out subdirectories creates them with
    ``exist_ok=True``, and one writing a file writes it rather than appending. A
    caller that needs the directory to describe exactly one run clears it first;
    the REST surface does, because it owns the path it passes.
    """

    format_name: str

    #: Whether this format drops information the kernel can represent.
    #:
    #: A property of the **format**, not of a particular release: a bbox-only
    #: format loses a polygon whether or not today's dataset happens to hold one,
    #: and asking per release would mean re-answering on every export and getting
    #: a different answer as the data drifted. Declared once, in the plugin, by
    #: whoever knows what the format can express.
    #:
    #: Everything the domain allows counts — geometry variants, attribute kinds,
    #: per-annotation provenance and confidence. A format carrying all of it sets
    #: ``False`` and never thinks about this again; ``LossyExportNotConsented`` is
    #: what a ``True`` costs the caller, once.
    lossy: bool

    #: Which geometries this format can write.
    #:
    #: The **checkable** half of ``lossy``. The flag above is a blanket statement
    #: a plugin makes about itself and nobody can verify; this is a list a report
    #: can be computed against, which is what turns "this format is lossy" into
    #: "this release loses 1,204 polygon annotations across 310 assets".
    #:
    #: Declared over ``GeometryType`` — every name the domain can address, not
    #: only the three an ``Annotation`` may carry today — so a format that will
    #: one day write masks says so once and the report widens with the union
    #: rather than with a second edit here.
    #:
    #: A format supporting everything still sets ``lossy`` honestly: the two
    #: answer different questions, and attributes, confidence and provenance are
    #: outside what a geometry list can see.
    supported_geometries: frozenset[GeometryType]

    #: Which geometries this format writes, but not as they stand.
    #:
    #: Without it, ``supported_geometries`` gets read with two intents.
    #: ``_compatibility`` reads "not supported" as *absent from the output*, while
    #: the YOLO and VOC exporters read it as *convert to something I can write*
    #: and emit a polygon as its axis-aligned bounding box under the polygon's own
    #: class name. Both readings are defensible, which is what makes the report
    #: wrong rather than the code buggy: the model had no word for **carried, but
    #: reduced**.
    #:
    #: Declare a geometry here when an annotation of it reaches the output having
    #: lost something the kernel could represent. Declare it in
    #: ``supported_geometries`` when it arrives intact, and in **neither** when it
    #: is not written at all. The two sets are disjoint — a geometry cannot be
    #: both intact and reduced — and ``_compatibility`` lets ``supported`` win if
    #: a plugin says both, because writing something whole is the weaker claim to
    #: doubt.
    #:
    #: Empty is the right answer for most formats, and for both reasons: COCO
    #: writes a polygon as a polygon, and ``DummyExporter`` writes nothing at all.
    #: A format that converts silently is the one this field exists to stop.
    degraded_geometries: frozenset[GeometryType]

    #: Which asset modalities this format can write.
    #:
    #: A plain ``str`` set, matching ``Asset.modality``, and for the same reason
    #: ``DatasetChange.operation`` is a ``str`` while ``DatasetOperation`` is an
    #: enum: a modality is a value a *format* declares, and a build that has never
    #: heard of one should report it as unsupported rather than fail to load the
    #: plugin.
    #:
    #: **Declared and published, but not yet judged against.** A
    #: ``ManifestAsset`` carries no modality — adding one would change the shape
    #: of every manifest and therefore every release hash ever computed — and
    #: reading it off the live ``Asset`` would make an export report depend on
    #: something that can move after publication. ``_compatibility`` in
    #: ``release_service.py`` says so in full. Everything ingested today is
    #: ``image``.
    supported_modalities: frozenset[str]

    #: Which models a person can train on this format's output.
    #:
    #: At least one, so every installed format is reachable through the one
    #: target control a surface renders — an exporter with no target would be a
    #: format nothing can address. A non-YOLO format declares a single target
    #: named after its own ``format_name``, family ``other``, so exporting to it
    #: is the same gesture as exporting to a trainer.
    #:
    #: Names are unique across every installed plugin — :func:`resolve_target`
    #: is what turns one into an exporter — and each target's
    #: ``supported_geometries`` stays within the exporter's own, which
    #: :func:`validate_targets` checks: a target is a promise about this
    #: exporter's output, and one promising a geometry the format never writes
    #: would make the catalog describe files that do not appear.
    targets: frozenset[ExportTarget]

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None: ...


def validate_targets(exporter: Exporter) -> None:
    """Check an exporter's target declarations against the exporter itself.

    Every target's ``supported_geometries`` must be a subset of the exporter's
    own, so a defective declaration is refused where it can be named rather
    than surfacing as a catalog entry whose exports are missing what it
    promised.

    Raises:
        InvalidExportTarget: a target claims a geometry the exporter does not
            write.
    """
    for target in exporter.targets:
        undeliverable = target.supported_geometries - exporter.supported_geometries
        if undeliverable:
            claimed = ", ".join(sorted(one.value for one in undeliverable))
            raise InvalidExportTarget(
                f"format {exporter.format_name!r} declares target {target.name!r} "
                f"supporting geometries it does not write: {claimed}"
            )


def resolve_target(installed: Mapping[str, Exporter], name: str) -> tuple[Exporter, ExportTarget]:
    """The exporter declaring that target, and the declaration itself.

    Pure resolution over exporters already in hand, the way ``pick`` resolves a
    format name: the kernel may not scan entry points, so whoever composed the
    call passes what is installed.

    Raises:
        ExportTargetNotFound: no installed exporter declares the name.
        ExportTargetConflict: more than one installed exporter declares it.
    """
    matches = [
        (exporter, target)
        for exporter in installed.values()
        for target in exporter.targets
        if target.name == name
    ]
    if not matches:
        every = tuple(
            sorted(target.name for exporter in installed.values() for target in exporter.targets)
        )
        known = ", ".join(every) or "none"
        raise ExportTargetNotFound(
            f"no installed exporter declares target {name!r}; installed targets: {known}",
            installed=every,
        )
    if len(matches) > 1:
        formats = ", ".join(sorted(exporter.format_name for exporter, _ in matches))
        raise ExportTargetConflict(
            f"target {name!r} is declared by more than one installed format ({formats}); "
            "remove one of the distributions, or export by format name"
        )
    return matches[0]
