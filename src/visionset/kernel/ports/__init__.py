"""Ports: ``typing.Protocol`` interfaces the kernel depends on.

Adapters (default ones in ``visionset.kernel.adapters``, plugins elsewhere)
implement these; the kernel never imports an implementation directly.
"""

from visionset.kernel.ports.auth_provider import AuthProvider
from visionset.kernel.ports.blob_store import BlobStore
from visionset.kernel.ports.event_bus import Event, EventBus
from visionset.kernel.ports.exporter import Exporter
from visionset.kernel.ports.importer import Importer
from visionset.kernel.ports.media_processor import MediaProcessor
from visionset.kernel.ports.metadata_store import MetadataStore, Repository, UnitOfWork
from visionset.kernel.ports.model_provider import ModelProvider

__all__ = [
    "AuthProvider",
    "BlobStore",
    "Event",
    "EventBus",
    "Exporter",
    "Importer",
    "MediaProcessor",
    "MetadataStore",
    "ModelProvider",
    "Repository",
    "UnitOfWork",
]
