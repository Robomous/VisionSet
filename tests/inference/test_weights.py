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

from visionset.inference import MODULES, cache_root, fetch_weights, with_families
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


#: What the faked config declares. A real family rather than a placeholder,
#: because the point of recording it is that a client can act on it.
DOWNLOADED_FAMILY = "sam2"


@pytest.fixture()
def fetched(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[tuple[str, Path]]:
    """Record the download's arguments and write nothing.

    The config read that follows the download is faked here too, and not only
    for speed: the real one imports ``transformers``, and
    ``test_configuring_a_connection_reaches_no_model_runtime`` asserts that a
    full-suite process has not imported it. A fixture that dragged it in would
    fail a test three directories away, in a run whose order decided it.
    """
    seen: list[tuple[str, Path]] = []

    def _download(connection: InferenceConnection, *, into: Path) -> Path:
        seen.append((f"{connection.model_id}@{connection.model_revision}", into))
        return tmp_path / "snapshot"

    monkeypatch.setattr(weights_module, "download", _download)
    monkeypatch.setattr(weights_module, "family_of", lambda *_, **__: DOWNLOADED_FAMILY)
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


def test_a_finished_download_records_what_kind_of_model_arrived(
    connections: InferenceConnectionService, workspace: WorkspaceService, fetched: list
) -> None:
    """The first moment the answer exists without reaching a network.

    A connection is born knowing a model id and nothing about the model. The
    config that says what it is arrives with the weights, so this is where it
    becomes knowable — and reading it here is what lets a client be told what
    this connection can be asked for instead of finding out one refusal at a
    time.
    """
    made = a_local(connections)
    assert made.model_family is None

    assert fetch_weights(workspace, made.id).model_family == DOWNLOADED_FAMILY
    assert connections.get(made.id).model_family == DOWNLOADED_FAMILY


def test_a_re_download_records_a_family_a_row_was_missing(
    connections: InferenceConnectionService,
    workspace: WorkspaceService,
    fetched: list,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The remedy for a row that predates the column, and it is the ordinary action.

    ``download_weights`` is legal at ``ready``, and a run there used to be a
    no-op on the row. It is still idempotent — but *idempotent* now means "the
    row ends up saying what is true", not "the row is never written", which is
    why the early return compares the fields rather than the state.
    """
    made = a_local(connections)
    fetch_weights(workspace, made.id)
    # A row written before a connection recorded any of this.
    monkeypatch.setattr(weights_module, "family_of", lambda *_, **__: "")
    assert fetch_weights(workspace, made.id).model_family == ""

    monkeypatch.setattr(weights_module, "family_of", lambda *_, **__: DOWNLOADED_FAMILY)
    assert fetch_weights(workspace, made.id).model_family == DOWNLOADED_FAMILY


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
    assert said == [
        "fetching some/model at abc123",
        "reading what kind of model arrived",
        "recording the connection as ready",
    ]


def test_reporting_is_optional(
    connections: InferenceConnectionService, workspace: WorkspaceService, fetched: list
) -> None:
    assert fetch_weights(workspace, a_local(connections).id).setup_state is (
        ConnectionSetupState.READY
    )


# --- the gate -----------------------------------------------------------------


def test_a_connection_that_is_already_set_up_is_verified_rather_than_refused(
    connections: InferenceConnectionService, workspace: WorkspaceService, fetched: list
) -> None:
    """The second run is the repair action, not a mistake to catch.

    `download_weights` is legal at `ready`, so this reaches the download again
    — and the download against a full cache is a hash check rather than a
    transfer, which is what makes running it the way to answer "are the weights
    still there?" on a machine where a disk filled or a cache was pruned.
    """
    made = a_local(connections)
    ready = fetch_weights(workspace, made.id)

    verified = fetch_weights(workspace, made.id)
    assert verified.setup_state is ConnectionSetupState.READY
    # Nothing moved: the record is a no-op on a row that is already ready, so a
    # verification does not age the connection it verified.
    assert verified.updated_at == ready.updated_at
    assert len(fetched) == 2


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


# --- the backfill -------------------------------------------------------------
#
# Every row written before a connection recorded what kind of model it holds has
# to acquire one somewhere, and a migration cannot do it: the answer is in a
# model cache under the workspace, and the kernel — where migrations run — is
# forbidden from reaching one. So it happens here, on the read path, and these
# are the bounds that make that defensible.


class _Resolver:
    """A stand-in for reading a config, counting how often it is asked."""

    def __init__(self, answer: str | Exception = "sam2") -> None:
        self.answer = answer
        self.calls = 0

    def __call__(self, *_: object, **__: object) -> str:
        self.calls += 1
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def test_a_set_up_row_with_no_family_acquires_one_and_keeps_it(
    connections: InferenceConnectionService,
    workspace: WorkspaceService,
    fetched: list,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The backfill itself, and the bound that makes it cost once."""
    made = a_local(connections)
    fetch_weights(workspace, made.id)
    _forget_the_family(connections, made.id)

    resolver = _Resolver("sam2")
    monkeypatch.setattr(weights_module, "family_of", resolver)
    (resolved,) = with_families(workspace, [connections.get(made.id)])
    assert resolved.model_family == "sam2"
    assert connections.get(made.id).model_family == "sam2"
    assert resolver.calls == 1

    # Read again: the row has an answer, so nothing looks a second time.
    with_families(workspace, [connections.get(made.id)])
    assert resolver.calls == 1


def test_a_config_that_declared_nothing_is_recorded_and_not_asked_again(
    connections: InferenceConnectionService,
    workspace: WorkspaceService,
    fetched: list,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The empty string is a finding, which is why it is worth storing.

    Folding it into NULL would make every read of that connection re-open a
    config that has already answered — for the life of the workspace.
    """
    made = a_local(connections)
    fetch_weights(workspace, made.id)
    _forget_the_family(connections, made.id)

    resolver = _Resolver("")
    monkeypatch.setattr(weights_module, "family_of", resolver)
    with_families(workspace, [connections.get(made.id)])
    assert connections.get(made.id).model_family == ""

    with_families(workspace, [connections.get(made.id)])
    assert resolver.calls == 1


def test_a_build_that_cannot_look_records_nothing(
    connections: InferenceConnectionService,
    workspace: WorkspaceService,
    fetched: list,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A build without the optional runtime has not looked, and must not say it did.

    Recording the empty string here would put "this model declares nothing" on
    the row on the strength of never having checked — and a machine that later
    installs the runtime would go on believing it, because a row with an answer
    is never asked again.
    """
    made = a_local(connections)
    fetch_weights(workspace, made.id)
    _forget_the_family(connections, made.id)

    monkeypatch.setattr(
        weights_module, "family_of", _Resolver(LocalInferenceUnavailable("no runtime"))
    )
    (resolved,) = with_families(workspace, [connections.get(made.id)])
    assert resolved.model_family is None
    assert connections.get(made.id).model_family is None


def test_nothing_that_has_no_config_here_is_ever_asked(
    connections: InferenceConnectionService,
    workspace: WorkspaceService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An http connection keeps its model elsewhere; an unfetched one has no files.

    Both would send the resolver looking for a config that cannot be there, and
    the empty string it came back with would be recorded as a finding about a
    model nobody has ever read.
    """
    resolver = _Resolver("sam2")
    monkeypatch.setattr(weights_module, "family_of", resolver)
    rows = [an_http(connections), a_local(connections)]

    assert [one.model_family for one in with_families(workspace, rows)] == [None, None]
    assert resolver.calls == 0


def _forget_the_family(connections: InferenceConnectionService, connection_id: Any) -> None:
    """Put a row back the way one written before the column looked.

    Through the service rather than by editing the row, so the state this starts
    from is one the shipped code can actually produce: pointing a connection at a
    different model forgets what kind of model it was.
    """
    current = connections.get(connection_id)
    connections.update(connection_id, model_id=current.model_id + "-again")
    assert connections.get(connection_id).model_family is None
