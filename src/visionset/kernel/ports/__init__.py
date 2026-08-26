"""Ports: ``typing.Protocol`` interfaces the kernel depends on.

Adapters (default ones in ``visionset.kernel.adapters``, plugins elsewhere)
implement these; the kernel never imports an implementation directly.
"""

from visionset.kernel.ports.auth_provider import AuthProvider
from visionset.kernel.ports.blob_store import BlobStore
from visionset.kernel.ports.event_bus import EventBus
from visionset.kernel.ports.exporter import (
    ContentReader,
    Exporter,
    resolve_target,
    validate_installed,
    validate_targets,
)
from visionset.kernel.ports.image_processor import (
    DEFAULT_THUMBNAIL_MAX_EDGE,
    THUMBNAIL_FORMAT,
    ImageProcessor,
)
from visionset.kernel.ports.importer import Importer
from visionset.kernel.ports.job_queue import JobQueue
from visionset.kernel.ports.metadata_store import (
    UNINITIALIZED,
    MetadataStore,
    Repository,
    UnitOfWork,
)
from visionset.kernel.ports.model_provider import ModelProvider
from visionset.kernel.ports.point_segmenter import PointSegmenter
from visionset.kernel.ports.preprocessing import PreprocessingDriver
from visionset.kernel.ports.progress_reporter import ProgressReporter
from visionset.kernel.ports.provider import Provider, Runner, WeightsSource
from visionset.kernel.ports.video_processor import (
    DEFAULT_EXTRACTION_FPS,
    FRAME_FORMAT,
    VideoProcessor,
)

__all__ = [
    "DEFAULT_EXTRACTION_FPS",
    "DEFAULT_THUMBNAIL_MAX_EDGE",
    "FRAME_FORMAT",
    "THUMBNAIL_FORMAT",
    "UNINITIALIZED",
    "AuthProvider",
    "BlobStore",
    "EventBus",
    "ContentReader",
    "Exporter",
    "ImageProcessor",
    "Importer",
    "JobQueue",
    "MetadataStore",
    "ModelProvider",
    "PointSegmenter",
    "PreprocessingDriver",
    "ProgressReporter",
    "Provider",
    "Repository",
    "Runner",
    "UnitOfWork",
    "VideoProcessor",
    "WeightsSource",
    "resolve_target",
    "validate_targets",
    "validate_installed",
]
