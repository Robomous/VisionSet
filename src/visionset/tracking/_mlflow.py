# usage: from visionset.tracking._mlflow import build_mlflow_tracker
"""The MLflow implementation, reached only when tracking is enabled.

Every MLflow import happens inside a function, so a base install and a disabled
deployment never load the SDK. Runs are addressed by explicit id through one
``MlflowClient``: no fluent API, no active run, no autologging.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from collections.abc import Mapping
from importlib import import_module
from types import ModuleType
from typing import Any, Final, NoReturn
from urllib.parse import urlsplit

from visionset.kernel.errors import TrackingUnavailable
from visionset.tracking._tracker import ParamValue, RunStatus

EXTRA: Final = "mlflow"
INSTALL_COMMAND: Final = f'pip install "visionset[{EXTRA}]"'
MODULES: Final[tuple[str, ...]] = ("mlflow",)

URI_VARIABLE: Final = "MLFLOW_TRACKING_URI"

ENVIRONMENT_DEFAULTS: Final[Mapping[str, str]] = {
    "MLFLOW_DISABLE_TELEMETRY": "true",
    "MLFLOW_DISABLE_AGENT_HINT": "true",
    "MLFLOW_SUPPRESS_PRINTING_URL_TO_STDOUT": "true",
    "MLFLOW_HTTP_REQUEST_TIMEOUT": "5",
    "MLFLOW_HTTP_REQUEST_MAX_RETRIES": "1",
    "MLFLOW_HTTP_REQUEST_BACKOFF_FACTOR": "1",
}
"""Applied with ``setdefault`` before MLflow is imported, so an operator's own
value always wins. MLflow's defaults retry for minutes, which would stall the
work being tracked when the server is down."""

_STATUS: Final[Mapping[RunStatus, str]] = {
    RunStatus.FINISHED: "FINISHED",
    RunStatus.FAILED: "FAILED",
    RunStatus.KILLED: "KILLED",
}

_ERROR_CODE = re.compile(r"[A-Z][A-Z_]{0,63}")

_log = logging.getLogger("visionset.tracking")

REDACTED: Final = "<tracking server>"

_REDACTED_LOGGERS: Final[tuple[str, ...]] = (
    "urllib3.connectionpool",
    "urllib3.connection",
    "urllib3.poolmanager",
    "urllib3.util.retry",
)
"""urllib3 names the host and port in its connection and retry records."""


class _RedactTrackingAddress(logging.Filter):
    """Rewrites any record naming the tracking server's address before it is emitted.

    Attached to the urllib3 loggers above and to the handlers MLflow installs on its
    own ``mlflow`` logger, which does not propagate. Nothing else is touched: the
    application's own handlers and loggers keep their configuration.
    """

    def __init__(self) -> None:
        super().__init__()
        self.terms: set[str] = set()

    def _redacted(self, text: str) -> str:
        for term in sorted(self.terms, key=len, reverse=True):
            text = text.replace(term, REDACTED)
        return text

    def filter(self, record: logging.LogRecord) -> bool:
        if not self.terms:
            return True
        try:
            message = record.getMessage()
        except Exception:
            message = str(record.msg)
        if any(term in message for term in self.terms):
            record.msg, record.args = self._redacted(message), None
        if record.exc_info or record.exc_text:
            rendered = record.exc_text or ""
            if record.exc_info:
                rendered += logging.Formatter().formatException(record.exc_info)
            if any(term in rendered for term in self.terms):
                record.exc_info, record.exc_text = None, None
        return True


_redaction = _RedactTrackingAddress()


def _address_terms(uri: str) -> set[str]:
    parts = urlsplit(uri)
    host = parts.netloc.rsplit(":", 1)[0] if parts.port else parts.netloc
    terms = {uri, parts.netloc, host, parts.hostname or "", parts.path.rstrip("/")}
    return {term for term in terms if term.strip("/")}


def _install_redaction(uri: str) -> None:
    _redaction.terms |= _address_terms(uri)
    for name in _REDACTED_LOGGERS:
        logger = logging.getLogger(name)
        if _redaction not in logger.filters:
            logger.addFilter(_redaction)
    for handler in logging.getLogger("mlflow").handlers:
        if _redaction not in handler.filters:
            handler.addFilter(_redaction)


def _imported(name: str) -> ModuleType:
    try:
        return import_module(name)
    except ImportError:
        raise TrackingUnavailable(
            f"VISIONSET_MLFLOW_ENABLED is true, and the MLflow client is not installed "
            f"here. Install it with: {INSTALL_COMMAND}"
        ) from None


def _describe(exc: BaseException) -> str:
    """The exception's class and MLflow error code — never its message, which can
    carry the tracking URI or a local path."""
    code = getattr(exc, "error_code", None)
    if isinstance(code, str) and _ERROR_CODE.fullmatch(code):
        return f"{type(exc).__name__}: {code}"
    return type(exc).__name__


def _tracking_uri() -> str:
    uri = os.environ.get(URI_VARIABLE, "").strip()
    if not uri:
        raise TrackingUnavailable(
            f"VISIONSET_MLFLOW_ENABLED is true, and {URI_VARIABLE} is not set. Set it to "
            "the tracking server's address; tracking never picks a location on its own."
        )
    try:
        parts = urlsplit(uri)
        carries_credentials = parts.username is not None or parts.password is not None
        carries_query = bool(parts.query or parts.fragment)
        parts.port  # noqa: B018 - a malformed port raises here rather than inside MLflow
    except ValueError:
        raise TrackingUnavailable(f"{URI_VARIABLE} is not a valid URI.") from None
    if carries_query:
        raise TrackingUnavailable(
            f"{URI_VARIABLE} carries a query string or fragment, which MLflow would append "
            "request paths after. Give the server's base address, and put a token in "
            "MLFLOW_TRACKING_TOKEN."
        )
    if carries_credentials:
        raise TrackingUnavailable(
            f"{URI_VARIABLE} carries credentials. Remove them from the URI and set "
            "MLFLOW_TRACKING_USERNAME and MLFLOW_TRACKING_PASSWORD, or "
            "MLFLOW_TRACKING_TOKEN, instead."
        )
    return uri


class MlflowTracker:
    """Records runs through one ``MlflowClient``, swallowing every failure as a warning."""

    def __init__(self, client: Any, entities: ModuleType, experiment: str) -> None:
        self._client = client
        self._entities = entities
        self._experiment = experiment
        self._experiment_id: str | None = None
        self._lock = threading.Lock()

    def __reduce__(self) -> NoReturn:
        raise TypeError(
            "a tracker does not cross a process boundary; pass TrackingSettings and "
            "build the tracker where it is used"
        )

    def __repr__(self) -> str:
        return f"MlflowTracker(experiment={self._experiment!r})"

    def _warn(self, action: str, exc: BaseException) -> None:
        _log.warning(
            "MLflow tracking could not %s (%s); the work continues untracked.",
            action,
            _describe(exc),
        )

    def _resolve_experiment(self) -> str:
        found = self._client.get_experiment_by_name(self._experiment)
        if found is not None:
            return str(found.experiment_id)
        try:
            return str(self._client.create_experiment(self._experiment))
        except Exception:
            # Another process may have created it between the lookup and the create.
            found = self._client.get_experiment_by_name(self._experiment)
            if found is None:
                raise
            return str(found.experiment_id)

    def _experiment_id_for_runs(self) -> str:
        with self._lock:
            if self._experiment_id is None:
                self._experiment_id = self._resolve_experiment()
            return self._experiment_id

    def start_run(self, name: str, *, tags: Mapping[str, str] | None = None) -> str | None:
        try:
            run = self._client.create_run(
                self._experiment_id_for_runs(), run_name=name, tags=dict(tags or {})
            )
            return str(run.info.run_id)
        except Exception as exc:
            self._warn("start a run", exc)
            return None

    def log_params(self, run_id: str | None, params: Mapping[str, ParamValue]) -> None:
        if run_id is None or not params:
            return
        try:
            batch = [self._entities.Param(key, str(value)) for key, value in params.items()]
            self._client.log_batch(run_id, params=batch)
        except Exception as exc:
            self._warn("record parameters", exc)

    def log_metrics(
        self, run_id: str | None, metrics: Mapping[str, float], *, step: int | None = None
    ) -> None:
        if run_id is None or not metrics:
            return
        try:
            now = int(time.time() * 1000)
            batch = [
                self._entities.Metric(key, float(value), now, step or 0)
                for key, value in metrics.items()
            ]
            self._client.log_batch(run_id, metrics=batch)
        except Exception as exc:
            self._warn("record metrics", exc)

    def set_tags(self, run_id: str | None, tags: Mapping[str, str]) -> None:
        if run_id is None or not tags:
            return
        try:
            batch = [self._entities.RunTag(key, str(value)) for key, value in tags.items()]
            self._client.log_batch(run_id, tags=batch)
        except Exception as exc:
            self._warn("record tags", exc)

    def end_run(self, run_id: str | None, status: RunStatus = RunStatus.FINISHED) -> None:
        if run_id is None:
            return
        try:
            self._client.set_terminated(run_id, status=_STATUS[status])
        except Exception as exc:
            self._warn("end a run", exc)


def build_mlflow_tracker(experiment: str) -> MlflowTracker:
    """Build the MLflow tracker, or refuse with the remedy.

    Raises:
        TrackingUnavailable: ``MLFLOW_TRACKING_URI`` is missing, malformed, or
            carries credentials, a query string or a fragment; the MLflow client
            is not installed; or MLflow refuses the URI as a tracking store.
    """
    uri = _tracking_uri()
    for name, value in ENVIRONMENT_DEFAULTS.items():
        os.environ.setdefault(name, value)
    tracking = _imported("mlflow.tracking")
    entities = _imported("mlflow.entities")
    _install_redaction(uri)
    try:
        client = tracking.MlflowClient(tracking_uri=uri)
    except Exception as exc:
        raise TrackingUnavailable(
            f"MLflow could not use {URI_VARIABLE} as a tracking store ({_describe(exc)}). "
            "Check the scheme and that the store it names is reachable from here."
        ) from None
    return MlflowTracker(client, entities, experiment)
