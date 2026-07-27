"""Domain entities and value objects.

Convention reminders encoded here:
- Entity identity is always a UUID (annotations are never addressed by index).
- Asset content identity is the SHA-256 hash of the bytes.
- Coordinates live in the asset's native reference frame (pixels for images);
  normalization is an exporter concern.
"""

from visionset.kernel.domain.annotation import Annotation, Provenance
from visionset.kernel.domain.asset import Asset
from visionset.kernel.domain.batch import BATCH_TRANSITIONS, Batch, BatchState
from visionset.kernel.domain.dataset import (
    Dataset,
    DatasetChange,
    DatasetMember,
    DatasetOperation,
)
from visionset.kernel.domain.events import (
    AnnotationOperation,
    AnnotationsWritten,
    BatchApproved,
    BatchCompleted,
    DomainEvent,
    IngestCompleted,
    ReleasePublished,
)
from visionset.kernel.domain.geometry import (
    IMPLEMENTED_GEOMETRIES,
    BboxGeometry,
    ClassificationGeometry,
    Geometry,
    PolygonGeometry,
)
from visionset.kernel.domain.ingest import (
    INGEST_TRANSITIONS,
    IngestFailure,
    IngestFailureKind,
    IngestJob,
    IngestResult,
    IngestState,
    ThumbnailBackfill,
)
from visionset.kernel.domain.media import (
    ImageFormat,
    ImageMetadata,
    VideoFrame,
    VideoMetadata,
)
from visionset.kernel.domain.names import normalize_name
from visionset.kernel.domain.partition import (
    BySegments,
    BySize,
    Partition,
    SingleJob,
    partition_assets,
)
from visionset.kernel.domain.project import Project
from visionset.kernel.domain.release import (
    MANIFEST_VERSION,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    Release,
    ReleaseVerification,
    SplitAssignment,
    SplitRecipe,
    assign_split,
    canonical_bytes,
    sha256_hex,
)
from visionset.kernel.domain.schema import (
    AnnotationSchema,
    Attribute,
    AttributeValue,
    GeometryType,
    LabelClass,
)
from visionset.kernel.domain.schema_diff import (
    ChangeKind,
    SchemaChange,
    SchemaDiff,
    diff_classes,
)
from visionset.kernel.domain.source import (
    Source,
    SourceKind,
    VideoProvenance,
    canonical_path,
)
from visionset.kernel.domain.task import (
    ASSET_PROGRESS_TRANSITIONS,
    JOB_TRANSITIONS,
    PROMOTABLE_PROGRESS,
    SETTLED_PROGRESS,
    AnnotationJob,
    AnnotationJobState,
    AssetProgress,
    TaskGroup,
    progress_after_annotating,
)
from visionset.kernel.domain.transitions import require_move
from visionset.kernel.domain.workspace import Workspace

__all__ = [
    "ASSET_PROGRESS_TRANSITIONS",
    "BATCH_TRANSITIONS",
    "IMPLEMENTED_GEOMETRIES",
    "INGEST_TRANSITIONS",
    "JOB_TRANSITIONS",
    "MANIFEST_VERSION",
    "PROMOTABLE_PROGRESS",
    "SETTLED_PROGRESS",
    "Annotation",
    "AnnotationJob",
    "AnnotationJobState",
    "AnnotationOperation",
    "AnnotationSchema",
    "AnnotationsWritten",
    "Asset",
    "AssetProgress",
    "Attribute",
    "AttributeValue",
    "Batch",
    "BatchApproved",
    "BatchCompleted",
    "BatchState",
    "BboxGeometry",
    "BySegments",
    "BySize",
    "ChangeKind",
    "ClassificationGeometry",
    "Dataset",
    "DatasetChange",
    "DatasetMember",
    "DatasetOperation",
    "DomainEvent",
    "Geometry",
    "GeometryType",
    "ImageFormat",
    "ImageMetadata",
    "IngestCompleted",
    "IngestFailure",
    "IngestFailureKind",
    "IngestJob",
    "IngestResult",
    "IngestState",
    "LabelClass",
    "Manifest",
    "ManifestAnnotation",
    "ManifestAsset",
    "Partition",
    "PolygonGeometry",
    "Project",
    "Provenance",
    "Release",
    "ReleasePublished",
    "ReleaseVerification",
    "SchemaChange",
    "SchemaDiff",
    "SingleJob",
    "Source",
    "SourceKind",
    "SplitAssignment",
    "SplitRecipe",
    "TaskGroup",
    "ThumbnailBackfill",
    "VideoFrame",
    "VideoMetadata",
    "VideoProvenance",
    "Workspace",
    "assign_split",
    "canonical_bytes",
    "canonical_path",
    "diff_classes",
    "normalize_name",
    "partition_assets",
    "progress_after_annotating",
    "require_move",
    "sha256_hex",
]
