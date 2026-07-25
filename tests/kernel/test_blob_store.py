import hashlib
import io
from pathlib import Path

import pytest

from visionset.kernel.adapters import FilesystemBlobStore
from visionset.kernel.ports import BlobStore


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


def test_satisfies_blob_store_port(tmp_path: Path) -> None:
    assert isinstance(FilesystemBlobStore(tmp_path / "blobs"), BlobStore)
