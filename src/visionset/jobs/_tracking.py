# usage: internal to visionset.jobs — what an execution attempt sends to a tracker
"""One tracking run per execution attempt, built from an allowlist and sent off the job's path.

The job row stays the record of what happened; a run is a best-effort copy of a
few named facts about one attempt. Three rules shape this module:

- **Nothing here can change a job.** Every call into a tracker happens on this
  process's delivery thread, so a slow or failing tracking server neither delays
  nor fails the work. The job's only cost is putting two tasks on a queue.
- **Only allowlisted values leave.** Tags, parameters and metrics are built by the
  functions below from named keys, each value checked for its shape; a value that
  is missing or not the expected shape is omitted rather than defaulted.
- **Correlation is explicit.** The dispatcher mints an ``execution_id`` for each
  dispatch, and every run carries it beside the job id and the claim's attempt
  number, so a retried or re-enqueued job produces an independent run.
"""

from __future__ import annotations

import atexit
import logging
import math
import queue
import re
import threading
import time
from collections.abc import Callable, Mapping
from typing import Final
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from visionset import __version__
from visionset.kernel.domain import (
    ANNOTATION_JOB_KEY,
    BATCH_JOB_KEY,
    CONNECTION_JOB_KEY,
    PRE_LABEL_CONFIDENCE_KEY,
    PRE_LABEL_GEOMETRIES_KEY,
    PRE_LABEL_JOB_TYPE,
    PRE_LABEL_REPLACE_KEY,
    GeometryType,
)
from visionset.kernel.error_codes import error_code
from visionset.kernel.errors import TrackingUnavailable
from visionset.tracking import (
    NoOpTracker,
    ParamValue,
    RunStatus,
    Tracker,
    TrackingSettings,
    build_tracker,
)

_log: Final = logging.getLogger("visionset.tracking")

EXECUTION_SOURCE: Final = "background_job"

TAG_JOB_ID: Final = "visionset.job_id"
TAG_JOB_TYPE: Final = "visionset.job_type"
TAG_EXECUTION_ID: Final = "visionset.execution_id"
TAG_ATTEMPT: Final = "visionset.attempt"
TAG_SOURCE: Final = "visionset.execution_source"
TAG_VERSION: Final = "visionset.version"
TAG_JOB_STATE: Final = "visionset.job_state"
TAG_ERROR_CLASS: Final = "visionset.error_class"
TAG_ERROR_CODE: Final = "visionset.error_code"
TAG_RECONCILED: Final = "visionset.reconciled"

#: Payload keys whose value is an identifier safe to publish, once it parses as a UUID.
IDENTIFIER_TAGS: Final[Mapping[str, str]] = {
    BATCH_JOB_KEY: "visionset.batch_id",
    CONNECTION_JOB_KEY: "visionset.connection_id",
    ANNOTATION_JOB_KEY: "visionset.annotation_job_id",
}

#: Pre-labeling's result keys that are counts, and the metric each becomes.
PRE_LABEL_COUNTS: Final[Mapping[str, str]] = {
    "assets_skipped": "assets_skipped_count",
    "regions_discarded": "regions_discarded_count",
    "regions_out_of_bounds": "regions_out_of_bounds_count",
    "annotations_written": "annotations_written_count",
    "annotations_replaced": "annotations_replaced_count",
}

RECONCILED_WORKER_LOST: Final = "worker_lost"
RECONCILED_SERVER_RESTART: Final = "server_restart"

#: Runs queued for delivery beyond which a new attempt is not tracked at all.
MAX_BACKLOG: Final = 64
#: How long a process exiting waits for queued deliveries before it gives up on them.
EXIT_FLUSH_S: Final = 10.0

_JOB_TYPE = re.compile(r"[a-z0-9][a-z0-9._-]{0,99}")
_VERSION = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+!_-]{0,63}")
_CLASS_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,99}")
_ERROR_CODE = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
_MODEL_REF = re.compile(
    r"(?P<model_id>[A-Za-z0-9][A-Za-z0-9._-]{0,95}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?)"
    r"@(?P<model_revision>[0-9a-f]{40})"
)


class AttemptTracking(BaseModel):
    """Everything a worker needs to track one attempt, and nothing it could leak.

    Crosses the process boundary, so it holds the settings (two fields, no URI and
    no credential) and identifiers — never a tracker.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    settings: TrackingSettings
    execution_id: UUID
    job_id: UUID
    job_type: str
    attempt: int = Field(ge=0)


# --- the data contract --------------------------------------------------------


def _uuid(value: JsonValue) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return str(UUID(value))
    except ValueError:
        return None


def _count(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def attempt_tags(attempt: AttemptTracking, payload: Mapping[str, JsonValue]) -> dict[str, str]:
    """The tags a run opens with."""
    tags = {
        TAG_JOB_ID: str(attempt.job_id),
        TAG_EXECUTION_ID: str(attempt.execution_id),
        TAG_ATTEMPT: str(attempt.attempt),
        TAG_SOURCE: EXECUTION_SOURCE,
    }
    if _JOB_TYPE.fullmatch(attempt.job_type):
        tags[TAG_JOB_TYPE] = attempt.job_type
    if _VERSION.fullmatch(__version__):
        tags[TAG_VERSION] = __version__
    for key, tag in IDENTIFIER_TAGS.items():
        identifier = _uuid(payload.get(key))
        if identifier is not None:
            tags[tag] = identifier
    return tags


def attempt_params(job_type: str, payload: Mapping[str, JsonValue]) -> dict[str, ParamValue]:
    """What the attempt was asked to do, for the job types that say so."""
    if job_type != PRE_LABEL_JOB_TYPE:
        return {}
    params: dict[str, ParamValue] = {}
    confidence = payload.get(PRE_LABEL_CONFIDENCE_KEY)
    if (
        isinstance(confidence, int | float)
        and not isinstance(confidence, bool)
        and math.isfinite(confidence)
        and 0.0 <= confidence <= 1.0
    ):
        params["minimum_confidence"] = float(confidence)
    replace = payload.get(PRE_LABEL_REPLACE_KEY)
    if isinstance(replace, bool):
        params["replace_model_labels"] = replace
    geometries = payload.get(PRE_LABEL_GEOMETRIES_KEY)
    if isinstance(geometries, list) and geometries:
        known = {shape.value for shape in GeometryType}
        if all(isinstance(shape, str) and shape in known for shape in geometries):
            params["requested_geometries"] = ",".join(sorted(set(map(str, geometries))))
    return params


def result_params(job_type: str, result: Mapping[str, JsonValue]) -> dict[str, ParamValue]:
    """Which model answered, when the result names it in the ``id@revision`` form."""
    if job_type != PRE_LABEL_JOB_TYPE:
        return {}
    model_ref = result.get("model_ref")
    if not isinstance(model_ref, str):
        return {}
    match = _MODEL_REF.fullmatch(model_ref)
    if match is None:
        return {}
    return {"model_id": match["model_id"], "model_revision": match["model_revision"]}


def outcome_metrics(
    job_type: str,
    result: Mapping[str, JsonValue],
    *,
    processed: int,
    total: int | None,
    failures: int,
) -> dict[str, float]:
    """The final counts of an attempt that returned, as its job row records them.

    Progress counts are sent only when the handler reported progress at all, so a
    handler that never reported is not recorded as having processed zero.
    """
    metrics: dict[str, float] = {}
    if processed > 0 or total is not None or failures > 0:
        metrics["processed_count"] = float(processed)
        metrics["failures_count"] = float(failures)
        if total is not None and total >= processed:
            metrics["total_count"] = float(total)
    if job_type == PRE_LABEL_JOB_TYPE:
        for key, name in PRE_LABEL_COUNTS.items():
            count = _count(result.get(key))
            if count is not None:
                metrics[name] = float(count)
    return metrics


def failure_tags(exc: BaseException) -> dict[str, str]:
    """The class and declared code of what ended an attempt — never its text."""
    tags: dict[str, str] = {}
    name = type(exc).__name__
    if _CLASS_NAME.fullmatch(name):
        tags[TAG_ERROR_CLASS] = name
    code = error_code(exc)
    if code is not None and _ERROR_CODE.fullmatch(code):
        tags[TAG_ERROR_CODE] = code
    return tags


# --- delivery -----------------------------------------------------------------


class _Courier:
    """This process's one delivery thread, started on first use."""

    def __init__(self) -> None:
        self._queue: queue.Queue[Callable[[], None]] = queue.Queue()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        #: Set once the process is exiting: a send still in flight after the exit
        #: flush gave up must not write to a stream the interpreter is closing.
        self.closing = False

    def backlog(self) -> int:
        return self._queue.unfinished_tasks

    def send(self, task: Callable[[], None]) -> None:
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(
                    target=self._deliver, name="visionset-tracking", daemon=True
                )
                self._thread.start()
        self._queue.put(task)

    def _deliver(self) -> None:
        while True:
            task = self._queue.get()
            try:
                task()
            except Exception as exc:  # noqa: BLE001 — a tracker must never reach a job
                if not self.closing:
                    _log.warning(
                        "MLflow tracking failed (%s); the work continues untracked.",
                        type(exc).__name__,
                    )
            finally:
                self._queue.task_done()

    def flush(self, timeout_s: float) -> bool:
        """Wait for everything queued so far, up to ``timeout_s``. Returns whether it all went."""
        deadline = time.monotonic() + timeout_s
        with self._queue.all_tasks_done:
            while self._queue.unfinished_tasks:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._queue.all_tasks_done.wait(remaining)
        return True


_COURIER: Final = _Courier()
_TRACKERS: Final[dict[TrackingSettings, Tracker]] = {}
_TRACKERS_LOCK: Final = threading.Lock()


def _tracker_for(settings: TrackingSettings) -> Tracker:
    """This process's tracker for these settings, built once.

    Built on the caller's thread, before anything is queued: building imports
    the client and sets environment defaults, and doing either on the delivery
    thread while a handler imports its own modules is how a tracker could break
    the job it tracks. Building makes no request.
    """
    with _TRACKERS_LOCK:
        tracker = _TRACKERS.get(settings)
        if tracker is None:
            try:
                tracker = build_tracker(settings)
            except TrackingUnavailable as exc:
                _log.warning("MLflow tracking is off in this process: %s", exc)
                tracker = NoOpTracker()
            _TRACKERS[settings] = tracker
        return tracker


def flush(timeout_s: float) -> bool:
    """Wait for this process's queued deliveries. Returns whether they all went."""
    return _COURIER.flush(timeout_s)


def _flush_at_exit() -> None:
    flush(EXIT_FLUSH_S)
    _COURIER.closing = True


atexit.register(_flush_at_exit)


class TrackedAttempt:
    """The run for one attempt: opened on the delivery thread, closed there too."""

    def __init__(self, attempt: AttemptTracking, tracker: Tracker, tags: dict[str, str]) -> None:
        self._attempt = attempt
        self._tracker = tracker
        self._tags = tags
        self._run_id: str | None = None

    def _open(self, params: dict[str, ParamValue]) -> None:
        name = self._tags.get(TAG_JOB_TYPE, EXECUTION_SOURCE)
        self._run_id = self._tracker.start_run(name, tags=self._tags)
        self._tracker.log_params(self._run_id, params)

    def _close(
        self,
        status: RunStatus,
        params: dict[str, ParamValue],
        metrics: dict[str, float],
        tags: dict[str, str],
    ) -> None:
        if self._run_id is None:
            return
        tracker = self._tracker
        try:
            tracker.log_params(self._run_id, params)
            tracker.log_metrics(self._run_id, metrics)
            tracker.set_tags(self._run_id, tags)
        finally:
            tracker.end_run(self._run_id, status)

    def close(
        self,
        status: RunStatus,
        *,
        params: dict[str, ParamValue] | None = None,
        metrics: dict[str, float] | None = None,
        tags: dict[str, str] | None = None,
    ) -> None:
        try:
            sent = (dict(params or {}), dict(metrics or {}), dict(tags or {}))
            _COURIER.send(lambda: self._close(status, *sent))
        except Exception as exc:  # noqa: BLE001
            _log.warning("MLflow tracking could not queue a run's end (%s).", type(exc).__name__)

    def close_returned(
        self,
        job_type: str,
        *,
        result: Mapping[str, JsonValue],
        cancelled: bool,
        processed: int,
        total: int | None,
        failures: int,
        duration_s: float,
    ) -> None:
        """Close the run of an attempt whose handler returned."""
        try:
            metrics = outcome_metrics(
                job_type, result, processed=processed, total=total, failures=failures
            )
            params = result_params(job_type, result)
        except Exception as exc:  # noqa: BLE001
            _log.warning("MLflow tracking could not read a run's outcome (%s).", type(exc).__name__)
            metrics, params = {}, {}
        self.close(
            RunStatus.KILLED if cancelled else RunStatus.FINISHED,
            params=params,
            metrics={"duration_seconds": duration_s, **metrics},
            tags={TAG_JOB_STATE: "cancelled" if cancelled else "succeeded"},
        )

    def close_raised(self, exc: BaseException, *, duration_s: float) -> None:
        """Close the run of an attempt whose handler raised."""
        try:
            tags = {TAG_JOB_STATE: "failed", **failure_tags(exc)}
        except Exception:  # noqa: BLE001
            tags = {TAG_JOB_STATE: "failed"}
        self.close(RunStatus.FAILED, metrics={"duration_seconds": duration_s}, tags=tags)


def open_attempt(
    attempt: AttemptTracking | None, payload: Mapping[str, JsonValue]
) -> TrackedAttempt | None:
    """Queue the opening of this attempt's run, or ``None`` when it is not tracked."""
    if attempt is None or not attempt.settings.mlflow_enabled:
        return None
    try:
        if _COURIER.backlog() >= MAX_BACKLOG:
            _log.warning(
                "MLflow tracking is %d deliveries behind; this attempt is not tracked.",
                _COURIER.backlog(),
            )
            return None
        tracker = _tracker_for(attempt.settings)
        if isinstance(tracker, NoOpTracker):
            return None
        run = TrackedAttempt(attempt, tracker, attempt_tags(attempt, payload))
        params = attempt_params(attempt.job_type, payload)
        _COURIER.send(lambda: run._open(params))
        return run
    except Exception as exc:  # noqa: BLE001
        _log.warning("MLflow tracking could not queue a run (%s).", type(exc).__name__)
        return None


def reconcile(settings: TrackingSettings | None, tags: Mapping[str, str], reason: str) -> None:
    """Fail whatever run is still open for an attempt whose process is gone. Best-effort.

    Queued on this process's delivery thread. A run whose server cannot be reached
    now stays open on it; nothing retries.
    """
    if settings is None or not settings.mlflow_enabled:
        return

    def task(tracker: Tracker) -> None:
        for run_id in tracker.running_runs({TAG_SOURCE: EXECUTION_SOURCE, **tags}):
            tracker.end_run(run_id, RunStatus.FAILED)
            tracker.set_tags(run_id, {TAG_RECONCILED: reason, TAG_JOB_STATE: "failed"})

    try:
        tracker = _tracker_for(settings)
        _COURIER.send(lambda: task(tracker))
    except Exception as exc:  # noqa: BLE001
        _log.warning("MLflow tracking could not queue a reconciliation (%s).", type(exc).__name__)
