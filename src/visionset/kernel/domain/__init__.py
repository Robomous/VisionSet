"""Domain entities and value objects.

Convention reminders encoded here:
- Entity identity is always a UUID (annotations are never addressed by index).
- Asset content identity is the SHA-256 hash of the bytes.
- Coordinates live in the asset's native reference frame (pixels for images);
  normalization is an exporter concern.
"""

from visionset.kernel.domain.annotation import Annotation, Provenance
from visionset.kernel.domain.asset import Asset
from visionset.kernel.domain.batch import Batch, BatchState
from visionset.kernel.domain.dataset import Dataset, DatasetChange, DatasetMember
from visionset.kernel.domain.geometry import (
    IMPLEMENTED_GEOMETRIES,
    BboxGeometry,
    ClassificationGeometry,
    Geometry,
    PolygonGeometry,
)
from visionset.kernel.domain.ingest import IngestJob, IngestState
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
from visionset.kernel.domain.task import AnnotationJob, AnnotationJobState, AssetProgress, TaskGroup
from visionset.kernel.domain.workspace import Workspace

__all__ = [
    "IMPLEMENTED_GEOMETRIES",
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
    "ChangeKind",
    "ClassificationGeometry",
    "Dataset",
    "DatasetChange",
    "DatasetMember",
    "Geometry",
    "GeometryType",
    "IngestJob",
    "IngestState",
    "LabelClass",
    "Manifest",
    "PolygonGeometry",
    "Project",
    "Provenance",
    "Release",
    "SchemaChange",
    "SchemaDiff",
    "Source",
    "TaskGroup",
    "Workspace",
    "diff_classes",
]
