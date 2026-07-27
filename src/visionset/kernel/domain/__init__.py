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
from visionset.kernel.domain.geometry import (
    IMPLEMENTED_GEOMETRIES,
    BboxGeometry,
    ClassificationGeometry,
    Geometry,
    PolygonGeometry,
)
from visionset.kernel.domain.ingest import IngestJob, IngestState
from visionset.kernel.domain.names import normalize_name
from visionset.kernel.domain.partition import (
    BySegments,
    BySize,
    Partition,
    SingleJob,
    partition_assets,
)
from visionset.kernel.domain.project import Project
from visionset.kernel.domain.release import Manifest, Release
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
from visionset.kernel.domain.source import Source
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
from visionset.kernel.domain.workspace import Workspace

__all__ = [
    "ASSET_PROGRESS_TRANSITIONS",
    "BATCH_TRANSITIONS",
    "IMPLEMENTED_GEOMETRIES",
    "JOB_TRANSITIONS",
    "PROMOTABLE_PROGRESS",
    "SETTLED_PROGRESS",
    "Annotation",
    "AnnotationJob",
    "AnnotationJobState",
    "AnnotationSchema",
    "Asset",
    "AssetProgress",
    "Attribute",
    "AttributeValue",
    "Batch",
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
    "Geometry",
    "GeometryType",
    "IngestJob",
    "IngestState",
    "LabelClass",
    "Manifest",
    "Partition",
    "PolygonGeometry",
    "Project",
    "Provenance",
    "Release",
    "SchemaChange",
    "SchemaDiff",
    "SingleJob",
    "Source",
    "TaskGroup",
    "Workspace",
    "diff_classes",
    "normalize_name",
    "partition_assets",
    "progress_after_annotating",
]
