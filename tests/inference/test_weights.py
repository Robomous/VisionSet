"""Fetching weights: where they land, what order it happens in, and what a
failure leaves behind.

The download itself is faked — a real one is gigabytes over a network, which is
neither a unit test nor a thing CI should do — but everything around it is the
shipped code: the gate, the ordering that makes a crash safe, the write that
records the connection ready, and the translation of a library's exception into
one the kernel owns.

`tests/server/test_inference.py` drives the same sequence through the background
job and the route; this file is the sequence itself.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from visionset.inference import MODULES, cache_root, fetch_weights
from visionset.inference import weights as weights_module
from visionset.inference.weights import MODELS_DIRNAME, download
from visionset.kernel.domain import (
    ConnectionSetupState,
    ConnectionType,
    InferenceConnection,
)
from visionset.kernel.errors import (
    InferenceConnectionNotDownloadable,
    InferenceConnectionNotFound,
    LocalInferenceUnavailable,
)
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

EXTRA_INSTALLED = all(importlib.util.find_spec(name) is not None for name in MODULES)


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws", name="weights")
    try:
        yield made
    finally:
        made.close()


@pytest.fixture()
def connections(workspace: WorkspaceService) -> InferenceConnectionService:
    return InferenceConnectionService(workspace)


def a_local(connections: InferenceConnectionService, name: str = "local-gd") -> Any:
    return connections.create(
        name,
        connection_type=ConnectionType.LOCAL,
        model_id="some/model",
        model_revision="abc123",
        device="cuda",
        precision="fp16",
    )


def an_http(connections: InferenceConnectionService, name: str = "remote") -> Any:
    return connections.create(
        name,
        connection_type=ConnectionType.HTTP,
        model_id="some/model",
        model_revision="abc123",
        endpoint_url="https://example.invalid/predict",
    )


@pytest.fixture()
def fetched(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[tuple[str, Path]]:
    """Record the download's arguments and write nothing."""
    seen: list[tuple[str, Path]] = []

    def _download(connection: InferenceConnection, *, into: Path) -> Path:
        seen.append((f"{connection.model_id}@{connection.model_revision}", into))
        return tmp_path / "snapshot"

    monkeypatch.setattr(weights_module, "download", _download)
    return seen


# --- where the cache lives ----------------------------------------------------


def test_the_cache_is_under_the_workspace(tmp_path: Path) -> None:
    """A workspace somebody copies is a workspace whose model came with it.

    The alternative — a shared cache in a home directory — makes "does this
    workspace run?" a question about the machine, which is the local-first
    promise inverted.
    """
    assert cache_root(tmp_path) == tmp_path / MODELS_DIRNAME


def test_one_cache_for_the_whole_workspace_rather_than_one_per_connection(
    connections: InferenceConnectionService, workspace: WorkspaceService, fetched: list
) -> None:
    """Two connections pinned to the same weights share the files.

    The download library addresses its cache by content, so a directory apiece
    would hold two copies of six gigabytes for no gain.
    """
    fetch_weights(workspace, a_local(connections, "one").id)
    fetch_weights(workspace, a_local(connections, "two").id)
    assert [into for _, into in fetched] == [cache_root(workspace.root)] * 2


# --- the sequence -------------------------------------------------------------


def test_a_finished_download_leaves_the_connection_ready(
    connections: InferenceConnectionService, workspace: WorkspaceService, fetched: list
) -> None:
    made = a_local(connections)
    assert made.setup_state is ConnectionSetupState.NOT_SET_UP

    ready = fetch_weights(workspace, made.id)
    assert ready.setup_state is ConnectionSetupState.READY
    assert connections.get(made.id).setup_state is ConnectionSetupState.READY
    assert fetched == [("some/model@abc123", cache_root(workspace.root))]


def test_the_pinned_revision_is_what_is_asked_for(
    connections: InferenceConnectionService, workspace: WorkspaceService, fetched: list
) -> None:
    """Never defaulted to a branch. Quietly fetching `main` when a pin does not
    resolve would produce weights whose identity the row now misdescribes."""
    made = connections.create(
        "pinned",
        connection_type=ConnectionType.LOCAL,
        model_id="org/model",
        model_revision="0f1e2d3c",
        device="cpu",
        precision="fp32",
    )
    fetch_weights(workspace, made.id)
    assert fetched[0][0] == "org/model@0f1e2d3c"


def test_a_failed_download_leaves_the_connection_exactly_where_it_was(
    connections: InferenceConnectionService,
    workspace: WorkspaceService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """**Never a half-ready state**, and it is an ordering rather than a guard.

    The state flip is the last statement of `fetch_weights`, so a run that dies
    before it has written nothing at all — which is what makes the failure safe
    without a rollback, a sentinel state, or a version column.
    """

    def _explode(connection: InferenceConnection, *, into: Path) -> Path:
        raise OSError("the disk filled")

    monkeypatch.setattr(weights_module, "download", _explode)
    made = a_local(connections)

    with pytest.raises(OSError, match="the disk filled"):
        fetch_weights(workspace, made.id)
    assert connections.get(made.id).setup_state is ConnectionSetupState.NOT_SET_UP


def test_the_phases_are_reported_in_order(
    connections: InferenceConnectionService, workspace: WorkspaceService, fetched: list
) -> None:
    """A phase and not a count, because a count over files nobody asked about is
    a number that looks like progress without being any."""
    said: list[str] = []
    fetch_weights(workspace, a_local(connections).id, on_progress=said.append)
    assert said == ["fetching some/model at abc123", "recording the connection as ready"]


def test_reporting_is_optional(
    connections: InferenceConnectionService, workspace: WorkspaceService, fetched: list
) -> None:
    assert fetch_weights(workspace, a_local(connections).id).setup_state is (
        ConnectionSetupState.READY
    )


# --- the gate -----------------------------------------------------------------


def test_a_connection_that_is_already_set_up_is_refused(
    connections: InferenceConnectionService, workspace: WorkspaceService, fetched: list
) -> None:
    made = a_local(connections)
    fetch_weights(workspace, made.id)

    with pytest.raises(InferenceConnectionNotDownloadable, match="already set up"):
        fetch_weights(workspace, made.id)
    assert len(fetched) == 1


def test_an_http_connection_is_refused_before_anything_is_fetched(
    connections: InferenceConnectionService, workspace: WorkspaceService, fetched: list
) -> None:
    with pytest.raises(InferenceConnectionNotDownloadable, match="runs elsewhere|no weights"):
        fetch_weights(workspace, an_http(connections).id)
    assert fetched == []


def test_an_unknown_connection_is_not_found(workspace: WorkspaceService, fetched: list) -> None:
    with pytest.raises(InferenceConnectionNotFound):
        fetch_weights(workspace, uuid4())
    assert fetched == []


def test_recording_a_ready_connection_ready_again_changes_nothing(
    connections: InferenceConnectionService, workspace: WorkspaceService, fetched: list
) -> None:
    """The idempotency the job handler's registration claims.

    A crash after the commit and before the row settled means a retry arrives at
    a connection a previous attempt already finished; refusing that would fail a
    job whose work is done.
    """
    made = a_local(connections)
    ready = fetch_weights(workspace, made.id)
    again = connections.record_weights_ready(made.id)
    assert again.setup_state is ConnectionSetupState.READY
    assert again.updated_at == ready.updated_at


def test_recording_an_unknown_connection_ready_is_not_found(
    connections: InferenceConnectionService,
) -> None:
    with pytest.raises(InferenceConnectionNotFound):
        connections.record_weights_ready(uuid4())


# --- the library boundary -----------------------------------------------------


def test_downloading_for_an_http_connection_refuses_rather_than_fetching_nothing() -> None:
    """`download` is public, so a caller reaching it directly gets the sentence.

    Unreachable through `fetch_weights` — the gate refuses first — and kept
    because a public function that quietly did nothing for half its inputs is a
    worse answer than one that says so.
    """
    remote = InferenceConnection(
        name="remote",
        connection_type=ConnectionType.HTTP,
        model_id="some/model",
        model_revision="abc123",
        endpoint_url="https://example.invalid/predict",
        setup_state=ConnectionSetupState.READY,
    )
    with pytest.raises(LocalInferenceUnavailable, match="runs its model elsewhere"):
        download(remote, into=Path("/nowhere"))


@pytest.mark.skipif(EXTRA_INSTALLED, reason="the local runtime is installed here")
def test_a_missing_hub_client_names_the_install_command(tmp_path: Path) -> None:
    """The translation, unstubbed: an `ImportError` becomes a kernel error whose
    message is the remedy."""
    made = InferenceConnection(
        name="local-gd",
        connection_type=ConnectionType.LOCAL,
        model_id="some/model",
        model_revision="abc123",
        device="cpu",
        precision="fp32",
    )
    with pytest.raises(LocalInferenceUnavailable) as raised:
        download(made, into=tmp_path / MODELS_DIRNAME)
    assert 'pip install "visionset[local-inference]"' in str(raised.value)


def test_a_download_failure_arrives_in_the_kernels_vocabulary(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Every way a fetch can fail is a different class in the hub client, and a
    caller must not have to know any of them.

    The same translation `_built` does for pydantic: nothing from outside the
    kernel's vocabulary escapes, so a failed job carries a sentence rather than a
    library traceback.
    """

    class FakeHub:
        @staticmethod
        def snapshot_download(**_: object) -> str:
            raise ValueError("404 Client Error: Repository Not Found")

    monkeypatch.setattr(weights_module, "imported", lambda name: FakeHub)
    made = InferenceConnection(
        name="local-gd",
        connection_type=ConnectionType.LOCAL,
        model_id="some/model",
        model_revision="abc123",
        device="cpu",
        precision="fp32",
    )
    with pytest.raises(LocalInferenceUnavailable) as raised:
        download(made, into=tmp_path / MODELS_DIRNAME)
    assert "could not fetch some/model at abc123" in str(raised.value)
    assert "Repository Not Found" in str(raised.value)


def test_the_cache_directory_is_created_by_the_download(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Not by opening a workspace: a workspace that never downloads a model never
    grows the directory, which keeps `models/` a statement that something was
    fetched rather than a stub."""
    into = tmp_path / MODELS_DIRNAME
    assert not into.exists()

    class FakeHub:
        @staticmethod
        def snapshot_download(**_: object) -> str:
            return str(into / "snapshot")

    monkeypatch.setattr(weights_module, "imported", lambda name: FakeHub)
    made = InferenceConnection(
        name="local-gd",
        connection_type=ConnectionType.LOCAL,
        model_id="some/model",
        model_revision="abc123",
        device="cpu",
        precision="fp32",
    )
    assert download(made, into=into) == into / "snapshot"
    assert into.is_dir()
