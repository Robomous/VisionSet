from pathlib import Path
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import Manifest, Release


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

    def export(self, release: Release, manifest: Manifest, dest: Path) -> None: ...
