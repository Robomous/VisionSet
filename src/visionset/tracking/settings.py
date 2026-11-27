# usage: from visionset.tracking.settings import TrackingSettings, load_tracking_settings
"""Whether tracking is on, and under which experiment — and nothing else.

These two fields are the whole of what crosses a process boundary. The tracking
URI and every credential stay in the environment the MLflow client reads itself,
so a settings object can be dumped into a job payload, pickled to a spawned
worker or logged without carrying a secret. A worker started with ``spawn``
inherits the environment, so it rebuilds its own client from the same variables.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from visionset.kernel.errors import TrackingUnavailable

DEFAULT_EXPERIMENT = "visionset"
MAX_EXPERIMENT_LENGTH = 500


class TrackingSettings(BaseSettings):
    """Tracking configuration from ``VISIONSET_``-prefixed variables."""

    model_config = SettingsConfigDict(env_prefix="VISIONSET_", extra="ignore", frozen=True)

    mlflow_enabled: bool = Field(
        default=False,
        description=(
            "Turns MLflow tracking on. Off by default, and when blank; "
            "MLFLOW_TRACKING_URI alone never turns it on."
        ),
    )
    mlflow_experiment: str = Field(
        default=DEFAULT_EXPERIMENT,
        description="The MLflow experiment runs are recorded under. Checked only when enabled.",
    )

    @field_validator("mlflow_enabled", mode="before")
    @classmethod
    def blank_is_off(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return False
        return value


def load_tracking_settings() -> TrackingSettings:
    """Read the tracking settings from the environment, or refuse naming the variable.

    Raises:
        TrackingUnavailable: ``VISIONSET_MLFLOW_ENABLED`` is neither blank nor a
            boolean, or tracking is enabled with an empty or over-long experiment name.
    """
    try:
        settings = TrackingSettings()
    except ValidationError:
        raise TrackingUnavailable(
            "VISIONSET_MLFLOW_ENABLED is not a valid value. It takes true or false; "
            "leave it unset or blank to keep tracking off."
        ) from None
    if settings.mlflow_enabled:
        experiment = settings.mlflow_experiment.strip()
        if not experiment or len(experiment) > MAX_EXPERIMENT_LENGTH:
            raise TrackingUnavailable(
                "VISIONSET_MLFLOW_EXPERIMENT must name the experiment runs are recorded "
                f"under, in 1 to {MAX_EXPERIMENT_LENGTH} characters. Unset it to use "
                f"{DEFAULT_EXPERIMENT!r}."
            )
    return settings


@lru_cache(maxsize=1)
def tracking_settings() -> TrackingSettings:
    """The settings this process runs with; ``tracking_settings.cache_clear()`` in tests.

    Raises:
        TrackingUnavailable: see :func:`load_tracking_settings`.
    """
    return load_tracking_settings()
