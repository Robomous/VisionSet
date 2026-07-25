from typing import BinaryIO, Protocol, runtime_checkable


@runtime_checkable
class BlobStore(Protocol):
    """Content-addressed immutable blob storage. Key = SHA-256 hex digest."""

    def put(self, content: BinaryIO) -> str: ...

    def get(self, content_hash: str) -> BinaryIO: ...

    def exists(self, content_hash: str) -> bool: ...
