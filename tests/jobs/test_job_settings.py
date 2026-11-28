"""The executor's values beside their defaults, and the settings every surface publishes."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from visionset import __version__
from visionset.jobs import DEFAULT_POLL_INTERVAL_S, DEFAULT_WORKERS
from visionset.jobs.settings import executor_status, job_settings, workspace_settings
from visionset.kernel.adapters.sqlite_progress_reporter import DEFAULT_MIN_INTERVAL_S
from visionset.kernel.domain import ExecutorVariable
from visionset.tracking import tracking_status

_VARIABLES = (
    "VISIONSET_JOB_WORKERS",
    "VISIONSET_JOB_POLL_INTERVAL_S",
    "VISIONSET_JOB_PROGRESS_MIN_INTERVAL_S",
)


@pytest.fixture(autouse=True)
def clean_executor_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for name in _VARIABLES:
        monkeypatch.delenv(name, raising=False)
    job_settings.cache_clear()
    yield
    job_settings.cache_clear()


def test_every_knob_is_reported_at_its_default() -> None:
    status = executor_status()

    assert status.problem is None
    assert status.variables == (
        ExecutorVariable(name="VISIONSET_JOB_WORKERS", value=DEFAULT_WORKERS, default=1),
        ExecutorVariable(
            name="VISIONSET_JOB_POLL_INTERVAL_S",
            value=DEFAULT_POLL_INTERVAL_S,
            default=DEFAULT_POLL_INTERVAL_S,
        ),
        ExecutorVariable(
            name="VISIONSET_JOB_PROGRESS_MIN_INTERVAL_S",
            value=DEFAULT_MIN_INTERVAL_S,
            default=DEFAULT_MIN_INTERVAL_S,
        ),
    )


def test_a_set_value_is_reported_beside_its_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VISIONSET_JOB_WORKERS", "3")

    workers = executor_status().variables[0]

    assert (workers.value, workers.default) == (3, DEFAULT_WORKERS)
    assert isinstance(workers.value, int)


def test_a_refused_value_withholds_every_value_and_names_the_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VISIONSET_JOB_WORKERS", "0")

    status = executor_status()

    assert all(variable.value is None for variable in status.variables)
    assert status.problem is not None
    assert status.problem.startswith("VISIONSET_JOB_WORKERS is not a valid value")
    assert "VISIONSET_JOB_POLL_INTERVAL_S" not in status.problem


def test_the_workspace_settings_compose_version_tracking_and_executor() -> None:
    settings = workspace_settings()

    assert settings.version == __version__
    assert settings.tracking == tracking_status()
    assert settings.executor == executor_status()
