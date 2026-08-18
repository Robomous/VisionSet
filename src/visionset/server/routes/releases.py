# usage: from visionset.server.routes import releases
"""Releases: freezing a dataset, checking one, and handing it to a format plugin.

Two routers, the ``sources.py`` split — publishing and listing hang off the
dataset, and a release is addressable on its own.

**The manifest download is raw bytes off the blob store**, not
``ReleaseService.manifest()`` re-serialized. A manifest is hash-pinned evidence
and the whole promise is that publishing twice from an unchanged dataset gives
byte-identical documents; parsing one and dumping it again would put this
build's JSON encoder between a client and the bytes the hash is *of*.

**Export is queued, not synchronous**: the caller gets a background-job row to
poll. The refusals a *request* can make are still made on the request, and only
the work moved. See ``export_release``.

The exporter is resolved *here* rather than in the kernel. ``ReleaseService``
takes an ``Exporter`` instance because import-linter forbids the kernel from
importing ``visionset.formats`` at all, so a delivery module is the only place a
name can become an implementation. Reaching it through a dependency rather than
a direct import is what lets a test substitute one.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from typing import Annotated, Any, Final
from uuid import UUID

from fastapi import Query, Response, status
from fastapi.responses import StreamingResponse

from visionset.formats.registry import pick
from visionset.jobs.export import JOB_TYPE as export_job_type
from visionset.jobs.export import payload_for as export_payload_for
from visionset.kernel.domain import BackgroundJobSpec
from visionset.kernel.services import ReleaseService
from visionset.server.dependencies import (
    ExportersDep,
    RunnerDep,
    WorkspaceDep,
    protected_router,
)
from visionset.server.errors import documented
from visionset.server.models import (
    BackgroundJobOut,
    ExportCompatibilityOut,
    ReleaseCreate,
    ReleaseOut,
    ReleasePage,
    ReleaseVerificationOut,
    SplitAssignmentOut,
)

project_router = protected_router(prefix="/datasets/{dataset_id}/releases", tags=["releases"])
router = protected_router(prefix="/releases", tags=["releases"])

#: A manifest is one JSON document that is already in memory-sized reach, but it
#: is streamed anyway — it names every asset and every label of a fifty-thousand
#: item release, and there is no size at which reading it whole becomes the right
#: answer for a route that only forwards it.
_MANIFEST_RESPONSE: Final[dict[int | str, dict[str, Any]]] = {
    200: {
        "content": {"application/json": {"schema": {}}},
        "description": "The canonical manifest document, byte for byte.",
    }
}

FormatQuery = Annotated[
    str,
    Query(description="Which installed format to write. `GET /formats` lists them."),
]

#: A gate, so it is a query parameter and the route never pre-checks it — the
#: flag goes to the service and the kernel's own refusal carries the code. A
#: third word beside `confirm` and `allow_destructive` because it guards a third
#: thing: not destroying data, not narrowing a contract, but emitting an
#: incomplete copy of something that stays intact.
AllowLossyQuery = Annotated[
    bool,
    Query(description="Required when the format cannot carry everything the release holds."),
]


@project_router.post("", status_code=status.HTTP_201_CREATED, responses=documented(404, 409))
def publish_release(workspace: WorkspaceDep, dataset_id: UUID, body: ReleaseCreate) -> ReleaseOut:
    """Freeze the trunk as it stands into an immutable, named snapshot.

    What is frozen is the content: every member asset, every annotation on it as
    it was, and the schema version those labels were judged against. Deleting an
    annotation afterwards cannot reach backwards into a published release.

    Publishing twice from an unchanged dataset produces byte-identical manifests
    and therefore the same `manifest_hash`, because nothing time-, machine- or
    identity-specific goes inside the document. The tag, the timestamp and the
    build live on the release row instead.

    `split` is stored as a recipe, not materialized. `GET
    /releases/{release_id}/assignment` cuts the folds on demand, deterministically
    and from the frozen asset set. Fractions must sum to 1.0.

    Tags are unique per dataset and **case-sensitive**, like a git tag: `v1.0` and
    `V1.0` are two releases, and reusing one is 409 `RELEASE_TAG_TAKEN`. A dataset
    with no assets is 409 `EMPTY_RELEASE`; zero *annotations* is fine, since
    unlabeled images are legitimate training data. A project with no schema is 404
    `SCHEMA_NOT_FOUND`, because there is no version to pin, and an unknown dataset
    is 404 `DATASET_NOT_FOUND`.

    One refusal is about the labels rather than about the request: an annotation
    carrying a coordinate canonical JSON cannot express — a NaN or an infinity —
    is 409 `UNSERIALIZABLE_MANIFEST`, and the message names it. Nothing is
    published, because writing that value as `null` would lose it silently and
    writing it as `NaN` would produce a manifest no other tool can read. The
    remedy is to correct the annotation and publish again.
    """
    release = ReleaseService(workspace).publish(
        dataset_id, body.tag, split=None if body.split is None else body.split.to_domain()
    )
    return ReleaseOut.of(release)


@project_router.get("", responses=documented(404))
def list_releases(workspace: WorkspaceDep, dataset_id: UUID) -> ReleasePage:
    """Every release of that dataset, oldest first."""
    found = ReleaseService(workspace).list(dataset_id)
    return ReleasePage(items=[ReleaseOut.of(release) for release in found], total=len(found))


@router.get("/{release_id}", responses=documented(404))
def get_release(workspace: WorkspaceDep, release_id: UUID) -> ReleaseOut:
    """The release with that id.

    `schema_version`, `asset_count` and `annotation_count` are a read cache of
    facts that also live inside the manifest, kept out here so listing a
    dataset's releases does not open a blob per row. `verify` is what cross-checks
    them.
    """
    return ReleaseOut.of(ReleaseService(workspace).get(release_id))


@router.get(
    "/{release_id}/manifest",
    response_class=StreamingResponse,
    response_model=None,
    responses={**documented(404), **_MANIFEST_RESPONSE},
)
def get_release_manifest(workspace: WorkspaceDep, release_id: UUID) -> StreamingResponse:
    """The frozen document itself, byte for byte.

    Streamed straight off the blob store rather than parsed and re-serialized, so
    what arrives hashes to `manifest_hash` — which is the point of a hash-pinned
    artifact and would not survive a round trip through this build's JSON encoder.

    Cached forever and never revalidated: the document is named by its own digest,
    so these bytes cannot change. The `ETag` is that digest.
    """
    releases = ReleaseService(workspace)
    release = releases.get(release_id)
    return StreamingResponse(
        releases.open_manifest(release),
        media_type="application/json",
        headers={
            "ETag": f'"{release.manifest_hash}"',
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


@router.get("/{release_id}/verify", responses=documented(404))
def verify_release(workspace: WorkspaceDep, release_id: UUID) -> ReleaseVerificationOut:
    """Re-read and re-hash everything this release names.

    A report rather than a verdict, because "is this still intact?" has more than
    two useful answers and somebody looking at a damaged workspace needs the list.
    `missing` and `corrupt` are never merged: a blob that is gone was deleted out
    from under us, while one whose bytes no longer hash to its own name was
    altered in place, and the remedies differ.

    `manifest_intact` is settled first. When it is false, `checked` is zero and
    every list is empty — an altered document is not an inventory worth walking.

    `cache_mismatches` is where the release row disagrees with the document it
    names. Anything in it is a bug in this build rather than damage.

    A GET because it changes nothing, but it is not free: it reads every blob the
    release names.
    """
    return ReleaseVerificationOut.of(ReleaseService(workspace).verify(release_id))


@router.get("/{release_id}/assignment", responses=documented(404))
def get_release_assignment(workspace: WorkspaceDep, release_id: UUID) -> SplitAssignmentOut:
    """Materialize the release's split recipe into train/val/test folds.

    Computed from the frozen manifest, never from the dataset as it stands today —
    reading live membership would let a curator change a published release's folds
    by editing the trunk afterwards.

    Deterministic, and keyed on each asset's *content hash* rather than its id, so
    identical bytes land in the same fold and cannot straddle a train/test
    boundary. Nothing is stored; asking twice gives the same answer.

    A release published without a recipe is 404 `NO_SPLIT_RECIPE`. That is not a
    defect in the release: no recipe means one undivided set, and answering
    all-train would be indistinguishable from a real recipe that said so. An
    unknown release is the other 404, `RELEASE_NOT_FOUND` — the code is what
    tells "there is no such release" from "that release divides into one fold".
    """
    return SplitAssignmentOut.of(ReleaseService(workspace).assignment(release_id))


@router.get("/{release_id}/export-compatibility", responses=documented(404))
def check_export(
    workspace: WorkspaceDep,
    exporters: ExportersDep,
    release_id: UUID,
    format: FormatQuery,
) -> ExportCompatibilityOut:
    """Say what the named format would drop from this release, without writing anything.

    The pre-flight for `POST /releases/{release_id}/export`: same release, same
    format name, same document the export refuses with and writes into its own
    output. A client showing a consent dialog asks this first; one that would
    rather find out by being refused does not have to.

    `compatible` is the answer. It is not the same question as the format's
    `lossy` flag, which `GET /formats` publishes: that is the format's blanket
    statement about everything a capability list cannot see, while this is about
    the labels *this* release actually holds. Export asks for `allow_lossy=true`
    when either says so.

    A GET because it writes nothing and answers the same thing every time — a
    release is immutable, so this response is as stable as the release is.
    """
    return ExportCompatibilityOut.of(
        ReleaseService(workspace).check_export(release_id, pick(exporters, format))
    )


@router.post(
    "/{release_id}/export",
    status_code=status.HTTP_202_ACCEPTED,
    responses=documented(404, 409),
)
def export_release(
    workspace: WorkspaceDep,
    exporters: ExportersDep,
    runner: RunnerDep,
    response: Response,
    release_id: UUID,
    format: FormatQuery,
    allow_lossy: AllowLossyQuery = False,
) -> BackgroundJobOut:
    """Queue the release for writing, and answer at once with the job to poll.

    **202, not 200, and this is a breaking change to this one endpoint.** It used
    to block until the exporter finished and answer with the archive. A real
    exporter walks every asset in a release and copies its bytes, which is
    minutes of work behind a request that has no way to report progress and every
    proxy's timeout in front of it. So this now follows the launch-and-poll
    contract the ingest routes have always used: poll
    `GET /background-jobs/{id}` — the `Location` header names it — until `state`
    is `succeeded`, then `GET /background-jobs/{id}/artifact` for the archive.

    **Everything a caller can be told now is still told now.** Which formats
    exist is a property of this deployment — `GET /formats` lists what is
    installed — and an unknown name is 404 `EXPORT_FORMAT_NOT_FOUND` on this
    request. A format that cannot carry everything the release holds is 409
    `LOSSY_EXPORT_NOT_CONSENTED` on this request too, and retrying is the
    identical call plus `allow_lossy=true`. An unknown release is 404
    `RELEASE_NOT_FOUND`. None of the three creates a job, so a caller holding a
    job id holds one that will run.

    A POST because it does work and writes files, though it changes nothing a
    later read can see: the release is immutable, and re-exporting overwrites the
    previous archive.
    """
    # ``pick`` rather than ``exporters[format]``: a ``KeyError`` is outside the
    # ``VisionSetError`` tree and would answer 500 to a caller who mistyped a
    # format name. One wording for the refusal, and it lives in the registry.
    exporter = pick(exporters, format)
    # Synchronously, before the job exists: a refusal a request can make is a
    # refusal the request makes. Discovering the consent gate in a
    # worker would put a 409 on a row somebody has to go and read. The worker
    # checks again; that one is the guarantee, this one is the answer.
    ReleaseService(workspace).require_export_consent(release_id, exporter, allow_lossy=allow_lossy)
    job = workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=export_job_type,
            payload=export_payload_for(release_id, format, allow_lossy=allow_lossy),
            idempotent=True,
        )
    )
    runner.wake()
    response.headers["Location"] = f"/background-jobs/{job.id}"
    return BackgroundJobOut.of(job)
