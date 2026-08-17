import hashlib
import io
from pathlib import Path

import pytest

from visionset.kernel.adapters import FilesystemBlobStore


def test_put_get_exists_roundtrip(tmp_path: Path) -> None:
    store = FilesystemBlobStore(tmp_path / "blobs")
    payload = b"visionset" * 1000
    expected = hashlib.sha256(payload).hexdigest()

    content_hash = store.put(io.BytesIO(payload))
    assert content_hash == expected
    assert store.exists(content_hash)
    with store.get(content_hash) as fh:
        assert fh.read() == payload


def test_paths_are_sharded_by_hash_prefix(tmp_path: Path) -> None:
    root = tmp_path / "blobs"
    store = FilesystemBlobStore(root)
    h = store.put(io.BytesIO(b"shard me"))
    assert (root / h[:2] / h[2:4] / h).is_file()


def test_put_is_idempotent_for_same_content(tmp_path: Path) -> None:
    store = FilesystemBlobStore(tmp_path / "blobs")
    h1 = store.put(io.BytesIO(b"same bytes"))
    h2 = store.put(io.BytesIO(b"same bytes"))
    assert h1 == h2


def test_get_missing_blob_raises(tmp_path: Path) -> None:
    store = FilesystemBlobStore(tmp_path / "blobs")
    with pytest.raises(FileNotFoundError):
        store.get("0" * 64)


class _TornStream(io.RawIOBase):
    """A stream that yields one chunk and then fails, like a torn upload."""

    def __init__(self) -> None:
        self._reads = 0

    def read(self, size: int = -1) -> bytes:
        self._reads += 1
        if self._reads > 1:
            raise OSError("torn stream")
        return b"first chunk"


def test_a_failed_read_leaves_no_temp_file_in_the_blob_root(tmp_path: Path) -> None:
    root = tmp_path / "blobs"
    store = FilesystemBlobStore(root)
    with pytest.raises(OSError, match="torn stream"):
        store.put(_TornStream())
    assert list(root.iterdir()) == []


def test_a_failed_rename_leaves_no_temp_file_in_the_blob_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "blobs"
    store = FilesystemBlobStore(root)

    def refuse(self: Path, target: object) -> Path:
        raise OSError("no space left on device")

    monkeypatch.setattr(Path, "replace", refuse)
    with pytest.raises(OSError, match="no space"):
        store.put(io.BytesIO(b"doomed"))
    assert not [p for p in root.rglob("*") if p.is_file()]
