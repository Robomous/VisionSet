# usage: from tests.fixtures.samples import PROJECT, RELEASE
"""One fully-populated instance of every domain model a surface publishes.

The `tests/fixtures/media.py` precedent: a plain module of module-level values,
no pytest import and no fixtures, so anything may reach for it. It exists for
`tests/cli/test_json_contract.py`, which compares `visionset.wire`'s JSON
projections against the server's wire models field by field.

**Every optional field is populated.** A sample carrying `None` where a nested
model belongs would let the projection of that nested model go unchecked, which
is exactly the drift the parity gate is for.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationJobState,
    AnnotationSchema,
    Asset,
    AssetProgress,
    Attribute,
    Batch,
    BatchState,
    BboxGeometry,
    ChangeKind,
    ClassCompatibility,
    ClassCount,
    ClassExportStatus,
    ClassificationGeometry,
    Dataset,
    DatasetStats,
    ExportCompatibility,
    ExportResult,
    GeometryType,
    ImageFormat,
    IngestFailure,
    IngestFailureKind,
    IngestJob,
    IngestState,
    LabelClass,
    PolygonGeometry,
    Project,
    Release,
    ReleaseVerification,
    SchemaChange,
    SchemaDiff,
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
    # Both populated on purpose: a sample carrying ``None`` where a real value
    # belongs lets that half of the projection go unchecked, and ``created_at``
    # is the one field in this model whose two spellings can disagree — the wire
    # writes it as text and the round-trip gate is what catches a drifting format.
    description="added the faded condition",
    created_at=_WHEN,
)

DATASET = Dataset(
    id=uuid4(), project_id=PROJECT.id, name="road-signs", description="a sample project"
)

SCHEMA_DIFF = SchemaDiff(
    changes=(
        SchemaChange(
            kind=ChangeKind.ADDITIVE,
            label_class="pedestrian",
            attribute=None,
            detail="class added",
        ),
        SchemaChange(
            kind=ChangeKind.DESTRUCTIVE,
            label_class="sign",
            attribute="condition",
            detail="attribute removed",
        ),
    ),
)

SOURCE = Source(
    project_id=PROJECT.id,
    kind=SourceKind.VIDEO,
    path=str(Path("/workspace/incoming/clip.mp4")),
    # Fully populated, per this module's rule: a ``None`` here would let the
    # display-name half of the wire projections go unchecked.
    display_name="dashcam morning run",
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
    # Populated, like every other optional field here: a null would let the
    # timestamp's encoding go unchecked, and the two spellings of a moment
    # (`_output.moment` is human, `wire._moment` is parity) are exactly the pair
    # a key-set comparison cannot tell apart.
    ingested_at=datetime(2026, 8, 3, 12, 30, 45, 123456, tzinfo=UTC),
)

COUNTS = {
    AssetProgress.UNANNOTATED: 1,
    AssetProgress.ANNOTATED: 2,
    AssetProgress.SKIPPED: 3,
    AssetProgress.REVIEW_PENDING: 4,
    AssetProgress.ACCEPTED: 5,
}

# Settled progress, so ``allowed_actions`` comes out non-empty: an in-progress job
# whose assets are all unannotated declares nothing, and a projection checked only
# against an empty list is a projection nobody checked.
JOB = AnnotationJob(
    task_group_id=uuid4(),
    state=AnnotationJobState.IN_PROGRESS,
    progress=dict.fromkeys(BATCH.asset_ids, AssetProgress.ANNOTATED),
)

BBOX = BboxGeometry(x=1.5, y=2.5, width=30.0, height=40.0)
POLYGON = PolygonGeometry(points=[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)])
CLASSIFICATION = ClassificationGeometry()

# Every geometry variant gets its own sample rather than one standing for the
# union: they are three components on the wire, and a projection that dropped
# `points` would still round-trip through the bbox model.
GEOMETRIES = (BBOX, POLYGON, CLASSIFICATION)

ANNOTATION = Annotation(
    asset_id=ASSET.id,
    label_class="sign",
    schema_version=3,
    geometry=BBOX,
    attributes={"condition": "faded"},
    provenance="model",
    model_ref="yolo-v8n@1",
    confidence=0.87,
)

DATASET_STATS = DatasetStats(
    dataset_id=DATASET.id,
    asset_count=2,
    annotated_asset_count=1,
    annotation_count=5,
    per_class=(ClassCount(label_class="sign", annotations=5, assets=1),),
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

EXPORT_COMPATIBILITY = ExportCompatibility(
    release_id=RELEASE.id,
    format_name="dummy",
    compatible=False,
    format_is_lossy=True,
    excluded_annotations=3,
    excluded_assets=1,
    degraded_annotations=4,
    degraded_assets=2,
    # One class per `ClassExportStatus`, deliberately: a sample carrying only two
    # of the three would leave the third's projection unchecked by every parity
    # gate that reads this module, which is the same argument the file's own
    # docstring makes about a `None` where a nested model belongs.
    classes=(
        ClassCompatibility(
            label_class="lane",
            geometry=GeometryType.POLYGON,
            status=ClassExportStatus.DEGRADED,
            annotations=4,
            assets=2,
            reason="dummy writes a polygon as its bounding box; the shape is lost",
        ),
        ClassCompatibility(
            label_class="sign",
            geometry=GeometryType.BBOX,
            status=ClassExportStatus.SUPPORTED,
            annotations=2,
            assets=2,
        ),
        ClassCompatibility(
            label_class="weather",
            geometry=GeometryType.CLASSIFICATION_TAG,
            status=ClassExportStatus.DROPPED,
            annotations=3,
            assets=1,
            reason="dummy cannot place a classification_tag and drops it",
        ),
    ),
)

EXPORT_RESULT = ExportResult(
    release_id=RELEASE.id,
    format_name="dummy",
    compatibility=EXPORT_COMPATIBILITY,
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
