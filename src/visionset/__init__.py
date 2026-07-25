"""Robomous VisionSet — local-first dataset creation for computer vision and Physical AI."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("visionset")
except PackageNotFoundError:  # pragma: no cover - only hit when not installed
    __version__ = "0.0.0"

__all__ = ["__version__"]
