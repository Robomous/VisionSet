from pathlib import Path, PurePosixPath
from typing import BinaryIO, Protocol, runtime_checkable

from visionset.kernel.domain import ImportedDataset


@runtime_checkable
class Importer(Protocol):
    """An annotation-format importer plugin.

    Implementations are discovered via the ``visionset.formats`` entry-point
    group, so third-party distributions can plug in. ``read`` reads a directory
    and returns a value: it never touches a workspace, and it reports everything
    it could not represent in ``ImportedDataset.losses`` rather than dropping it.

    Raises:
        ImportSourceUnreadable: the source is malformed or names an unsafe path.
    """

    format_name: str

    def read(self, src: Path) -> ImportedDataset: ...


@runtime_checkable
class OpensPictures(Protocol):
    """An importer whose source holds pictures inside its files rather than as files.

    Optional beside :class:`Importer`. The import service calls ``open`` for an
    image whose path names no file in the source, in both inspect and commit,
    and reads the picture from the stream it answers. Nothing is written into
    the source.

    Raises:
        OSError: the source holds no picture at ``path``; the image is an
            ``image`` loss, as a missing file is.
        ImportSourceUnreadable: the picture cannot be read out of the source.
    """

    def open(self, src: Path, path: PurePosixPath) -> BinaryIO: ...
