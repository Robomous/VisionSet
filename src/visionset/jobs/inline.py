# usage: from visionset.jobs.inline import Surface, tracked_run, pre_label_observer
"""Tracking for the work a command or a tool runs in its own process.

The CLI and the MCP server never enqueue: they call the same kernel services and
``visionset.inference`` functions the handlers call, and block on them. This is
how such a run is tracked with the background path's own allowlists, so an
inline export and a queued one send the same named facts and differ only in
``visionset.execution_source``, which names the surface.

Nothing here can change the work: every failure becomes a warning on the
``visionset.tracking`` logger, and with tracking off nothing is built, imported
or queued. Delivery is the background path's thread, flushed at process exit
for at most ``EXIT_FLUSH_S``.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from enum import StrEnum
from typing import Final
from uuid import UUID, uuid4

from pydantic import JsonValue

from visionset.jobs import export, ingest, weights
from visionset.jobs._tracking import (
    TrackedAttempt,
    identifier_tags,
    open_run,
    run_tags,
)
from visionset.kernel.domain import (
    PRE_LABEL_JOB_TYPE,
    BackgroundJob,
    BackgroundJobOutcome,
    BackgroundJobState,
    ExportResult,
    InferenceConnection,
    IngestResult,
)
from visionset.kernel.errors import TrackingUnavailable
from visionset.kernel.services import WorkspaceService
from visionset.tracking import TrackingSettings, tracking_settings

_log: Final = logging.getLogger("visionset.tracking")

_Outcome = tuple[dict[str, JsonValue], Mapping[str, JsonValue], int, int | None]


class Surface(StrEnum):
    """Where an inline run executed; sent as ``visionset.execution_source``."""

    CLI = "cli"
    MCP = "mcp"


_warned = threading.Event()


def _enabled_settings() -> TrackingSettings | None:
    try:
        settings = tracking_settings()
    except TrackingUnavailable as exc:
        if not _warned.is_set():
            _warned.set()
            _log.warning("this process runs untracked: %s", exc)
        return None
    return settings if settings.mlflow_enabled else None


def _open(
    surface: Surface,
    job_type: str,
    payload: Mapping[str, JsonValue],
    *,
    job_id: UUID | None = None,
    attempt: int | None = None,
) -> TrackedAttempt | None:
    try:
        settings = _enabled_settings()
    except Exception as exc:  # noqa: BLE001 — a tracker must never reach the work
        _log.warning("MLflow tracking could not read its settings (%s).", type(exc).__name__)
        return None
    if settings is None:
        return None
    return open_run(
        settings,
        job_type,
        payload,
        lambda: run_tags(surface.value, job_type, uuid4(), payload, job_id=job_id, attempt=attempt),
    )


class InlineRun:
    """One operation's run. Every method is a no-op when the operation is untracked."""

    def __init__(
        self, job_type: str, payload: Mapping[str, JsonValue], run: TrackedAttempt | None
    ) -> None:
        self._job_type = job_type
        self._payload = payload
        self._run = run
        self._started = time.monotonic()
        self._bytes: tuple[int, int | None] = (0, None)

    def on_bytes(
        self, inner: Callable[[int, int | None], None] | None = None
    ) -> Callable[[int, int | None], None] | None:
        """``inner``, also noting the last byte count when tracked; unchanged when not."""
        if self._run is None:
            return inner

        def noted(done: int, total: int | None) -> None:
            self._bytes = (done, total)
            if inner is not None:
                inner(done, total)

        return noted

    def _close(
        self,
        outcome: Callable[[], _Outcome],
        workspace: WorkspaceService | None,
    ) -> None:
        run, self._run = self._run, None
        if run is None:
            return
        duration_s = time.monotonic() - self._started
        try:
            result, payload, processed, total = outcome()
        except Exception as exc:  # noqa: BLE001 — a tracker must never reach the work
            _log.warning("MLflow tracking could not read a run's outcome (%s).", type(exc).__name__)
            result, payload, processed, total, workspace = {}, {}, 0, None, None
        run.close_returned(
            self._job_type,
            payload=payload,
            result=result,
            cancelled=False,
            processed=processed,
            total=total,
            failures=0,
            duration_s=duration_s,
            workspace=workspace,
            tags=identifier_tags(payload),
        )

    def exported(self, result: ExportResult, workspace: WorkspaceService) -> None:
        """Close the run with what the export wrote; the handler reports its files as done."""
        self._close(
            lambda: (
                export.outcome_of(result),
                self._payload,
                result.file_count,
                result.file_count,
            ),
            workspace,
        )

    def ingested(self, result: IngestResult, workspace: WorkspaceService) -> None:
        """Close the run with the ingest row's counters, which the handler reports instead."""
        self._close(
            lambda: (ingest.outcome_of(result), ingest.payload_for(result.job_id), 0, None),
            workspace,
        )

    def downloaded(self, ready: InferenceConnection, workspace: WorkspaceService) -> None:
        """Close the run with the last byte count ``on_bytes`` saw."""
        self._close(
            lambda: (weights.outcome_of(ready), weights.payload_for(ready.id), *self._bytes),
            workspace,
        )

    def raised(self, exc: BaseException) -> None:
        run, self._run = self._run, None
        if run is not None:
            run.close_raised(exc, duration_s=time.monotonic() - self._started)

    def unreported(self) -> None:
        """Close a run whose block returned without saying what the work came to."""
        self._close(lambda: ({}, self._payload, 0, None), None)


@contextmanager
def tracked_run(
    surface: Surface, job_type: str, payload: Mapping[str, JsonValue] | None = None
) -> Iterator[InlineRun]:
    """Track the operation in the block as one run of ``job_type``.

    ``payload`` is what the background job of that type would carry, as far as
    the caller knows it before the work starts. The block reports what the work
    came to through one of the run's methods; an exception leaving the block
    fails the run and goes on unchanged.
    """
    known = payload or {}
    run = InlineRun(job_type, known, _open(surface, job_type, known))
    try:
        yield run
    except BaseException as exc:
        run.raised(exc)
        raise
    run.unreported()


class PreLabelTracking:
    """One run per pre-label row an inline call writes, opened as the row is."""

    def __init__(self, surface: Surface) -> None:
        self._surface = surface
        self._open: dict[UUID, tuple[TrackedAttempt, float]] = {}

    def recorded(self, row: BackgroundJob) -> None:
        try:
            run = _open(
                self._surface, PRE_LABEL_JOB_TYPE, row.payload, job_id=row.id, attempt=row.attempt
            )
            if run is not None:
                self._open[row.id] = (run, time.monotonic())
        except Exception as exc:  # noqa: BLE001 — a tracker must never reach the run
            _log.warning("MLflow tracking could not queue a run (%s).", type(exc).__name__)

    def settled(
        self, row: BackgroundJob, outcome: BackgroundJobOutcome, error: BaseException | None
    ) -> None:
        opened = self._open.pop(row.id, None)
        if opened is None:
            return
        run, started = opened
        duration_s = time.monotonic() - started
        if error is not None:
            run.close_raised(error, duration_s=duration_s)
            return
        try:
            run.close_returned(
                PRE_LABEL_JOB_TYPE,
                payload=row.payload,
                result=outcome.result,
                cancelled=outcome.state is BackgroundJobState.CANCELLED,
                processed=outcome.processed,
                total=outcome.total,
                failures=len(outcome.failures),
                duration_s=duration_s,
            )
        except Exception as exc:  # noqa: BLE001
            _log.warning("MLflow tracking could not queue a run's end (%s).", type(exc).__name__)


def pre_label_observer(surface: Surface) -> PreLabelTracking | None:
    """The observer an inline pre-label call takes, or ``None`` when tracking is off."""
    return PreLabelTracking(surface) if _enabled_settings() is not None else None
