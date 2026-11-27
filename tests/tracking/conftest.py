from __future__ import annotations

from collections.abc import Iterator

import pytest

from visionset.tracking import tracking_settings
from visionset.tracking._mlflow import ENVIRONMENT_DEFAULTS, ENVIRONMENT_FORCED

_VARIABLES = (
    "VISIONSET_MLFLOW_ENABLED",
    "VISIONSET_MLFLOW_EXPERIMENT",
    "MLFLOW_TRACKING_URI",
    "MLFLOW_TRACKING_USERNAME",
    "MLFLOW_TRACKING_PASSWORD",
    "MLFLOW_TRACKING_TOKEN",
    *ENVIRONMENT_DEFAULTS,
    *ENVIRONMENT_FORCED,
)


@pytest.fixture(autouse=True)
def clean_tracking_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Start from nothing, and take back what ``build_tracker``'s ``setdefault`` wrote.

    Setting then deleting records the original value, so the undo removes a
    variable the code under test added even though it was absent to begin with.
    """
    for name in _VARIABLES:
        monkeypatch.setenv(name, "placeholder")
        monkeypatch.delenv(name)
    tracking_settings.cache_clear()
    yield
    tracking_settings.cache_clear()
