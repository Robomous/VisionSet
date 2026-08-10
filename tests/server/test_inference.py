"""The inference-connection endpoints, against a real workspace on disk.

Every assertion here is about the *wire*: the status, the body, the code a client
branches on, and what `allowed_actions` declares. What the kernel does underneath
is `tests/kernel/test_inference_connections.py`'s subject.
"""

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.local_inference import without_the_extra
from tests.server._api import api_client
from tests.server._jobs import InlineDispatcher, ManualDispatcher

from visionset.inference import weights as weights_module
from visionset.inference.integrity import IntegrityReport
from visionset.jobs import integrity as job_module
from visionset.kernel.domain import BackgroundJobState
from visionset.kernel.errors import WeightsDamaged
from visionset.kernel.services import InferenceConnectionService
from visionset.server.routes import inference as inference_routes

LOCAL: dict[str, Any] = {
    "name": "local-gd",
    "connection_type": "local",
    "model_id": "some/model",
    "model_revision": "abc123",
    "device": "cpu",
    "precision": "fp32",
}

HTTP: dict[str, Any] = {
    "name": "remote",
    "connection_type": "http",
    "model_id": "some/model",
    "model_revision": "abc123",
    "endpoint_url": "https://example.invalid/predict",
}


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made


@pytest.fixture()
def runtime_present(monkeypatch: pytest.MonkeyPatch) -> None:
    """Answer the route's install check as if the extra were installed.

    Every download test below is about routing, gating and the job — none is
    about whether torch imports — and the base development environment
    deliberately does not carry the extra. Stubbing the *check* rather than the
    library keeps that separation: what the check does when it really fails has
    its own test, and it is the one that runs unstubbed.
    """
    monkeypatch.setattr(inference_routes, "require_local_inference", lambda: None)


@pytest.fixture()
def fetched(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[str]:
    """Record what the handler would have downloaded, and download nothing.

    Patched at ``visionset.inference.weights.download`` — the module global
    ``fetch_weights`` calls — so everything above it is the shipped code: the
    gate, the ordering, and the write that records the connection ready.
    """
    seen: list[str] = []

    def _download(connection: Any, *, into: Path) -> Path:
        seen.append(f"{connection.model_id}@{connection.model_revision}")
        return tmp_path / "snapshot"

    monkeypatch.setattr(weights_module, "download", _download)
    return seen


#: What the faked config declares, where a test needs one.
DOWNLOADED_FAMILY = "sam2"


@pytest.fixture(autouse=True)
def _the_config_read_is_faked(monkeypatch: pytest.MonkeyPatch) -> None:
    """A finished download reads the model's config; here it does not.

    Nothing in this file is about what a config says, and the real read imports
    ``transformers`` — which ``test_configuring_a_connection_reaches_no_model_runtime``
    asserts a full-suite process has not done. An unfaked read would fail that
    test, in another directory, in a run whose order decided it.
    """
    monkeypatch.setattr(weights_module, "family_of", lambda *_, **__: DOWNLOADED_FAMILY)


def created(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    response = client.post("/inference/connections", json=body)
    assert response.status_code == 201, response.text
    made: dict[str, Any] = response.json()
    return made


# --- creating -----------------------------------------------------------------


def test_creating_a_connection_answers_with_it(client: TestClient) -> None:
    made = created(client, LOCAL)
    assert made["name"] == "local-gd"
    assert made["connection_type"] == "local"
    assert made["setup_state"] == "not_set_up"


def test_an_http_connection_is_ready_on_arrival(client: TestClient) -> None:
    assert created(client, HTTP)["setup_state"] == "ready"


def test_parameters_that_do_not_match_the_kind_are_refused(client: TestClient) -> None:
    """A 422: the payload itself is wrong, rather than the resource's state."""
    response = client.post("/inference/connections", json=LOCAL | {"endpoint_url": "https://x"})
    assert response.status_code == 422, response.text


def test_a_taken_name_is_a_conflict(client: TestClient) -> None:
    created(client, LOCAL)
    response = client.post("/inference/connections", json=HTTP | {"name": "LOCAL-GD"})
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NAME_TAKEN"


def test_a_caller_cannot_declare_a_connection_already_set_up(client: TestClient) -> None:
    """`setup_state` is not an input, so supplying it changes nothing.

    Weights being present is a fact about the disk, and a client saying otherwise
    must not be able to make the workspace believe it.
    """
    assert created(client, LOCAL | {"setup_state": "ready"})["setup_state"] == "not_set_up"


# --- reading ------------------------------------------------------------------


def test_listing_is_the_envelope(client: TestClient) -> None:
    created(client, LOCAL)
    created(client, HTTP)
    body = client.get("/inference/connections").json()
    assert set(body) == {"items", "total"}
    assert body["total"] == 2
    assert [one["name"] for one in body["items"]] == ["local-gd", "remote"]


def test_an_empty_listing_is_an_envelope_not_an_array(client: TestClient) -> None:
    assert client.get("/inference/connections").json() == {"items": [], "total": 0}


def test_an_unknown_connection_is_not_found(client: TestClient) -> None:
    response = client.get(f"/inference/connections/{uuid4()}")
    assert response.status_code == 404, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_FOUND"


# --- what it declares ---------------------------------------------------------


def test_a_connection_declares_what_this_slice_can_perform(client: TestClient) -> None:
    """The declared set is exactly the routes that exist, per kind.

    A fresh `local` connection has weights to fetch and says so; an `http` one
    has none of its own and never will, in any state. `test` is the action this
    resource will still grow, and it is not declared while nothing performs it —
    a declaration obliges every conforming client to render a control.
    """
    assert created(client, LOCAL)["allowed_actions"] == ["download_weights", "update", "delete"]
    assert created(client, HTTP)["allowed_actions"] == ["update", "delete"]
    # `check_integrity` is absent from both, and for two different reasons —
    # the local one has no snapshot yet and the HTTP one never will.
    # The `ready` half is `test_a_ready_connection_declares_the_integrity_check`.


@pytest.mark.parametrize("body", [LOCAL, HTTP], ids=["local", "http"])
def test_every_declared_action_is_one_the_api_performs(
    client: TestClient, runtime_present: None, body: dict[str, Any]
) -> None:
    """Declared ⇔ reachable, walked over HTTP rather than asserted about a table.

    `tests/architecture/test_capability_reachability.py` is deliberately
    batches-only — it requires an MCP tool as well as a route, and MCP is a later
    slice for this resource — so the reachability half is proved here instead.
    """
    made = created(client, body)
    routes = {
        "download_weights": lambda: client.post(f"/inference/connections/{made['id']}/download"),
        "check_integrity": lambda: client.post(
            f"/inference/connections/{made['id']}/check-integrity"
        ),
        "update": lambda: client.patch(
            f"/inference/connections/{made['id']}", json={"model_revision": "deadbeef"}
        ),
        "delete": lambda: client.delete(f"/inference/connections/{made['id']}"),
    }
    assert set(made["allowed_actions"]) <= set(routes)
    for action in made["allowed_actions"]:
        response = routes[action]()
        assert response.status_code in (200, 202, 204), (action, response.text)


# --- updating -----------------------------------------------------------------


def test_an_omitted_field_is_left_alone(client: TestClient) -> None:
    made = created(client, LOCAL)
    edited = client.patch(
        f"/inference/connections/{made['id']}", json={"model_revision": "deadbeef"}
    ).json()
    assert edited["model_revision"] == "deadbeef"
    assert edited["device"] == "cpu"
    assert edited["name"] == "local-gd"


def test_an_edit_moves_the_updated_stamp(client: TestClient) -> None:
    made = created(client, LOCAL)
    edited = client.patch(
        f"/inference/connections/{made['id']}", json={"model_revision": "deadbeef"}
    ).json()
    assert edited["updated_at"] > made["updated_at"]
    assert edited["created_at"] == made["created_at"]


def test_the_kind_is_not_editable(client: TestClient) -> None:
    """`ConnectionUpdate` has no `connection_type`, so supplying one changes nothing."""
    made = created(client, LOCAL)
    edited = client.patch(
        f"/inference/connections/{made['id']}", json={"connection_type": "http"}
    ).json()
    assert edited["connection_type"] == "local"


def test_an_edit_into_a_shape_the_kind_refuses_is_a_422(client: TestClient) -> None:
    made = created(client, LOCAL)
    response = client.patch(
        f"/inference/connections/{made['id']}", json={"endpoint_url": "https://x"}
    )
    assert response.status_code == 422, response.text


def test_a_device_this_build_cannot_address_is_refused_with_the_reason(
    client: TestClient,
) -> None:
    """The vocabulary reaches the wire as a sentence, not as a silent fallback.

    What the form does with the two fields is the form's business; that a caller
    who bypasses it is *told* is the kernel's, and this is where a client can see
    it. The message is what a control renders, so it names the members rather
    than saying the value was rejected.
    """
    response = client.post("/inference/connections", json=LOCAL | {"device": "gpu"})
    assert response.status_code == 422, response.text
    body = response.json()
    assert body["code"] == "INFERENCE_CONNECTION_INVALID"
    assert "not a device this build can run on" in body["message"]
    assert "cuda:N" in body["message"]


def test_half_precision_on_a_cpu_is_refused_with_the_reason(client: TestClient) -> None:
    """The cross-field rule at the wire, which is the one a form cannot own alone."""
    response = client.post("/inference/connections", json=LOCAL | {"precision": "fp16"})
    assert response.status_code == 422, response.text
    assert "fp16 is not available on cpu" in response.json()["message"]


def test_a_precision_outside_the_vocabulary_never_reaches_the_kernel(
    client: TestClient,
) -> None:
    """An enum on the wire, so the contract states the members rather than implying them.

    `device` cannot be one — `cuda:N` is a member that is not a fixed word — which
    is why the two closed vocabularies are published two different ways and why
    the kernel, not the schema, is what both refusals have in common.
    """
    response = client.post("/inference/connections", json=LOCAL | {"precision": "bf16"})
    assert response.status_code == 422, response.text
    assert "fp16" in response.text and "fp32" in response.text


# --- deleting -----------------------------------------------------------------


def test_deleting_answers_no_content_and_removes_it(client: TestClient) -> None:
    made = created(client, LOCAL)
    assert client.delete(f"/inference/connections/{made['id']}").status_code == 204
    assert client.get(f"/inference/connections/{made['id']}").status_code == 404


def test_deleting_needs_no_confirmation(client: TestClient) -> None:
    """Unlike a project: what is destroyed is a configuration, not work.

    Provenance is denormalised onto the annotation at write time, so nothing
    holds a key to this row.
    """
    made = created(client, LOCAL)
    assert client.delete(f"/inference/connections/{made['id']}").status_code == 204


def test_deleting_an_unknown_connection_is_not_found(client: TestClient) -> None:
    assert client.delete(f"/inference/connections/{uuid4()}").status_code == 404


# --- downloading weights ------------------------------------------------------


def test_downloading_answers_202_and_points_at_its_job(
    tmp_path: Path, runtime_present: None
) -> None:
    """The launch-and-poll contract, the same one the export route answers with."""
    dispatcher = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as client:
        made = created(client, LOCAL)
        response = client.post(f"/inference/connections/{made['id']}/download")

        assert response.status_code == 202, response.text
        job = response.json()
        assert job["type"] == "inference.download_weights"
        assert job["state"] == "queued"
        assert response.headers["Location"] == f"/background-jobs/{job['id']}"
        # The launch nudged the dispatcher rather than leaving the row for a poll.
        assert dispatcher.wakes == 1
        # Queued is queued: nothing has run, so the connection has not moved.
        assert client.get(f"/inference/connections/{made['id']}").json()["setup_state"] == (
            "not_set_up"
        )


def test_a_finished_download_leaves_the_connection_ready(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """The state flip is the job's last act, and it is visible over the wire."""
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = created(client, LOCAL)
        job = client.post(f"/inference/connections/{made['id']}/download").json()

        settled = client.get(f"/background-jobs/{job['id']}").json()
        assert settled["state"] == BackgroundJobState.SUCCEEDED.value, settled
        assert settled["result"]["setup_state"] == "ready"
        assert fetched == ["some/model@abc123"]

        after = client.get(f"/inference/connections/{made['id']}").json()
        assert after["setup_state"] == "ready"
        # The declaration survives the flip: what the action means changes from
        # "fetch these" to "check these are still here", and the name of
        # a capability does not change with the state it is read in. What the
        # flip *adds* is `check_integrity`, which had nothing to read before
        # — so this is the one square where becoming ready grows the row
        # a control rather than only re-labelling one.
        assert after["allowed_actions"] == [
            "download_weights",
            "check_integrity",
            "update",
            "delete",
        ]


def test_a_failed_download_leaves_the_connection_not_set_up(
    tmp_path: Path, runtime_present: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Never a half-ready row: the failure is on the job and nowhere else.

    The ordering rule `visionset.inference.weights` states, proved by breaking
    the download rather than by reading the code: the state flip is the last
    statement, so a run that dies before it has written nothing at all.
    """

    def _explode(connection: Any, *, into: Path) -> Path:
        raise OSError("the disk filled")

    monkeypatch.setattr(weights_module, "download", _explode)
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = created(client, LOCAL)
        job = client.post(f"/inference/connections/{made['id']}/download").json()

        settled = client.get(f"/background-jobs/{job['id']}").json()
        assert settled["state"] == BackgroundJobState.FAILED.value
        assert "the disk filled" in settled["error"]

        after = client.get(f"/inference/connections/{made['id']}").json()
        assert after["setup_state"] == "not_set_up"
        assert "download_weights" in after["allowed_actions"]


def test_running_the_download_twice_is_a_verified_no_op(
    tmp_path: Path, runtime_present: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The idempotency the registry claims for this handler, exercised.

    Both the re-queued orphan and the person pressing the action a second time
    take this path: the route accepts, the handler runs, the download
    verifies a cache it already filled, and the row ends where it started. What
    the test holds is that *nothing moved* — a second run that reported a state
    change would mean the write is not the no-op the handler's registration
    promises.
    """
    from visionset.jobs.weights import run as download_run

    calls: list[str] = []
    monkeypatch.setattr(
        weights_module,
        "download",
        lambda connection, *, into: (calls.append(connection.model_id), into)[1],
    )
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = created(client, LOCAL)
        client.post(f"/inference/connections/{made['id']}/download")
        ready = client.get(f"/inference/connections/{made['id']}").json()
        assert ready["setup_state"] == "ready"

        response = client.post(f"/inference/connections/{made['id']}/download")
        assert response.status_code == 202, response.text
        job = client.get(f"/background-jobs/{response.json()['id']}").json()
        assert job["state"] == BackgroundJobState.SUCCEEDED.value, job

        again = client.get(f"/inference/connections/{made['id']}").json()
        assert again["setup_state"] == "ready"
        assert again["updated_at"] == ready["updated_at"]

    assert calls == ["some/model", "some/model"]
    assert callable(download_run)


def test_downloading_an_http_connection_is_a_conflict(
    client: TestClient, runtime_present: None
) -> None:
    """Its model runs elsewhere, so there is nothing here to fetch — in any state."""
    made = created(client, HTTP)
    response = client.post(f"/inference/connections/{made['id']}/download")
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_DOWNLOADABLE"
    assert "download_weights" not in made["allowed_actions"]


def test_downloading_an_unknown_connection_is_not_found(
    client: TestClient, runtime_present: None
) -> None:
    response = client.post(f"/inference/connections/{uuid4()}/download")
    assert response.status_code == 404, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_FOUND"


@without_the_extra
def test_a_missing_local_runtime_refuses_with_the_install_command(client: TestClient) -> None:
    """Unstubbed, and the message is the remedy.

    A deployment condition rather than a client error, so it is a 5xx — and one
    of the four that opt out of the opaque body, because nobody can reconstruct
    a `pip install` line from "the server failed to handle the request".

    The action stays *declared* through all of this, deliberately: whether this
    machine has the extra is not a fact about the connection, and a control that
    vanished would leave the install command with nowhere to be shown
    (design principle 9).
    """
    made = created(client, LOCAL)
    assert "download_weights" in made["allowed_actions"]

    response = client.post(f"/inference/connections/{made['id']}/download")
    assert response.status_code == 500, response.text
    body = response.json()
    assert body["code"] == "LOCAL_INFERENCE_UNAVAILABLE"
    assert 'pip install "visionset[local-inference]"' in body["message"]


def test_a_refused_download_creates_no_job(client: TestClient, runtime_present: None) -> None:
    """A caller holding a job id holds one that will run.

    `export_release`'s rule: the refusals a request can make are made on the
    request, so no row is ever written for work that was never going to happen.
    """
    made = created(client, HTTP)
    assert client.post(f"/inference/connections/{made['id']}/download").status_code == 409
    assert client.get("/background-jobs").json()["total"] == 0
    assert UUID(made["id"])


# --- the integrity check ------------------------------------------------------


def _made_ready(client: TestClient) -> dict[str, Any]:
    """A local connection the download job has taken to `ready`."""
    made = created(client, LOCAL)
    client.post(f"/inference/connections/{made['id']}/download")
    return client.get(f"/inference/connections/{made['id']}").json()


def test_a_ready_connection_declares_the_integrity_check(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """The one square it is legal on, read off the wire rather than the table."""
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        assert "check_integrity" in _made_ready(client)["allowed_actions"]


def test_checking_a_ready_connection_launches_the_check(
    tmp_path: Path, runtime_present: None, fetched: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """202, its own type, and the `Location` header the poll follows."""
    # Patched on the *handler*, not on `visionset.inference`: the handler binds
    # the name at import, so patching the source module would leave the job
    # calling the real thing — which is a network call, and how this test first
    # failed against a 401 from the hub.
    monkeypatch.setattr(
        job_module,
        "check_integrity",
        lambda workspace, connection_id, **_: IntegrityReport(files_checked=3, bytes_read=99),
    )
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = _made_ready(client)
        response = client.post(f"/inference/connections/{made['id']}/check-integrity")

        assert response.status_code == 202, response.text
        job = response.json()
        assert job["type"] == "inference.check_integrity"
        assert response.headers["Location"] == f"/background-jobs/{job['id']}"

        settled = client.get(f"/background-jobs/{job['id']}").json()
        assert settled["state"] == BackgroundJobState.SUCCEEDED.value, settled
        assert settled["result"]["files_checked"] == 3
        assert settled["result"]["bytes_read"] == 99
        # Success is no transition: the row is where it was.
        assert client.get(f"/inference/connections/{made['id']}").json()["setup_state"] == "ready"


def test_a_check_that_found_damage_leaves_the_row_not_set_up_with_the_reason(
    tmp_path: Path, runtime_present: None, fetched: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The integrity check's transition, seen the way a browser sees it.

    The job carries the sentence and the row carries the state, and the row has
    *already* moved by the time the job says so — which is what lets the failed
    job name a remedy the connection now declares.
    """

    def _damaged(workspace: Any, connection_id: Any, **_: Any) -> None:
        InferenceConnectionService(workspace).record_weights_missing(connection_id)
        raise WeightsDamaged("1 file does not match (model.safetensors)")

    monkeypatch.setattr(job_module, "check_integrity", _damaged)
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = _made_ready(client)
        job = client.post(f"/inference/connections/{made['id']}/check-integrity").json()

        settled = client.get(f"/background-jobs/{job['id']}").json()
        assert settled["state"] == BackgroundJobState.FAILED.value, settled
        assert "model.safetensors" in settled["error"]

        after = client.get(f"/inference/connections/{made['id']}").json()
        assert after["setup_state"] == "not_set_up"
        # The remedy is declared, and the check no longer is — there is nothing
        # left to read.
        assert "download_weights" in after["allowed_actions"]
        assert "check_integrity" not in after["allowed_actions"]


def test_checking_a_connection_whose_weights_never_arrived_is_a_conflict(
    client: TestClient, runtime_present: None
) -> None:
    """Its own code, because its remedy is not the other one's: download first."""
    made = created(client, LOCAL)
    response = client.post(f"/inference/connections/{made['id']}/check-integrity")
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_CHECKABLE"
    assert "download" in response.json()["message"]
    assert "check_integrity" not in made["allowed_actions"]


def test_checking_an_http_connection_is_a_conflict(
    client: TestClient, runtime_present: None
) -> None:
    """No files here in any state, and the sentence says so rather than
    pointing at a download that would fetch nothing."""
    made = created(client, HTTP)
    response = client.post(f"/inference/connections/{made['id']}/check-integrity")
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_CHECKABLE"
    assert "runs elsewhere" in response.json()["message"]


def test_checking_an_unknown_connection_is_not_found(
    client: TestClient, runtime_present: None
) -> None:
    response = client.post(f"/inference/connections/{uuid4()}/check-integrity")
    assert response.status_code == 404, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_FOUND"


def test_a_refused_check_creates_no_job(client: TestClient, runtime_present: None) -> None:
    """The download route's rule, one action over."""
    made = created(client, LOCAL)
    assert client.post(f"/inference/connections/{made['id']}/check-integrity").status_code == 409
    assert client.get("/background-jobs").json()["total"] == 0


# --- the download size, read before anybody agrees to a download ---------------


@pytest.fixture()
def listing(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str | None]]:
    """A hub that lists files and refuses to fetch any.

    Patched at ``visionset.inference.weights.imported`` — the one door the
    optional runtime arrives through — so everything above it is the shipped
    code: the counting, the refusals, and the cache.
    """
    asked: list[tuple[str, str | None]] = []

    class Sibling:
        def __init__(self, rfilename: str, size: int) -> None:
            self.rfilename = rfilename
            self.size = size

    class Info:
        siblings = [Sibling("config.json", 1_024), Sibling("model.safetensors", 300_000_000)]

    class Hub:
        @staticmethod
        def model_info(repo_id: str, **kwargs: Any) -> type[Info]:
            asked.append((repo_id, kwargs.get("revision")))
            return Info

        @staticmethod
        def snapshot_download(**_: object) -> str:
            raise AssertionError("reading a size must not download anything")

    monkeypatch.setattr(weights_module, "imported", lambda _name: Hub)
    weights_module.known_sizes().clear()
    return asked


def test_the_download_size_is_answered_from_the_listing(
    client: TestClient, listing: list[tuple[str, str | None]]
) -> None:
    """The number D1 requires on screen before somebody confirms a download.

    `Hub.snapshot_download` raises, so this reds if the route ever answers by
    fetching what it is measuring.
    """
    response = client.get(
        "/inference/download-size",
        params={"model_id": "facebook/sam2-hiera-base-plus", "model_revision": "main"},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "model_id": "facebook/sam2-hiera-base-plus",
        "model_revision": "main",
        "total_bytes": 300_001_024,
        "file_count": 2,
    }
    assert listing == [("facebook/sam2-hiera-base-plus", "main")]


def test_the_size_route_names_no_connection(
    client: TestClient, listing: list[tuple[str, str | None]]
) -> None:
    """It is asked while a form is being filled in, so there is no row yet.

    A workspace with no connections at all answers it, which is the state every
    first-time setup is in.
    """
    assert client.get("/inference/connections").json()["total"] == 0
    response = client.get(
        "/inference/download-size",
        params={"model_id": "some/model", "model_revision": "abc123"},
    )
    assert response.status_code == 200, response.text


def test_a_size_asked_for_twice_is_read_once(
    client: TestClient, listing: list[tuple[str, str | None]]
) -> None:
    """A pinned revision is a fixed set of files, so the answer cannot go stale."""
    for _ in range(2):
        client.get(
            "/inference/download-size",
            params={"model_id": "some/model", "model_revision": "abc123"},
        )
    assert listing == [("some/model", "abc123")]


def test_the_size_route_wants_both_halves_of_the_pair(client: TestClient) -> None:
    """A size is a fact about one revision, so the revision is not optional."""
    response = client.get("/inference/download-size", params={"model_id": "some/model"})
    assert response.status_code == 422, response.text


@without_the_extra
def test_a_size_without_the_runtime_carries_the_install_command(client: TestClient) -> None:
    """Unstubbed, and the same refusal the download gives.

    The size is read with the client that would do the fetching, so a machine
    without the extra cannot answer — and says what to install rather than
    failing opaquely (design principle 9).
    """
    weights_module.known_sizes().clear()
    response = client.get(
        "/inference/download-size",
        params={"model_id": "some/model", "model_revision": "abc123"},
    )
    assert response.status_code == 500, response.text
    body = response.json()
    assert body["code"] == "LOCAL_INFERENCE_UNAVAILABLE"
    assert 'pip install "visionset[local-inference]"' in body["message"]


# --- what its model can be asked for ------------------------------------------
#
# A second declaration beside `allowed_actions`, answering a different question:
# an action is something to do *to* this connection, a capability is what its
# model answers. A client offering a tool needs both, and being ready says the
# files are here rather than that they are the right kind of model.


def test_a_connection_declares_what_its_model_can_be_asked_for(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """Read off the wire, and only after a download has read the config."""
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        assert _made_ready(client)["capabilities"] == ["point_suggest"]


def test_a_connection_whose_weights_never_arrived_declares_nothing(
    client: TestClient,
) -> None:
    """Nothing is fetched at creation, so nothing has been read at creation.

    The empty list is not a refusal: the server still judges every request on
    its own. It says only that no client can rely on this connection for a
    particular tool yet.
    """
    assert created(client, LOCAL)["capabilities"] == []


def test_an_http_connection_declares_nothing_yet(client: TestClient) -> None:
    """`ready` on arrival and still capable of nothing a client may rely on.

    An HTTP connection's model runs elsewhere, and how a remote endpoint states
    what it can do is the remote-contract slice's question. Until it is
    answered, the honest declaration is the empty one — the two states this
    resource can be in are not the two questions being asked.
    """
    made = created(client, HTTP)
    assert made["setup_state"] == "ready"
    assert made["capabilities"] == []


def test_a_row_written_before_the_column_is_resolved_on_its_first_read(
    tmp_path: Path, runtime_present: None, fetched: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The backfill, over HTTP, with its bound: once per row, then never again.

    Reached through the listing because that is the client that needs it — the
    editor reads the list to decide which connection a click can go through, and
    a row that predates the column would otherwise be invisible to every tool
    for the life of the workspace.
    """
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = _made_ready(client)
        # A row the way one written before the column looked: still `ready`,
        # with nothing recorded about what kind of model it holds. The edit's own
        # answer is the honest empty one — it is a write, and nothing has read
        # the new model's config.
        patched = client.patch(
            f"/inference/connections/{made['id']}", json={"model_id": "other/model"}
        )
        assert patched.json()["capabilities"] == []

        reads: list[str] = []

        def _read(connection: Any, **_: Any) -> str:
            reads.append(connection.model_id)
            return "grounding-dino"

        monkeypatch.setattr(weights_module, "family_of", _read)
        listed = client.get("/inference/connections").json()["items"]
        assert [one["capabilities"] for one in listed] == [["text_detect"]]
        assert reads == ["other/model"]

        # And the answer is now on the row, so no read of it looks again.
        client.get("/inference/connections")
        client.get(f"/inference/connections/{made['id']}")
        assert reads == ["other/model"]
