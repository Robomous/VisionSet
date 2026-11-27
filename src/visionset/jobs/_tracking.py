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
import json
import logging
import math
import queue
import re
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Final
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from visionset import __version__
from visionset.jobs.ingest import INGEST_JOB_KEY
from visionset.jobs.ingest import JOB_TYPE as INGEST_JOB_TYPE
from visionset.kernel.domain import (
    ANNOTATION_JOB_KEY,
    BATCH_JOB_KEY,
    CONNECTION_JOB_KEY,
    EXPORT_ALLOW_LOSSY_KEY,
    EXPORT_FORMAT_KEY,
    EXPORT_JOB_TYPE,
    EXPORT_RECIPE_KEY,
    EXPORT_RELEASE_KEY,
    EXPORT_TARGET_KEY,
    PRE_LABEL_CONFIDENCE_KEY,
    PRE_LABEL_GEOMETRIES_KEY,
    PRE_LABEL_JOB_TYPE,
    PRE_LABEL_REPLACE_KEY,
    WEIGHT_DOWNLOAD_JOB_TYPE,
    GeometryType,
    InferenceConnection,
    IngestJob,
    Release,
)
from visionset.kernel.error_codes import error_code
from visionset.kernel.errors import TrackingUnavailable
from visionset.kernel.services import (
    InferenceConnectionService,
    IngestService,
    ReleaseService,
    WorkspaceService,
)
from visionset.tracking import (
    DatasetInput,
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
TAG_DATASET_ID: Final = "visionset.dataset_id"
TAG_SOURCE_ID: Final = "visionset.source_id"
TAG_BATCH_ID: Final = "visionset.batch_id"

#: Payload keys whose value is an identifier safe to publish, once it parses as a UUID.
IDENTIFIER_TAGS: Final[Mapping[str, str]] = {
    BATCH_JOB_KEY: TAG_BATCH_ID,
    CONNECTION_JOB_KEY: "visionset.connection_id",
    ANNOTATION_JOB_KEY: "visionset.annotation_job_id",
    EXPORT_RELEASE_KEY: "visionset.release_id",
    INGEST_JOB_KEY: "visionset.ingest_job_id",
}

#: Pre-labeling's result keys that are counts, and the metric each becomes.
PRE_LABEL_COUNTS: Final[Mapping[str, str]] = {
    "assets_skipped": "assets_skipped_count",
    "regions_discarded": "regions_discarded_count",
    "regions_out_of_bounds": "regions_out_of_bounds_count",
    "annotations_written": "annotations_written_count",
    "annotations_replaced": "annotations_replaced_count",
}

#: An export's result keys that are counts or sizes, and the metric each becomes.
EXPORT_COUNTS: Final[Mapping[str, str]] = {
    "total_bytes": "output_bytes",
    "source_file_count": "source_image_count",
    "augmented_file_count": "augmented_image_count",
}

#: An ingest's result keys that are counts, and the metric each becomes.
INGEST_COUNTS: Final[Mapping[str, str]] = {
    "asset_count": "asset_count",
    "created": "created_asset_count",
}

RELEASE_SOURCE_TYPE: Final = "visionset_release"
#: MLflow refuses a dataset digest longer than 36 characters; the full hash is a parameter.
RELEASE_DIGEST_LENGTH: Final = 32

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
_MODEL_ID_SHAPE = r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?"
_MODEL_ID = re.compile(_MODEL_ID_SHAPE)
_COMMIT = re.compile(r"[0-9a-f]{40}")
_MODEL_REF = re.compile(rf"(?P<model_id>{_MODEL_ID_SHAPE})@(?P<model_revision>{_COMMIT.pattern})")
_PLUGIN_NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
_SHA256 = re.compile(r"[0-9a-f]{64}")


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
    if job_type == EXPORT_JOB_TYPE:
        return _export_params(payload)
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


def _export_params(payload: Mapping[str, JsonValue]) -> dict[str, ParamValue]:
    params: dict[str, ParamValue] = {}
    for key, name in ((EXPORT_FORMAT_KEY, "export_format"), (EXPORT_TARGET_KEY, "export_target")):
        value = payload.get(key)
        if isinstance(value, str) and _PLUGIN_NAME.fullmatch(value):
            params[name] = value
    allow_lossy = payload.get(EXPORT_ALLOW_LOSSY_KEY)
    if isinstance(allow_lossy, bool):
        params["allow_lossy"] = allow_lossy
    if EXPORT_RECIPE_KEY in payload:
        recipe = payload[EXPORT_RECIPE_KEY]
        if recipe is None or isinstance(recipe, dict):
            params["recipe_applied"] = recipe is not None
    return params


def result_params(job_type: str, result: Mapping[str, JsonValue]) -> dict[str, ParamValue]:
    """What a returned attempt names about its inputs: a model, or a recipe's hash."""
    if job_type == EXPORT_JOB_TYPE:
        recipe_hash = result.get("recipe_hash")
        if isinstance(recipe_hash, str) and _SHA256.fullmatch(recipe_hash):
            return {"recipe_hash": recipe_hash}
        return {}
    if job_type == WEIGHT_DOWNLOAD_JOB_TYPE:
        model_id, revision = result.get("model_id"), result.get("model_revision")
        if not (isinstance(model_id, str) and _MODEL_ID.fullmatch(model_id)):
            return {}
        params: dict[str, ParamValue] = {"model_id": model_id}
        if isinstance(revision, str) and _COMMIT.fullmatch(revision):
            params["model_revision"] = revision
        return params
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
    handler that never reported is not recorded as having processed zero. A
    weight download reports bytes, so its progress is named in bytes.
    """
    metrics: dict[str, float] = {}
    if job_type == WEIGHT_DOWNLOAD_JOB_TYPE:
        if processed > 0 or total is not None:
            metrics["bytes_done"] = float(processed)
            if total is not None and total >= processed:
                metrics["bytes_total"] = float(total)
    elif processed > 0 or total is not None or failures > 0:
        metrics["processed_count"] = float(processed)
        metrics["failures_count"] = float(failures)
        if total is not None and total >= processed:
            metrics["total_count"] = float(total)
    counts = {
        PRE_LABEL_JOB_TYPE: PRE_LABEL_COUNTS,
        EXPORT_JOB_TYPE: EXPORT_COUNTS,
        INGEST_JOB_TYPE: INGEST_COUNTS,
    }.get(job_type, {})
    for key, name in counts.items():
        count = _count(result.get(key))
        if count is not None:
            metrics[name] = float(count)
    return metrics


@dataclass(frozen=True)
class RecordFields:
    """What the canonical rows behind a returned attempt add to its run."""

    params: dict[str, ParamValue] = field(default_factory=dict)
    metrics: dict[str, float] = field(default_factory=dict)
    tags: dict[str, str] = field(default_factory=dict)
    datasets: tuple[DatasetInput, ...] = ()


def release_fields(release: Release) -> RecordFields:
    """A consumed release, by identity and digest. Its tag and dataset name stay home."""
    tags = {TAG_DATASET_ID: str(release.dataset_id)}
    if not _SHA256.fullmatch(release.manifest_hash):
        return RecordFields(tags=tags)
    identity = {"release_id": str(release.id), "dataset_id": str(release.dataset_id)}
    profile = {
        "manifest_hash": release.manifest_hash,
        "schema_version": release.schema_version,
        "asset_count": release.asset_count,
        "annotation_count": release.annotation_count,
    }
    dataset = DatasetInput(
        name=f"visionset-release-{release.id}",
        digest=release.manifest_hash[:RELEASE_DIGEST_LENGTH],
        source_type=RELEASE_SOURCE_TYPE,
        source=json.dumps(identity, sort_keys=True),
        profile=json.dumps(profile, sort_keys=True),
        context="export",
    )
    return RecordFields(
        params={
            "release_manifest_hash": release.manifest_hash,
            "release_schema_version": release.schema_version,
        },
        tags=tags,
        datasets=(dataset,),
    )


def ingest_fields(job: IngestJob) -> RecordFields:
    """The ingest row's own final counters and ids. Never its batch name, error or failures."""
    metrics = {"processed_count": float(job.processed), "failures_count": float(len(job.failures))}
    if job.total is not None and job.total >= job.processed:
        metrics["total_count"] = float(job.total)
    tags = {TAG_SOURCE_ID: str(job.source_id)}
    if job.batch_id is not None:
        tags[TAG_BATCH_ID] = str(job.batch_id)
    return RecordFields(metrics=metrics, tags=tags)


def connection_fields(connection: InferenceConnection) -> RecordFields:
    """Which driver serves a connection and what kind of model arrived; never its name or URL."""
    params: dict[str, ParamValue] = {}
    if connection.provider_id is not None and _PLUGIN_NAME.fullmatch(connection.provider_id):
        params["model_provider"] = connection.provider_id
    if connection.model_family and _PLUGIN_NAME.fullmatch(connection.model_family):
        params["model_family"] = connection.model_family
    return RecordFields(params=params)


def read_record_fields(
    workspace: WorkspaceService, job_type: str, payload: Mapping[str, JsonValue]
) -> RecordFields:
    """Read the one row a returned attempt worked on, by the id its payload names.

    One read by primary key, on the worker's own thread and handle; nothing is
    scanned. A row that cannot be read is left out.
    """
    if job_type == EXPORT_JOB_TYPE:
        release_id = _uuid(payload.get(EXPORT_RELEASE_KEY))
        if release_id is not None:
            return release_fields(ReleaseService(workspace).get(UUID(release_id)))
    elif job_type == INGEST_JOB_TYPE:
        ingest_job_id = _uuid(payload.get(INGEST_JOB_KEY))
        if ingest_job_id is not None:
            return ingest_fields(IngestService(workspace).get(UUID(ingest_job_id)))
    elif job_type == WEIGHT_DOWNLOAD_JOB_TYPE:
        connection_id = _uuid(payload.get(CONNECTION_JOB_KEY))
        if connection_id is not None:
            return connection_fields(InferenceConnectionService(workspace).get(UUID(connection_id)))
    return RecordFields()


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
        datasets: tuple[DatasetInput, ...],
    ) -> None:
        if self._run_id is None:
            return
        tracker = self._tracker
        try:
            tracker.log_params(self._run_id, params)
            tracker.log_metrics(self._run_id, metrics)
            tracker.set_tags(self._run_id, tags)
            tracker.log_inputs(self._run_id, datasets)
        finally:
            tracker.end_run(self._run_id, status)

    def close(
        self,
        status: RunStatus,
        *,
        params: dict[str, ParamValue] | None = None,
        metrics: dict[str, float] | None = None,
        tags: dict[str, str] | None = None,
        datasets: tuple[DatasetInput, ...] = (),
    ) -> None:
        try:
            sent = (dict(params or {}), dict(metrics or {}), dict(tags or {}), tuple(datasets))
            _COURIER.send(lambda: self._close(status, *sent))
        except Exception as exc:  # noqa: BLE001
            _log.warning("MLflow tracking could not queue a run's end (%s).", type(exc).__name__)

    def close_returned(
        self,
        job_type: str,
        *,
        payload: Mapping[str, JsonValue],
        result: Mapping[str, JsonValue],
        cancelled: bool,
        processed: int,
        total: int | None,
        failures: int,
        duration_s: float,
        workspace: WorkspaceService | None = None,
    ) -> None:
        """Close the run of an attempt whose handler returned.

        ``workspace`` is read for the rows a completed attempt worked on, and only
        when it was not cancelled; the reads happen here, on the caller's thread.
        """
        try:
            metrics = outcome_metrics(
                job_type, result, processed=processed, total=total, failures=failures
            )
            params = result_params(job_type, result)
        except Exception as exc:  # noqa: BLE001
            _log.warning("MLflow tracking could not read a run's outcome (%s).", type(exc).__name__)
            metrics, params = {}, {}
        records = RecordFields()
        if workspace is not None and not cancelled:
            try:
                records = read_record_fields(workspace, job_type, payload)
            except Exception as exc:  # noqa: BLE001
                _log.warning(
                    "MLflow tracking could not read a run's records (%s).", type(exc).__name__
                )
        self.close(
            RunStatus.KILLED if cancelled else RunStatus.FINISHED,
            params={**params, **records.params},
            metrics={"duration_seconds": duration_s, **metrics, **records.metrics},
            tags={**records.tags, TAG_JOB_STATE: "cancelled" if cancelled else "succeeded"},
            datasets=records.datasets,
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
