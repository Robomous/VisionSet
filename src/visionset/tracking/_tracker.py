# usage: from visionset.tracking import NoOpTracker, RunStatus, Tracker
"""The neutral tracking interface and the implementation that does nothing."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable

ParamValue = str | int | float | bool


@dataclass(frozen=True)
class DatasetInput:
    """A dataset a run consumed, named by identity. It carries no data."""

    name: str
    digest: str
    source_type: str
    source: str
    profile: str | None = None
    context: str | None = None


class RunStatus(StrEnum):
    """How a run ended."""

    FINISHED = "finished"
    FAILED = "failed"
    KILLED = "killed"


@runtime_checkable
class Tracker(Protocol):
    """Records runs by explicit id. Best-effort: no method raises into its caller.

    ``start_run`` answers ``None`` when nothing was recorded — tracking is off, or
    the server could not be reached — and every other method accepts that ``None``
    and does nothing with it, so a caller never branches on whether tracking works.
    """

    def start_run(self, name: str, *, tags: Mapping[str, str] | None = None) -> str | None: ...

    def log_params(self, run_id: str | None, params: Mapping[str, ParamValue]) -> None: ...

    def log_metrics(
        self, run_id: str | None, metrics: Mapping[str, float], *, step: int | None = None
    ) -> None: ...

    def set_tags(self, run_id: str | None, tags: Mapping[str, str]) -> None: ...

    def log_inputs(self, run_id: str | None, datasets: Sequence[DatasetInput]) -> None: ...

    def end_run(self, run_id: str | None, status: RunStatus = RunStatus.FINISHED) -> None: ...

    def running_runs(self, tags: Mapping[str, str]) -> list[str]:
        """Ids of the runs still running that carry every one of these tags.

        Answers ``[]`` when nothing matches, when nothing was recorded, and when
        the server could not be asked — a caller cannot tell those apart, and
        never needs to: it is how an interrupted run is found and ended late.
        """
        ...


class NoOpTracker:
    """Tracking turned off: imports nothing, opens nothing, records nothing."""

    def start_run(self, name: str, *, tags: Mapping[str, str] | None = None) -> str | None:
        return None

    def log_params(self, run_id: str | None, params: Mapping[str, ParamValue]) -> None:
        return None

    def log_metrics(
        self, run_id: str | None, metrics: Mapping[str, float], *, step: int | None = None
    ) -> None:
        return None

    def set_tags(self, run_id: str | None, tags: Mapping[str, str]) -> None:
        return None

    def log_inputs(self, run_id: str | None, datasets: Sequence[DatasetInput]) -> None:
        return None

    def end_run(self, run_id: str | None, status: RunStatus = RunStatus.FINISHED) -> None:
        return None

    def running_runs(self, tags: Mapping[str, str]) -> list[str]:
        return []
