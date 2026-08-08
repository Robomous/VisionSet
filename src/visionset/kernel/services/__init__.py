"""Application services: the SDK surface every delivery layer calls.

A service orchestrates domain models over ports, and normally never imports an
adapter — with one deliberate exception. ``workspace_service`` is the composition
point where the default adapters are constructed, because something has to name
them, and one place is better than every place. Every public surface it exposes
is port-typed, so nothing above it can reach SQLAlchemy by accident.
"""

from visionset.kernel.services.annotation_service import AnnotationService
from visionset.kernel.services.batch_service import BatchService
from visionset.kernel.services.dataset_service import DatasetService
from visionset.kernel.services.inference_connection_service import InferenceConnectionService
from visionset.kernel.services.ingest_service import IngestService
from visionset.kernel.services.job_service import JobService
from visionset.kernel.services.project_service import ProjectService
from visionset.kernel.services.release_service import EXPORT_REPORT_FILENAME, ReleaseService
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.source_service import SourceService
from visionset.kernel.services.token_service import TokenService
from visionset.kernel.services.workspace_service import (
    BLOBS_DIRNAME,
    DB_FILENAME,
    WORKSPACE_ENV_VAR,
    WorkspaceService,
    resolve_workspace_root,
)

__all__ = [
    "BLOBS_DIRNAME",
    "DB_FILENAME",
    "EXPORT_REPORT_FILENAME",
    "WORKSPACE_ENV_VAR",
    "AnnotationService",
    "BatchService",
    "DatasetService",
    "InferenceConnectionService",
    "IngestService",
    "JobService",
    "ProjectService",
    "ReleaseService",
    "SchemaService",
    "SourceService",
    "TokenService",
    "WorkspaceService",
    "resolve_workspace_root",
]
