# usage: from visionset.inference import check_integrity
"""Re-reading a cached snapshot to find out whether it is still what arrived.

**The gap this closes.** ``download_weights`` at ``ready`` establishes that a
snapshot is *complete* — every file the revision names is present — and it
establishes that by consulting an index rather than by opening anything. The
cache is addressed by commit hash and etag, so a re-run finds what it already
has and hands back the path. What it therefore cannot see is a file that is
present and **damaged**: truncated by a filesystem error, rotted on a failing
disk, edited in place. That one surfaces much later, inside an adapter, in a
sentence about tensors, on a connection the row still calls ``Ready``.

**So this reads every byte.** There is no cheaper mechanism that answers the
question: a size check would pass a file whose length is right and whose middle
is wrong, and a modification-time check would pass anything that was damaged
without being rewritten. Reading gigabytes is the cost of the answer, which is
why this is a background job and never something inline.

## Two digest kinds, and choosing wrongly fails forever on intact files

The hub does not publish one digest per file. It publishes the digest **its own
storage keeps**, and that differs by how the file is stored:

- **LFS-tracked files** — the weights, and anything else large — carry
  ``lfs.sha256``: a plain SHA-256 over the file's contents.
- **Everything else** — ``config.json``, tokenizer JSON, ``.gitattributes`` —
  carries only ``blob_id``, which is a **git object id**: SHA-1 over
  ``b"blob <len>\\0"`` followed by the contents. It is not a hash of the file's
  bytes alone, and nothing on disk equals it.

Hashing a config with plain SHA-256 and comparing it against a git OID would
therefore fail on a perfectly intact file, every time, for as long as the check
existed — a check that cries damage over healthy weights is worse than no check,
because the remedy it names deletes them. :func:`published_digests` reads which
kind the hub gave for each file and :func:`digest_of` computes that kind; the
selection is per file and never per repository, because the two kinds appear
side by side inside one revision.

Verified against the locked ``huggingface_hub`` (1.26.0) and against the hub
itself: every file of a real revision carries one of the two, so nothing is
skipped. A file the hub gives neither for is **refused**, not passed —
:func:`published_digests` raises rather than quietly checking nine files out of
ten and reporting success.

## Purge before the state write, and only that order works

A cache hit is returned unread. So a connection sent back to ``not_set_up`` with
the damaged bytes still on disk would be "repaired" by the download action
handing back the very same file, and arrive at ``ready`` carrying the damage —
the remedy would launder the fault. Purging first is what makes
``download_weights`` a genuine remedy: the blob is gone, so the next download is
a real transfer.

**The two writes cannot be made atomic, and the ordering picks which way the
crash window falls.** One is a filesystem unlink and the other is a SQLite
commit; nothing brackets them. What matters is which side is safe to fail on:

- Purge, then write — a crash between them leaves ``ready`` with a **missing**
  file. That is an incomplete snapshot, which is exactly the condition
  ``download_weights`` already exists to repair, and the next run of either
  action fixes it for real.
- Write, then purge — a crash between them leaves ``not_set_up`` with the
  **corrupt** file still cached, and the download somebody then runs restores it
  to ``ready``. Silent, and unrecoverable by any control this product offers.

The first is the one this module does. Never-half-ready is untouched either way:
``setup_state`` has two values, this writes one of them, and there is no moment
at which a reader finds a third.

**A crash before the verdict changes nothing at all.** Every read above happens
before the first unlink, so a run that dies while hashing leaves the connection
``ready`` and the cache exactly as it found it.

## What is not a verdict

A metadata fetch needs the network, and a network that is not there is not
evidence about the files. So a failed lookup raises before anything is read, and
raises the same way a missing extra does: no purge, no state change, and a
sentence naming what happened and what to do. Answering "damaged" because a
laptop was on a train would destroy a healthy cache; answering "intact" would be
a guarantee made out of nothing.
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Final
from uuid import UUID

from visionset.inference._extra import imported
from visionset.inference.weights import cache_root
from visionset.kernel.domain import InferenceConnection
from visionset.kernel.errors import LocalInferenceUnavailable, WeightsDamaged
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

_logger: Final = logging.getLogger(__name__)

READ_CHUNK: Final = 1 << 20
"""How much of a file to hash at a time, in bytes.

A megabyte, because the files at the large end of this are measured in
gigabytes and reading one into memory to hash it would make the check's cost a
function of the model rather than of the disk.
"""


class Digest(StrEnum):
    """Which of the hub's two published digest kinds a file is checked against.

    A closed vocabulary rather than a string, for ``Precision``'s reason: the
    set is small, this module is what decides which member applies to a file,
    and a third kind arriving would be a deliberate change here rather than a
    value that flowed in and was ignored.
    """

    SHA256 = "sha256"
    """A plain SHA-256 over the file's contents. What LFS-tracked files carry."""

    GIT_OID = "git_oid"
    """SHA-1 over ``b"blob <len>\\0"`` and then the contents — a git object id.

    The digest git itself would compute, which is why small files carry it: they
    are stored as ordinary git objects rather than through LFS, so the object id
    is the only digest the hub has for them.
    """


@dataclass(frozen=True, slots=True)
class PublishedDigest:
    """What the hub says one file of a pinned revision should hash to."""

    path: str
    """The file's name relative to the repository root, as the hub spells it."""

    digest: Digest
    """Which kind :attr:`value` is — see :class:`Digest`."""

    value: str
    """The digest itself, lowercase hexadecimal."""


@dataclass(frozen=True, slots=True)
class IntegrityReport:
    """What one pass over a snapshot read, and what it found.

    Returned only when the snapshot is **intact**: a pass that found damage
    raises :class:`~visionset.kernel.errors.WeightsDamaged` after purging, so
    there is no report a caller could mistake for a clean bill of health while
    it carries a list of broken files.
    """

    files_checked: int
    """How many files were read in full and compared."""

    bytes_read: int
    """How many bytes that came to — the honest measure of what this cost."""

    def counts(self) -> dict[str, int]:
        """The report as the two surfaces publish it, spelled once.

        Not a ``visionset.wire`` projection, because that module pairs with a
        server model and no route publishes this shape: the route publishes a
        *job*, and this is what a finished one carries in its result. So the
        agreement worth holding is between the job's result and the command's
        ``--json``, and the way to hold it is for both to call this rather than
        each writing the keys out.
        """
        return {"files_checked": self.files_checked, "bytes_read": self.bytes_read}


def check_integrity(
    workspace: WorkspaceService,
    connection_id: UUID,
    *,
    on_progress: Callable[[str], None] | None = None,
    on_file: Callable[[int, int], None] | None = None,
) -> IntegrityReport:
    """Re-read this connection's snapshot; purge and stand it down if damaged.

    The whole operation in the order that makes the failure safe, and the one
    body every surface shares — ``fetch_weights``' rule, one action over: the
    background job runs it, the CLI runs it inline, and the browser reaches it
    through the job. Two implementations of "what checking means" is how a
    terminal and an API come to disagree about whether a model is usable.

    ``on_progress`` reports phases and ``on_file`` reports counts, and the split
    is because this job has both to give where the download has only the first.
    A download's bytes belong to a library that owns the transfer; a check owns
    its own loop and knows exactly how many files it has left, so inventing a
    number is not necessary here and reporting one is not dishonest.

    Raises:
        InferenceConnectionNotFound: no such connection in this workspace.
        InferenceConnectionNotCheckable: it has no weights of its own, or they
            are not here yet.
        LocalInferenceUnavailable: the optional runtime is not installed, or the
            hub's metadata could not be read — neither of which is evidence
            about the files, so neither purges or changes any state.
        WeightsDamaged: at least one file did not match. The connection is
            ``not_set_up`` and the offending blobs are gone by the time this is
            raised; the message names the files.
    """
    connections = InferenceConnectionService(workspace)
    connection = connections.require_checkable(connection_id)
    say = on_progress or (lambda _: None)

    say(f"reading what the hub publishes for {connection.model_id}")
    published = published_digests(connection.model_id, connection.model_revision)
    commit = resolved_commit(connection.model_id, connection.model_revision)

    say(f"re-reading {len(published)} files")
    damaged: list[tuple[str, Path | None]] = []
    bytes_read = 0
    for done, expected in enumerate(published, start=1):
        found = cached_file(
            connection, expected.path, commit=commit, into=cache_root(workspace.root)
        )
        if found is None:
            # A file the revision names and the disk does not hold. Damage
            # rather than a separate outcome: the snapshot cannot load either
            # way, and the remedy is the same download.
            damaged.append((expected.path, None))
        else:
            try:
                actual, read = digest_of(found, expected.digest)
            except OSError as exc:
                # A file that will not read *is* the failure this looks for —
                # the classic shape of a dying disk — so it is damage and not an
                # error escaping the check. Losing the reason would make the
                # verdict unexplainable, so it is logged where it happened.
                _logger.warning("could not read %s: %s", found, exc)
                damaged.append((expected.path, found))
            else:
                bytes_read += read
                if actual != expected.value:
                    damaged.append((expected.path, found))
        if on_file is not None:
            on_file(done, len(published))

    if not damaged:
        say("every file matched what the hub published")
        return IntegrityReport(files_checked=len(published), bytes_read=bytes_read)

    # Purge first, then stand the connection down. The module docstring is why
    # this order is the only one available: a cache hit is returned unread, so
    # the remedy would otherwise re-serve the damage.
    say(f"purging {len(damaged)} damaged files")
    purge(path for _, path in damaged if path is not None)
    connections.record_weights_missing(connection.id)
    raise WeightsDamaged(_why_damaged(connection, [name for name, _ in damaged]))


def resolved_commit(model_id: str, model_revision: str) -> str:
    """The commit that revision points at, which is how the cache is addressed.

    A connection is required to carry a real revision, so this is nearly always
    the value it already holds — but the cache is keyed by commit and never by
    the name somebody typed, so resolving is what lets a check work for a pin
    that happens to be spelled as a tag.

    Raises:
        LocalInferenceUnavailable: the runtime is absent or the hub could not be
            read.
    """
    return _repository(model_id, model_revision).sha or model_revision


def published_digests(model_id: str, model_revision: str) -> tuple[PublishedDigest, ...]:
    """What the hub says every file of that revision should hash to.

    Every file, and **a file it will not digest is refused rather than
    skipped**. ``measure`` takes the same line about sizes and for a sharper
    reason here: silently passing over a file would report "intact" about a
    snapshot nobody checked, which is a guarantee made out of a gap.

    Raises:
        LocalInferenceUnavailable: the runtime is absent, the revision could not
            be read, or the listing did not digest every file.
    """
    info = _repository(model_id, model_revision)
    files = tuple(getattr(info, "siblings", None) or ())
    if not files:
        raise LocalInferenceUnavailable(
            f"the hub listed no files for {model_id} at {model_revision}, so there is "
            "nothing to check against; check the model id and the revision"
        )
    published: list[PublishedDigest] = []
    undigested: list[str] = []
    for one in files:
        name = str(getattr(one, "rfilename", "?"))
        sha256 = _lfs_sha256(getattr(one, "lfs", None))
        oid = getattr(one, "blob_id", None)
        if sha256:
            published.append(PublishedDigest(path=name, digest=Digest.SHA256, value=sha256))
        elif oid:
            published.append(PublishedDigest(path=name, digest=Digest.GIT_OID, value=str(oid)))
        else:
            undigested.append(name)
    if undigested:
        raise LocalInferenceUnavailable(
            f"the hub published no digest for {len(undigested)} of {len(files)} files in "
            f"{model_id} at {model_revision} (for example {undigested[0]!r}), so those "
            "files cannot be checked and the snapshot cannot be called intact"
        )
    return tuple(published)


def digest_of(path: Path, digest: Digest) -> tuple[str, int]:
    """That file's digest of that kind, and how many bytes it took to read it.

    Streamed in :data:`READ_CHUNK` pieces, so the cost is the disk's and not the
    machine's memory. The byte count comes back because it is the only honest
    measure of what a check cost, and because computing it a second way — from
    the listing's sizes — would report what the hub *said* rather than what this
    read.

    The git-object-id case hashes a header first: ``b"blob <len>\\0"``, where the
    length is the file's size in bytes. That is what makes the value comparable
    to ``blob_id``, and doing it any other way produces a digest that will never
    match an intact file.
    """
    size = path.stat().st_size
    running = hashlib.sha256() if digest is Digest.SHA256 else hashlib.sha1()
    if digest is Digest.GIT_OID:
        running.update(b"blob %d\0" % size)
    read = 0
    with path.open("rb") as handle:
        while chunk := handle.read(READ_CHUNK):
            running.update(chunk)
            read += len(chunk)
    return running.hexdigest(), read


def cached_file(
    connection: InferenceConnection, filename: str, *, commit: str, into: Path
) -> Path | None:
    """Where that file of the pinned snapshot is on disk, or ``None`` if it is not.

    Asked of ``huggingface_hub`` rather than by assembling the path here: the
    cache layout is that library's, and a hand-built path is a mirror that goes
    wrong on the release that reorganises it.

    ``None`` is a real answer and the caller treats it as damage. A file the
    revision names and the disk does not have is a snapshot that cannot load,
    whatever the row says — and the remedy is the same download either way.
    """
    hub = imported("huggingface_hub")
    found = hub.try_to_load_from_cache(
        repo_id=connection.model_id,
        filename=filename,
        cache_dir=str(into),
        revision=commit,
    )
    # The library answers with a sentinel object for "known to be absent" and
    # ``None`` for "never looked for"; neither is a path, and both mean the same
    # thing here.
    return Path(found) if isinstance(found, str) else None


def purge(paths: Iterable[Path]) -> tuple[Path, ...]:
    """Remove those cached files and the blobs behind them. Say what went.

    **Both halves, or the purge does not purge.** A snapshot entry is a symlink
    into a content-addressed ``blobs/`` directory, so deleting the link alone
    leaves the damaged bytes exactly where a re-download would find them — and
    the whole point of purging is that the next download is a real transfer.

    Idempotent, and it has to be: a re-queued orphan arrives at a cache a
    previous attempt already emptied, and a purge that raised on an absent file
    would turn a completed remedy into a failing job.

    Tolerant of a cache that holds real files rather than symlinks. The library
    falls back to copying where a filesystem has no symlinks, and there the
    entry *is* the blob — so resolving and unlinking the same path twice is the
    ordinary case rather than an error.
    """
    gone: list[Path] = []
    for path in paths:
        blob = Path(os.path.realpath(path))
        for target in (path, blob):
            try:
                target.unlink()
            except FileNotFoundError:
                continue
            gone.append(target)
    _logger.info("purged %d cached files", len(gone))
    return tuple(gone)


def _repository(model_id: str, model_revision: str) -> Any:
    """The hub's record of that revision, with per-file metadata attached.

    ``Any`` because the shape belongs to an optional dependency imported inside
    the function: there is no type here to name without making the extra a
    condition of type-checking the product. Every attribute read off it is read
    through ``getattr`` with a default, one call site over, for the same reason.

    One network call, and the only one this module makes. Its failure is
    deliberately **not** a verdict: see the module docstring.

    Raises:
        LocalInferenceUnavailable: the runtime is absent, or the hub could not
            be read.
    """
    hub = imported("huggingface_hub")
    _logger.debug("reading the digests of %s at %s", model_id, model_revision)
    try:
        return hub.model_info(model_id, revision=model_revision, files_metadata=True)
    except Exception as exc:  # noqa: BLE001 — ``download``'s reason, one call over
        raise LocalInferenceUnavailable(
            f"could not read what the hub publishes for {model_id} at {model_revision}: "
            f"{exc}. Nothing was changed and nothing was removed — a check needs the "
            "published digests to compare against, so this is not an answer about the "
            "files on this machine"
        ) from exc


def _lfs_sha256(lfs: Any) -> str | None:
    """The SHA-256 inside a sibling's LFS metadata, however that object spells it.

    ``BlobLfsInfo`` is a dataclass that also updates itself into a ``dict``, so
    both an attribute and a key are correct at the locked version. Reading both
    is not defensive clutter: it is the one shape in this file that belongs to a
    library rather than to us, and the fallback costs a line.
    """
    if lfs is None:
        return None
    found = lfs.get("sha256") if isinstance(lfs, dict) else getattr(lfs, "sha256", None)
    return str(found) if found else None


def _why_damaged(connection: InferenceConnection, files: list[str]) -> str:
    """The failure, in a sentence that names the files and the remedy.

    Names them rather than counting them, up to a point: "3 files are damaged"
    tells somebody looking at a disk nothing about which disk, while a filename
    is something they can go and look at. The list is capped because a snapshot
    on a failing disk can have every file in it wrong, and a job error is read
    in a table cell.
    """
    shown = ", ".join(sorted(files)[:3])
    rest = "" if len(files) <= 3 else f", and {len(files) - 3} more"
    plural = "file does" if len(files) == 1 else "files do"
    return (
        f"{len(files)} {plural} not match what the hub published for "
        f"{connection.model_id} at {connection.model_revision} ({shown}{rest}). "
        f"The damaged copies have been removed and {connection.name!r} is back to "
        "not set up; download the weights again to fetch clean ones"
    )
