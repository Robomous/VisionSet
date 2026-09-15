"""Raw media to an approved, partitioned batch — M2's exit criterion in one pass.

A folder of stills goes in; fifty hash-deduplicated assets in an approved batch of
two jobs come out, with a pollable progress row and a per-file report of what could
not be read. Nothing here is annotated and nothing is released —
[`sdk_end_to_end.py`](sdk_end_to_end.py) covers that half of the cycle. This one is
about where assets *come from*.

Run it::

    uv run python examples/ingest_end_to_end.py [DESTINATION]

Video is not a source this example touches. Importing a video is a **browser**
capability now — Mediabunny decodes it client-side and hands VisionSet PNG frames
it has already materialized, so there is no server-side decoder left to demonstrate
from a script (see [`docs/content/ingest.md`](../docs/content/ingest.md)).

The stills are Pillow's work rather than a hand-rolled PNG encoder: this example
predates no image library, so writing one next to Pillow would be archaeology.
"""

from __future__ import annotations

import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from PIL import Image

from visionset.kernel.domain import (
    Asset,
    AssetProgress,
    BySize,
    DomainEvent,
    GeometryType,
    IngestJob,
    IngestResult,
    LabelClass,
)
from visionset.kernel.services import (
    BatchService,
    IngestService,
    JobService,
    ProjectService,
    SchemaService,
    SourceService,
    WorkspaceService,
)

#: Where the example puts its workspace unless told otherwise. Under
#: ``workspace-data/``, which the repository ignores by design.
DEFAULT_DEST = Path(__file__).resolve().parent / "workspace-data" / "ingest-e2e"

STILL_SIZE = (48, 32)

#: Fifty assets cut into two jobs. The partition is exact — disjoint, and their
#: union is the batch — which ``partition_assets`` guarantees rather than hopes.
PHOTO_COUNT = 50
JOB_SIZE = 25

#: A second folder, shot on a different day: mostly new content, but a couple of
#: frames are byte-identical to ones already in the project. Content addressing
#: collapses those on sight — the same property a video source registered twice
#: at two rates used to demonstrate, without needing a video to do it.
SECOND_FOLDER_NEW = 8
SECOND_FOLDER_OVERLAP = 2

#: What a folder of photographs really looks like: some of it is not a
#: photograph. This file is reported, not skipped — see the ingest report below.
STRAY_FILE = "notes.txt"

#: One class is enough. A batch cannot be approved by a project with no schema —
#: approval pins the active version forever — but this example writes no labels,
#: so the contract only has to exist.
CLASSES: tuple[LabelClass, ...] = (
    LabelClass(name="vehicle", geometries=(GeometryType.BBOX,), color="#2a9d8f"),
)


@dataclass(frozen=True)
class Summary:
    """What the run produced, for a reader and for the smoke test alike."""

    project_id: UUID
    schema_version: int
    source_id: UUID
    batch_id: UUID
    asset_ids: tuple[UUID, ...]
    progress: IngestJob
    job_sizes: tuple[int, ...]
    rerun: IngestResult
    second_source_id: UUID
    second: IngestResult
    asset_count: int
    thumbnailed: int
    events: tuple[str, ...]


# --- synthetic media ------------------------------------------------------


def _pixels(index: int) -> bytes:
    """Deterministic RGB bytes for photo ``index``.

    Same index, same bytes — which is what lets the second folder below reuse a
    couple of indices from the first and get byte-identical overlap without
    copying a file.
    """
    width, height = STILL_SIZE
    return bytes(
        channel
        for y in range(height)
        for x in range(width)
        for channel in ((x * 5 + index * 61) % 256, (y * 7) % 256, (x + y + index * 23) % 256)
    )


def write_stills(directory: Path, indices: list[int], *, stray: bool = False) -> Path:
    """A folder of photographs, one per logical index in ``indices``."""
    directory.mkdir(parents=True, exist_ok=True)
    for position, index in enumerate(indices):
        Image.frombytes("RGB", STILL_SIZE, _pixels(index)).save(
            directory / f"still-{position:03d}.png", format="PNG"
        )
    if stray:
        (directory / STRAY_FILE).write_text("shot on the coast road, tuesday\n")
    return directory


# --- the cycle ------------------------------------------------------------


def main(dest: Path) -> Summary:
    """Drive an empty directory to an approved batch, and report what happened.

    ``dest`` must not already be a workspace: this creates one. Everything the
    run produces lives under it.
    """
    seen: list[DomainEvent] = []

    with WorkspaceService.init(dest, name="ingest-end-to-end") as workspace:
        workspace.event_bus.subscribe(DomainEvent, seen.append)

        projects = ProjectService(workspace)
        schemas = SchemaService(workspace)
        sources = SourceService(workspace)
        ingest = IngestService(workspace)
        batches = BatchService(workspace)
        jobs = JobService(workspace)

        # (1) A project, its 1:1 dataset, and a labeling contract. Nothing here
        # writes a label, but a batch cannot be approved without a schema to pin.
        project = projects.create("dashcam", description="Ingest end-to-end demo")
        schema = schemas.create_version(project.id, CLASSES).published
        _say(f"project {project.name!r} ({project.id}) with schema v{schema.version}")

        # (2) A folder of fifty photographs, plus a file that is not one. A
        # directory can be listed, so the job states its total before the first
        # file — and the file that is not an image is reported rather than
        # skipped, because guessing which files an operator meant to offer is a
        # policy the kernel would be inventing.
        incoming = write_stills(dest / "incoming", list(range(PHOTO_COUNT)), stray=True)
        source = sources.register_images(project.id, incoming)
        ingested = ingest.ingest(source.id, batch_name="photos")
        progress = ingest.get(ingested.job_id)
        reported = ", ".join(
            f"{Path(failure.name).name} ({failure.kind.value}: {failure.reason})"
            for failure in ingested.failures
        )
        _say(
            f"directory: {progress.processed} of {progress.total} read, "
            f"{ingested.created} created, {ingested.failed} reported — {reported}"
        )

        batch = batches.get(ingested.batch_id)
        _say(f"{ingested.created} assets in batch {batch.name!r} ({batch.state.value})")

        # (3) Approval freezes membership, pins the schema version forever, and
        # cuts the batch into jobs. The partition is exact — disjoint, union is
        # the batch — which is a domain guarantee, not a service's arithmetic.
        batch = batches.approve(batch.id, BySize(size=JOB_SIZE))
        batch_jobs = batches.jobs(batch.id)
        outstanding = jobs.batch_progress(batch.id)[AssetProgress.UNANNOTATED]
        _say(
            f"approved against schema v{batch.schema_version} into {len(batch_jobs)} jobs "
            f"of {'/'.join(str(len(job.progress)) for job in batch_jobs)}; "
            f"{outstanding} assets awaiting an annotator"
        )

        # (4) The idempotency property, demonstrated rather than asserted: the
        # same source ingested again creates nothing at all. It lands in a new
        # batch because the first one froze at approval — a batch is an
        # ephemeral unit of work and two may name the same assets.
        rerun = ingest.ingest(source.id, batch_name="photos-again")
        _say(
            f"re-ingested: {rerun.created} created, {rerun.deduplicated} already known "
            f"(same assets: {set(rerun.asset_ids) == set(ingested.asset_ids)})"
        )

        # (5) A second folder is a different source — but identity is content,
        # not origin: a couple of its frames are byte-identical to ones the
        # project already has, and content addressing collapses them on sight.
        second_dir = write_stills(
            dest / "incoming-2",
            [*range(SECOND_FOLDER_OVERLAP), *range(PHOTO_COUNT, PHOTO_COUNT + SECOND_FOLDER_NEW)],
        )
        second_source = sources.register_images(project.id, second_dir)
        second = ingest.ingest(second_source.id, batch_name="photos-2")
        _say(
            f"a second folder ({second_source.id} ≠ {source.id}): "
            f"{second.created} new, {len(second.assets) - second.created} already known"
        )

        # (6) Every asset got a preview at ingest, cached in the same blob store
        # as its content. A thumbnail hash is a cache key and not an identity:
        # it is in no release manifest, and nothing recomputes it to verify one.
        everything = _all_assets(ingested, rerun, second)
        thumbnailed = sum(1 for asset in everything.values() if asset.thumbnail_hash is not None)
        _say(f"{thumbnailed} of {len(everything)} assets carry a cached preview")

        _say(f"events seen, in order: {', '.join(event.name for event in seen)}")

        return Summary(
            project_id=project.id,
            schema_version=schema.version,
            source_id=source.id,
            batch_id=batch.id,
            asset_ids=ingested.asset_ids,
            progress=progress,
            job_sizes=tuple(len(job.progress) for job in batch_jobs),
            rerun=rerun,
            second_source_id=second_source.id,
            second=second,
            asset_count=len(everything),
            thumbnailed=thumbnailed,
            events=tuple(event.name for event in seen),
        )


def _all_assets(*results: IngestResult) -> dict[UUID, Asset]:
    """Every distinct asset the run produced, keyed by id.

    Three ingests over two sources, and only fifty-eight assets between them —
    which is the point. A dict rather than a list because the runs overlap by
    design, and counting the overlap twice would describe a project that does
    not exist.
    """
    return {asset.id: asset for result in results for asset in result.assets}


def _say(message: str) -> None:
    print(f"  · {message}")


# --- running it -----------------------------------------------------------


def _clear_previous_run(dest: Path) -> None:
    """Remove a previous run of this example, and refuse to remove anything else.

    Only ever called for :data:`DEFAULT_DEST`. A directory that holds anything
    other than what this example writes is not ours to delete, so it stops
    instead of guessing.
    """
    if not dest.exists():
        return
    if not dest.is_dir():
        raise SystemExit(f"refusing to run: {dest} exists and is not a directory")
    # The two ``-wal``/``-shm`` entries are SQLite's WAL sidecars. A clean close
    # removes them, so they are only here if a previous run was killed — which
    # is exactly when this function has to be able to clean up.
    ours = {
        "visionset.db", "visionset.db-wal", "visionset.db-shm",
        "blobs", "incoming", "incoming-2",
    }  # fmt: skip
    stray = {entry.name for entry in dest.iterdir()} - ours
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

    print(f"VisionSet ingest end-to-end · {dest}")
    summary = main(dest)
    print(
        f"\nDone. {len(summary.asset_ids)} assets from a folder of {PHOTO_COUNT} stills, "
        f"{summary.asset_count} in the project altogether.\n"
        f"Workspace left at {dest} — open it again with WorkspaceService.open()."
    )


if __name__ == "__main__":
    _run()
