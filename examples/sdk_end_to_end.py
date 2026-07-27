"""The whole VisionSet cycle in one pass, with nothing but ``import visionset``.

This is M1's exit criterion made executable: an empty directory becomes a
workspace, a project, a labeling contract, six annotated frames, a curated
trunk, and finally a release whose every byte can be re-hashed and checked —
without a server, a CLI, or a single file the repository had to ship.

Run it::

    uv run python examples/sdk_end_to_end.py [DESTINATION]

The images are generated here at runtime, from the standard library alone. That
is not a convenience: VisionSet never commits fixture media, and an example that
makes its own pixels needs no fixture at all. Pillow is a dependency now, and
this deliberately still does not use it — the encoder below is six lines and its
bytes are fixed, which is what keeps the split folds the same on every machine.

**Every step now goes through the service that owns it.** That sentence used to
carry an exception: creating an ``Asset`` had no door, so this file wrote the row
by hand through the same public port a service uses. #20's ``IngestService``
closed it. The frames are written to disk, the directory is registered as a
source, and the ingest hashes them, stores them once and puts them in a batch —
which is what a real caller does with a real folder of photographs.
"""

from __future__ import annotations

import shutil
import struct
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    Asset,
    AssetProgress,
    Attribute,
    AttributeValue,
    BboxGeometry,
    BySize,
    ClassificationGeometry,
    DomainEvent,
    GeometryType,
    LabelClass,
    Manifest,
    PolygonGeometry,
    Release,
    ReleaseVerification,
    SplitAssignment,
    SplitRecipe,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    DatasetService,
    IngestService,
    JobService,
    ProjectService,
    ReleaseService,
    SchemaService,
    SourceService,
    WorkspaceService,
)

#: Where the example puts its workspace unless told otherwise. Under
#: ``workspace-data/``, which the repository ignores by design.
DEFAULT_DEST = Path(__file__).resolve().parent / "workspace-data" / "sdk-e2e"

FRAME_COUNT = 6
FRAME_WIDTH = 64
FRAME_HEIGHT = 48

#: The frame whose bounding box is attributed to a model rather than a person.
MODEL_LABELED_FRAME = 2


# --- the labeling contract ------------------------------------------------

#: Three classes for three geometries. ``LabelClass.geometry`` is singular — a
#: class is bound to exactly one shape — so demonstrating a box, a polygon and a
#: whole-frame tag takes three classes, not one class with three geometries.
CLASSES: tuple[LabelClass, ...] = (
    LabelClass(
        name="stop-sign",
        geometry=GeometryType.BBOX,
        color="#d62828",
        attributes=(
            # The one required attribute: an annotation without it is refused by
            # AnnotationService with MissingRequiredAttribute.
            Attribute(
                name="occlusion",
                kind="select",
                required=True,
                options=("none", "partial", "heavy"),
                default="none",
            ),
            # Optional, with a default a surface can offer. Required and default
            # are independent, which is why both live on the same class here.
            Attribute(name="damaged", kind="boolean", default=False),
        ),
    ),
    LabelClass(name="lane-marking", geometry=GeometryType.POLYGON, color="#f4a261"),
    LabelClass(
        name="weather",
        geometry=GeometryType.CLASSIFICATION_TAG,
        color="#264653",
        attributes=(Attribute(name="condition", kind="select", options=("clear", "rain", "fog")),),
    ),
)

_OCCLUSION = ("none", "partial", "heavy")
_CONDITION = ("clear", "rain", "fog")


@dataclass(frozen=True)
class Summary:
    """What the run produced, for a reader and for the smoke test alike."""

    project_id: UUID
    dataset_id: UUID
    source_id: UUID
    ingest_job_id: UUID
    schema_version: int
    asset_ids: tuple[UUID, ...]
    skipped_asset_id: UUID
    job_count: int
    annotation_count: int
    promoted_asset_ids: tuple[UUID, ...]
    release: Release
    reissue: Release
    manifest: Manifest
    verification: ReleaseVerification
    assignment: SplitAssignment
    events: tuple[str, ...]


# --- synthetic media ------------------------------------------------------


def png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """A solid-color 8-bit truecolor PNG, built from the standard library alone.

    A PNG is a signature followed by length-prefixed, CRC-checked chunks: IHDR
    describes the raster, IDAT carries the zlib-compressed scanlines (each
    prefixed with a filter byte), IEND ends the file. Nothing here is
    VisionSet-specific — it exists so the example can make its own pixels.
    """

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit, truecolor
    scanline = b"\x00" + bytes(rgb) * width  # filter type 0, then the pixels
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(scanline * height, 9))
        + chunk(b"IEND", b"")
    )


def frame_bytes(index: int) -> bytes:
    """Frame ``index``, the same bytes on every machine and every run.

    Derived from the index rather than randomized, and that matters: an asset's
    identity is the SHA-256 of its content, and the split keys on content hash
    too — so which frames land in train, val and test is fixed, run after run.

    The *manifest* hash still changes between runs, and that is correct rather
    than a leak: a manifest names asset and annotation ids, which are fresh
    UUIDs each time. A manifest hash is a snapshot identity, not a universal
    content identity. Within one run, republishing an unchanged trunk reproduces
    it exactly — which is the property step (13) demonstrates.
    """
    return png(FRAME_WIDTH, FRAME_HEIGHT, (40 + index * 30, 90, 200 - index * 20))


# --- offering the frames to the project -----------------------------------


def _write_frames(directory: Path, count: int) -> Path:
    """Put ``count`` generated frames on disk, the way a camera would have.

    Named ``frame-000.png`` upward, because ingest reads a directory in filename
    order and that order becomes the batch's membership order — so the labels
    below can be indexed by position and still mean what they say.
    """
    directory.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        (directory / f"frame-{index:03d}.png").write_bytes(frame_bytes(index))
    return directory


# --- labels ---------------------------------------------------------------


def labels_for(asset: Asset, index: int) -> list[Annotation]:
    """One box, one polygon and one whole-frame tag for a single asset.

    ``schema_version=1`` is a placeholder in every one of them. The field is
    required and ``ge=1``, but ``AnnotationService`` stamps in the version the
    *batch* pinned and discards whatever the caller passed — so a label can
    never claim a contract it was not judged against.
    """
    attributes: dict[str, AttributeValue] = {"occlusion": _OCCLUSION[index % len(_OCCLUSION)]}
    if index == 1:
        # Set on one frame only. 'damaged' is optional, and its default is what a
        # surface would offer rather than something every annotation carries.
        attributes["damaged"] = True

    # One frame's box is a pre-annotation, as a model provider will produce them
    # post-beta (#81). provenance='model' without a model_ref cannot be
    # constructed at all — the domain refuses it, so no service re-checks it.
    by_model = index == MODEL_LABELED_FRAME

    return [
        Annotation(
            asset_id=asset.id,
            label_class="stop-sign",
            schema_version=1,
            geometry=BboxGeometry(x=8.0 + index * 3, y=6.0, width=24.0, height=18.0),
            attributes=attributes,
            provenance="model" if by_model else "human",
            model_ref="demo-detector:0.1" if by_model else None,
            confidence=0.83 if by_model else None,
        ),
        Annotation(
            asset_id=asset.id,
            label_class="lane-marking",
            schema_version=1,
            geometry=PolygonGeometry(
                # Coordinates are always the asset's own pixels, never
                # normalized. Normalizing is an exporter's job, at the boundary.
                points=[(4.0, 44.0), (28.0, 30.0), (36.0, 30.0), (16.0, 46.0)]
            ),
            provenance="human",
        ),
        Annotation(
            asset_id=asset.id,
            label_class="weather",
            schema_version=1,
            geometry=ClassificationGeometry(),
            attributes={"condition": _CONDITION[index % len(_CONDITION)]},
            provenance="human",
        ),
    ]


# --- the cycle ------------------------------------------------------------


def main(dest: Path) -> Summary:
    """Drive an empty directory to a verified release, and report what happened.

    ``dest`` must not already be a workspace: this creates one. Everything the
    run produces lives under it.
    """
    seen: list[DomainEvent] = []

    with WorkspaceService.init(dest, name="sdk-end-to-end") as workspace:
        # (1) Subscriptions are by type, and DomainEvent is the catch-all. Every
        # event below arrives *after* its transaction committed, so a subscriber
        # can never see work that was rolled back — nor cause a rollback.
        workspace.event_bus.subscribe(DomainEvent, seen.append)

        projects = ProjectService(workspace)
        schemas = SchemaService(workspace)
        sources = SourceService(workspace)
        ingest = IngestService(workspace)
        batches = BatchService(workspace)
        jobs = JobService(workspace)
        annotations = AnnotationService(workspace)
        datasets = DatasetService(workspace)
        releases = ReleaseService(workspace)

        # (2) A project and its dataset are created in one transaction: the 1:1
        # trunk exists from the first moment, so there is never a dataset-less
        # project for a later step to trip over.
        project = projects.create("road-signs", description="Synthetic end-to-end demo")
        dataset = projects.get_dataset(project.id)
        _say(f"project {project.name!r} ({project.id}) with dataset {dataset.id}")

        # (3) Version 1 of the labeling contract. Versions are 1..N and are never
        # edited; "active" is derived (the highest), never a stored column.
        schema = schemas.create_version(project.id, CLASSES)
        _say(f"schema v{schema.version}: {', '.join(c.name for c in schema.classes)}")

        # (4) Six generated frames on disk, and the directory holding them
        # registered as where this project's data comes from. Registration does
        # not walk the folder: what is in it is read at ingest, because a count
        # taken now would be stale by the time anything used it.
        incoming = _write_frames(dest / "incoming", FRAME_COUNT)
        source = sources.register_images(project.id, incoming)
        _say(f"source {source.kind.value} registered at {source.path}")

        # (5) Ingest hashes every file, stores the bytes once (content-addressed,
        # so re-running this creates nothing), records what the decoder made of
        # them, and puts the lot in a draft batch. Membership order is ingest
        # order. A batch is the unit of annotation work; in draft it is still
        # editable, and membership freezes at approval.
        ingested = ingest.ingest(source.id, batch_name="batch-001")
        assets = list(ingested.assets)
        batch = batches.get(ingested.batch_id)
        _say(
            f"{ingested.created} assets ingested into batch {batch.name!r} "
            f"({ingested.deduplicated} already known, {ingested.failed} unreadable)"
        )

        # (6) Approval pins the active schema version to the batch forever and
        # cuts it into jobs. The partition is exact: disjoint, and their union is
        # the batch. BySize(3) over six assets gives two jobs of three.
        batch = batches.approve(batch.id, BySize(size=3))
        batch_jobs = batches.jobs(batch.id)
        _say(
            f"batch {batch.name!r} approved against schema v{batch.schema_version}, "
            f"partitioned into {len(batch_jobs)} jobs"
        )

        # (7) Nothing may be written into a batch nobody opened.
        batches.start(batch.id)

        # (8) Do the work. One asset is deliberately skipped rather than labeled:
        # 'skipped' settles the job (it does not block completion) but is not
        # promotable, so it never reaches the trunk.
        skipped_asset_id = assets[-1].id
        written = _annotate(jobs, annotations, batch_jobs, assets, skipped_asset_id)
        _say(f"{written} annotations written; asset {skipped_asset_id} skipped")

        # (9) Completing every job does not complete the batch — BatchService
        # derives that itself, because one state machine in two places is one
        # too many.
        batch = batches.complete(batch.id)

        # (10) Promotion is a union against current membership: idempotent, and
        # it admits only assets whose progress is promotable.
        promoted = datasets.promote(batch.id, actor="sdk_end_to_end")
        _say(f"{len(promoted)} of {len(assets)} assets promoted into the trunk")

        # (11) Freeze it. The recipe is stored, not applied — assignment() cuts
        # the folds on demand from the frozen asset set.
        recipe = SplitRecipe(train=0.6, val=0.2, test=0.2, seed=42)
        release = releases.publish(dataset.id, "v1.0", split=recipe)
        manifest = releases.manifest(release.id)
        _say(
            f"release {release.tag} — {release.asset_count} assets, "
            f"{release.annotation_count} labels, manifest {release.manifest_hash[:12]}…"
        )

        # (12) Re-read and re-hash every blob the manifest names, and cross-check
        # the row's counts against the document.
        verification = releases.verify(release.id)
        _say(f"verified: {verification.checked} blobs, ok={verification.ok}")

        assignment = releases.assignment(release.id)
        _say(
            f"split {recipe.train}/{recipe.val}/{recipe.test} seed {recipe.seed} → "
            f"train {len(assignment.train)}, val {len(assignment.val)}, "
            f"test {len(assignment.test)}"
        )

        # (13) The immutability property, demonstrated rather than asserted: an
        # unchanged trunk published again produces the very same bytes, so both
        # releases name one blob.
        reissue = releases.publish(dataset.id, "v1.1", split=recipe)
        _say(
            f"republished as {reissue.tag}: manifest hash "
            f"{'identical' if reissue.manifest_hash == release.manifest_hash else 'DIFFERENT'}"
        )

        _say(f"events seen, in order: {', '.join(event.name for event in seen)}")

        return Summary(
            project_id=project.id,
            dataset_id=dataset.id,
            source_id=source.id,
            ingest_job_id=ingested.job_id,
            schema_version=schema.version,
            asset_ids=tuple(asset.id for asset in assets),
            skipped_asset_id=skipped_asset_id,
            job_count=len(batch_jobs),
            annotation_count=written,
            promoted_asset_ids=tuple(asset.id for asset in promoted),
            release=release,
            reissue=reissue,
            manifest=manifest,
            verification=verification,
            assignment=assignment,
            events=tuple(event.name for event in seen),
        )


def _annotate(
    jobs: JobService,
    annotations: AnnotationService,
    batch_jobs: list[AnnotationJob],
    assets: list[Asset],
    skipped_asset_id: UUID,
) -> int:
    """Label every asset in every job, except the one to skip. Returns the count."""
    index_of = {asset.id: index for index, asset in enumerate(assets)}
    written = 0
    for job in batch_jobs:
        jobs.start(job.id)
        # next_pending is ordered by the batch's own asset order, not by
        # whatever order the rows happen to sit in.
        for asset in jobs.next_pending(job.id, len(job.progress)):
            if asset.id == skipped_asset_id:
                jobs.mark(job.id, asset.id, AssetProgress.SKIPPED)
                continue
            # Progress moves to 'annotated' as a consequence of the write —
            # nothing has to remember to mark it.
            written += len(annotations.add(job.id, labels_for(asset, index_of[asset.id])))
        jobs.complete(job.id)
    return written


def _say(message: str) -> None:
    print(f"  · {message}")


# --- running it -----------------------------------------------------------


def _clear_previous_run(dest: Path) -> None:
    """Remove a previous run of this example, and refuse to remove anything else.

    Only ever called for :data:`DEFAULT_DEST`. A directory that holds anything
    other than what a workspace holds is not ours to delete, so the example stops
    instead of guessing.
    """
    if not dest.exists():
        return
    if not dest.is_dir():
        raise SystemExit(f"refusing to run: {dest} exists and is not a directory")
    stray = {entry.name for entry in dest.iterdir()} - {"visionset.db", "blobs", "incoming"}
    if stray:
        raise SystemExit(
            f"refusing to remove {dest}: it holds {', '.join(sorted(stray))}, "
            f"which this example did not write"
        )
    shutil.rmtree(dest)


def _run() -> None:
    if len(sys.argv) > 2:
        raise SystemExit(f"usage: {Path(sys.argv[0]).name} [DESTINATION]")
    if len(sys.argv) == 2:
        # A destination someone named is never removed automatically; if it is
        # already a workspace, WorkspaceService says so and stops.
        dest = Path(sys.argv[1]).resolve()
    else:
        dest = DEFAULT_DEST
        _clear_previous_run(dest)

    print(f"VisionSet end-to-end · {dest}")
    summary = main(dest)
    print(
        f"\nDone. {len(summary.promoted_asset_ids)} assets and "
        f"{summary.release.annotation_count} labels released as "
        f"{summary.release.tag} (manifest {summary.release.manifest_hash}).\n"
        f"Workspace left at {dest} — open it again with WorkspaceService.open()."
    )


if __name__ == "__main__":
    _run()
