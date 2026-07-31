from pathlib import Path
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import GeometryType, Manifest, Release


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
    #: The **checkable** half of ``lossy``, added by #65. The flag above is a
    #: blanket statement a plugin makes about itself and nobody can verify; this
    #: is a list a report can be computed against, which is what turns "this
    #: format is lossy" into "this release loses 1,204 polygon annotations across
    #: 310 assets".
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

    def export(self, release: Release, manifest: Manifest, dest: Path) -> None: ...
