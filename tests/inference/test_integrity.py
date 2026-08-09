"""Re-reading a snapshot: which digest each file is checked against, what damage
costs it, and what a check that could not reach the hub is careful not to claim.

The hub is faked and the **cache is real**. That split is deliberate and it is
where this file earns its keep: the digests have to come from somewhere a test
can control, but the thing being purged is a content-addressed directory of
blobs with symlinks pointing into it, and a purge that deleted only the link
would pass any test that faked the filesystem too. So `_cache` builds the layout
`huggingface_hub` builds — verified against the locked 1.26.0 and against the
hub itself — and the purge tests assert against files on disk.

`tests/kernel/test_capabilities.py` owns when the action is *offered*;
`tests/server/test_inference.py` drives it through the route and the job. This
file is the mechanism.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from visionset.inference import cache_root, check_integrity
from visionset.inference import integrity as integrity_module
from visionset.inference.integrity import Digest, digest_of, published_digests, purge
from visionset.kernel.domain import ConnectionSetupState, ConnectionType
from visionset.kernel.errors import (
    InferenceConnectionNotCheckable,
    InferenceConnectionNotFound,
    LocalInferenceUnavailable,
    WeightsDamaged,
)
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

COMMIT = "de431c4043854a71d8101e17995dfe596bf101a5"
"""The revision every connection here pins. A real-looking commit, because the
cache is addressed by one and a short string would not exercise the path."""

WEIGHTS = b"\x00\x01\x02" * 4096
"""Stands in for a checkpoint: LFS-tracked, so checked by sha256."""

CONFIG = b'{"model_type": "sam2"}\n'
"""Stands in for a config: not LFS-tracked, so checked by its git object id."""

EMPTY_BLOB_OID = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
"""git's object id for an empty file. A published constant, used as an oracle.

Any implementation of the git-object rule can be checked against this without
trusting a second copy of the rule written in this file — which is the whole
point of using it, since re-deriving the header here would only prove that two
identical mistakes agree.
"""

HELLO_BLOB_OID = "ce013625030ba8dba906f756967f9e9ca394464a"
"""git's object id for ``b"hello\\n"``. The same oracle, with a body."""


def _pointer(data: bytes) -> bytes:
    """The text git actually holds for an LFS-tracked file."""
    return b"version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %d\n" % (
        sha256_of(data).encode(),
        len(data),
    )


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_oid_of(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws", name="integrity")
    try:
        yield made
    finally:
        made.close()


@pytest.fixture()
def connections(workspace: WorkspaceService) -> InferenceConnectionService:
    return InferenceConnectionService(workspace)


def a_ready_local(connections: InferenceConnectionService, name: str = "local-sam") -> Any:
    """A local connection whose weights the workspace believes it already has."""
    made = connections.create(
        name,
        connection_type=ConnectionType.LOCAL,
        model_id="acme/sam",
        model_revision=COMMIT,
        device="cuda",
        precision="fp16",
    )
    return connections.record_weights_ready(made.id)


class FakeSibling:
    """One file of a revision, shaped the way ``model_info`` shapes one.

    ``lfs`` is a plain dict rather than the library's dataclass, which is the
    harder of the two for the code under test: ``BlobLfsInfo`` is a dataclass
    that also updates itself into a dict, so a reader that only knew about
    attributes would pass against the real object and fail here.
    """

    def __init__(self, name: str, data: bytes, *, lfs: bool) -> None:
        self.rfilename = name
        self.size = len(data)
        self.lfs = {"sha256": sha256_of(data), "size": len(data)} if lfs else None
        # An LFS file's `blob_id` is the object id of its **pointer text**, not
        # of its contents — git only ever stored the pointer. Verified against
        # the hub on three real LFS files. Getting this right in the fixture is
        # what makes the wrong digest choice *fail*: an implementation checking
        # weights against `blob_id` would compare a hash of megabytes to a hash
        # of a hundred-odd bytes, which is exactly what would happen in
        # production and exactly what a fixture that reused the content's oid
        # would hide.
        self.blob_id = git_oid_of(_pointer(data) if lfs else data)


class FakeHub:
    """Enough of ``huggingface_hub`` for this module, and no more.

    ``try_to_load_from_cache`` resolves against the **real** directory the
    fixture built, rather than answering from a dict, so a purge that left a
    symlink behind would still be found here — which is exactly the failure the
    purge tests need to be able to see.
    """

    def __init__(self, files: dict[str, FakeSibling], *, sha: str = COMMIT) -> None:
        self.files = files
        self.sha = sha
        self.lookups = 0
        self.fail: Exception | None = None

    def model_info(self, model_id: str, *, revision: str, files_metadata: bool = False) -> Any:
        self.lookups += 1
        if self.fail is not None:
            raise self.fail
        assert files_metadata, "a check without per-file metadata has nothing to compare against"
        return type("FakeInfo", (), {"sha": self.sha, "siblings": list(self.files.values())})()

    def try_to_load_from_cache(
        self, *, repo_id: str, filename: str, cache_dir: str, revision: str
    ) -> str | None:
        candidate = _snapshot(Path(cache_dir), repo_id, revision) / filename
        # ``exists()`` follows the link, which is what makes a dangling entry —
        # a purged blob with its symlink still in place — read as absent.
        return str(candidate) if candidate.exists() else None


def _snapshot(cache: Path, repo_id: str, commit: str) -> Path:
    """Where the library puts a revision's files. Verified against 1.26.0."""
    return cache / f"models--{repo_id.replace('/', '--')}" / "snapshots" / commit


def _cache(root: Path, repo_id: str, files: dict[str, bytes], lfs: set[str]) -> Path:
    """Build the cache layout the download library builds, for real.

    Blobs named by the digest that addresses them — sha256 for an LFS file, the
    git object id for anything else — and a snapshot directory of symlinks
    pointing at them. That naming is not decoration: it is why one purge removes
    the bytes for every revision that shared them.
    """
    folder = root / f"models--{repo_id.replace('/', '--')}"
    blobs = folder / "blobs"
    snapshot = _snapshot(root, repo_id, COMMIT)
    blobs.mkdir(parents=True, exist_ok=True)
    snapshot.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        blob = blobs / (sha256_of(data) if name in lfs else git_oid_of(data))
        blob.write_bytes(data)
        link = snapshot / name
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(blob)
    return snapshot


@pytest.fixture()
def hub(monkeypatch: pytest.MonkeyPatch) -> FakeHub:
    """The fake in place of the real client, for every import in the module."""
    made = FakeHub(
        {
            "model.safetensors": FakeSibling("model.safetensors", WEIGHTS, lfs=True),
            "config.json": FakeSibling("config.json", CONFIG, lfs=False),
        }
    )
    monkeypatch.setattr(integrity_module, "imported", lambda _name: made)
    return made


@pytest.fixture()
def cached(workspace: WorkspaceService) -> Path:
    """An intact snapshot on disk, matching what :data:`hub` publishes."""
    return _cache(
        cache_root(workspace.root),
        "acme/sam",
        {"model.safetensors": WEIGHTS, "config.json": CONFIG},
        lfs={"model.safetensors"},
    )


# --- the digest mechanics -----------------------------------------------------


def test_the_git_object_id_is_the_one_git_itself_computes() -> None:
    """Checked against published constants, not against a second copy of the rule.

    The header — ``blob <length>\\0`` before the contents — is the whole
    difference between this and a plain SHA-1, and getting it wrong produces a
    digest that never matches an intact file. Two well-known object ids are the
    oracle, because re-deriving the rule here would only prove that two
    identical mistakes agree with each other.
    """
    assert git_oid_of(b"") == EMPTY_BLOB_OID
    assert git_oid_of(b"hello\n") == HELLO_BLOB_OID


def test_each_file_is_checked_against_the_digest_kind_the_hub_gave_for_it(hub: FakeHub) -> None:
    """The trap this feature is most likely to fall into, asserted directly.

    A revision carries both kinds side by side: the weights are LFS-tracked and
    carry a sha256, the config is an ordinary git object and carries only an
    object id. Choosing per repository rather than per file would check one of
    them against the wrong thing for ever.
    """
    published = {one.path: one for one in published_digests("acme/sam", COMMIT)}
    assert published["model.safetensors"].digest is Digest.SHA256
    assert published["model.safetensors"].value == sha256_of(WEIGHTS)
    assert published["config.json"].digest is Digest.GIT_OID
    assert published["config.json"].value == git_oid_of(CONFIG)


def test_a_config_hashed_the_weights_way_would_never_match(hub: FakeHub, cached: Path) -> None:
    """Why the selection has to be per file: the wrong kind fails on healthy bytes.

    This is the shape of the bug the feature is one line away from at all times
    — a check that reports damage over an intact snapshot, whose remedy then
    deletes it — so it is pinned rather than described.
    """
    config = cached / "config.json"
    as_published, _ = digest_of(config, Digest.GIT_OID)
    as_weights, _ = digest_of(config, Digest.SHA256)
    assert as_published == git_oid_of(CONFIG)
    assert as_weights != git_oid_of(CONFIG)


def test_a_digest_reports_the_bytes_it_read(hub: FakeHub, cached: Path) -> None:
    """The count comes from the read, never from what the listing claimed."""
    _, read = digest_of(cached / "model.safetensors", Digest.SHA256)
    assert read == len(WEIGHTS)


def test_a_file_the_hub_will_not_digest_is_refused_rather_than_skipped(hub: FakeHub) -> None:
    """Skipping one file would report "intact" about a snapshot nobody checked."""
    naked = FakeSibling("mystery.bin", b"x", lfs=False)
    naked.blob_id = None
    hub.files["mystery.bin"] = naked
    with pytest.raises(LocalInferenceUnavailable, match="no digest"):
        published_digests("acme/sam", COMMIT)


# --- the intact path ----------------------------------------------------------


def test_an_intact_snapshot_leaves_the_connection_alone_and_says_what_it_read(
    connections: InferenceConnectionService, workspace: WorkspaceService, hub: FakeHub, cached: Path
) -> None:
    """Success is no transition at all, plus the two numbers the job publishes."""
    made = a_ready_local(connections)
    report = check_integrity(workspace, made.id)
    assert report.files_checked == 2
    assert report.bytes_read == len(WEIGHTS) + len(CONFIG)
    assert connections.get(made.id).setup_state is ConnectionSetupState.READY
    assert (cached / "model.safetensors").exists()


def test_every_file_is_reported_as_it_is_read(
    connections: InferenceConnectionService, workspace: WorkspaceService, hub: FakeHub, cached: Path
) -> None:
    """A real total, unlike the download — this loop knows how many are left."""
    seen: list[tuple[int, int]] = []
    check_integrity(
        workspace, a_ready_local(connections).id, on_file=lambda d, t: seen.append((d, t))
    )
    assert seen == [(1, 2), (2, 2)]


# --- damage -------------------------------------------------------------------


def test_one_wrong_byte_fails_names_the_file_purges_it_and_stands_the_connection_down(
    connections: InferenceConnectionService, workspace: WorkspaceService, hub: FakeHub, cached: Path
) -> None:
    """The whole failure path, end to end, over a real blob on a real disk."""
    made = a_ready_local(connections)
    blob = Path(os.path.realpath(cached / "model.safetensors"))
    blob.write_bytes(WEIGHTS[:-1] + b"\xff")

    with pytest.raises(WeightsDamaged, match="model.safetensors"):
        check_integrity(workspace, made.id)

    assert connections.get(made.id).setup_state is ConnectionSetupState.NOT_SET_UP
    assert not blob.exists(), "the damaged bytes are still on disk"
    assert (cached / "config.json").exists(), "an intact file was purged along with the damaged one"


def test_the_purge_removes_the_blob_so_the_next_download_really_re_fetches(
    connections: InferenceConnectionService, workspace: WorkspaceService, hub: FakeHub, cached: Path
) -> None:
    """The point of purging, asserted as the library would experience it.

    A cache hit is returned unread, so "the file is gone" has to mean gone to
    the *lookup* and not merely to the symlink. Asking the same question the
    download asks — is this in the cache? — is what proves the next download is
    a transfer rather than a hit.
    """
    made = a_ready_local(connections)
    Path(os.path.realpath(cached / "config.json")).write_bytes(b"tampered\n")
    with pytest.raises(WeightsDamaged):
        check_integrity(workspace, made.id)

    found = hub.try_to_load_from_cache(
        repo_id="acme/sam",
        filename="config.json",
        cache_dir=str(cache_root(workspace.root)),
        revision=COMMIT,
    )
    assert found is None, "the download would still be served the damaged copy"


def test_a_file_that_is_simply_gone_is_damage_too(
    connections: InferenceConnectionService, workspace: WorkspaceService, hub: FakeHub, cached: Path
) -> None:
    """A snapshot that cannot load is a snapshot that cannot load."""
    made = a_ready_local(connections)
    (cached / "config.json").unlink()
    with pytest.raises(WeightsDamaged, match="config.json"):
        check_integrity(workspace, made.id)
    assert connections.get(made.id).setup_state is ConnectionSetupState.NOT_SET_UP


def test_the_purge_happens_before_the_connection_is_stood_down(
    connections: InferenceConnectionService,
    workspace: WorkspaceService,
    hub: FakeHub,
    cached: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ordering the decision on #471 turns on, observed rather than assumed.

    A crash between the two writes has to fall on the side that leaves a
    *missing* file rather than a cached corrupt one, because the second is what
    a later download would hand back — laundering the damage into a `ready`
    connection with no control able to see it. So the state write must find the
    blob already gone.
    """
    made = a_ready_local(connections)
    blob = Path(os.path.realpath(cached / "model.safetensors"))
    blob.write_bytes(WEIGHTS[:-1] + b"\xff")

    seen: list[bool] = []
    original = InferenceConnectionService.record_weights_missing

    def spy(self: InferenceConnectionService, connection_id: Any) -> Any:
        seen.append(blob.exists())
        return original(self, connection_id)

    monkeypatch.setattr(InferenceConnectionService, "record_weights_missing", spy)
    with pytest.raises(WeightsDamaged):
        check_integrity(workspace, made.id)
    assert seen == [False], "the connection was stood down while the damage was still cached"


def test_checking_again_after_damage_is_refused_rather_than_repeated(
    connections: InferenceConnectionService, workspace: WorkspaceService, hub: FakeHub, cached: Path
) -> None:
    """The second run has nothing to check, and the gate is what says so.

    Not an error the check has to handle: the connection is `not_set_up` after
    the first verdict, and `check_integrity` is not legal there — which is the
    same answer `allowed_actions` gives a browser looking at the row.
    """
    made = a_ready_local(connections)
    (cached / "config.json").unlink()
    with pytest.raises(WeightsDamaged):
        check_integrity(workspace, made.id)
    with pytest.raises(InferenceConnectionNotCheckable, match="download"):
        check_integrity(workspace, made.id)


def test_purging_is_idempotent(cached: Path) -> None:
    """A re-queued orphan arrives at a cache a previous attempt already emptied."""
    target = cached / "config.json"
    blob = Path(os.path.realpath(target))
    assert purge([target]) == (target, blob)
    assert purge([target]) == ()


# --- what is not a verdict ----------------------------------------------------


def test_a_hub_that_cannot_be_reached_changes_nothing_and_removes_nothing(
    connections: InferenceConnectionService, workspace: WorkspaceService, hub: FakeHub, cached: Path
) -> None:
    """An absence of evidence, kept apart from evidence of absence.

    Answering "damaged" because a laptop was on a train would destroy a healthy
    cache; answering "intact" would be a guarantee made out of nothing. So the
    only correct behaviour is to fail the job and touch neither the row nor the
    disk.
    """
    made = a_ready_local(connections)
    hub.fail = RuntimeError("name resolution failed")

    with pytest.raises(LocalInferenceUnavailable, match="Nothing was changed"):
        check_integrity(workspace, made.id)

    assert connections.get(made.id).setup_state is ConnectionSetupState.READY
    assert (cached / "model.safetensors").exists()
    assert (cached / "config.json").exists()


# --- the gate -----------------------------------------------------------------


def test_a_connection_whose_weights_never_arrived_has_nothing_to_check(
    connections: InferenceConnectionService, workspace: WorkspaceService, hub: FakeHub
) -> None:
    """Refused, and the sentence names the download that would make it checkable."""
    made = connections.create(
        "unfetched",
        connection_type=ConnectionType.LOCAL,
        model_id="acme/sam",
        model_revision=COMMIT,
        device="cpu",
        precision="fp32",
    )
    with pytest.raises(InferenceConnectionNotCheckable, match="download them first"):
        check_integrity(workspace, made.id)
    assert hub.lookups == 0, "the hub was asked about a connection with nothing to check"


def test_an_http_connection_has_no_files_here_to_check(
    connections: InferenceConnectionService, workspace: WorkspaceService, hub: FakeHub
) -> None:
    """A different sentence, because it is a different remedy — there is none."""
    made = connections.create(
        "remote",
        connection_type=ConnectionType.HTTP,
        model_id="acme/sam",
        model_revision=COMMIT,
        endpoint_url="https://example.invalid/predict",
    )
    with pytest.raises(InferenceConnectionNotCheckable, match="runs elsewhere"):
        check_integrity(workspace, made.id)


def test_an_unknown_connection_is_not_found(workspace: WorkspaceService, hub: FakeHub) -> None:
    """The gate resolves before it decides, like every other one."""
    with pytest.raises(InferenceConnectionNotFound):
        check_integrity(workspace, uuid4())
