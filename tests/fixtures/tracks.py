# usage: from tests.fixtures.tracks import TrackWorld, track_world
"""A workspace holding one clip, two open jobs and a track, for the surface tests.

Built through the SDK on a workspace that already exists, then closed, so each
surface's test drives the rest through its own transport. The clip has six
distinct frames; the batch is cut into two jobs of three, so positions 0-2 sit
in ``jobs[0]`` and 3-5 in ``jobs[1]``. ``track`` is a ``car`` track observing
positions 0 and 1. Unobserved ``car`` boxes wait at positions 2 and 3, and a
``van`` box at position 2, for a test to observe.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from uuid import UUID

from PIL import Image

from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    BboxGeometry,
    BySize,
    GeometryType,
    IncomingFrame,
    LabelClass,
    VideoMetadata,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    JobService,
    ProjectService,
    SchemaService,
    SourceService,
    TrackService,
    VideoImportService,
    WorkspaceService,
)

SIZE = (16, 12)
FRAMES = 6
PROJECT = "clips"


@dataclass(frozen=True)
class TrackWorld:
    project: str
    source: str
    stills: str
    batch: str
    jobs: tuple[str, str]
    occurrences: tuple[str, ...]
    assets: tuple[str, ...]
    track: str
    observed: tuple[str, str]
    spare: dict[int, str]
    van: str


def _jpeg(seed: int) -> bytes:
    width, height = SIZE
    pixels = bytes(
        channel
        for y in range(height)
        for x in range(width)
        for channel in ((x * 7 + seed * 13) % 256, (y * 5 + seed * 29) % 256, (seed * 47) % 256)
    )
    buffer = BytesIO()
    Image.frombytes("RGB", SIZE, pixels).save(buffer, format="JPEG", quality=95)
    return buffer.getvalue()


def _box(
    annotations: AnnotationService, job: AnnotationJob, asset_id: UUID, label_class: str
) -> UUID:
    return annotations.add(
        job.id,
        [
            Annotation(
                asset_id=asset_id,
                label_class=label_class,
                schema_version=1,
                geometry=BboxGeometry(x=1.0, y=1.0, width=5.0, height=5.0),
                provenance="human",
            )
        ],
    )[0].id


def track_world(root: Path, scratch: Path) -> TrackWorld:
    """Populate the workspace at ``root``; ``scratch`` holds an empty stills folder."""
    workspace = WorkspaceService.open(root)
    try:
        project = ProjectService(workspace).create(PROJECT)
        SchemaService(workspace).create_version(
            project.id,
            [
                LabelClass(name="car", geometries=(GeometryType.BBOX,)),
                LabelClass(name="van", geometries=(GeometryType.BBOX,)),
            ],
        )
        imports = VideoImportService(workspace)
        session = imports.start(
            project.id,
            display_name="clip.webm",
            metadata=VideoMetadata(
                width=SIZE[0], height=SIZE[1], fps=30.0, duration_seconds=FRAMES, codec="vp9"
            ),
            extraction_fps=1.0,
            materializer="mediabunny/1.56.1",
            batch_name="clip",
        )
        imports.append_frames(
            session.id,
            [
                IncomingFrame(
                    ordinal=n,
                    requested_timestamp=float(n),
                    source_timestamp=None,
                    width=SIZE[0],
                    height=SIZE[1],
                    content=BytesIO(_jpeg(n)),
                )
                for n in range(FRAMES)
            ],
        )
        batch = imports.commit(session.id)
        source_id = imports.get(session.id).source_id
        occurrences = SourceService(workspace).occurrences(source_id)

        batches, jobs = BatchService(workspace), JobService(workspace)
        batches.approve(batch.id, BySize(size=3))
        batches.start(batch.id)
        opened = []
        for job in batches.jobs(batch.id):
            jobs.start(job.id)
            opened.append(jobs.get(job.id))
        first, second = sorted(opened, key=lambda j: occurrences[0].asset_id not in j.progress)
        for o in occurrences:
            holder = first if o.position < 3 else second
            assert o.asset_id in holder.progress, "the jobs did not cut the clip in position order"

        annotations = AnnotationService(workspace)
        tracks = TrackService(workspace)
        created = tracks.create(source_id, "car").track
        observed = []
        for position in (0, 1):
            box = _box(annotations, first, occurrences[position].asset_id, "car")
            tracks.observe(first.id, created.id, occurrences[position].id, box)
            observed.append(str(box))
        spare = {
            2: str(_box(annotations, first, occurrences[2].asset_id, "car")),
            3: str(_box(annotations, second, occurrences[3].asset_id, "car")),
        }
        van = str(_box(annotations, first, occurrences[2].asset_id, "van"))

        (scratch / "stills").mkdir(parents=True, exist_ok=True)
        stills = SourceService(workspace).register_images(project.id, scratch / "stills")

        return TrackWorld(
            project=PROJECT,
            source=str(source_id),
            stills=str(stills.id),
            batch=str(batch.id),
            jobs=(str(first.id), str(second.id)),
            occurrences=tuple(str(o.id) for o in occurrences),
            assets=tuple(str(o.asset_id) for o in occurrences),
            track=str(created.id),
            observed=(observed[0], observed[1]),
            spare=spare,
            van=van,
        )
    finally:
        workspace.close()
