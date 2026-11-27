"""Inline runs from the CLI and the MCP server, held to the background path's allowlists.

Each operation runs three ways against one workspace — as a background job
through ``execute``, as a command, and as a tool — and the three runs must
carry the same keys and values, differing only in the identifiers that name a
different row and in ``visionset.execution_source``. Only the tracker is in
memory, and only the network half of a weight download and the model behind a
pre-label are faked.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from tests.cli import _flow as cli
from tests.fixtures.media import write_images
from tests.fixtures.tracking import ENABLED, FakeTracker, Recorded
from tests.mcp import _flow as mcp

from visionset.inference import prelabel as prelabel_module
from visionset.inference import weights as weights_module
from visionset.jobs import REGISTRY, _tracking, export, ingest, prelabel, weights
from visionset.jobs import inline as inline_module
from visionset.jobs._tracking import AttemptTracking
from visionset.jobs._worker import execute
from visionset.kernel.domain import (
    AssetPrediction,
    BackgroundJobSpec,
    BackgroundJobState,
    BboxGeometry,
    ConnectionType,
    DownloadSize,
    GeometryType,
    ModelCapability,
    PredictedRegion,
    ServedFamily,
)
from visionset.kernel.errors import TrackingUnavailable
from visionset.kernel.services import (
    WORKSPACE_ENV_VAR,
    InferenceConnectionService,
    IngestService,
    ProjectService,
    ReleaseService,
    SourceService,
    WorkspaceService,
)
from visionset.tracking import RunStatus, tracking_settings

COMMIT = "0123456789abcdef0123456789abcdef01234567"
MODEL_REF = f"acme/detector@{COMMIT}"
FETCHED_BYTES = 4_000_000_000
SENSITIVE = "confidential"

#: Tags whose value names the run or its row, and so differs between equivalent runs.
PER_RUN = {"visionset.execution_id", "visionset.execution_source"}
BACKGROUND_ONLY = {"visionset.job_id", "visionset.attempt"}


@pytest.fixture(autouse=True)
def _environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)
    for name in ("VISIONSET_MLFLOW_ENABLED", "VISIONSET_MLFLOW_EXPERIMENT", "MLFLOW_TRACKING_URI"):
        monkeypatch.setenv(name, "placeholder")
        monkeypatch.delenv(name)
    tracking_settings.cache_clear()
    yield
    tracking_settings.cache_clear()


@pytest.fixture()
def enabled(monkeypatch: pytest.MonkeyPatch, tracker: FakeTracker) -> FakeTracker:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    tracking_settings.cache_clear()
    return tracker


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    made = cli.workspace(tmp_path)
    monkeypatch.setenv(WORKSPACE_ENV_VAR, str(made))
    return made


def _background(root: Path, job_type: str, payload: dict[str, Any]) -> Any:
    with WorkspaceService.open(root) as service:
        job = service.job_queue.enqueue(BackgroundJobSpec(type=job_type, payload=payload))
        service.job_queue.claim("test")
    attempt = AttemptTracking(
        settings=ENABLED, execution_id=uuid4(), job_id=job.id, job_type=job_type, attempt=1
    )
    return execute(REGISTRY[job_type], root, job.id, payload, 0, attempt)


def _reset(tracker: FakeTracker) -> None:
    """Forget the runs a test's setup opened through the same commands."""
    assert _tracking.flush(10)
    tracker.runs.clear()


def _by_source(tracker: FakeTracker) -> dict[str, list[Recorded]]:
    assert _tracking.flush(10)
    grouped: dict[str, list[Recorded]] = {}
    for run in tracker.runs.values():
        grouped.setdefault(run.tags["visionset.execution_source"], []).append(run)
    return grouped


def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
    except ValueError:
        return False
    return True


def _shape(run: Recorded) -> tuple[Any, ...]:
    """Everything a run sent, with each identifier reduced to the fact that it was sent."""
    tags = {
        key: "<id>" if _is_uuid(value) else value
        for key, value in run.tags.items()
        if key not in PER_RUN | BACKGROUND_ONLY
    }
    metrics = {key: value for key, value in run.metrics.items() if key != "duration_seconds"}
    return run.name, run.status, tags, run.params, metrics


def _assert_parity(
    tracker: FakeTracker, *, inline_rows: bool = False
) -> tuple[Recorded, Recorded, Recorded]:
    grouped = _by_source(tracker)
    assert {source: len(runs) for source, runs in grouped.items()} == {
        "background_job": 1,
        "cli": 1,
        "mcp": 1,
    }
    [queued], [command], [tool] = grouped["background_job"], grouped["cli"], grouped["mcp"]
    assert _shape(command) == _shape(queued)
    assert _shape(tool) == _shape(queued)
    assert "duration_seconds" in command.metrics and "duration_seconds" in tool.metrics
    assert set(queued.tags) >= BACKGROUND_ONLY
    for inline in (command, tool):
        expected = set(queued.tags) if inline_rows else set(queued.tags) - BACKGROUND_ONLY
        assert set(inline.tags) == expected
        assert inline.tags["visionset.execution_id"] != queued.tags["visionset.execution_id"]
    assert command.tags["visionset.execution_id"] != tool.tags["visionset.execution_id"]
    return queued, command, tool


# --- export ---------------------------------------------------------------------


def _release(root: Path, tmp_path: Path) -> tuple[str, UUID]:
    project = cli.published_release(root, tmp_path)
    with WorkspaceService.open(root) as service:
        found = ReleaseService(service).resolve(project, "v1.0")
    return project, found.id


def test_an_export_from_a_command_or_a_tool_sends_what_a_background_export_sends(
    root: Path, tmp_path: Path, enabled: FakeTracker
) -> None:
    project, release_id = _release(root, tmp_path)
    _reset(enabled)

    _background(
        root, export.JOB_TYPE, export.payload_for(release_id, "coco", target=None, allow_lossy=True)
    )
    printed = cli.payload(
        root,
        "export",
        "-p",
        project,
        "--release",
        "v1.0",
        "--format",
        "coco",
        "--allow-lossy",
        "--out",
        str(tmp_path / f"{SENSITIVE}-cli"),
    )
    answered = mcp.payload(
        mcp.call(
            "export_release",
            project=project,
            tag="v1.0",
            format="coco",
            allow_lossy=True,
            dest=str(tmp_path / f"{SENSITIVE}-mcp"),
        )
    )

    queued, command, tool = _assert_parity(enabled)
    for run in (queued, command, tool):
        assert run.status is RunStatus.FINISHED
        assert run.tags["visionset.release_id"] == str(release_id)
        assert run.metrics["output_bytes"] > 0
        assert run.params["release_manifest_hash"]
        [dataset] = run.datasets
        assert dataset.context == "export"
    assert command.datasets == queued.datasets == tool.datasets
    assert command.metrics["output_bytes"] == float(printed["total_bytes"])
    assert tool.metrics["output_bytes"] == float(answered["total_bytes"])
    assert command.tags["visionset.execution_source"] == "cli"
    assert tool.tags["visionset.execution_source"] == "mcp"
    for run in (command, tool):
        assert SENSITIVE not in repr(run) and str(tmp_path) not in repr(run)


def test_a_refused_export_fails_its_run_and_the_refusal_reaches_the_caller_unchanged(
    root: Path, tmp_path: Path, enabled: FakeTracker
) -> None:
    project, _ = _release(root, tmp_path)
    occupied = tmp_path / "occupied"
    occupied.mkdir()
    (occupied / "keep.txt").write_text("mine")
    _reset(enabled)

    result = cli.run(
        root, "export", "-p", project, "--release", "v1.0", "--format", "coco",
        "--allow-lossy", "--out", str(occupied), "--json",
    )  # fmt: skip

    assert result.exit_code == 1
    assert result.stdout.strip().startswith("{")
    assert json.loads(result.stdout)["error"]["code"] == "EXPORT_DESTINATION_NOT_EMPTY"
    [run] = _by_source(enabled)["cli"]
    assert run.status is RunStatus.FAILED
    assert run.tags["visionset.job_state"] == "failed"
    assert run.tags["visionset.error_code"] == "EXPORT_DESTINATION_NOT_EMPTY"
    assert set(run.metrics) == {"duration_seconds"}
    assert run.datasets == []


# --- ingest ---------------------------------------------------------------------


def test_an_ingest_from_a_command_or_a_tool_sends_what_a_background_ingest_sends(
    root: Path, tmp_path: Path, enabled: FakeTracker
) -> None:
    folders = {}
    for name in ("queued", "command", "tool"):
        folders[name] = tmp_path / f"{SENSITIVE}-{name}"
        write_images(folders[name], count=3, prefix=SENSITIVE)
        cli.ok(root, "project", "create", f"{SENSITIVE}-{name}")
    with WorkspaceService.open(root) as service:
        project = ProjectService(service).get_by_name(f"{SENSITIVE}-queued")
        source = SourceService(service).register_images(project.id, folders["queued"])
        pending = IngestService(service).enqueue(source.id, batch_name=SENSITIVE)
    _reset(enabled)

    _background(root, ingest.JOB_TYPE, ingest.payload_for(pending.id))
    printed = cli.payload(
        root, "ingest", str(folders["command"]), "-p", f"{SENSITIVE}-command", "--batch-name", "b"
    )
    answered = mcp.payload(
        mcp.call("ingest", project=f"{SENSITIVE}-tool", path=str(folders["tool"]))
    )

    queued, command, tool = _assert_parity(enabled)
    assert command.metrics == {**command.metrics, "created_asset_count": 3.0, "asset_count": 3.0}
    assert command.metrics["processed_count"] == 3.0
    assert command.tags["visionset.ingest_job_id"] == printed["job_id"]
    assert tool.tags["visionset.ingest_job_id"] == answered["ingest_job_id"]
    assert tool.tags["visionset.batch_id"] == answered["batch_id"]
    for run in (command, tool):
        assert {"visionset.source_id", "visionset.batch_id"} <= set(run.tags)
        assert SENSITIVE not in repr(run) and str(tmp_path) not in repr(run)


# --- weight download -------------------------------------------------------------


@pytest.fixture()
def downloadable(root: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[UUID]:
    def download(connection: Any, *, into: Path, on_bytes: Any = None) -> Path:
        if callable(on_bytes):
            on_bytes(FETCHED_BYTES // 2)
        return tmp_path / f"{SENSITIVE}-cache"

    monkeypatch.setattr(weights_module, "download", download)
    monkeypatch.setattr(weights_module, "family_of", lambda *_, **__: "sam2")
    monkeypatch.setattr(
        weights_module,
        "download_size",
        lambda model_id, model_revision: DownloadSize(
            model_id=model_id,
            model_revision=model_revision,
            total_bytes=FETCHED_BYTES,
            file_count=2,
        ),
    )
    with WorkspaceService.open(root) as service:
        return [
            InferenceConnectionService(service)
            .create(
                f"{SENSITIVE}-{index}",
                connection_type=ConnectionType.LOCAL,
                model_id="some-org/some-model",
                model_revision=COMMIT,
                device="cpu",
                precision="fp32",
                provider_id="sam",
            )
            .id
            for index in range(3)
        ]


def test_a_download_from_a_command_or_a_tool_sends_what_a_background_download_sends(
    root: Path, enabled: FakeTracker, downloadable: list[UUID]
) -> None:
    queued_id, command_id, tool_id = downloadable
    _reset(enabled)

    _background(root, weights.JOB_TYPE, weights.payload_for(queued_id))
    cli.ok(root, "inference", "download", str(command_id))
    mcp.payload(mcp.call("download_connection_weights", connection=str(tool_id)))

    queued, command, tool = _assert_parity(enabled)
    assert command.metrics["bytes_done"] == float(FETCHED_BYTES)
    assert command.metrics["bytes_total"] == float(FETCHED_BYTES)
    assert command.params == {
        "model_id": "some-org/some-model",
        "model_revision": COMMIT,
        "model_provider": "sam",
        "model_family": "sam2",
    }
    assert command.tags["visionset.connection_id"] == str(command_id)
    assert tool.tags["visionset.connection_id"] == str(tool_id)


# --- pre-label ------------------------------------------------------------------


class _Predictor:
    def predict(self, request: Any) -> Any:
        region = PredictedRegion(
            label="sign", confidence=0.9, geometry=BboxGeometry(x=1, y=2, width=3, height=4)
        )
        return (
            AssetPrediction(asset_id=target.asset_id, model_ref=MODEL_REF, regions=(region,))
            for target in request.targets
        )


class _Pool:
    def get(self, connection: object, *, workspace_root: Path) -> object:
        return _Predictor()

    def served(self, connection: object, *, workspace_root: Path) -> ServedFamily:
        return ServedFamily(
            capability=ModelCapability.TEXT_DETECT, produces=frozenset({GeometryType.BBOX})
        )


@pytest.fixture()
def predicting(root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    monkeypatch.setattr(prelabel_module, "resident", lambda: _Pool())
    _, batch = cli.started_batch(root, tmp_path, jobs_of=2)
    connection = cli.payload(
        root, "inference", "create", f"{SENSITIVE}-detector", "--type", "local",
        "--model", "acme/detector", "--revision", COMMIT, "--device", "cpu",
        "--precision", "fp32",
    )["id"]  # fmt: skip
    return batch, connection


def _inline_rows(root: Path) -> dict[UUID, Any]:
    with WorkspaceService.open(root) as service:
        return {row.id: row for row in service.job_queue.list() if row.worker == "inline"}


def test_a_pre_label_from_a_command_or_a_tool_sends_what_a_background_pre_label_sends(
    root: Path, enabled: FakeTracker, predicting: tuple[str, str]
) -> None:
    batch, connection = predicting
    queued_job, command_job, tool_job = cli.jobs_of(root, batch)
    _reset(enabled)

    _background(
        root,
        prelabel.JOB_TYPE,
        prelabel.payload_for(UUID(queued_job), UUID(batch), UUID(connection), 0.5),
    )
    cli.ok(root, "job", "pre-label", command_job, connection, "--minimum-confidence", "0.5")
    mcp.payload(
        mcp.call("pre_label_job", job_id=tool_job, connection=connection, minimum_confidence=0.5)
    )

    queued, command, tool = _assert_parity(enabled, inline_rows=True)
    assert command.params == {
        "minimum_confidence": 0.5,
        "replace_model_labels": False,
        "model_id": "acme/detector",
        "model_revision": COMMIT,
    }
    assert command.metrics == {
        **command.metrics,
        "processed_count": 2.0,
        "total_count": 2.0,
        "annotations_written_count": 2.0,
    }
    rows = _inline_rows(root)
    assert len(rows) == 2
    for run, job in ((command, command_job), (tool, tool_job)):
        assert run.tags["visionset.annotation_job_id"] == job
        [row] = [row for row in rows.values() if row.payload["annotation_job_id"] == job]
        assert row.state is BackgroundJobState.SUCCEEDED
        assert run.tags["visionset.job_id"] == str(row.id)
        assert run.tags["visionset.attempt"] == "1"


def test_a_batch_or_project_pre_label_opens_one_run_per_row_it_writes_and_no_more(
    root: Path, enabled: FakeTracker, predicting: tuple[str, str]
) -> None:
    batch, connection = predicting
    _reset(enabled)

    cli.ok(root, "batch", "pre-label", batch, connection)
    cli_rows = _inline_rows(root)
    mcp.payload(mcp.call("pre_label_project", project="road-signs", connection=connection))

    grouped = _by_source(enabled)
    assert set(grouped) == {"cli", "mcp"}
    rows = _inline_rows(root)
    assert len(cli_rows) == 3
    assert len(rows) == 6
    assert sorted(run.tags["visionset.job_id"] for run in grouped["cli"]) == sorted(
        map(str, cli_rows)
    )
    assert sorted(run.tags["visionset.job_id"] for run in grouped["mcp"]) == sorted(
        str(row) for row in rows if row not in cli_rows
    )
    for run in [*grouped["cli"], *grouped["mcp"]]:
        assert run.status is RunStatus.FINISHED
        assert run.ends == 1


def test_a_background_pre_label_opens_no_inline_run(
    root: Path, enabled: FakeTracker, predicting: tuple[str, str]
) -> None:
    batch, connection = predicting
    job = cli.jobs_of(root, batch)[0]
    _reset(enabled)

    _background(
        root, prelabel.JOB_TYPE, prelabel.payload_for(UUID(job), UUID(batch), UUID(connection), 0.5)
    )

    assert {source: len(runs) for source, runs in _by_source(enabled).items()} == {
        "background_job": 1
    }
    assert _inline_rows(root) == {}


def test_a_pre_label_refused_before_its_row_is_written_opens_no_run(
    root: Path, enabled: FakeTracker, predicting: tuple[str, str]
) -> None:
    _, connection = predicting
    _reset(enabled)

    result = cli.run(root, "job", "pre-label", str(uuid4()), connection)

    assert result.exit_code == 1
    assert _by_source(enabled) == {}
    assert _inline_rows(root) == {}


def test_a_pre_label_that_fails_after_its_row_fails_its_run_with_the_rows_code(
    root: Path,
    enabled: FakeTracker,
    predicting: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    batch, connection = predicting
    job = cli.jobs_of(root, batch)[0]

    class Broken(_Predictor):
        def predict(self, request: Any) -> Any:
            raise RuntimeError(f"{SENSITIVE} model fell over")

    monkeypatch.setattr(_Pool, "get", lambda *_, **__: Broken())
    _reset(enabled)

    result = cli.run(root, "job", "pre-label", job, connection)

    assert result.exit_code != 0
    [row] = _inline_rows(root).values()
    assert row.state is BackgroundJobState.FAILED
    [run] = _by_source(enabled)["cli"]
    assert run.status is RunStatus.FAILED
    assert run.tags["visionset.job_id"] == str(row.id)
    assert run.tags["visionset.error_class"] == "RuntimeError"
    assert SENSITIVE not in repr(run)


# --- best effort ----------------------------------------------------------------


def _export_argv(project: str, out: Path) -> list[str]:
    return [
        "export", "-p", project, "--release", "v1.0", "--format", "coco", "--allow-lossy",
        "--out", str(out), "--json",
    ]  # fmt: skip


def _without_directory(document: str) -> dict[str, Any]:
    parsed = json.loads(document)
    parsed.pop("directory")
    return parsed


def test_a_tracker_failing_at_every_step_changes_no_output_and_no_exit_code(
    root: Path, tmp_path: Path, tracker: FakeTracker, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, _ = _release(root, tmp_path)
    untracked = cli.run(root, *_export_argv(project, tmp_path / "a"))
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    tracking_settings.cache_clear()
    tracker.fail = {"start", "params", "metrics", "tags", "inputs", "end"}

    tracked = cli.run(root, *_export_argv(project, tmp_path / "b"))

    assert _tracking.flush(10)
    assert untracked.exit_code == tracked.exit_code == 0
    assert _without_directory(tracked.stdout) == _without_directory(untracked.stdout)
    assert tracker.runs == {}


def test_a_tracker_that_cannot_be_built_leaves_the_work_untracked_and_unchanged(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def refuse(settings: Any) -> Any:
        raise TrackingUnavailable("MLFLOW_TRACKING_URI is not set")

    monkeypatch.setattr(_tracking, "build_tracker", refuse)
    _tracking._TRACKERS.clear()
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    tracking_settings.cache_clear()
    project, _ = _release(root, tmp_path)

    result = cli.run(root, *_export_argv(project, tmp_path / "out"))

    _tracking._TRACKERS.clear()
    assert result.exit_code == 0
    assert json.loads(result.stdout)["format"] == "coco"
    assert "MLFLOW_TRACKING_URI is not set" in caplog.text
    assert "MLFLOW_TRACKING_URI" not in result.stdout


def test_an_unreadable_flag_runs_the_command_untracked_and_warns_once(
    root: Path,
    tmp_path: Path,
    tracker: FakeTracker,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    project, _ = _release(root, tmp_path)
    monkeypatch.setattr(inline_module, "_warned", inline_module.threading.Event())
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "maybe")
    tracking_settings.cache_clear()

    first = cli.run(root, *_export_argv(project, tmp_path / "one"))
    second = cli.run(root, *_export_argv(project, tmp_path / "two"))

    assert first.exit_code == second.exit_code == 0
    assert json.loads(first.stdout)["format"] == "coco"
    assert "VISIONSET_MLFLOW_ENABLED" not in first.stdout
    warnings = [r for r in caplog.records if "VISIONSET_MLFLOW_ENABLED" in r.getMessage()]
    assert len(warnings) == 1
    assert tracker.built == []  # type: ignore[attr-defined]


def test_disabled_tracking_builds_nothing_and_queues_nothing(
    root: Path,
    tmp_path: Path,
    tracker: FakeTracker,
    monkeypatch: pytest.MonkeyPatch,
    predicting: tuple[str, str],
    downloadable: list[UUID],
) -> None:
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://tracking.invalid:5000")
    queued: list[object] = []
    monkeypatch.setattr(_tracking._COURIER, "send", queued.append)
    batch, connection = predicting
    project = "road-signs"
    folder = tmp_path / "more"
    write_images(folder, count=2, prefix="more")
    ok_jobs = cli.jobs_of(root, batch)

    cli.ok(root, "job", "pre-label", ok_jobs[0], connection)
    cli.ok(root, "batch", "pre-label", batch, connection)
    cli.ok(root, "ingest", str(folder), "-p", project)
    cli.ok(root, "inference", "download", str(downloadable[0]))
    mcp.payload(mcp.call("pre_label_job", job_id=ok_jobs[1], connection=connection))
    mcp.payload(mcp.call("download_connection_weights", connection=str(downloadable[1])))
    assert len(_inline_rows(root)) == 5

    assert queued == []
    assert tracker.built == []  # type: ignore[attr-defined]
    assert inline_module.pre_label_observer(inline_module.Surface.CLI) is None
