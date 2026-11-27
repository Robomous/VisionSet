"""The MLflow tracker against a real client: what it sends, and how it fails."""

from __future__ import annotations

import logging
import multiprocessing
import os
import pickle
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from tests.fixtures.mlflow_server import (
    MlflowServer,
    closed_port,
    require_mlflow,
    serving_mlflow,
    silent_server,
)

from visionset.kernel.errors import TrackingUnavailable
from visionset.tracking import (
    DatasetInput,
    RunStatus,
    TrackingSettings,
    build_tracker,
    load_tracking_settings,
)
from visionset.tracking._mlflow import ENVIRONMENT_DEFAULTS, MlflowTracker


def _enable(monkeypatch: pytest.MonkeyPatch, uri: str) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    monkeypatch.setenv("MLFLOW_TRACKING_URI", uri)
    monkeypatch.setenv("MLFLOW_HTTP_REQUEST_MAX_RETRIES", "0")


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> Iterator[MlflowServer]:
    require_mlflow()
    with serving_mlflow() as running:
        _enable(monkeypatch, running.url)
        yield running


def _warnings(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        record.getMessage()
        for record in caplog.records
        if record.name == "visionset.tracking" and record.levelno == logging.WARNING
    ]


def test_a_run_sends_exactly_what_it_was_given(server: MlflowServer) -> None:
    tracker = build_tracker(load_tracking_settings())

    run_id = tracker.start_run("export", tags={"visionset.kind": "export"})
    tracker.log_params(run_id, {"format": "coco", "allow_lossy": False})
    tracker.log_metrics(run_id, {"assets": 12.0}, step=3)
    tracker.set_tags(run_id, {"outcome": "ok"})
    tracker.end_run(run_id, RunStatus.FAILED)

    assert run_id == "run-1"
    posted = {seen.path: seen.body for seen in server.requests if seen.method == "POST"}
    assert posted["/api/2.0/mlflow/experiments/create"] == {"name": "visionset"}
    created = posted["/api/2.0/mlflow/runs/create"]
    assert created is not None
    assert {k: v for k, v in created.items() if k != "start_time"} == {
        "experiment_id": "7",
        "user_id": "unknown",
        "run_name": "export",
        "tags": [{"key": "visionset.kind", "value": "export"}],
    }
    batches = [seen.body for seen in server.requests if seen.path.endswith("/runs/log-batch")]
    assert batches[0] == {
        "run_id": "run-1",
        "params": [
            {"key": "format", "value": "coco"},
            {"key": "allow_lossy", "value": "False"},
        ],
    }
    assert batches[1] is not None
    assert [(m["key"], m["value"], m["step"]) for m in batches[1]["metrics"]] == [
        ("assets", 12.0, 3)
    ]
    assert batches[2] == {"run_id": "run-1", "tags": [{"key": "outcome", "value": "ok"}]}
    updated = posted["/api/2.0/mlflow/runs/update"]
    assert updated is not None
    assert updated["status"] == "FAILED"


def test_a_dataset_input_is_sent_as_identity_with_its_context(server: MlflowServer) -> None:
    tracker = build_tracker(load_tracking_settings())

    run_id = tracker.start_run("export.release")
    tracker.log_inputs(run_id, [RELEASE_INPUT])
    tracker.log_inputs(run_id, [])
    tracker.end_run(run_id)

    sent = [seen.body for seen in server.requests if seen.path.endswith("/runs/log-inputs")]
    assert sent == [
        {
            "run_id": "run-1",
            "datasets": [
                {
                    "tags": [{"key": "mlflow.data.context", "value": "export"}],
                    "dataset": {
                        "name": "visionset-release-r1",
                        "digest": "ab" * 16,
                        "source_type": "visionset_release",
                        "source": '{"release_id": "r1"}',
                        "profile": '{"schema_version": 2}',
                    },
                }
            ],
        }
    ]
    assert server.runs["run-1"].status == "FINISHED"


def test_nothing_identifying_the_machine_is_sent(server: MlflowServer) -> None:
    tracker = build_tracker(load_tracking_settings())
    tracker.end_run(tracker.start_run("ingest"))

    sent = repr([(seen.path, seen.headers, seen.body) for seen in server.requests])
    for local in (os.getcwd(), socket.gethostname(), os.environ.get("USER") or "\0"):
        assert local not in sent
    assert {seen.path.split("?")[0] for seen in server.requests} <= {
        "/api/2.0/mlflow/experiments/get-by-name",
        "/api/2.0/mlflow/experiments/create",
        "/api/2.0/mlflow/runs/create",
        "/api/2.0/mlflow/runs/get",
        "/api/2.0/mlflow/runs/update",
    }


def test_a_whole_run_prints_nothing_naming_the_server(
    server: MlflowServer, capfd: pytest.CaptureFixture[str]
) -> None:
    tracker = build_tracker(load_tracking_settings())

    run_id = tracker.start_run("export")
    tracker.log_params(run_id, {"a": 1})
    tracker.log_metrics(run_id, {"m": 1.0})
    tracker.end_run(run_id)

    out, err = capfd.readouterr()
    assert run_id == "run-1"
    assert any(seen.path.endswith("/runs/update") for seen in server.requests)
    host_and_port = server.url.removeprefix("http://")
    for printed in (out, err):
        assert host_and_port not in printed
        assert "127.0.0.1" not in printed


def _rebuilt_in_a_worker(payload: dict[str, object]) -> tuple[str, dict[str, object], str | None]:
    settings = TrackingSettings(**payload)
    tracker = build_tracker(settings)
    run_id = tracker.start_run("worker")
    tracker.end_run(run_id)
    return type(tracker).__name__, settings.model_dump(mode="json"), run_id


def test_a_spawned_worker_rebuilds_an_enabled_tracker_from_the_payload(
    server: MlflowServer,
) -> None:
    payload = load_tracking_settings().model_dump(mode="json")
    assert payload == {"mlflow_enabled": True, "mlflow_experiment": "visionset"}

    with multiprocessing.get_context("spawn").Pool(1) as pool:
        kind, rebuilt, run_id = pool.apply(_rebuilt_in_a_worker, (payload,))

    assert (kind, rebuilt, run_id) == ("MlflowTracker", payload, "run-1")
    assert any(seen.path.endswith("/runs/create") for seen in server.requests)


def test_the_experiment_is_looked_up_once_and_reused(server: MlflowServer) -> None:
    server.experiment_exists = True
    tracker = build_tracker(load_tracking_settings())

    tracker.start_run("a")
    tracker.start_run("b")

    paths = [seen.path.split("?")[0] for seen in server.requests]
    assert paths.count("/api/2.0/mlflow/experiments/get-by-name") == 1
    assert "/api/2.0/mlflow/experiments/create" not in paths


def test_the_client_is_imported_only_when_tracking_is_built() -> None:
    """In a fresh interpreter: reading the settings loads nothing, building does."""
    require_mlflow()
    probe = """
import sys
from visionset.tracking import build_tracker, load_tracking_settings
settings = load_tracking_settings()
assert "mlflow" not in sys.modules, "reading the settings imported mlflow"
build_tracker(settings)
assert "mlflow" in sys.modules
import mlflow.telemetry.client as telemetry
assert telemetry.get_telemetry_client() is None, "telemetry was not disabled"
"""
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("MLFLOW_", "DO_NOT_TRACK"))
        and k not in {"CI", "GITHUB_ACTIONS", "PYTEST_CURRENT_TEST"}
    }
    env |= {"VISIONSET_MLFLOW_ENABLED": "true", "MLFLOW_TRACKING_URI": closed_port()}
    result = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stderr


def test_bounded_defaults_are_applied_and_an_operator_value_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    require_mlflow()
    _enable(monkeypatch, closed_port())
    monkeypatch.setenv("MLFLOW_HTTP_REQUEST_TIMEOUT", "30")

    build_tracker(load_tracking_settings())

    assert os.environ["MLFLOW_HTTP_REQUEST_TIMEOUT"] == "30"
    assert os.environ["MLFLOW_HTTP_REQUEST_MAX_RETRIES"] == "0"
    for name in ("MLFLOW_DISABLE_TELEMETRY", "MLFLOW_HTTP_REQUEST_BACKOFF_FACTOR"):
        assert os.environ[name] == ENVIRONMENT_DEFAULTS[name]


def test_an_unavailable_server_is_a_sanitized_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    require_mlflow()
    uri = closed_port()
    _enable(monkeypatch, uri)
    tracker = build_tracker(load_tracking_settings())

    with caplog.at_level(logging.WARNING, logger="visionset.tracking"):
        run_id = tracker.start_run("export")
        tracker.log_params("run-elsewhere", {"a": 1})
        tracker.end_run("run-elsewhere")

    assert run_id is None
    warnings = _warnings(caplog)
    assert len(warnings) == 3
    port = uri.rsplit(":", 1)[1]
    for warning in warnings:
        assert "127.0.0.1" not in warning
        assert port not in warning


def test_a_server_that_never_answers_is_bounded_by_the_timeout(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    require_mlflow()
    with silent_server() as uri:
        _enable(monkeypatch, uri)
        monkeypatch.setenv("MLFLOW_HTTP_REQUEST_TIMEOUT", "1")
        tracker = build_tracker(load_tracking_settings())

        started = time.monotonic()
        with caplog.at_level(logging.WARNING, logger="visionset.tracking"):
            run_id = tracker.start_run("export")
        elapsed = time.monotonic() - started

    assert run_id is None
    assert elapsed < 10
    assert len(_warnings(caplog)) == 1


def test_no_log_record_or_output_names_the_server_under_the_shipped_defaults(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    capfd: pytest.CaptureFixture[str],
) -> None:
    """An unresolvable host, MLflow's retry left at VisionSet's default of one.

    urllib3 names the host in its connection and retry records, and a retry is
    what makes it warn rather than debug. Captured at the root and on MLflow's
    own logger, which does not propagate.
    """
    require_mlflow()
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    monkeypatch.setenv(
        "MLFLOW_TRACKING_URI", "http://tracking-secret-host.invalid:5000/private-prefix"
    )
    tracker = build_tracker(load_tracking_settings())
    assert os.environ["MLFLOW_HTTP_REQUEST_MAX_RETRIES"] == "1"
    mlflow_logger = logging.getLogger("mlflow")
    mlflow_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(logging.DEBUG):
            run_id = tracker.start_run("export")
            tracker.log_params("run-elsewhere", {"a": 1})
            tracker.end_run("run-elsewhere")
    finally:
        mlflow_logger.removeHandler(caplog.handler)

    assert run_id is None
    assert any(record.name.startswith("urllib3") for record in caplog.records)
    rendered = [caplog.handler.format(record) for record in caplog.records]
    rendered += list(capfd.readouterr())
    for text in rendered:
        assert "tracking-secret-host" not in text
        assert "private-prefix" not in text


def test_the_shipped_timeout_and_retry_bound_a_silent_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Five seconds, retried once: about ten seconds and no more."""
    require_mlflow()
    with silent_server() as uri:
        monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
        monkeypatch.setenv("MLFLOW_TRACKING_URI", uri)
        tracker = build_tracker(load_tracking_settings())

        started = time.monotonic()
        run_id = tracker.start_run("export")
        elapsed = time.monotonic() - started

    assert run_id is None
    assert 9.5 <= elapsed < 15


def test_an_unusable_uri_is_refused_without_echoing_it(monkeypatch: pytest.MonkeyPatch) -> None:
    require_mlflow()
    _enable(monkeypatch, "nosuchscheme://private-host.example/store")

    with pytest.raises(TrackingUnavailable) as raised:
        build_tracker(load_tracking_settings())

    assert "private-host" not in str(raised.value)


def test_a_tracker_refuses_to_cross_a_process_boundary(server: MlflowServer) -> None:
    tracker = build_tracker(load_tracking_settings())

    with pytest.raises(TypeError, match="TrackingSettings"):
        pickle.dumps(tracker)
    assert server.url not in repr(tracker)


class _FakeClient:
    """The client's surface, failing where a test says so."""

    def __init__(self, *, fail: set[str] | None = None, created_elsewhere: bool = False):
        self.fail = fail or set()
        self.created_elsewhere = created_elsewhere
        self.lookups = 0
        self.calls: list[tuple[str, Any]] = []

    def _maybe_fail(self, name: str) -> None:
        if name in self.fail:
            error = RuntimeError("https://user:secret@host.example/path failed")
            error.error_code = "TEMPORARILY_UNAVAILABLE"  # type: ignore[attr-defined]
            raise error

    def get_experiment_by_name(self, name: str) -> Any:
        self.lookups += 1
        if self.created_elsewhere and self.lookups > 1:
            return SimpleNamespace(experiment_id="9")
        return None

    def create_experiment(self, name: str) -> str:
        if self.created_elsewhere:
            raise RuntimeError("RESOURCE_ALREADY_EXISTS")
        return "8"

    def create_run(self, experiment_id: str, **kwargs: Any) -> Any:
        self._maybe_fail("create_run")
        self.calls.append(("create_run", experiment_id))
        return SimpleNamespace(info=SimpleNamespace(run_id="r"))

    def log_batch(self, run_id: str, **kwargs: Any) -> None:
        self._maybe_fail("log_batch")
        self.calls.append(("log_batch", kwargs))

    def set_terminated(self, run_id: str, status: str) -> None:
        self._maybe_fail("set_terminated")
        self.calls.append(("set_terminated", status))

    def log_inputs(self, run_id: str, **kwargs: Any) -> None:
        self._maybe_fail("log_inputs")
        self.calls.append(("log_inputs", kwargs))

    def search_runs(self, experiment_ids: list[str], **kwargs: Any) -> list[Any]:
        self._maybe_fail("search_runs")
        self.calls.append(("search_runs", kwargs))
        return [SimpleNamespace(info=SimpleNamespace(run_id="r"))]


_ENTITIES: Any = SimpleNamespace(
    Param=lambda key, value: (key, value),
    Metric=lambda key, value, timestamp, step: (key, value, step),
    RunTag=lambda key, value: (key, value),
    Dataset=lambda **fields: fields,
    DatasetInput=lambda dataset, tags: (dataset, tags),
    InputTag=lambda key, value: (key, value),
)

RELEASE_INPUT = DatasetInput(
    name="visionset-release-r1",
    digest="ab" * 16,
    source_type="visionset_release",
    source='{"release_id": "r1"}',
    profile='{"schema_version": 2}',
    context="export",
)


def test_an_experiment_created_concurrently_is_adopted() -> None:
    client = _FakeClient(created_elsewhere=True)
    tracker = MlflowTracker(client, _ENTITIES, "visionset")

    assert tracker.start_run("a") == "r"
    assert client.calls == [("create_run", "9")]


def test_failures_never_raise_and_never_log_the_exception_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _FakeClient(fail={"create_run", "log_batch", "log_inputs", "set_terminated"})
    tracker = MlflowTracker(client, _ENTITIES, "visionset")

    with caplog.at_level(logging.WARNING, logger="visionset.tracking"):
        assert tracker.start_run("a") is None
        tracker.log_params("r", {"a": 1})
        tracker.log_metrics("r", {"m": 1.0})
        tracker.set_tags("r", {"t": "v"})
        tracker.log_inputs("r", [RELEASE_INPUT])
        tracker.end_run("r", RunStatus.KILLED)

    warnings = _warnings(caplog)
    assert len(warnings) == 6
    assert all("TEMPORARILY_UNAVAILABLE" in warning for warning in warnings)
    assert not any("secret" in warning or "host.example" in warning for warning in warnings)


def test_a_run_that_never_started_sends_nothing() -> None:
    client = _FakeClient()
    tracker = MlflowTracker(client, _ENTITIES, "visionset")

    tracker.log_params(None, {"a": 1})
    tracker.log_metrics(None, {"m": 1.0})
    tracker.set_tags(None, {"t": "v"})
    tracker.log_inputs(None, [RELEASE_INPUT])
    tracker.end_run(None)

    assert client.calls == []
    assert client.lookups == 0


def test_running_runs_finds_only_open_runs_carrying_every_tag(server: MlflowServer) -> None:
    tracker = build_tracker(load_tracking_settings())
    open_match = tracker.start_run("a", tags={"visionset.job_id": "j-1", "k": "v"})
    ended_match = tracker.start_run("b", tags={"visionset.job_id": "j-1", "k": "v"})
    tracker.start_run("c", tags={"visionset.job_id": "j-2", "k": "v"})
    tracker.end_run(ended_match, RunStatus.FINISHED)

    assert tracker.running_runs({"visionset.job_id": "j-1", "k": "v"}) == [open_match]
    assert tracker.running_runs({"visionset.job_id": "j-3"}) == []


@pytest.mark.parametrize(
    "tags",
    [
        {},
        {"visionset.job_id": "x' or tags.k != '"},
        {"visionset.job_id": "/home/user/secret"},
        {"key with space": "v"},
        {"k": ""},
    ],
)
def test_running_runs_refuses_a_value_it_would_have_to_quote(tags: dict[str, str]) -> None:
    client = _FakeClient()
    tracker = MlflowTracker(client, _ENTITIES, "visionset")

    assert tracker.running_runs(tags) == []
    assert client.calls == []
    assert client.lookups == 0


def test_running_runs_filters_on_the_tags_and_the_running_status() -> None:
    client = _FakeClient()
    tracker = MlflowTracker(client, _ENTITIES, "visionset")

    assert tracker.running_runs({"visionset.execution_id": "e-1"}) == ["r"]
    assert client.calls == [
        (
            "search_runs",
            {
                "filter_string": "tags.`visionset.execution_id` = 'e-1' "
                "and attributes.status = 'RUNNING'",
                "max_results": 50,
            },
        )
    ]


def test_a_failed_lookup_answers_nothing_and_warns_without_the_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    tracker = MlflowTracker(_FakeClient(fail={"search_runs"}), _ENTITIES, "visionset")

    with caplog.at_level(logging.WARNING, logger="visionset.tracking"):
        assert tracker.running_runs({"k": "v"}) == []

    assert _warnings(caplog) == [
        "MLflow tracking could not look up running runs (RuntimeError: TEMPORARILY_UNAVAILABLE); "
        "the work continues untracked."
    ]
