# usage: from visionset.server.uploads import stage
"""Where an uploaded file lands before a source is registered over it.

The kernel registers a source by **path**: `SourceService.register_images` takes
a directory and `register_video` takes a file, both of which have to exist on
this machine. An HTTP client has bytes. This module is the one place that bridges
the two, and it is deliberately a *server* concern — the CLI and MCP surfaces
already hold real paths and never come through here.

**Uploads are staged content-addressed**, under ``<workspace>/uploads/<digest>/``,
where the digest names the whole part set: sha-256 over the sorted
``name:sha256`` lines. One rule for one clip and for fifty stills. The property
that buys is worth the arithmetic — the same bytes under the same filenames land
on the same path, so `SourceService`'s own ``(kind, path, extraction_fps)``
idempotency answers a repeated upload with the *same* `Source` instead of a
second one over a second copy.

**Nothing is buffered whole.** Starlette spools an `UploadFile` to disk past
1 MiB and hands over a plain synchronous file object, so a ``def`` handler reads
it here in chunks straight into the staging file. ``upload.read()`` would undo
that in one line and must not appear in this module.

**Staged uploads are never deleted**, which is the posture blobs already have
(`BlobStore` has no ``delete``). A workspace's disk grows with what was offered
to it, not only with what was kept; ``docs/content/api.md`` says so out loud rather than
implying a cleanup nothing performs.
"""

from __future__ import annotations

import hashlib
import os
import shutil
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Final
from uuid import uuid4

from fastapi import UploadFile

#: Staging root, relative to the workspace directory. Server-owned: the kernel
#: neither writes nor reads it, and `WorkspaceService.open` simply tolerates it
#: the way it tolerates anything else beside the database and ``blobs/``.
UPLOADS_DIRNAME: Final = "uploads"

#: What a part is called when the client sent no usable filename.
FALLBACK_NAME: Final = "upload"

_CHUNK: Final = 1024 * 1024


@dataclass(frozen=True, slots=True)
class StagedUpload:
    """A staged part set: the directory it landed in, and what is in it."""

    directory: Path
    names: tuple[str, ...]

    @property
    def only(self) -> Path:
        """The single staged file, for a route that accepted exactly one."""
        return self.directory / self.names[0]


def safe_name(filename: str | None) -> str:
    """The last component of a client-supplied filename, and nothing else.

    The path-traversal guard, and the only one needed: everything a client sends
    is reduced to a bare name before it is joined to anything. Backslashes are
    folded first because a Windows browser sends ``C:\\Users\\me\\clip.mp4`` in
    that field. A name that survives as empty, as ``.`` or ``..``, or that
    carries a NUL, is replaced rather than refused — a badly named part is not a
    reason to reject an otherwise good upload.
    """
    candidate = PurePosixPath((filename or "").replace("\\", "/")).name.strip()
    if not candidate or candidate in {".", ".."} or "\x00" in candidate:
        return FALLBACK_NAME
    return candidate


def stage(root: Path, uploads: Sequence[UploadFile]) -> StagedUpload:
    """Write every part under ``root`` and return where they landed.

    The parts go into a private ``.staging-<uuid>`` directory first, because the
    name of the final one is not known until every byte has been hashed. The
    rename is what publishes them, so a half-written upload is never a directory
    a source could be registered over.
    """
    uploads_root = root / UPLOADS_DIRNAME
    uploads_root.mkdir(parents=True, exist_ok=True)
    staging = Path(uploads_root / f".staging-{uuid4().hex}")
    staging.mkdir()

    try:
        staged: list[tuple[str, str]] = []
        taken: set[str] = set()
        for upload in uploads:
            name = _unused(safe_name(upload.filename), taken)
            staged.append((name, _write(staging / name, upload)))

        target = uploads_root / _set_digest(staged)
        if target.exists():
            # Already staged by an earlier upload of the same bytes — identical
            # content, so the winner is as good as ours.
            shutil.rmtree(staging)
        else:
            try:
                os.replace(staging, target)
            except OSError:
                # A concurrent upload of the same set won the rename between the
                # check above and here. Same argument, same answer.
                shutil.rmtree(staging, ignore_errors=True)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    return StagedUpload(directory=target, names=tuple(name for name, _ in staged))


def _unused(name: str, taken: set[str]) -> str:
    """``name``, or the next ``name-2``/``name-3`` that is not spoken for.

    Two parts may legitimately arrive under one filename, and a directory source
    reads its files by name — collapsing them would silently drop one. The
    suffix goes before the extension so the file still looks like what it is.
    """
    candidate = name
    stem, dot, suffix = name.partition(".")
    attempt = 1
    while candidate in taken:
        attempt += 1
        candidate = f"{stem}-{attempt}{dot}{suffix}"
    taken.add(candidate)
    return candidate


def _write(path: Path, upload: UploadFile) -> str:
    """Stream one part to ``path``, returning the sha-256 of what was written."""
    digest = hashlib.sha256()
    # Seek first for the reason `ImageProcessor`'s port docstring gives: a handle
    # is read from wherever it sits, and this one has been looked at before.
    upload.file.seek(0)
    with path.open("wb") as out:
        while chunk := upload.file.read(_CHUNK):
            digest.update(chunk)
            out.write(chunk)
    return digest.hexdigest()


def _set_digest(staged: Sequence[tuple[str, str]]) -> str:
    """One digest naming a whole part set — the staging directory's name.

    Sorted, so the order parts arrived in cannot fork one upload into two
    directories. The name is inside the digest as well as the content: a file
    renamed is a different thing to offer a project, and a directory source
    reads its members by name.
    """
    lines = "".join(f"{name}:{content}\n" for name, content in sorted(staged))
    return hashlib.sha256(lines.encode()).hexdigest()
