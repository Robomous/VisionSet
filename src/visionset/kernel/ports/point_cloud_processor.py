"""Point clouds: validate a scan's bytes, report what it is, draw it from above.

A port of its own rather than two more methods on ``ImageProcessor``: a scan
has no pixels, so every image method would be one a point-cloud implementation
raises from, and the reverse.
"""

from dataclasses import dataclass
from typing import BinaryIO, Final, Protocol, runtime_checkable

from visionset.kernel.domain import PointCloudMetadata, PointSample, ScanFrame
from visionset.kernel.ports.image_processor import DEFAULT_THUMBNAIL_MAX_EDGE

#: The most points one scan may hold, counted as declared in its header before
#: anything is decoded. A header promising more is refused as ``UnsupportedMedia``,
#: the rule ``ImageProcessor`` applies to a decompression bomb. Ten million is
#: several sweeps of a 128-beam lidar, and keeps the decoded coordinates (three
#: doubles a point) under a quarter of a gigabyte.
MAX_POINT_CLOUD_POINTS: Final = 10_000_000

#: The most bytes a scan's point data may occupy, before or after decompression.
MAX_POINT_CLOUD_BYTES: Final = 512 << 20


@dataclass(frozen=True, slots=True)
class PointCloudReading:
    """What one decode of a scan says: its metadata, and its preview if that rendered."""

    metadata: PointCloudMetadata
    thumbnail: bytes | None


@runtime_checkable
class PointCloudProcessor(Protocol):
    """Reads single point-cloud scans: what they are, and a top-down preview.

    The rules ``ImageProcessor`` owes its callers hold here too: both methods
    read from the beginning, neither closes the stream, and ``name`` is for
    reporting only. **The bytes decide**, never a suffix: the header is sniffed.

    ``probe`` decodes every point before answering, so a truncated or damaged
    scan is refused before a caller stores anything. A point with a non-finite
    coordinate is dropped (an organized cloud's empty pixel); a scan left with
    none is refused.

    ``thumbnail`` draws the scan seen from above along ``frame``'s up axis,
    forward pointing up the picture, encoded as ``THUMBNAIL_FORMAT``.

    ``read`` answers both from one decode, which is what an ingest wants: it
    raises as ``probe`` does, and a preview that alone fails comes back ``None``.

    ``sample`` keeps every ``ceil(n / budget)``-th of the ``n`` finite points, in
    file order, so the same scan and budget always give the same points. It
    carries intensity and 8-bit colour when the scan has them, and raises as
    ``probe`` does; a ``budget`` below 1 is a ``ValueError``.

    Nothing else escapes: any fault the bytes provoke is one of the two
    refusals below, so a hostile file can never be taken for a broken machine.

    Raises:
        UnsupportedMedia: not a PCD or PLY scan this reads (no recognisable
            header, an unsupported encoding, no float ``x``, ``y`` and ``z``),
            or one declaring more than :data:`MAX_POINT_CLOUD_POINTS` points or
            :data:`MAX_POINT_CLOUD_BYTES` of point data.
        CorruptMedia: a scan whose header is recognisable and whose data will
            not decode, or whose every point is non-finite.
    """

    def probe(self, content: BinaryIO, *, name: str | None = None) -> PointCloudMetadata: ...

    def thumbnail(
        self,
        content: BinaryIO,
        *,
        frame: ScanFrame,
        max_edge: int = DEFAULT_THUMBNAIL_MAX_EDGE,
        name: str | None = None,
    ) -> bytes: ...

    def read(
        self,
        content: BinaryIO,
        *,
        frame: ScanFrame,
        max_edge: int = DEFAULT_THUMBNAIL_MAX_EDGE,
        name: str | None = None,
    ) -> PointCloudReading: ...

    def sample(self, content: BinaryIO, *, budget: int, name: str | None = None) -> PointSample: ...
