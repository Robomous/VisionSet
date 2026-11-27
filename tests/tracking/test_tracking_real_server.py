"""VisionSet against a real MLflow tracking server: the dev stack's own ``mlflow`` profile.

Every other tracking test talks to the recording stub in ``tests/fixtures/mlflow_server.py``,
which answers what the adapter is expected to send. This one starts the pinned server
image from ``docker/compose.yaml`` under a throwaway project name, so it also proves
the profile starts, and reads every run back through MLflow's own client.

Opt-in, because pulling and starting the server costs far more than the rest of the
tracking suite: ``VISIONSET_REQUIRE_MLFLOW_SERVER=1`` runs it, and then a missing
Docker, image or client is a failure rather than a skip. The ``tracking-smoke`` CI
job sets it. Without it, every test here skips.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from tests.fixtures.mlflow_server import MLFLOW_INSTALLED
from tests.fixtures.tls_proxy import Pki, make_pki, serving_proxy

from visionset.jobs import HandlerRef, JobRunner, _tracking, register
from visionset.kernel.domain import BackgroundJobSpec, BackgroundJobState
from visionset.kernel.errors import BatchNotFound
from visionset.kernel.services import WorkspaceService
from visionset.tracking import RunStatus, TrackingSettings, build_tracker, tracking_settings

REQUIRE = "VISIONSET_REQUIRE_MLFLOW_SERVER"
COMPOSE_FILE = Path(__file__).resolve().parents[2] / "docker" / "compose.yaml"
START_TIMEOUT_S = 300
SETTLE_TIMEOUT_S = 120.0
SECRET = "/home/someone/secret-dir"
USERNAME, PASSWORD, TOKEN = "tracker", "not-a-real-password", "not-a-real-token"
BASIC = "Basic " + base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()
BEARER = f"Bearer {TOKEN}"


def succeeds(workspace_root: Path, payload: dict[str, Any], reporter: Any) -> dict[str, Any]:
    reporter.report(processed=3, total=4)
    return {}


def refuses(workspace_root: Path, payload: dict[str, Any], reporter: Any) -> dict[str, Any]:
    raise BatchNotFound(SECRET)


SUCCEEDS = "test.real_server_succeeds"
REFUSES = "test.real_server_refuses"
register(HandlerRef(type=SUCCEEDS, func=f"{__name__}:succeeds"))
register(HandlerRef(type=REFUSES, func=f"{__name__}:refuses"))


def _compose(project: str, *args: str, timeout: float = 120, check: bool = True) -> str:
    return subprocess.run(
        ["docker", "compose", "-p", project, "-f", str(COMPOSE_FILE), "--profile", "mlflow", *args],
        check=check,
        capture_output=True,
        text=True,
        env={**os.environ, "VISIONSET_MLFLOW_PORT": "0"},
        timeout=timeout,
    ).stdout


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    if os.environ.get(REQUIRE) != "1":
        pytest.skip(f"starts a real MLflow server in Docker; set {REQUIRE}=1 to run")
    if not MLFLOW_INSTALLED:
        pytest.fail("the MLflow client is not installed here: `uv sync --extra mlflow`")
    if shutil.which("docker") is None:
        pytest.fail("docker is not on PATH")
    project = f"visionset-mlflow-test-{uuid4().hex[:12]}"
    wait = str(START_TIMEOUT_S)
    try:
        try:
            _compose(
                project,
                "up",
                "--detach",
                "--wait",
                "--wait-timeout",
                wait,
                "mlflow",
                timeout=START_TIMEOUT_S + 60,
            )
            address = _compose(project, "port", "mlflow", "5000").strip()
        except subprocess.CalledProcessError as exc:
            pytest.fail(f"the mlflow profile did not start: {exc.stderr}")
        assert address.startswith("127.0.0.1:"), address
        yield f"http://{address}"
    finally:
        _compose(project, "down", "--volumes", "--timeout", "5", check=False)


@pytest.fixture()
def experiment() -> str:
    return f"visionset-it-{uuid4().hex[:12]}"


@pytest.fixture()
def reader(server_url: str) -> Any:
    from mlflow.tracking import MlflowClient

    return MlflowClient(tracking_uri=server_url)


@pytest.fixture()
def remote_environment(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name in ("REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "SSL_CERT_FILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("MLFLOW_HTTP_REQUEST_MAX_RETRIES", "0")
    return monkeypatch


@pytest.fixture()
def pki(tmp_path: Path) -> Pki:
    return make_pki(tmp_path)


def _runs(reader: Any, experiment: str) -> list[Any]:
    found = reader.get_experiment_by_name(experiment)
    assert found is not None, "the experiment was never created on the server"
    return list(reader.search_runs([found.experiment_id]))


def _record_one_run(experiment: str) -> str | None:
    tracker = build_tracker(TrackingSettings(mlflow_enabled=True, mlflow_experiment=experiment))
    run_id = tracker.start_run("remote_check", tags={"visionset.execution_source": "test"})
    tracker.log_metrics(run_id, {"processed_count": 7.0})
    tracker.end_run(run_id, RunStatus.FINISHED)
    return run_id


def test_the_adapter_round_trips_a_run_through_a_real_server(
    server_url: str, reader: Any, experiment: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MLFLOW_TRACKING_URI", server_url)
    tracker = build_tracker(TrackingSettings(mlflow_enabled=True, mlflow_experiment=experiment))
    tags = {"visionset.job_id": str(uuid4()), "visionset.execution_source": "test"}

    run_id = tracker.start_run("annotation.pre_label", tags=tags)
    assert run_id is not None
    assert tracker.running_runs(tags) == [run_id]
    tracker.log_params(run_id, {"minimum_confidence": 0.25, "replace_model_labels": False})
    tracker.log_metrics(run_id, {"annotations_written_count": 12.0, "duration_seconds": 1.5})
    tracker.set_tags(run_id, {"visionset.job_state": "cancelled"})
    tracker.end_run(run_id, RunStatus.KILLED)

    run = reader.get_run(run_id)
    assert run.info.status == "KILLED"
    assert run.info.run_name == "annotation.pre_label"
    assert run.info.end_time is not None
    assert run.data.metrics == {"annotations_written_count": 12.0, "duration_seconds": 1.5}
    assert run.data.params == {"minimum_confidence": "0.25", "replace_model_labels": "False"}
    assert {key: run.data.tags[key] for key in (*tags, "visionset.job_state")} == {
        **tags,
        "visionset.job_state": "cancelled",
    }
    assert tracker.running_runs(tags) == []


def _settle(workspace: WorkspaceService, job_ids: list[UUID]) -> dict[UUID, Any]:
    runner = JobRunner(
        workspace.job_queue,
        workspace.root,
        workers=2,
        poll_interval_s=0.05,
        tracking=tracking_settings(),
    )
    runner.start()
    try:
        runner.wake()
        deadline = time.monotonic() + SETTLE_TIMEOUT_S
        while time.monotonic() < deadline:
            rows = [workspace.job_queue.get(job_id) for job_id in job_ids]
            if all(row is not None and row.settled for row in rows):
                break
            time.sleep(0.05)
    finally:
        runner.stop(timeout=SETTLE_TIMEOUT_S)
    return {job_id: workspace.job_queue.get(job_id) for job_id in job_ids}


def test_background_jobs_end_as_finished_and_failed_runs_on_a_real_server(
    server_url: str,
    reader: Any,
    experiment: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    monkeypatch.setenv("VISIONSET_MLFLOW_EXPERIMENT", experiment)
    monkeypatch.setenv("MLFLOW_TRACKING_URI", server_url)
    tracking_settings.cache_clear()
    _tracking._TRACKERS.clear()
    workspace = WorkspaceService.init(tmp_path / "ws")
    try:
        good = workspace.job_queue.enqueue(BackgroundJobSpec(type=SUCCEEDS, payload={}))
        bad = workspace.job_queue.enqueue(BackgroundJobSpec(type=REFUSES, payload={}))
        rows = _settle(workspace, [good.id, bad.id])
    finally:
        _tracking._TRACKERS.clear()
        workspace.close()

    assert rows[good.id].state is BackgroundJobState.SUCCEEDED
    assert rows[bad.id].state is BackgroundJobState.FAILED
    runs = {run.data.tags["visionset.job_id"]: run for run in _runs(reader, experiment)}
    assert set(runs) == {str(good.id), str(bad.id)}

    finished, failed = runs[str(good.id)], runs[str(bad.id)]
    assert (finished.info.status, finished.info.run_name) == ("FINISHED", SUCCEEDS)
    assert finished.data.tags["visionset.job_state"] == "succeeded"
    assert finished.data.tags["visionset.execution_source"] == "background_job"
    assert finished.data.metrics["processed_count"] == 3.0
    assert finished.data.metrics["total_count"] == 4.0
    assert finished.data.metrics["duration_seconds"] >= 0.0

    assert (failed.info.status, failed.info.run_name) == ("FAILED", REFUSES)
    assert failed.data.tags["visionset.job_state"] == "failed"
    assert failed.data.tags["visionset.error_code"] == "BATCH_NOT_FOUND"
    assert failed.data.tags["visionset.error_class"] == "BatchNotFound"
    assert "processed_count" not in failed.data.metrics

    for run in (finished, failed):
        recorded = json.dumps([run.data.tags, run.data.params, run.data.metrics])
        assert SECRET not in recorded
        assert str(tmp_path) not in recorded


@pytest.mark.parametrize(
    ("variables", "accept", "client_cert"),
    [
        pytest.param(
            {"MLFLOW_TRACKING_USERNAME": USERNAME, "MLFLOW_TRACKING_PASSWORD": PASSWORD},
            BASIC,
            False,
            id="basic",
        ),
        pytest.param({"MLFLOW_TRACKING_TOKEN": TOKEN}, BEARER, False, id="bearer"),
        pytest.param({"MLFLOW_TRACKING_TOKEN": TOKEN}, BEARER, True, id="bearer-client-cert"),
    ],
)
def test_an_authenticated_https_server_receives_the_run(
    server_url: str,
    reader: Any,
    experiment: str,
    pki: Pki,
    remote_environment: pytest.MonkeyPatch,
    variables: dict[str, str],
    accept: str,
    client_cert: bool,
) -> None:
    with serving_proxy(server_url, pki, accept=accept, require_client_cert=client_cert) as proxy:
        remote_environment.setenv("MLFLOW_TRACKING_URI", proxy.url)
        remote_environment.setenv("MLFLOW_TRACKING_SERVER_CERT_PATH", str(pki.ca))
        if client_cert:
            remote_environment.setenv("MLFLOW_TRACKING_CLIENT_CERT_PATH", str(pki.client_bundle))
        for name, value in variables.items():
            remote_environment.setenv(name, value)

        run_id = _record_one_run(experiment)

    assert run_id is not None
    assert proxy.refused == 0
    assert proxy.authorizations and set(proxy.authorizations) == {accept}
    run = reader.get_run(run_id)
    assert run.info.status == "FINISHED"
    assert run.data.metrics == {"processed_count": 7.0}
    assert run.data.tags["visionset.execution_source"] == "test"


def test_wrong_credentials_are_refused_and_record_nothing(
    server_url: str, reader: Any, experiment: str, pki: Pki, remote_environment: pytest.MonkeyPatch
) -> None:
    with serving_proxy(server_url, pki, accept=BASIC) as proxy:
        remote_environment.setenv("MLFLOW_TRACKING_URI", proxy.url)
        remote_environment.setenv("MLFLOW_TRACKING_SERVER_CERT_PATH", str(pki.ca))
        remote_environment.setenv("MLFLOW_TRACKING_USERNAME", USERNAME)
        remote_environment.setenv("MLFLOW_TRACKING_PASSWORD", "wrong")

        run_id = _record_one_run(experiment)

    assert run_id is None
    assert proxy.refused >= 1
    assert reader.get_experiment_by_name(experiment) is None


@pytest.mark.parametrize("client_cert", [False, True], ids=["untrusted-server", "no-client-cert"])
def test_a_tls_handshake_that_fails_sends_nothing(
    server_url: str,
    reader: Any,
    experiment: str,
    pki: Pki,
    remote_environment: pytest.MonkeyPatch,
    client_cert: bool,
) -> None:
    with serving_proxy(server_url, pki, accept=BEARER, require_client_cert=client_cert) as proxy:
        remote_environment.setenv("MLFLOW_TRACKING_URI", proxy.url)
        remote_environment.setenv("MLFLOW_TRACKING_TOKEN", TOKEN)
        if client_cert:
            remote_environment.setenv("MLFLOW_TRACKING_SERVER_CERT_PATH", str(pki.ca))

        run_id = _record_one_run(experiment)

    assert run_id is None
    assert proxy.authorizations == []
    assert reader.get_experiment_by_name(experiment) is None
