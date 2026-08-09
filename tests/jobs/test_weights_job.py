"""The weight-download handler, driven directly rather than through a route.

`tests/server/test_inference.py` runs this job through the 202-and-poll contract,
which is where its *outcome* belongs. What is left over is the handler's own
contract with the dispatcher — the payload it reads, the cancellation point it
honours, and the result it hands back for somebody to poll — and none of that
needs an application.

The download is faked. A real one is gigabytes over a network, which is neither a
unit test nor a thing CI should do; everything else here is the shipped code.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from visionset.inference import weights as weights_module
from visionset.jobs import REGISTRY
from visionset.jobs.weights import JOB_TYPE, payload_for, run
from visionset.kernel.domain import ConnectionSetupState, ConnectionType, ItemFailure
from visionset.kernel.services import InferenceConnectionService, WorkspaceService


class Reporter:
    """Two counters and a boolean, which is what a `ProgressReporter` double is.

    The shape `kernel/ports/progress_reporter.py` says a handler should be
    testable against: no database anywhere near it.
    """

    def __init__(self, *, cancelled: bool = False) -> None:
        self._cancelled = cancelled
        self.reports: list[tuple[int, int | None]] = []

    def report(
        self,
        *,
        processed: int,
        total: int | None = None,
        failures: Sequence[ItemFailure] = (),
    ) -> None:
        self.reports.append((processed, total))

    def is_cancelled(self) -> bool:
        return self._cancelled


@pytest.fixture()
def root(tmp_path: Path) -> Iterator[Path]:
    """A workspace with one local connection in it, closed before the handler runs.

    Closed deliberately: the handler is handed a *root* and opens its own handle,
    because measured against a real workspace neither the service nor the store
    nor the engine will pickle. Leaving one open here would test a path a worker
    never takes.
    """
    made = WorkspaceService.init(tmp_path / "ws", name="weights")
    try:
        InferenceConnectionService(made).create(
            "local-gd",
            connection_type=ConnectionType.LOCAL,
            model_id="some/model",
            model_revision="abc123",
            device="cuda",
            precision="fp16",
        )
    finally:
        made.close()
    yield tmp_path / "ws"


def only_connection(root: Path) -> UUID:
    with WorkspaceService.open(root) as service:
        return InferenceConnectionService(service).list()[0].id


def setup_state(root: Path) -> ConnectionSetupState:
    with WorkspaceService.open(root) as service:
        return InferenceConnectionService(service).list()[0].setup_state


@pytest.fixture()
def fetched(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[str]:
    seen: list[str] = []

    def _download(connection: object, *, into: Path) -> Path:
        seen.append(connection.model_id)
        return tmp_path / "snapshot"

    monkeypatch.setattr(weights_module, "download", _download)
    return seen


# --- registration -------------------------------------------------------------


def test_the_type_is_registered_and_idempotent() -> None:
    """Idempotent because it is: a snapshot already in the cache is verified
    rather than re-fetched, and recording a ready connection ready again returns
    it unchanged. That is what makes an orphan safe to re-queue after a crash."""
    ref = REGISTRY[JOB_TYPE]
    assert ref.func == "visionset.jobs.weights:run"
    assert ref.idempotent


def test_the_payload_is_built_where_the_type_is_known() -> None:
    """One place names the key and the same place reads it.

    A route spelling `{"connection_id": ...}` by hand would be free to spell it
    differently, and the mismatch would surface as a `KeyError` inside a worker.
    """
    connection_id = uuid4()
    assert payload_for(connection_id) == {"connection_id": str(connection_id)}


# --- running ------------------------------------------------------------------


def test_a_finished_run_reports_its_result_for_whoever_polls(
    root: Path, fetched: list[str]
) -> None:
    connection_id = only_connection(root)
    reporter = Reporter()

    result = run(root, payload_for(connection_id), reporter)

    assert result["connection_id"] == str(connection_id)
    assert result["setup_state"] == "ready"
    assert result["model_id"] == "some/model"
    assert result["model_revision"] == "abc123"
    assert reporter.reports == [(1, 1)]
    assert setup_state(root) is ConnectionSetupState.READY
    assert fetched == ["some/model"]


def test_a_cancelled_run_fetches_nothing_and_changes_nothing(
    root: Path, fetched: list[str]
) -> None:
    """The honest cancellation point is the one before any bytes are fetched.

    What follows is a single library call that writes a cache and reports
    nothing this process can subdivide, so `export`'s rule applies: consult the
    reporter once, before starting, and not during.
    """
    assert run(root, payload_for(only_connection(root)), Reporter(cancelled=True)) == {}
    assert fetched == []
    assert setup_state(root) is ConnectionSetupState.NOT_SET_UP


def test_a_second_run_verifies_and_settles_rather_than_failing(
    root: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """**The idempotency claimed at registration, on the path a crash takes.**

    `sweep_orphans` re-enqueues an idempotent orphan as a *new* job, so a crash
    between the state flip committing and the row settling produces exactly this:
    a second run against a connection that is now `ready`. The route's gate
    cannot protect it — a retry does not go through a route — and refusing here
    would fail a job whose work is done.

    So it re-checks: the download is entered again (a snapshot download finds
    what the cache already holds and fetches only what is missing) and the write
    below is a no-op. The result is the same result, which is what the caller
    polling the row needs it to be.
    """
    calls: list[str] = []
    monkeypatch.setattr(
        weights_module,
        "download",
        lambda connection, *, into: (calls.append(connection.model_id), tmp_path)[1],
    )
    connection_id = only_connection(root)
    first = run(root, payload_for(connection_id), Reporter())

    assert run(root, payload_for(connection_id), Reporter()) == first
    assert calls == ["some/model", "some/model"]
    assert setup_state(root) is ConnectionSetupState.READY


def test_a_retry_is_still_refused_for_a_kind_with_no_weights(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The kind half of the gate is the half that never relaxed.

    #469 made the state half unconditional — a `ready` connection can be asked
    to re-check its own cache — and left this exactly where it was: a connection
    with no weights of its own has none on the second attempt either, so the
    handler refuses rather than reaching a download that would have nothing to
    do.
    """
    from visionset.kernel.errors import InferenceConnectionNotDownloadable

    made = WorkspaceService.init(tmp_path / "ws", name="weights")
    try:
        remote = InferenceConnectionService(made).create(
            "remote",
            connection_type=ConnectionType.HTTP,
            model_id="some/model",
            model_revision="abc123",
            endpoint_url="https://example.invalid/predict",
        )
    finally:
        made.close()

    with pytest.raises(InferenceConnectionNotDownloadable):
        run(tmp_path / "ws", payload_for(remote.id), Reporter())


def test_a_failure_leaves_the_connection_where_it_was(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No half-ready row, because the state flip is the last statement."""

    def _explode(connection: object, *, into: Path) -> Path:
        raise OSError("the disk filled")

    monkeypatch.setattr(weights_module, "download", _explode)
    with pytest.raises(OSError, match="the disk filled"):
        run(root, payload_for(only_connection(root)), Reporter())
    assert setup_state(root) is ConnectionSetupState.NOT_SET_UP
