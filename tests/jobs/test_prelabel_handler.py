"""The pre-labeling handler: registered, idempotent, and reporting in assets."""

from __future__ import annotations

from collections.abc import Iterator
from concurrent.futures import Executor, Future
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest

import visionset.inference.prelabel as prelabel_engine
from visionset.inference import PreLabelOutcome
from visionset.jobs import JobRunner, prelabel
from visionset.jobs.registry import known_types, resolve
from visionset.kernel.domain import (
    PRE_LABEL_JOB_TYPE,
    Asset,
    AssetPrediction,
    BackgroundJobSpec,
    BackgroundJobState,
    BboxGeometry,
    ConnectionType,
    GeometryType,
    LabelClass,
    PredictedRegion,
    PredictionRequest,
)
from visionset.kernel.services import (
    BatchService,
    InferenceConnectionService,
    JobService,
    ProjectService,
    SchemaService,
    WorkspaceService,
)


def test_the_type_is_registered_and_idempotent() -> None:
    """An orphan re-enqueued after a crash must be safe to run again."""
    assert PRE_LABEL_JOB_TYPE in known_types()
    assert resolve(PRE_LABEL_JOB_TYPE).idempotent is True


def test_the_payload_is_built_where_the_type_is_known() -> None:
    batch_id, connection_id = uuid4(), uuid4()

    payload = prelabel.payload_for(batch_id, connection_id, 0.35)

    assert payload["batch_id"] == str(batch_id)
    assert payload["connection_id"] == str(connection_id)
    assert payload["minimum_confidence"] == 0.35


def test_a_cancelled_run_does_nothing_and_says_so(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[object] = []
    monkeypatch.setattr(prelabel, "pre_label", lambda *a, **k: calls.append(a))

    class Cancelled:
        def is_cancelled(self) -> bool:
            return True

        def report(self, **_: object) -> None:
            raise AssertionError("a cancelled run reports nothing")

    assert prelabel.run(tmp_path, prelabel.payload_for(uuid4(), uuid4(), 0.35), Cancelled()) == {}
    assert calls == []


class Reporter:
    """Two counters and a boolean — the shape `kernel/ports/progress_reporter.py`
    says a handler should be testable against, with no database anywhere near it."""

    def __init__(self, *, cancelled: bool = False) -> None:
        self._cancelled = cancelled
        self.reports: list[tuple[int, int | None]] = []

    def report(self, *, processed: int, total: int | None = None, failures: object = ()) -> None:
        self.reports.append((processed, total))

    def is_cancelled(self) -> bool:
        return self._cancelled


def test_a_finished_run_reports_progress_and_returns_the_outcome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The positive path the cancellation test's absence assertion needs proven
    somewhere: `pre_label` is called, `should_stop` is the reporter's own method,
    and every `on_progress` call reaches the reporter."""
    captured: dict[str, Any] = {}

    def fake_pre_label(
        workspace: object,
        *,
        batch_id: UUID,
        connection_id: UUID,
        minimum_confidence: float,
        on_progress: Any,
        should_stop: Any,
    ) -> PreLabelOutcome:
        captured["batch_id"] = batch_id
        captured["connection_id"] = connection_id
        captured["minimum_confidence"] = minimum_confidence
        captured["should_stop"] = should_stop
        on_progress(1, 2)
        on_progress(2, 2)
        return PreLabelOutcome(
            assets_considered=2,
            assets_labeled=2,
            annotations_written=3,
            model_ref="acme/detector@abc123",
        )

    monkeypatch.setattr(prelabel, "pre_label", fake_pre_label)
    monkeypatch.setattr(prelabel, "workspace_for", lambda root: object())
    reporter = Reporter()
    batch_id, connection_id = uuid4(), uuid4()

    result = prelabel.run(
        Path("/does/not/matter"), prelabel.payload_for(batch_id, connection_id, 0.4), reporter
    )

    assert result == {
        "batch_id": str(batch_id),
        "assets_considered": 2,
        "assets_labeled": 2,
        "annotations_written": 3,
        "model_ref": "acme/detector@abc123",
        "stopped_early": False,
        "assets_skipped": 0,
    }
    assert captured["batch_id"] == batch_id
    assert captured["connection_id"] == connection_id
    assert captured["minimum_confidence"] == 0.4
    # The reporter's own method, not a wrapper around it — a loop can consult it
    # every iteration without this handler holding any state of its own.
    assert captured["should_stop"] == reporter.is_cancelled
    assert reporter.is_cancelled() is False
    assert reporter.reports == [(1, 2), (2, 2)]


# --- end to end: nobody polling ------------------------------------------------


class InlineExecutor(Executor):
    """Runs now, on this thread, capturing an exception on the future like a pool does.

    In-process rather than the real `spawn` pool, so `resident()` can be faked
    where the handler actually reaches it — a child interpreter would import a
    fresh, unpatched copy and there would be no torch install here to answer for
    real. `test_process_pool.py` is where the real pool earns its one test.
    """

    def submit(  # type: ignore[override]
        self, fn: Any, /, *args: Any, **kwargs: Any
    ) -> Future[Any]:
        future: Future[Any] = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:  # noqa: BLE001 — mirrors a real pool
            future.set_exception(exc)
        return future


class _FakeRunner:
    """A `ModelProvider` that always finds one box, so the pipeline writes something."""

    model_ref = "acme/detector@abc123"

    def predict(self, request: PredictionRequest) -> Iterator[AssetPrediction]:
        for target in request.targets:
            yield AssetPrediction(
                asset_id=target.asset_id,
                model_ref=self.model_ref,
                regions=(
                    PredictedRegion(
                        label="post",
                        confidence=0.9,
                        geometry=BboxGeometry(x=1.0, y=1.0, width=2.0, height=2.0),
                    ),
                ),
            )


class _FakePool:
    """A `ProviderPool` stand-in, resolved through `resident()` rather than
    handed in — the job handler never passes a pool, exactly as production does not."""

    def get(self, connection: object, *, workspace_root: Path) -> _FakeRunner:
        return _FakeRunner()


@pytest.fixture()
def queued_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[WorkspaceService, UUID]]:
    """A batch open for annotation, a connection, and the job already on the queue.

    `resident()` is faked at the point `pre_label` itself reaches it — the handler
    hands it nothing, so the pool a real run would build has to be replaced where
    it is looked up rather than where it is passed.
    """
    monkeypatch.setattr(prelabel_engine, "resident", lambda: _FakePool())
    workspace = WorkspaceService.init(tmp_path / "ws")
    project = ProjectService(workspace).create("prelabel-e2e")
    SchemaService(workspace).create_version(
        project.id, [LabelClass(name="post", geometries=(GeometryType.BBOX,))]
    )
    content_hash = workspace.blob_store.put(BytesIO(b"one-asset"))
    with workspace.unit_of_work() as uow:
        asset_id = uow.assets.add(
            Asset(project_id=project.id, content_hash=content_hash, uri="/tmp/one.png")
        ).id
    batches = BatchService(workspace)
    batch = batches.create(project.id, "first", [asset_id])
    batches.approve(batch.id)
    job_id = batches.jobs(batch.id)[0].id
    batches.start(batch.id)
    JobService(workspace).start(job_id)
    connection = InferenceConnectionService(workspace).create(
        "e2e-connection",
        connection_type=ConnectionType.HTTP,
        model_id="acme/detector",
        model_revision="abc123",
        endpoint_url="https://example.invalid/predict",
    )

    job = workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=PRE_LABEL_JOB_TYPE,
            payload=prelabel.payload_for(batch.id, connection.id, 0.35),
            idempotent=True,
        )
    )
    yield workspace, job.id
    workspace.close()


def test_the_row_settles_succeeded_with_nobody_polling(
    queued_job: tuple[WorkspaceService, UUID],
) -> None:
    """Nothing here reads the row in a loop: `drain()` is the dispatcher's own
    claim loop run to completion, and the line after it reads the settled row
    once — the property `weights.py` states and `test_dispatcher.py` holds for
    every handler through the same seam."""
    workspace, job_id = queued_job
    runner = JobRunner(
        workspace.job_queue,
        workspace.root,
        event_bus=workspace.event_bus,
        workers=1,
        progress_min_interval_s=0,
        executor_factory=lambda _: InlineExecutor(),
    )

    assert runner.drain() == 1

    stored = workspace.job_queue.get(job_id)
    assert stored is not None
    assert stored.state is BackgroundJobState.SUCCEEDED
    assert stored.result is not None
    assert stored.result["assets_considered"] == 1
    assert stored.result["assets_labeled"] == 1
    assert stored.result["model_ref"] == "acme/detector@abc123"
