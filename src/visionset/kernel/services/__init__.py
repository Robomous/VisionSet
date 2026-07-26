"""Application services: the SDK surface every delivery layer calls.

A service orchestrates domain models over ports, and normally never imports an
adapter — with one deliberate exception. ``workspace_service`` is the composition
point where the default adapters are constructed, because something has to name
them, and one place is better than every place. Every public surface it exposes
is port-typed, so nothing above it can reach SQLAlchemy by accident.
"""

from visionset.kernel.services.project_service import ProjectService
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.workspace_service import (
    BLOBS_DIRNAME,
    DB_FILENAME,
    WorkspaceService,
)

__all__ = [
    "BLOBS_DIRNAME",
    "DB_FILENAME",
    "ProjectService",
    "SchemaService",
    "WorkspaceService",
]
