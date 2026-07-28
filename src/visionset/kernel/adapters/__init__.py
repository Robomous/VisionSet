"""Default adapters for the kernel ports (filesystem + SQLite, local-first)."""

from visionset.kernel.adapters.ffmpeg_video_processor import FfmpegVideoProcessor
from visionset.kernel.adapters.filesystem_blob_store import FilesystemBlobStore
from visionset.kernel.adapters.in_process_event_bus import InProcessEventBus
from visionset.kernel.adapters.pillow_image_processor import PillowImageProcessor
from visionset.kernel.adapters.sqlite_metadata_store import SqliteMetadataStore
from visionset.kernel.adapters.stored_token_auth_provider import StoredTokenAuthProvider

__all__ = [
    "FfmpegVideoProcessor",
    "FilesystemBlobStore",
    "InProcessEventBus",
    "PillowImageProcessor",
    "SqliteMetadataStore",
    "StoredTokenAuthProvider",
]
