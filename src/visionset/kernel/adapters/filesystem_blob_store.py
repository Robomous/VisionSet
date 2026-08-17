"""Default BlobStore adapter: content-addressed files under a workspace directory."""

from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path
from typing import BinaryIO

_CHUNK = 1024 * 1024


class FilesystemBlobStore:
    """Stores blobs as ``<root>/<hash[:2]>/<hash[2:4]>/<hash>`` (path-sharded).

    Blobs are immutable: `put` of existing content is a no-op that returns the
    same hash. Writes go through a temp file + atomic rename, so a crashed
    `put` never leaves a partial blob at its final path. A failed `put` also
    removes its own temp file, so nothing lingers in the blob root.
    """

    def __init__(self, root: Path) -> None:
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)

    def _path_for(self, content_hash: str) -> Path:
        return self._root / content_hash[:2] / content_hash[2:4] / content_hash

    def put(self, content: BinaryIO) -> str:
        digest = hashlib.sha256()
        tmp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(dir=self._root, delete=False) as tmp:
                tmp_path = Path(tmp.name)
                while chunk := content.read(_CHUNK):
                    digest.update(chunk)
                    tmp.write(chunk)
            content_hash = digest.hexdigest()
            final = self._path_for(content_hash)
            if not final.exists():
                final.parent.mkdir(parents=True, exist_ok=True)
                tmp_path.replace(final)
            return content_hash
        finally:
            # The temp name is unique to this call, so after a successful
            # rename this is a no-op and can never touch a concurrent put.
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)

    def get(self, content_hash: str) -> BinaryIO:
        path = self._path_for(content_hash)
        if not path.is_file():
            raise FileNotFoundError(f"no blob with hash {content_hash!r}")
        return path.open("rb")

    def exists(self, content_hash: str) -> bool:
        return self._path_for(content_hash).is_file()
