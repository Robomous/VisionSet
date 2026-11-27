# usage: from visionset.tracking import build_tracker, tracking_settings
"""Optional experiment tracking, below the surfaces and outside the kernel.

Off by default. :func:`build_tracker` answers a :class:`NoOpTracker` unless
``VISIONSET_MLFLOW_ENABLED`` is true, and only then reads ``MLFLOW_TRACKING_URI``
and imports the MLflow client. What may cross a process boundary is
:class:`TrackingSettings`; a tracker is built in the process that uses it.
See ``docs/content/tracking.md``.
"""

from __future__ import annotations

from visionset.tracking._mlflow import build_mlflow_tracker
from visionset.tracking._tracker import NoOpTracker, ParamValue, RunStatus, Tracker
from visionset.tracking.settings import (
    TrackingSettings,
    load_tracking_settings,
    tracking_settings,
)


def build_tracker(settings: TrackingSettings) -> Tracker:
    """The tracker these settings call for.

    Raises:
        TrackingUnavailable: tracking is enabled and cannot run here — no
            ``MLFLOW_TRACKING_URI``, a URI carrying credentials or one MLflow
            refuses, or the MLflow client is not installed.
    """
    if not settings.mlflow_enabled:
        return NoOpTracker()
    return build_mlflow_tracker(settings.mlflow_experiment)


__all__ = [
    "NoOpTracker",
    "ParamValue",
    "RunStatus",
    "Tracker",
    "TrackingSettings",
    "build_tracker",
    "load_tracking_settings",
    "tracking_settings",
]
