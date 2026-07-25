from collections.abc import Mapping
from typing import BinaryIO, Protocol, runtime_checkable


@runtime_checkable
class MediaProcessor(Protocol):
    """Extracts technical metadata (dimensions, format, ...) from raw media bytes."""

    def probe(self, content: BinaryIO) -> Mapping[str, object]: ...
