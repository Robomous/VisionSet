# usage: from tests.fixtures.samples import PROJECT, RELEASE
"""One fully-populated instance of every domain model a surface publishes.

The `tests/fixtures/media.py` precedent: a plain module of module-level values,
no pytest import and no fixtures, so anything may reach for it. It exists for
`tests/cli/test_json_contract.py`, which compares the CLI's JSON projections
against the server's wire models field by field.

**Every optional field is populated.** A sample carrying `None` where a nested
model belongs would let the projection of that nested model go unchecked, which
is exactly the drift the parity gate is for.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from visionset.kernel.domain import (
    AnnotationJob,
    AnnotationJobState,
    AnnotationSchema,
    Asset,
    AssetProgress,
    Attribute,
    Batch,
    BatchState,
    ExportResult,
    GeometryType,
    ImageFormat,
    IngestFailure,
    IngestFailureKind,
    IngestJob,
    IngestState,
    LabelClass,
    Project,
    Release,
    ReleaseVerification,
    Source,
    SourceKind,
    SplitRecipe,
    ThumbnailBackfill,
    VideoMetadata,
    VideoProvenance,
)

_HASH = "0" * 64
_WHEN = datetime(2026, 7, 28, 12, 34, 56, 789012, tzinfo=UTC)

PROJECT = Project(
    id=uuid4(), workspace_id=uuid4(), name="road-signs", description="a sample project"
)

SCHEMA_VERSION = AnnotationSchema(
    project_id=PROJECT.id,
    version=3,
    classes=(
        LabelClass(
            name="sign",
            geometry=GeometryType.BBOX,
            color="#ff0000",
            attributes=(
                Attribute(
                    name="condition",
                    kind="select",
                    required=True,
                    options=("clean", "faded"),
                    default="clean",
                ),
            ),
        ),
    ),
)

SOURCE = Source(
    project_id=PROJECT.id,
    kind=SourceKind.VIDEO,
    path=str(Path("/workspace/incoming/clip.mp4")),
    registered_at=_WHEN,
    capture_params={"lens": "wide"},
    video=VideoProvenance(
        metadata=VideoMetadata(
            width=160, height=120, fps=10.0, duration_seconds=10.0, codec="h264"
        ),
        extraction_fps=5.0,
    ),
)

INGEST_FAILURE = IngestFailure(
    name="notes.txt", kind=IngestFailureKind.UNSUPPORTED, reason="not a recognizable image"
)

BATCH = Batch(
    project_id=PROJECT.id,
    name="clip-5fps",
    state=BatchState.IN_ANNOTATION,
    schema_version=3,
    asset_ids=[uuid4(), uuid4()],
)

INGEST_JOB = IngestJob(
    source_id=SOURCE.id,
    state=IngestState.COMPLETED,
    error=None,
    batch_id=BATCH.id,
    batch_name=BATCH.name,
    processed=2,
    total=3,
    failures=(INGEST_FAILURE,),
)

ASSET = Asset(
    project_id=PROJECT.id,
    content_hash=_HASH,
    uri=str(Path("/workspace/blobs") / _HASH),
    width=160,
    height=120,
    format=ImageFormat.PNG,
    source_id=SOURCE.id,
    frame_index=4,
    frame_timestamp=0.8,
    thumbnail_hash="1" * 64,
)

COUNTS = {
    AssetProgress.UNANNOTATED: 1,
    AssetProgress.ANNOTATED: 2,
    AssetProgress.SKIPPED: 3,
    AssetProgress.REVIEW_PENDING: 4,
    AssetProgress.ACCEPTED: 5,
}

JOB = AnnotationJob(
    task_group_id=uuid4(),
    state=AnnotationJobState.IN_PROGRESS,
    progress=dict.fromkeys(BATCH.asset_ids, AssetProgress.UNANNOTATED),
)

SPLIT = SplitRecipe(train=0.7, val=0.15, test=0.15, seed=42)

RELEASE = Release(
    dataset_id=uuid4(),
    tag="v1.0",
    manifest_hash=_HASH,
    schema_version=3,
    asset_count=2,
    annotation_count=5,
    split=SPLIT,
    created_at=_WHEN,
    visionset_version="0.0.1.dev0",
)

VERIFICATION = ReleaseVerification(
    release_id=RELEASE.id,
    manifest_hash=_HASH,
    manifest_intact=True,
    checked=2,
    missing=("2" * 64,),
    corrupt=("3" * 64,),
    cache_mismatches=("asset_count",),
)

EXPORT_RESULT = ExportResult(
    release_id=RELEASE.id,
    format_name="dummy",
    directory=Path("/workspace/exports/dummy"),
    file_count=7,
    total_bytes=4096,
)

THUMBNAIL_BACKFILL = ThumbnailBackfill(
    project_id=PROJECT.id,
    filled=(uuid4(),),
    missing=(uuid4(),),
    unreadable=(INGEST_FAILURE,),
)
