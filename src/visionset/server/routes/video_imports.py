# usage: from visionset.server.routes import video_imports
"""Video imports: a session a client streams locally decoded frames into.

**No video ever crosses this wire.** This server holds no decoder, so a clip is
never uploaded, probed or cut here: a client decodes the file on the machine it
already sits on and posts the frames it materialized as ordinary image parts.
What used to be one synchronous upload is therefore a session with a *middle* —
open it, append frames in bounded chunks, then commit the lot or throw it away —
and these five routes are that middle.

Two routers, for the reason ``sources.py`` has two: opening a session hangs off
the project it is for, and the session is addressable on its own afterwards.

**Nothing staged is in the project.** Between the first route and ``commit`` the
frames exist only as blobs and session rows, and no listing, batch or dataset can
see any of them — a client that closes its tab leaves the project exactly as it
was. ``commit`` is the single moment that changes.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
Reading a spooled upload is blocking I/O too.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Final
from uuid import UUID

from fastapi import File, Form, UploadFile, status
from fastapi.exceptions import RequestValidationError
from pydantic import TypeAdapter, ValidationError

from visionset.kernel.domain import IncomingFrame
from visionset.kernel.services import (
    BatchService,
    DatasetService,
    JobService,
    ProjectService,
    VideoImportService,
)
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    BatchOut,
    FrameDescriptor,
    VideoImportOut,
    VideoImportStart,
)

project_router = protected_router(
    prefix="/projects/{project_id}/video-imports", tags=["video imports"]
)
router = protected_router(prefix="/video-imports", tags=["video imports"])

FRAMES_PER_REQUEST: Final = 32
"""How many frame parts one request may carry.

A bound rather than a preference. ``VideoImportService.append_frames`` decodes
the whole chunk before it opens its transaction, so an unbounded request is an
unbounded amount of image data held at once; and one multipart body carrying a
whole extraction is a single point of failure a client has to redo from the
start. Thirty-two frames is half a minute of clip at the default rate — tens of
megabytes at ordinary frame sizes, and often enough that a progress bar moves.
"""

_DESCRIPTORS: Final = TypeAdapter(tuple[FrameDescriptor, ...])


def _promoted(workspace: WorkspaceDep, project_id: UUID) -> frozenset[UUID]:
    """The trunk's current membership, for the batch a commit answers with.

    A third spelling of `routes/batches.py`'s helper rather than an import, on
    the terms `routes/assets.py` states: a route module reaches for
    `dependencies`, `errors` and `models`, never for another route module.
    """
    dataset = ProjectService(workspace).get_dataset(project_id)
    return DatasetService(workspace).member_asset_ids(dataset.id)


def _bytes(upload: UploadFile) -> bytes:
    """One part, read whole.

    ``upload.file`` rather than ``await upload.read()`` because the handler is
    ``def``; the seek is for ``uploads.stage``'s reason — a handle is read from
    wherever it happens to sit.
    """
    upload.file.seek(0)
    return upload.file.read()


def _incoming(files: Sequence[UploadFile], descriptors: str) -> list[IncomingFrame]:
    """The chunk as domain values, or the 422 a request that cannot be one earns.

    `RequestValidationError` rather than a code of its own, for the reason
    `sources.py`'s range parsing used: a multipart field carries a string, and a
    string that will not parse is a malformed request rather than a refusal the
    kernel has an opinion about. The same goes for the two counts disagreeing —
    nothing downstream could pick which array to believe.
    """
    if len(files) > FRAMES_PER_REQUEST:
        raise RequestValidationError(
            [
                {
                    "type": "too_long",
                    "loc": ("body", "files"),
                    "msg": f"send at most {FRAMES_PER_REQUEST} frames per request",
                    "input": len(files),
                }
            ]
        )
    try:
        described = _DESCRIPTORS.validate_json(descriptors)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors()) from exc
    if len(described) != len(files):
        raise RequestValidationError(
            [
                {
                    "type": "value_error",
                    "loc": ("body", "descriptors"),
                    "msg": f"{len(described)} descriptors for {len(files)} frame parts",
                    "input": len(described),
                }
            ]
        )
    return [
        IncomingFrame(**descriptor.model_dump(), content=_bytes(upload))
        for descriptor, upload in zip(described, files, strict=True)
    ]


@project_router.post("", status_code=status.HTTP_201_CREATED, responses=documented(404, 409))
def start_video_import(
    workspace: WorkspaceDep, project_id: UUID, body: VideoImportStart
) -> VideoImportOut:
    """Declare a clip, and open a session to receive the frames cut out of it.

    The body is metadata only: what the caller's decoder read off the container,
    and the cut it is about to materialize. **No video bytes are sent here or
    anywhere else** — this server decodes nothing, so the file stays on the
    machine it is already on.

    `metadata` is recorded as the new source's provenance: what the clip *was*,
    rather than a promise about bytes somebody else can reproduce. Two decoders
    genuinely disagree over the same frame, which is why `materializer` is worth
    naming — it says what produced these ones.

    The one number **not** taken on trust is `expected_frame_count`. `ranges` is
    canonicalized against the declared duration and the grid points are counted
    here, so "every frame arrived" at commit is a fact this server computed
    rather than a claim it was handed. A selection holding no frame at all —
    narrower than one interval at `extraction_fps` — is 422 rather than an empty
    batch nobody meant.

    **Where the frames will land is settled here too**, on the same terms
    `POST /sources/{source_id}/ingest-jobs` settles it. `batch_id` adds them to a
    draft batch that already exists, which is how a second clip joins the first
    one's batch; `batch_name` names a batch the commit will create; passing
    neither uses the clip's own name, and passing both is 422. A `batch_name`
    that is not a name is 422 `INVALID_NAME`, a `batch_id` naming no batch in
    this project is 404 `BATCH_NOT_FOUND` — as is an unknown project, 404
    `PROJECT_NOT_FOUND` — and one naming a batch past `draft` —
    an approved batch has been cut into jobs already — is 409
    `BATCH_NOT_EDITABLE`. Every one of them is answered *here* rather than at
    commit: the alternative is telling somebody their target was unusable after
    they have spent minutes decoding a clip.

    Every import registers a source of its own, so starting twice over one file
    is two sources and never a collision. Identical frames still deduplicate by
    content, which is the only thing that deduplicates them.
    """
    try:
        session = VideoImportService(workspace).start(
            project_id,
            display_name=body.display_name,
            metadata=body.metadata.to_domain(),
            extraction_fps=body.extraction_fps,
            ranges=body.to_ranges(),
            scale_percent=body.scale_percent,
            batch_id=body.batch_id,
            batch_name=body.batch_name,
            materializer=body.materializer,
        )
    except ValueError as exc:
        # An empty selection refuses with a bare ``ValueError`` — outside the
        # ``VisionSetError`` tree, so a 500 — and it is reachable from a body
        # every field bound above accepts. Its own sentence is the 422's message.
        # ``InvalidName`` is not caught here: it is a ``VisionSetError``, mapped.
        raise RequestValidationError(
            [{"type": "value_error", "loc": ("body",), "msg": str(exc), "input": None}]
        ) from exc
    return VideoImportOut.of(session)


@router.get("/{import_id}", responses=documented(404))
def get_video_import(workspace: WorkspaceDep, import_id: UUID) -> VideoImportOut:
    """Where an import has got to.

    The session is its own progress report. `received_frame_count` counts
    *distinct* ordinals rather than appends, so re-sending a frame that is
    already staged never moves it. `state` is `open` until the import ends, and
    both of its ends — `committed` and `aborted` — are final.
    """
    return VideoImportOut.of(VideoImportService(workspace).get(import_id))


@router.post("/{import_id}/frames", responses=documented(404, 409))
def append_video_import_frames(
    workspace: WorkspaceDep,
    import_id: UUID,
    files: Annotated[
        list[UploadFile],
        File(description="The frames, as one multipart part each, PNG."),
    ],
    descriptors: Annotated[
        str,
        Form(
            description=(
                "One entry per part of `files`, in the same order, as a JSON "
                'array of {"ordinal": n, "requested_timestamp": s, '
                '"source_timestamp": s|null, "width": w, "height": h} objects. '
                "`ordinal` is the extraction-grid index, counted from the start "
                "of the clip rather than of the selection. "
                "`requested_timestamp` is the grid point ordinal/extraction_fps; "
                "`source_timestamp` is the presentation time of the sample the "
                "decoder actually drew, or null if it reported none."
            )
        ),
    ],
) -> VideoImportOut:
    """Stage a chunk of materialized frames, and answer the session's progress.

    **A chunk, not a whole extraction**: at most 32 parts per request, and
    beyond that is 422. Send as many requests as the clip needs; they may be
    sent in any order, and the session's frame count is what tracks them.

    A descriptor count that does not match the part count is 422 — the two
    arrays have drifted apart, and nothing here could pick which to believe.

    Every frame is decoded before it is stored, so a part that is not a PNG, or
    one whose bytes disagree with the size its descriptor declares, is 422
    `UNSUPPORTED_MEDIA` and one that will not decode at all is 422
    `CORRUPT_MEDIA`. A descriptor that does not describe its own bytes is not a
    frame with bad metadata; it is evidence a client's grid and this session's
    have diverged, which is worth finding out now rather than in a training run.

    **Re-sending a frame is free.** The same ordinal carrying the same bytes is a
    retry — a chunked upload that lost its connection is the ordinary case — so
    it succeeds, writes nothing, and leaves `received_frame_count` where it was.
    The same ordinal carrying *different* bytes is 409 `FRAME_CONTENT_CONFLICT`:
    abort the import and start again. Appending to an import that has already
    ended is 409 `VIDEO_IMPORT_NOT_OPEN`.

    **`ordinal` is an extraction-grid index**, not a position within the
    selection: it is the frame at `ordinal / extraction_fps` seconds into the
    clip, counted from the clip's start. A session cut from 5 s at 1 fps holds
    5, 6 and 7 — not 0, 1 and 2 — so an index the session's `ranges` do not
    cover is 422 `FRAME_ORDINAL_OUT_OF_RANGE`, whether or not it happens to fall
    below `expected_frame_count`, which is a count of frames and never a bound
    on their indices.
    """
    frames = _incoming(files, descriptors)
    return VideoImportOut.of(VideoImportService(workspace).append_frames(import_id, frames))


@router.post("/{import_id}/commit", responses=documented(404, 409))
def commit_video_import(workspace: WorkspaceDep, import_id: UUID) -> BatchOut:
    """Turn every staged frame into an asset, in one transaction, and answer the batch.

    Refused with 409 `VIDEO_IMPORT_INCOMPLETE` while any expected frame is still
    missing. That gate is the point of the session: a materialization that died
    partway would otherwise produce a batch silently short of a stretch of its
    clip, and nothing downstream could detect it — the assets are perfectly good
    images and the batch looks like any other.

    **Idempotent.** A repeated commit answers the batch the first one created and
    writes nothing, so a client that retried a timed-out request never gets a
    second batch. Committing an import that was aborted is 409
    `VIDEO_IMPORT_NOT_OPEN`, and an import this workspace does not hold is 404
    `VIDEO_IMPORT_NOT_FOUND`.

    The batch is the draft the import named with `batch_id`, if it named one, and
    otherwise one created here — called by the import's `batch_name` if it
    declared one and after its source if not. A target batch that has since been
    deleted is 404 `BATCH_NOT_FOUND` and one approved while the clip was decoding
    is 409 `BATCH_NOT_EDITABLE`; neither falls back to a batch of its own, which
    would put the frames somewhere nobody chose. Two frames with identical bytes
    collapse into one asset — a static shot at 1 fps genuinely yields the same image twice, and
    content addressing has always said so — so `asset_count` can be shorter than
    the frame count, which is the honest report.
    """
    batch = VideoImportService(workspace).commit(import_id)
    return BatchOut.of(
        batch,
        JobService(workspace).batch_progress(batch.id),
        promoted=_promoted(workspace, batch.project_id),
        pre_label_run=BatchService(workspace).latest_pre_label_job(batch.id),
    )


@router.delete(
    "/{import_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=documented(404, 409),
)
def abort_video_import(workspace: WorkspaceDep, import_id: UUID) -> None:
    """Throw the session away: no assets, no batch, nothing left in the project.

    The staged frames go with it. Aborting an import that is already aborted
    changes nothing and still answers 204, because a client cancelling twice
    means the same thing once; aborting a **committed** one is 409
    `VIDEO_IMPORT_NOT_OPEN`, since its frames are assets somebody may already be
    annotating and there is nothing here that could take them back.

    The source stays. It is the record that somebody declared this clip, which an
    abort does not un-declare, and it owns no assets.
    """
    VideoImportService(workspace).abort(import_id)
