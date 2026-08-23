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
from tests.fixtures.endpoint import closed_port, serving_endpoint
from tests.fixtures.local_inference import without_the_extra
from tests.server._api import api_client
from tests.server._jobs import InlineDispatcher, ManualDispatcher

from visionset.inference import weights as weights_module
from visionset.inference.integrity import IntegrityReport
from visionset.inference.registry import registered, served
from visionset.jobs import integrity as job_module
from visionset.kernel.domain import BackgroundJobState, DownloadSize, ServedFamily
from visionset.kernel.errors import LocalInferenceUnavailable, WeightsDamaged
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

    def _download(connection: Any, *, into: Path, on_bytes: Any = None) -> Path:
        seen.append(f"{connection.model_id}@{connection.model_revision}")
        if on_bytes is not None:
            on_bytes(FETCHED_BYTES // 4)
        return tmp_path / "snapshot"

    monkeypatch.setattr(weights_module, "download", _download)
    return seen


#: What the faked config declares, where a test needs one.
DOWNLOADED_FAMILY = "sam2"

#: What the faked revision weighs, in bytes.
FETCHED_BYTES = 4_000_000_000


@pytest.fixture(autouse=True)
def _the_config_read_is_faked(monkeypatch: pytest.MonkeyPatch) -> None:
    """A finished download reads the model's config; here it does not.

    Nothing in this file is about what a config says, and the real read pulls in
    the whole optional runtime to answer — seconds of import, spent only on the
    machines carrying the extra and not on the ones without. Faked, this file
    costs and asserts the same in both halves of the matrix.
    """
    monkeypatch.setattr(weights_module, "family_of", lambda *_, **__: DOWNLOADED_FAMILY)


@pytest.fixture(autouse=True)
def _the_size_lookup_is_faked(monkeypatch: pytest.MonkeyPatch) -> None:
    """A download reads its total from the hub; here it does not.

    The lookup is a metadata request over the network, and leaving it real would
    make these tests reach one — but only on a machine carrying the extra, which
    is the worst kind of intermittent.
    """
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


def test_a_created_connection_publishes_the_driver_it_was_given(client: TestClient) -> None:
    """The form reads the driver off the catalog entry it picked and sends it
    back, so the row can be resolved before anything has been downloaded."""
    assert created(client, LOCAL | {"provider_id": "sam"})["provider_id"] == "sam"


def test_a_connection_created_without_one_publishes_null(client: TestClient) -> None:
    """Null rather than absent, on every other nullable field's terms: a client
    reading the shape handles one spelling of "nothing recorded", not two."""
    made = created(client, LOCAL)
    assert "provider_id" in made
    assert made["provider_id"] is None


def test_a_driver_nobody_installed_is_still_recorded(client: TestClient) -> None:
    """Whether a driver is installed is a fact about this installation, not about
    the payload — so a name nothing here provides is stored and refused later, by
    whatever tries to run it."""
    assert created(client, LOCAL | {"provider_id": "not-installed"})["provider_id"] == (
        "not-installed"
    )


def test_repinning_to_another_offered_model_carries_the_new_driver(client: TestClient) -> None:
    made = created(client, LOCAL | {"provider_id": "sam"})

    edited = client.patch(
        f"/inference/connections/{made['id']}",
        json={"model_id": "acme/other", "provider_id": "acme"},
    )

    assert edited.status_code == 200, edited.text
    assert edited.json()["provider_id"] == "acme"


def test_moving_to_a_model_naming_no_driver_forgets_the_old_one(client: TestClient) -> None:
    """The recorded driver was recorded for the model this row used to name.

    The one client there is sends the whole shape on every edit, so this is what
    a switch to a hand-typed model looks like on the wire: a moved reference and
    a null provider.
    """
    made = created(client, LOCAL | {"provider_id": "sam"})

    edited = client.patch(
        f"/inference/connections/{made['id']}",
        json={"model_id": "typed/by-hand", "provider_id": None},
    )

    assert edited.status_code == 200, edited.text
    assert edited.json()["provider_id"] is None


def test_an_http_connection_is_ready_on_arrival(client: TestClient) -> None:
    assert created(client, HTTP)["setup_state"] == "ready"


def test_an_http_connection_publishes_the_variable_naming_its_credential(
    client: TestClient,
) -> None:
    """The name travels on the wire; the value never does — there is no field
    to carry it, by design rather than omission."""
    made = created(client, HTTP | {"credential_env": "ACME_TOKEN"})
    assert made["credential_env"] == "ACME_TOKEN"
    assert created(client, HTTP | {"name": "bare"})["credential_env"] is None


def test_a_local_connection_naming_a_credential_variable_is_refused(client: TestClient) -> None:
    response = client.post("/inference/connections", json=LOCAL | {"credential_env": "X"})
    assert response.status_code == 422, response.text


def test_the_empty_string_clears_the_credential_variable_on_an_edit(client: TestClient) -> None:
    made = created(client, HTTP | {"credential_env": "ACME_TOKEN"})
    kept = client.patch(f"/inference/connections/{made['id']}", json={"name": "still-remote"})
    assert kept.json()["credential_env"] == "ACME_TOKEN"
    cleared = client.patch(f"/inference/connections/{made['id']}", json={"credential_env": ""})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["credential_env"] is None


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
    """`setup_state` is not an input, and supplying it is refused rather than dropped.

    Weights being present is a fact about the disk, and a client saying otherwise
    must not be able to make the workspace believe it. `ConnectionCreate` forbids
    unknown fields, so a caller who thought they were setting this is told, rather
    than handed a 201 carrying a value they did not ask for.
    """
    response = client.post("/inference/connections", json=LOCAL | {"setup_state": "ready"})
    assert response.status_code == 422, response.text
    assert client.get("/inference/connections").json()["total"] == 0


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


@pytest.mark.parametrize(
    ("method", "suffix", "checks_for_the_extra"),
    [
        pytest.param("get", "", False, id="reading-it"),
        pytest.param("post", "/download", True, id="downloading-it"),
        pytest.param("post", "/check-integrity", True, id="checking-it"),
    ],
)
def test_an_unknown_connection_is_not_found(
    client: TestClient,
    request: pytest.FixtureRequest,
    method: str,
    suffix: str,
    checks_for_the_extra: bool,
) -> None:
    """Reading, downloading and checking an absent connection all refuse alike.

    The third column is the distinction the table exists to keep: the two routes
    that would reach a runtime check for the extra *before* they look anything up,
    so they need the check stubbed to get as far as the lookup. The read does not,
    and takes no stub — which is what makes its row prove the 404 arrives with
    nothing patched at all.
    """
    if checks_for_the_extra:
        request.getfixturevalue("runtime_present")

    response = getattr(client, method)(f"/inference/connections/{uuid4()}{suffix}")
    assert response.status_code == 404, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_FOUND"


# --- what it declares ---------------------------------------------------------


def test_a_connection_declares_what_this_slice_can_perform(client: TestClient) -> None:
    """The declared set is exactly the routes that exist.

    A fresh `local` connection has weights to fetch and says so; an `http` one
    has none of its own and never will, in any state, but does have an endpoint
    to ask.
    """
    assert created(client, LOCAL)["allowed_actions"] == ["download_weights", "update", "delete"]
    assert created(client, HTTP)["allowed_actions"] == ["test_endpoint", "update", "delete"]
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
    with serving_endpoint() as endpoint:
        made = created(client, {**body, "endpoint_url": endpoint.url} if body is HTTP else body)
        routes = {
            "download_weights": lambda: client.post(
                f"/inference/connections/{made['id']}/download"
            ),
            "check_integrity": lambda: client.post(
                f"/inference/connections/{made['id']}/check-integrity"
            ),
            "test_endpoint": lambda: client.post(
                f"/inference/connections/{made['id']}/test-endpoint"
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
    """`ConnectionUpdate` has no `connection_type`, so supplying one is refused."""
    made = created(client, LOCAL)
    response = client.patch(
        f"/inference/connections/{made['id']}", json={"connection_type": "http"}
    )
    assert response.status_code == 422, response.text
    read = client.get(f"/inference/connections/{made['id']}").json()
    assert read["connection_type"] == "local"


def test_a_misspelled_field_on_a_create_is_refused(client: TestClient) -> None:
    """`ConnectionCreate` forbids unknown fields, so a typo cannot be silently dropped."""
    response = client.post("/inference/connections", json=LOCAL | {"model_revison": "abc123"})
    assert response.status_code == 422, response.text
    assert client.get("/inference/connections").json()["total"] == 0


def test_a_misspelled_field_on_an_edit_is_refused_rather_than_answered_200(
    client: TestClient,
) -> None:
    """The whole point of `extra="forbid"` on `ConnectionUpdate`, in one case.

    Accepted and ignored, this answers 200 carrying the *old* revision, and the
    caller has no way at all to tell the edit did not take. The 422 is the only
    thing that distinguishes "you misspelled it" from "it worked".
    """
    made = created(client, LOCAL)

    response = client.patch(
        f"/inference/connections/{made['id']}", json={"model_revison": "deadbeef"}
    )
    assert response.status_code == 422, response.text
    assert client.get(f"/inference/connections/{made['id']}").json()["model_revision"] == "abc123"


def test_the_spelling_the_typo_missed_still_works(client: TestClient) -> None:
    """The positive path for the case above, so its 422 is about the *name*.

    Without it, a `ConnectionUpdate` that had stopped accepting the field at all
    would satisfy every assertion up there.
    """
    made = created(client, LOCAL)

    response = client.patch(
        f"/inference/connections/{made['id']}", json={"model_revision": "deadbeef"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["model_revision"] == "deadbeef"


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


def test_editing_the_model_takes_the_integrity_check_off_the_row(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """The declaration follows the reset, because it is derived from the state.

    `check_integrity` re-reads a snapshot. Pointing the connection at a model
    whose snapshot was never fetched leaves nothing to read, so the action stops
    being offered in the same response that performs the edit — a client never
    sees a window in which it is declared over weights that are not there.
    """
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = _made_ready(client)
        assert "check_integrity" in made["allowed_actions"]

        edited = client.patch(
            f"/inference/connections/{made['id']}", json={"model_id": "other/model"}
        ).json()
        assert edited["setup_state"] == "not_set_up"
        assert edited["capabilities"] == []
        assert edited["allowed_actions"] == ["download_weights", "update", "delete"]


def test_renaming_a_ready_connection_leaves_it_ready(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """The whole shape arrives on every edit, and a mention is not a move.

    The app's form PATCHes each field, so a rename carries the model id the row
    already had. Reading that as a change would send a set-up connection back for
    a download of weights that never left — the reset's own failure mode, and the
    reason it compares values rather than counting what was supplied.
    """
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = _made_ready(client)

        renamed = client.patch(
            f"/inference/connections/{made['id']}",
            json={
                "name": "renamed",
                "model_id": LOCAL["model_id"],
                "model_revision": LOCAL["model_revision"],
                "device": LOCAL["device"],
                "precision": LOCAL["precision"],
            },
        ).json()
        assert renamed["setup_state"] == "ready"
        assert renamed["capabilities"] == made["capabilities"]
        assert "check_integrity" in renamed["allowed_actions"]


def test_a_failed_download_leaves_the_connection_not_set_up(
    tmp_path: Path, runtime_present: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Never a half-ready row: the failure is on the job and nowhere else.

    The ordering rule `visionset.inference.weights` states, proved by breaking
    the download rather than by reading the code: the state flip is the last
    statement, so a run that dies before it has written nothing at all.
    """

    def _explode(connection: Any, *, into: Path, on_bytes: Any = None) -> Path:
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
        lambda connection, *, into, on_bytes=None: (calls.append(connection.model_id), into)[1],
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


SERVED_FAMILIES: tuple[tuple[str, ServedFamily], ...] = tuple(
    sorted(served(registered().providers).items())
)
"""Every family some installed driver serves, with what it declares.

Derived from the drivers rather than written, so a family added to a driver is
a subject of the wire claim below with nothing to remember.
"""


@pytest.mark.parametrize(
    ("family", "declared"), SERVED_FAMILIES, ids=[family for family, _ in SERVED_FAMILIES]
)
def test_a_connection_declares_the_shapes_its_model_answers_in(
    tmp_path: Path,
    runtime_present: None,
    fetched: list[str],
    monkeypatch: pytest.MonkeyPatch,
    family: str,
    declared: ServedFamily,
) -> None:
    """The wire's `produces` is the driver's declaration, sorted, per connection.

    Read off the listing as well as the single read: the listing is what a card
    view and a driver selector consume, and the two serializers must agree.
    """
    monkeypatch.setattr(weights_module, "family_of", lambda *_, **__: family)
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = _made_ready(client)
        expected = sorted(shape.value for shape in declared.produces)
        assert made["produces"] == expected
        listed = client.get("/inference/connections").json()["items"]
        assert [one["produces"] for one in listed] == [expected]


def test_a_connection_nobody_has_read_produces_nothing(client: TestClient) -> None:
    """Degrades with `capabilities`: no family known, no shape promised.

    An empty list, not null — the client rule is that a chip with no data is
    omitted, and a list a client can iterate is what lets it stay that simple.
    """
    assert created(client, LOCAL)["produces"] == []
    assert created(client, HTTP)["produces"] == []


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
        # A row the way one written before the column looked: `ready`, with
        # nothing recorded about what kind of model it holds. Downloading on a
        # machine whose optional runtime cannot read a config lands exactly
        # there, and it is the one producer of that state a test can drive — an
        # edited row is `not_set_up`, so the backfill never reaches it.
        def _no_runtime(*_: Any, **__: Any) -> str:
            raise LocalInferenceUnavailable("'transformers' is not installed here")

        monkeypatch.setattr(weights_module, "family_of", _no_runtime)
        made = _made_ready(client)
        assert made["setup_state"] == "ready"
        assert made["capabilities"] == []

        reads: list[str] = []

        def _read(connection: Any, **_: Any) -> str:
            reads.append(connection.model_id)
            return "grounding-dino"

        monkeypatch.setattr(weights_module, "family_of", _read)
        listed = client.get("/inference/connections").json()["items"]
        assert [one["capabilities"] for one in listed] == [["text_detect"]]
        assert reads == [LOCAL["model_id"]]

        # And the answer is now on the row, so no read of it looks again.
        client.get("/inference/connections")
        client.get(f"/inference/connections/{made['id']}")
        assert reads == [LOCAL["model_id"]]


# --- the download on the wire -------------------------------------------------


def test_a_connection_that_was_never_downloaded_carries_no_download(
    client: TestClient,
) -> None:
    """`null` and not a zeroed record, because *nobody has asked* and *it has
    fetched nothing so far* are different things with different renderings."""
    assert created(client, LOCAL)["download"] is None
    assert created(client, HTTP)["download"] is None


def test_the_download_is_on_the_connection_before_a_worker_touches_it(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """The `202` is enough to see it, which is what a pressed button needs.

    `ManualDispatcher` runs nothing, so this is the state a real deployment is in
    between the route answering and a worker claiming — the window in which a
    client that showed nothing would be showing a button somebody just pressed
    beside no explanation at all.
    """
    with api_client(tmp_path / "ws", dispatcher=ManualDispatcher()) as client:
        made = created(client, LOCAL)
        queued = client.post(f"/inference/connections/{made['id']}/download").json()

        row = client.get(f"/inference/connections/{made['id']}").json()

        assert row["download"] == {
            "job_id": queued["id"],
            "state": "queued",
            "bytes_done": 0,
            "bytes_total": None,
            "error": None,
            "error_code": None,
        }
        assert row["setup_state"] == "not_set_up"


def test_a_download_finishes_with_nobody_polling_it(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """The transfer belongs to the server, and no client is holding it up.

    Nothing here reads `/background-jobs/{id}` at any point — the observation is
    the connection listing and only that — and the run still completes and lands
    on the row. That is the whole of "closing the browser does not stop a
    download", stated as a test rather than as a paragraph.
    """
    dispatcher = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as client:
        made = created(client, LOCAL)
        client.post(f"/inference/connections/{made['id']}/download")

        # The worker runs. No client is involved in this line.
        assert dispatcher.run() == 1

        listed = client.get("/inference/connections").json()["items"]

    (row,) = listed
    assert row["setup_state"] == "ready"
    assert row["download"]["state"] == "succeeded"
    assert row["download"]["bytes_done"] == row["download"]["bytes_total"] == FETCHED_BYTES
    assert fetched == [f"{LOCAL['model_id']}@{LOCAL['model_revision']}"]


def test_a_settled_download_stays_on_the_row_with_its_reason(
    tmp_path: Path, runtime_present: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A transfer that failed while nobody was watching still has a sentence.

    Dropping the record when a job settles would leave the connection at `not_set
    _up` with nothing saying why — and the remedy on offer would look like the
    thing that had just failed, for no stated reason.
    """

    def _explode(connection: Any, *, into: Path, on_bytes: Any = None) -> Path:
        raise OSError("the disk filled")

    monkeypatch.setattr(weights_module, "download", _explode)
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = created(client, LOCAL)
        client.post(f"/inference/connections/{made['id']}/download")

        row = client.get(f"/inference/connections/{made['id']}").json()

    assert row["setup_state"] == "not_set_up"
    assert row["download"]["state"] == "failed"
    assert "the disk filled" in row["download"]["error"]
    # The remedy the row now declares, which is the one the prose can name.
    assert "download_weights" in row["allowed_actions"]


def test_a_second_download_replaces_the_first_on_the_row(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """One record, describing the most recent attempt.

    A row that went on showing a failed transfer after a successful retry would
    be describing a state the workspace has left.
    """
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = created(client, LOCAL)
        client.post(f"/inference/connections/{made['id']}/download")
        first = client.get(f"/inference/connections/{made['id']}").json()["download"]

        client.post(f"/inference/connections/{made['id']}/download")
        second = client.get(f"/inference/connections/{made['id']}").json()["download"]

    assert first["job_id"] != second["job_id"]
    assert second["state"] == "succeeded"


def test_an_edit_answers_with_the_download_the_listing_would_show(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """Every read of a connection says the same thing about it.

    A field carried on some routes and not others is a client having to know
    which answers it may believe.
    """
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = created(client, LOCAL)
        client.post(f"/inference/connections/{made['id']}/download")

        renamed = client.patch(
            f"/inference/connections/{made['id']}", json={"name": "renamed"}
        ).json()
        listed = client.get(f"/inference/connections/{made['id']}").json()

    assert renamed["download"] == listed["download"]
    assert renamed["download"]["state"] == "succeeded"


def test_the_integrity_check_is_not_read_as_a_download(
    tmp_path: Path, runtime_present: None, fetched: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two jobs over the same snapshot, and only one of them counts bytes.

    The check reports files, so a row that read its progress as a download would
    show a handful of bytes where gigabytes belong.
    """
    monkeypatch.setattr(
        job_module,
        "check_integrity",
        # `files_checked`, not `files`. Spelled wrongly when this test was
        # written, so the fake raised a `TypeError`, the job failed, and the
        # assertion below held for the wrong reason — a check that never
        # succeeded still leaves a download record untouched.
        lambda *_, **__: IntegrityReport(files_checked=3, bytes_read=99),
    )
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = _made_ready(client)
        before = client.get(f"/inference/connections/{made['id']}").json()["download"]

        client.post(f"/inference/connections/{made['id']}/check-integrity")
        after = client.get(f"/inference/connections/{made['id']}").json()["download"]

    assert after == before
    assert after["bytes_done"] == FETCHED_BYTES


# --- the check on the wire ----------------------------------------------------


def test_a_connection_that_was_never_checked_carries_no_check(client: TestClient) -> None:
    """`null` and not a zeroed record: *nobody asked* is not *nothing read yet*."""
    made = created(client, LOCAL)
    assert made["integrity_check"] is None
    assert created(client, HTTP)["integrity_check"] is None


def test_a_queued_check_is_visible_with_nobody_polling_the_job(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """A check somebody else started, seen by a client that never asked for one.

    Nothing here reads `/background-jobs/{id}` at any point: the observation is
    the connection listing and only that. That is the whole of "a reload does not
    lose a check", stated as a test rather than as a paragraph.
    """
    dispatcher = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as client:
        made = created(client, LOCAL)
        client.post(f"/inference/connections/{made['id']}/download")
        assert dispatcher.run() == 1
        queued = client.post(f"/inference/connections/{made['id']}/check-integrity").json()

        row = client.get(f"/inference/connections/{made['id']}").json()

        assert row["integrity_check"] == {
            "job_id": queued["id"],
            "state": "queued",
            "files_read": 0,
            "files_total": None,
            "error": None,
            "error_code": None,
        }
        # The connection is still `ready`: a check in flight is not a setup state.
        assert row["setup_state"] == "ready"


def test_a_live_check_does_not_change_what_the_connection_declares(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """**The decision, not a deferral: the declaration stays job-blind.**

    `CONNECTION_GATES` is a function of setup state and connection type, and a job
    moves neither — so a connection with a check in flight still declares
    `check_integrity` *and* `download_weights`, and a request for either is
    accepted rather than refused.

    Making the declaration job-aware was considered and refused. A refusal could
    only be built on a job row being live, and **this is the only one of three
    surfaces that makes one**: the CLI and the MCP tools run the same two
    operations inline (`visionset.cli.inference`, `visionset.mcp.inference`), so
    the rule would bind one caller in three while claiming an exclusivity none of
    them could rely on. It would also strand a connection behind actions it
    refuses whenever a worker died holding a job — the failure `sweep_orphans`
    clears up rather than one to design around. And the shipped default is one
    worker, so what a second request actually costs is a duplicate run *after*
    the first, which is waste rather than a race.

    What answers the waste instead is coalescing, one kind at a time: see
    `test_asking_for_a_download_twice_joins_the_transfer_already_running`. This
    test holds the other half — that nothing is refused, and that the two kinds
    stay independent.
    """
    dispatcher = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as client:
        made = created(client, LOCAL)
        client.post(f"/inference/connections/{made['id']}/download")
        assert dispatcher.run() == 1
        check = client.post(f"/inference/connections/{made['id']}/check-integrity").json()

        row = client.get(f"/inference/connections/{made['id']}").json()

        assert row["integrity_check"]["state"] == "queued"
        assert "check_integrity" in row["allowed_actions"]
        assert "download_weights" in row["allowed_actions"]
        # A download asked for while that check is live is accepted, and it is a
        # run of its own rather than the check handed back under another name.
        started = client.post(f"/inference/connections/{made['id']}/download")
        assert started.status_code == 202
        assert started.json()["id"] != check["id"]


# --- asking twice while one is running ----------------------------------------


def test_asking_for_a_download_twice_joins_the_transfer_already_running(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """One transfer, one id, and nothing queued behind it.

    The second `202` carries the *first* job's id, which is what makes a
    double-click, a second tab and a retried request all watch one run. The
    dispatcher count is the load-bearing half: a response that merely echoed an id
    while a second row sat in the queue would pass an assertion about the body and
    still pay for the gigabytes twice.
    """
    dispatcher = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as client:
        made = created(client, LOCAL)
        first = client.post(f"/inference/connections/{made['id']}/download")
        second = client.post(f"/inference/connections/{made['id']}/download")

        assert second.status_code == 202
        assert second.json()["id"] == first.json()["id"]
        assert second.headers["Location"] == f"/background-jobs/{first.json()['id']}"
        # One run to do, not two.
        assert dispatcher.run() == 1
    assert fetched == ["some/model@abc123"]


def test_asking_for_a_check_twice_joins_the_read_already_running(
    tmp_path: Path, runtime_present: None, fetched: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The download's rule over the other operation, and it is the costlier one.

    A check reads every byte of a multi-gigabyte snapshot to reach a verdict, so a
    second one queued behind the first pays that whole cost to answer a question
    already being answered.
    """
    read: list[UUID] = []

    def _checked(_: Any, connection_id: UUID, **__: Any) -> IntegrityReport:
        read.append(connection_id)
        return IntegrityReport(files_checked=2, bytes_read=99)

    monkeypatch.setattr(job_module, "check_integrity", _checked)
    dispatcher = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as client:
        made = created(client, LOCAL)
        client.post(f"/inference/connections/{made['id']}/download")
        assert dispatcher.run() == 1

        first = client.post(f"/inference/connections/{made['id']}/check-integrity")
        second = client.post(f"/inference/connections/{made['id']}/check-integrity")

        assert second.status_code == 202
        assert second.json()["id"] == first.json()["id"]
        assert dispatcher.run() == 1
    assert len(read) == 1


def test_a_settled_download_is_not_joined_by_the_next_request(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """Asking again after one finished starts a real second run.

    The half that keeps the action usable: `download_weights` stays legal at
    `ready` precisely so it can be asked again — to re-check a snapshot, or to
    retry after a failure — and a route that handed back the settled run would
    answer every one of those with a job that had already stopped.
    """
    dispatcher = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as client:
        made = created(client, LOCAL)
        first = client.post(f"/inference/connections/{made['id']}/download")
        assert dispatcher.run() == 1

        again = client.post(f"/inference/connections/{made['id']}/download")

        assert again.json()["id"] != first.json()["id"]
        assert dispatcher.run() == 1
    assert fetched == ["some/model@abc123"] * 2


def test_a_run_against_another_connection_is_not_joined(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """Matched on the connection the payload names, never on the type alone.

    Two connections downloading at once is ordinary — they may not even name the
    same model — and a route matching on job type would hand the second one the
    first one's transfer and report it as its own.
    """
    dispatcher = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as client:
        mine = created(client, LOCAL)
        theirs = created(client, dict(LOCAL, name="other-gd"))
        first = client.post(f"/inference/connections/{mine['id']}/download")
        second = client.post(f"/inference/connections/{theirs['id']}/download")

        assert second.json()["id"] != first.json()["id"]
        assert dispatcher.run() == 2


def test_joining_a_run_still_wakes_the_dispatcher(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """A queued run somebody joined still needs claiming.

    Nothing has started merely because a row exists, so a route that woke the
    dispatcher only when it enqueued would leave a joined `queued` job waiting on
    the poll interval — visible as a download that sits still for as long as the
    dispatcher happened to be sleeping.
    """
    dispatcher = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as client:
        made = created(client, LOCAL)
        client.post(f"/inference/connections/{made['id']}/download")
        woken = dispatcher.wakes

        client.post(f"/inference/connections/{made['id']}/download")

        assert dispatcher.wakes == woken + 1


def test_a_refusal_is_still_a_refusal_while_a_run_is_live(
    tmp_path: Path, runtime_present: None, fetched: list[str]
) -> None:
    """Joining happens after the gate, never instead of it.

    An `http` connection has no weights to fetch in any state, and a download
    running against a *different* connection must not turn that 409 into a 202
    pointing at somebody else's transfer.
    """
    dispatcher = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as client:
        local = created(client, LOCAL)
        remote = created(client, HTTP)
        client.post(f"/inference/connections/{local['id']}/download")

        refused = client.post(f"/inference/connections/{remote['id']}/download")

        assert refused.status_code == 409
        assert refused.json()["code"] == "INFERENCE_CONNECTION_NOT_DOWNLOADABLE"


def test_a_check_that_failed_while_nobody_watched_still_says_why(
    tmp_path: Path, runtime_present: None, fetched: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The verdict is the row's; the sentence is the check's; both survive a reload.

    Before this, a check that found damage while the tab was closed left a
    connection at `Not set up` with nothing anywhere saying what had happened.
    """

    def _damaged(workspace: Any, connection_id: Any, **_: Any) -> None:
        InferenceConnectionService(workspace).record_weights_missing(connection_id)
        raise WeightsDamaged("1 file does not match (model.safetensors)")

    monkeypatch.setattr(job_module, "check_integrity", _damaged)
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = _made_ready(client)
        client.post(f"/inference/connections/{made['id']}/check-integrity")

        row = client.get(f"/inference/connections/{made['id']}").json()

    assert row["setup_state"] == "not_set_up"
    assert row["integrity_check"]["state"] == "failed"
    assert "model.safetensors" in row["integrity_check"]["error"]
    # The remedy the row now declares, which is what the prose can name.
    assert "download_weights" in row["allowed_actions"]


def test_a_hub_that_could_not_be_reached_is_a_failure_and_not_a_verdict(
    tmp_path: Path, runtime_present: None, fetched: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """#475's semantics, unchanged — and now readable after a reload.

    A network that is not there is not evidence about the files, so nothing is
    purged and no state moves. What changes is only that the sentence saying so
    outlives the request.
    """

    def _unreachable(workspace: Any, connection_id: Any, **_: Any) -> None:
        raise LocalInferenceUnavailable("could not read what the hub publishes")

    monkeypatch.setattr(job_module, "check_integrity", _unreachable)
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = _made_ready(client)
        client.post(f"/inference/connections/{made['id']}/check-integrity")

        row = client.get(f"/inference/connections/{made['id']}").json()

    # No verdict: still ready, still checkable, nothing purged.
    assert row["setup_state"] == "ready"
    assert "check_integrity" in row["allowed_actions"]
    assert row["integrity_check"]["state"] == "failed"
    assert "could not read what the hub publishes" in row["integrity_check"]["error"]


def test_a_finished_check_reports_every_file_it_read(
    tmp_path: Path, runtime_present: None, fetched: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Files, and determinate: a check knows its total before it opens a file."""
    monkeypatch.setattr(
        job_module,
        "check_integrity",
        lambda workspace, connection_id, on_file=None, **_: (
            on_file(11, 11) if on_file is not None else None,
            IntegrityReport(files_checked=11, bytes_read=4_000),
        )[1],
    )
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = _made_ready(client)
        client.post(f"/inference/connections/{made['id']}/check-integrity")

        row = client.get(f"/inference/connections/{made['id']}").json()

    assert row["integrity_check"]["state"] == "succeeded"
    assert (row["integrity_check"]["files_read"], row["integrity_check"]["files_total"]) == (11, 11)
    # The pass leaves the connection exactly where it was.
    assert row["setup_state"] == "ready"


def test_the_two_runs_are_separate_records_on_one_row(
    tmp_path: Path, runtime_present: None, fetched: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """One connection, two questions, two records that never borrow each other's
    numbers — bytes for the transfer, files for the re-read."""
    monkeypatch.setattr(
        job_module,
        "check_integrity",
        lambda *_, **__: IntegrityReport(files_checked=3, bytes_read=99),
    )
    with api_client(tmp_path / "ws", dispatcher=InlineDispatcher()) as client:
        made = _made_ready(client)
        client.post(f"/inference/connections/{made['id']}/check-integrity")

        row = client.get(f"/inference/connections/{made['id']}").json()

    assert row["download"]["bytes_total"] == FETCHED_BYTES
    assert row["integrity_check"]["job_id"] != row["download"]["job_id"]
    assert set(row["integrity_check"]) == {
        "job_id",
        "state",
        "files_read",
        "files_total",
        "error",
        "error_code",
    }
    assert set(row["download"]) == {
        "job_id",
        "state",
        "bytes_done",
        "bytes_total",
        "error",
        "error_code",
    }


# --- asking an endpoint what it answers -----------------------------------------


def test_testing_an_endpoint_records_what_it_answers(client: TestClient) -> None:
    with serving_endpoint(capability="point_suggest") as endpoint:
        made = created(client, {**HTTP, "endpoint_url": endpoint.url})
        assert made["capabilities"] == [] and "test_endpoint" in made["allowed_actions"]
        response = client.post(f"/inference/connections/{made['id']}/test-endpoint")
    assert response.status_code == 200, response.text
    document = response.json()
    assert document["capabilities"] == ["point_suggest"]
    assert document["provider_id"] == "http"
    listed = client.get("/inference/connections").json()["items"][0]
    assert listed["capabilities"] == ["point_suggest"]


def test_a_local_connection_has_no_endpoint_to_test(client: TestClient) -> None:
    made = created(client, LOCAL)
    assert "test_endpoint" not in made["allowed_actions"]
    response = client.post(f"/inference/connections/{made['id']}/test-endpoint")
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_TESTABLE"
    assert "no endpoint" in response.json()["message"]


def test_an_endpoint_that_does_not_answer_is_a_502_naming_it(client: TestClient) -> None:
    url = closed_port()
    made = created(client, {**HTTP, "endpoint_url": url})
    response = client.post(f"/inference/connections/{made['id']}/test-endpoint")
    assert response.status_code == 502, response.text
    assert response.json()["code"] == "INFERENCE_ENDPOINT_UNAVAILABLE"
    assert url in response.json()["message"]
    assert client.get(f"/inference/connections/{made['id']}").json()["capabilities"] == []
