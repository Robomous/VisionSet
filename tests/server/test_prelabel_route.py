"""The pre-label route: refusals before a job exists, and the launch-and-poll 202.

`tests/inference/test_prelabel.py` owns what a run actually writes; this is the
wire's own business — the status, the code a client branches on, and that a
refusal never leaves a row in the queue.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.endpoint import serving_endpoint
from tests.fixtures.media import write_image
from tests.server._api import api_client
from tests.server._flow import batch_from_ingest, project_with_schema
from tests.server._jobs import InlineDispatcher, ManualDispatcher

from visionset.inference import PreLabelOutcome
from visionset.inference import weights as weights_module
from visionset.jobs import prelabel as prelabel_handler
from visionset.kernel.domain import DownloadSize
from visionset.server.routes import batches as batches_routes
from visionset.server.routes import inference as inference_routes

#: A plain box class with no required attribute, so it is exactly what
#: `detectable_classes` admits — unlike `_flow.SIGN`, whose required `occluded`
#: is the other refusal this suite proves.
DETECTABLE = {"name": "sign", "geometries": ["bbox"]}
#: A box class demanding an attribute a model's answer never carries.
ATTRIBUTE_GATED = {
    "name": "sign",
    "geometries": ["bbox"],
    "attributes": [{"name": "occluded", "kind": "boolean", "required": True}],
}
#: Nothing here admits `bbox`, so a schema of only this has nowhere for a
#: detection to land.
POLYGON_ONLY = {"name": "lane", "geometries": ["polygon"]}
#: A box class failing both tests at once: no `bbox` among its geometries *and*
#: an attribute it demands. Neither reason alone is the whole answer for it.
DOUBLY_EXCLUDED = {
    "name": "crossing",
    "geometries": ["polygon"],
    "attributes": [{"name": "painted", "kind": "boolean", "required": True}],
}
#: The ordinary schema — some classes a box can be written as, some not. The
#: partial case the plan exists for, since the total one is already refused.
MIXED = [DETECTABLE, POLYGON_ONLY, DOUBLY_EXCLUDED, {"name": "post", "geometries": ["bbox"]}]

FETCHED_BYTES = 4_000_000_000


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture(autouse=True)
def _local_setup_is_faked(monkeypatch: pytest.MonkeyPatch) -> None:
    """Let a connection reach `ready` and declare a family, on no network and no extra.

    Three seams, all of them already this suite's precedent in
    `tests/server/test_inference.py`: the install check on both routes that make
    one — the weight download and pre-labeling itself — the transfer, and the
    size lookup a create form reads before anybody commits to a download.
    """
    monkeypatch.setattr(inference_routes, "require_local_inference", lambda: None)
    monkeypatch.setattr(batches_routes, "require_local_inference", lambda: None)
    monkeypatch.setattr(weights_module, "download", lambda connection, *, into, on_bytes=None: into)
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


def _connection(
    client: TestClient,
    runner: InlineDispatcher | ManualDispatcher,
    monkeypatch: pytest.MonkeyPatch,
    *,
    family: str,
    capability: str,
) -> str:
    """A `ready` local connection whose model declares ``capability``.

    `fetch_weights` reads the config the moment the transfer finishes and
    records what it found on the same row — so the family this test wants has
    to be in place *before* the download runs, not after. Faked here rather
    than left real for `test_inference.py`'s reason: the real read needs the
    optional runtime this environment does not carry.

    ``runner.wait()`` rather than relying on ``wake()`` alone: a
    ``ManualDispatcher`` only counts a wake, so a caller that needs the
    connection genuinely `ready` before it goes on has to ask for the run
    itself, the way ``batch_from_ingest`` already does for an ingest.
    """
    monkeypatch.setattr(weights_module, "family_of", lambda *_, **__: family)
    body: dict[str, Any] = {
        "name": f"c-{uuid4().hex[:8]}",
        "connection_type": "local",
        "model_id": f"some/{family}",
        "model_revision": "v1",
        "device": "cpu",
        "precision": "fp32",
    }
    made = client.post("/inference/connections", json=body).json()
    connection_id = made["id"]
    queued = client.post(f"/inference/connections/{connection_id}/download")
    assert queued.status_code == 202, queued.text
    runner.wait()
    got = client.get(f"/inference/connections/{connection_id}").json()
    assert got["setup_state"] == "ready", got
    assert got["capabilities"] == [capability], got
    return str(connection_id)


def _pre_label_job_count(client: TestClient) -> int:
    """How many pre-label jobs this workspace has ever queued.

    Not `total` from the listing: an ingest and a connection download both
    queue jobs of their own kind on the way to a batch this suite can use, so a
    caller proving *this* refusal created no job has to count its own kind.
    """
    items = client.get("/background-jobs").json()["items"]
    return sum(1 for item in items if item["type"] == "annotation.pre_label")


@dataclass(frozen=True)
class OpenBatch:
    project_id: str
    id: str
    connection_id: str


def _open_batch(
    client: TestClient,
    runner: InlineDispatcher | ManualDispatcher,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    classes: list[dict[str, Any]],
    family: str = "grounding-dino",
    capability: str = "text_detect",
) -> OpenBatch:
    """A batch open for annotation, pinned to ``classes``, paired with a
    text-detect connection ready to answer it."""
    project_id = project_with_schema(client, classes=classes)
    batch_id = batch_from_ingest(client, runner, tmp_path, project_id, images=3)
    connection_id = _connection(client, runner, monkeypatch, family=family, capability=capability)
    assert client.post(f"/batches/{batch_id}/approve").status_code == 200
    assert client.post(f"/batches/{batch_id}/start").status_code == 200
    return OpenBatch(project_id=project_id, id=batch_id, connection_id=connection_id)


@pytest.fixture()
def in_annotation_batch(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> OpenBatch:
    return _open_batch(client, runner, tmp_path, monkeypatch, classes=[DETECTABLE])


@pytest.fixture()
def draft_batch(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> OpenBatch:
    project_id = project_with_schema(client, classes=[DETECTABLE])
    batch_id = batch_from_ingest(client, runner, tmp_path, project_id, images=3)
    connection_id = _connection(
        client, runner, monkeypatch, family="grounding-dino", capability="text_detect"
    )
    return OpenBatch(project_id=project_id, id=batch_id, connection_id=connection_id)


@pytest.fixture()
def polygon_only_batch(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> OpenBatch:
    return _open_batch(client, runner, tmp_path, monkeypatch, classes=[POLYGON_ONLY])


@pytest.fixture()
def attribute_gated_batch(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> OpenBatch:
    """Every class admits `bbox`, but each one also demands an attribute — the
    second reason `detectable_classes` excludes a class, proved on its own."""
    return _open_batch(client, runner, tmp_path, monkeypatch, classes=[ATTRIBUTE_GATED])


@pytest.fixture()
def mixed_batch(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> OpenBatch:
    """A schema a run can partly ask for — two classes in, two left out."""
    return _open_batch(client, runner, tmp_path, monkeypatch, classes=MIXED)


@pytest.fixture()
def approved_batch(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> OpenBatch:
    """Approved but not started — wrong for `pre_label` on batch state alone."""
    project_id = project_with_schema(client, classes=[DETECTABLE])
    batch_id = batch_from_ingest(client, runner, tmp_path, project_id, images=3)
    connection_id = _connection(
        client, runner, monkeypatch, family="grounding-dino", capability="text_detect"
    )
    assert client.post(f"/batches/{batch_id}/approve").status_code == 200
    return OpenBatch(project_id=project_id, id=batch_id, connection_id=connection_id)


@pytest.fixture()
def segmenter_connection(
    client: TestClient, runner: InlineDispatcher, monkeypatch: pytest.MonkeyPatch
) -> str:
    return _connection(
        client, runner, monkeypatch, family="visionset_stub", capability="point_suggest"
    )


# --- the happy path -------------------------------------------------------------


def test_pre_labeling_answers_202_and_points_at_the_job(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    response = client.post(
        f"/batches/{in_annotation_batch.id}/pre-label",
        json={"connection_id": in_annotation_batch.connection_id, "minimum_confidence": 0.35},
    )

    assert response.status_code == 202, response.text
    assert response.headers["location"] == f"/background-jobs/{response.json()['id']}"


def test_asking_twice_joins_the_run_already_in_flight(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A second request arriving while the first run is still queued gets that
    run's id back rather than a second job — proved with a dispatcher that never
    settles a job on its own, so the first launch is still `queued` when the
    second request asks."""
    manual = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=manual) as client:
        manual.bind(client.app.state.workspace_handle)
        monkeypatch.setattr(inference_routes, "require_local_inference", lambda: None)
        monkeypatch.setattr(batches_routes, "require_local_inference", lambda: None)
        monkeypatch.setattr(
            weights_module, "download", lambda connection, *, into, on_bytes=None: into
        )
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
        batch = _open_batch(client, manual, tmp_path, monkeypatch, classes=[DETECTABLE])

        body = {"connection_id": batch.connection_id}
        first = client.post(f"/batches/{batch.id}/pre-label", json=body)
        second = client.post(f"/batches/{batch.id}/pre-label", json=body)

        assert first.status_code == second.status_code == 202
        assert first.json()["id"] == second.json()["id"]
        assert _pre_label_job_count(client) == 1


def test_an_in_annotation_batch_declares_the_action(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    response = client.get(f"/batches/{in_annotation_batch.id}")

    assert "pre_label" in response.json()["allowed_actions"]


# --- the batch remembers the run, after the page that launched it is gone --------


def test_a_batch_with_no_pre_label_run_reports_none(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    response = client.get(f"/batches/{in_annotation_batch.id}")

    assert response.json()["pre_label_run"] is None


def test_a_settled_run_is_readable_with_no_job_id_of_its_own(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    """The whole feature: a dialog reopened holding no job id can still say what
    happened, because the batch itself carries its most recent run.

    The launch has no real weights behind it here, so the run settles `failed`
    — which is exactly the outcome this proves reaches the batch: `job_id`,
    `state` and the handler's own `error` sentence, none of them invented.
    """
    launched = client.post(
        f"/batches/{in_annotation_batch.id}/pre-label",
        json={"connection_id": in_annotation_batch.connection_id, "minimum_confidence": 0.35},
    ).json()

    reopened = client.get(f"/batches/{in_annotation_batch.id}").json()

    run = reopened["pre_label_run"]
    assert run is not None
    assert run["job_id"] == launched["id"]
    assert run["state"] == "failed"
    assert run["error"]
    assert run["annotations_replaced"] is None


def _faking_the_run(monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any]) -> None:
    """Stand in for `visionset.inference.pre_label` where the handler calls it, so a
    launch settles `succeeded` with a known outcome and records what it was asked."""

    def fake_pre_label(workspace: object, **kwargs: Any) -> PreLabelOutcome:
        captured.update(kwargs)
        return PreLabelOutcome(
            assets_considered=2,
            assets_labeled=2,
            annotations_written=2,
            model_ref="acme/detector@abc123",
            annotations_replaced=2,
        )

    monkeypatch.setattr(prelabel_handler, "pre_label", fake_pre_label)


def test_the_replace_flag_defaults_off_and_reaches_the_run_when_set(
    client: TestClient, in_annotation_batch: OpenBatch, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}
    _faking_the_run(monkeypatch, captured)

    plain = client.post(
        f"/batches/{in_annotation_batch.id}/pre-label",
        json={"connection_id": in_annotation_batch.connection_id},
    )
    assert plain.status_code == 202, plain.text
    assert captured["replace_model_labels"] is False

    flagged = client.post(
        f"/batches/{in_annotation_batch.id}/pre-label",
        json={"connection_id": in_annotation_batch.connection_id, "replace_model_labels": True},
    )
    assert flagged.status_code == 202, flagged.text
    assert flagged.json()["id"] != plain.json()["id"]
    assert captured["replace_model_labels"] is True

    run = client.get(f"/batches/{in_annotation_batch.id}").json()["pre_label_run"]
    assert run["job_id"] == flagged.json()["id"]
    assert run["state"] == "succeeded"
    assert run["annotations_replaced"] == 2


def test_an_unknown_request_field_is_still_refused(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    response = client.post(
        f"/batches/{in_annotation_batch.id}/pre-label",
        json={"connection_id": in_annotation_batch.connection_id, "replace": True},
    )
    assert response.status_code == 422
    assert _pre_label_job_count(client) == 0


def test_the_project_listing_carries_the_run_too(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    """The listing and the single-batch read agree, at the one-query cost model
    `_promoted` already pays for `promoted_asset_count`."""
    client.post(
        f"/batches/{in_annotation_batch.id}/pre-label",
        json={"connection_id": in_annotation_batch.connection_id, "minimum_confidence": 0.35},
    )

    listing = client.get(f"/projects/{in_annotation_batch.project_id}/batches").json()
    row = next(item for item in listing["items"] if item["id"] == in_annotation_batch.id)

    assert row["pre_label_run"] is not None
    assert row["pre_label_run"]["state"] == "failed"


def test_a_draft_batch_does_not_declare_the_action(
    client: TestClient, draft_batch: OpenBatch
) -> None:
    response = client.get(f"/batches/{draft_batch.id}")

    assert "pre_label" not in response.json()["allowed_actions"]


# --- refusals, and that none of them creates a job -------------------------------


def test_a_batch_that_is_not_being_annotated_is_refused_and_queues_nothing(
    client: TestClient, draft_batch: OpenBatch
) -> None:
    response = client.post(
        f"/batches/{draft_batch.id}/pre-label",
        json={"connection_id": draft_batch.connection_id},
    )

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "BATCH_NOT_IN_ANNOTATION"
    assert body["message"]
    assert _pre_label_job_count(client) == 0


# --- the plan a launch would run -------------------------------------------------


def test_the_plan_names_the_prompt_and_every_class_left_out_of_it(
    client: TestClient, mixed_batch: OpenBatch
) -> None:
    """Both lists, in the schema's own order, and both reasons where both hold.

    `crossing` carries two: told only that it admits no box, somebody adds one
    and watches it stay absent.
    """
    response = client.get(
        f"/batches/{mixed_batch.id}/pre-label",
        params={"connection_id": mixed_batch.connection_id},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["schema_version"] == 1
    assert body["asked_classes"] == ["sign", "post"]
    assert body["excluded_classes"] == [
        {"name": "lane", "reasons": ["no_producible_geometry"]},
        {"name": "crossing", "reasons": ["no_producible_geometry", "required_attribute"]},
    ]


def test_the_plan_needs_a_connection_and_names_what_it_writes(
    client: TestClient, mixed_batch: OpenBatch
) -> None:
    """The narrowing is the schema read against one model's shapes, so the plan
    says which shapes those are — and reading it still queues nothing."""
    body = client.get(
        f"/batches/{mixed_batch.id}/pre-label",
        params={"connection_id": mixed_batch.connection_id},
    ).json()

    assert body["asked_classes"] == ["sign", "post"]
    assert body["produces"] == ["bbox"]
    assert _pre_label_job_count(client) == 0


def test_the_plan_names_every_shape_a_multi_shape_model_produces(
    client: TestClient,
    runner: InlineDispatcher,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every other test in this file resolves through ``grounding-dino``, whose
    ``produces`` is a single shape; a model declaring two proves the route
    reports the whole set, not one it happens to have exercised so far."""
    batch = _open_batch(
        client,
        runner,
        tmp_path,
        monkeypatch,
        classes=[POLYGON_ONLY],
        family="text_detect",
        capability="text_detect",
    )

    response = client.get(
        f"/batches/{batch.id}/pre-label",
        params={"connection_id": batch.connection_id},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["produces"] == ["bbox", "polygon"]
    assert body["asked_classes"] == [POLYGON_ONLY["name"]]
    assert body["excluded_classes"] == []


def test_the_plan_without_a_connection_is_a_validation_error(
    client: TestClient, mixed_batch: OpenBatch
) -> None:
    assert client.get(f"/batches/{mixed_batch.id}/pre-label").status_code == 422


def test_the_plan_refuses_a_point_prompt_connection(
    client: TestClient, in_annotation_batch: OpenBatch, segmenter_connection: str
) -> None:
    """The plan and the launch refuse on the same terms, so reading one and then
    pressing the other gets one set of answers."""
    response = client.get(
        f"/batches/{in_annotation_batch.id}/pre-label",
        params={"connection_id": segmenter_connection},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "UNSUPPORTED_PROMPT"


def test_the_plan_refuses_a_not_set_up_connection(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    made = client.post(
        "/inference/connections",
        json={
            "name": f"c-{uuid4().hex[:8]}",
            "connection_type": "local",
            "model_id": "some/grounding-dino",
            "model_revision": "v1",
            "device": "cpu",
            "precision": "fp32",
        },
    ).json()

    response = client.get(
        f"/batches/{in_annotation_batch.id}/pre-label",
        params={"connection_id": made["id"]},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_SET_UP"


def test_the_plan_of_an_unknown_connection_is_not_found(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    response = client.get(
        f"/batches/{in_annotation_batch.id}/pre-label",
        params={"connection_id": str(uuid4())},
    )

    assert response.status_code == 404
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_FOUND"


def test_a_wholly_askable_schema_leaves_nothing_out(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    response = client.get(
        f"/batches/{in_annotation_batch.id}/pre-label",
        params={"connection_id": in_annotation_batch.connection_id},
    )

    assert response.status_code == 200, response.text
    assert response.json()["excluded_classes"] == []


def test_the_plan_refuses_a_schema_with_no_box_class(
    client: TestClient, polygon_only_batch: OpenBatch
) -> None:
    """Refused rather than answered with an empty prompt.

    Pre-labeling this batch is impossible, not merely unproductive, and the
    launch says so with this same code — so the dialog can stop before the press
    rather than after it.
    """
    response = client.get(
        f"/batches/{polygon_only_batch.id}/pre-label",
        params={"connection_id": polygon_only_batch.connection_id},
    )

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "SCHEMA_HAS_NO_DETECTABLE_CLASS"
    assert body["message"]


def test_the_plan_refuses_a_batch_that_is_not_being_annotated(
    client: TestClient, draft_batch: OpenBatch
) -> None:
    response = client.get(
        f"/batches/{draft_batch.id}/pre-label",
        params={"connection_id": draft_batch.connection_id},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "BATCH_NOT_IN_ANNOTATION"


def test_the_plan_of_an_unknown_batch_is_not_found(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    response = client.get(
        f"/batches/{uuid4()}/pre-label",
        params={"connection_id": in_annotation_batch.connection_id},
    )

    assert response.status_code == 404
    assert response.json()["code"] == "BATCH_NOT_FOUND"


def test_a_point_prompt_connection_is_refused_before_a_job_exists(
    client: TestClient, in_annotation_batch: OpenBatch, segmenter_connection: str
) -> None:
    response = client.post(
        f"/batches/{in_annotation_batch.id}/pre-label",
        json={"connection_id": segmenter_connection},
    )

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "UNSUPPORTED_PROMPT"
    assert body["message"]
    assert _pre_label_job_count(client) == 0


def test_a_schema_with_no_box_class_is_refused_before_a_job_exists(
    client: TestClient, polygon_only_batch: OpenBatch
) -> None:
    response = client.post(
        f"/batches/{polygon_only_batch.id}/pre-label",
        json={"connection_id": polygon_only_batch.connection_id},
    )

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "SCHEMA_HAS_NO_DETECTABLE_CLASS"
    assert body["message"]
    assert _pre_label_job_count(client) == 0


def test_a_schema_whose_box_class_requires_an_attribute_is_refused_before_a_job_exists(
    client: TestClient, attribute_gated_batch: OpenBatch
) -> None:
    """The refusal `detectable_classes` grew a second reason for: a bare
    prediction can never carry the attribute value this class demands."""
    response = client.post(
        f"/batches/{attribute_gated_batch.id}/pre-label",
        json={"connection_id": attribute_gated_batch.connection_id},
    )

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "SCHEMA_HAS_NO_DETECTABLE_CLASS"
    assert body["message"]
    assert _pre_label_job_count(client) == 0


def test_a_not_set_up_connection_is_refused_before_a_job_exists(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    """A connection that answers words but has no weights yet must not be told
    it answers places — `setup_state` is checked before the capability read,
    which is empty on a connection nobody has downloaded weights for."""
    body = {
        "name": f"c-{uuid4().hex[:8]}",
        "connection_type": "local",
        "model_id": "some/grounding-dino",
        "model_revision": "v1",
        "device": "cpu",
        "precision": "fp32",
    }
    made = client.post("/inference/connections", json=body).json()

    response = client.post(
        f"/batches/{in_annotation_batch.id}/pre-label",
        json={"connection_id": made["id"]},
    )

    assert response.status_code == 409
    body_out = response.json()
    assert body_out["code"] == "INFERENCE_CONNECTION_NOT_SET_UP"
    assert body_out["message"]
    assert _pre_label_job_count(client) == 0


def test_the_connection_is_refused_before_the_batch_state(
    client: TestClient, approved_batch: OpenBatch, segmenter_connection: str
) -> None:
    """An approved-but-not-started batch and a point-prompt connection are both
    wrong at once. The connection's refusal wins — the same order `pre_label`
    itself checks in — so REST and MCP never disagree about which of the two
    reasons a caller gets back."""
    response = client.post(
        f"/batches/{approved_batch.id}/pre-label",
        json={"connection_id": segmenter_connection},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "UNSUPPORTED_PROMPT"
    assert _pre_label_job_count(client) == 0


def test_an_unknown_batch_is_not_found(client: TestClient) -> None:
    response = client.post(f"/batches/{uuid4()}/pre-label", json={"connection_id": str(uuid4())})

    assert response.status_code == 404


def test_a_confidence_outside_the_unit_interval_is_a_validation_error(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    response = client.post(
        f"/batches/{in_annotation_batch.id}/pre-label",
        json={"connection_id": in_annotation_batch.connection_id, "minimum_confidence": 1.5},
    )

    assert response.status_code == 422
    assert _pre_label_job_count(client) == 0


def test_an_http_connection_that_answers_words_is_not_gated_on_the_local_runtime(
    client: TestClient, in_annotation_batch: OpenBatch, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The runtime gate is about a model that would load *here*; an endpoint loads nothing here."""

    def _never() -> None:
        raise AssertionError("the local runtime must not be demanded for an http connection")

    monkeypatch.setattr(batches_routes, "require_local_inference", _never)
    with serving_endpoint(capability="text_detect") as endpoint:
        made = client.post(
            "/inference/connections",
            json={
                "name": "remote-detector",
                "connection_type": "http",
                "model_id": "acme/detector",
                "model_revision": "v1",
                "endpoint_url": endpoint.url,
            },
        ).json()
        client.post(f"/inference/connections/{made['id']}/test-endpoint")
        response = client.post(
            f"/batches/{in_annotation_batch.id}/pre-label",
            json={"connection_id": made["id"]},
        )
    assert response.status_code == 202, response.text


def test_an_http_connection_nobody_asked_is_refused_with_the_action_that_asks(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    made = client.post(
        "/inference/connections",
        json={
            "name": "remote-detector",
            "connection_type": "http",
            "model_id": "acme/detector",
            "model_revision": "v1",
            "endpoint_url": "https://example.invalid/predict",
        },
    ).json()
    response = client.post(
        f"/batches/{in_annotation_batch.id}/pre-label",
        json={"connection_id": made["id"]},
    )
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_SET_UP"
    assert "test_endpoint" in response.json()["message"]


# --- the project-wide launch ---------------------------------------------------


def _more_stills(
    tmp_path: Path, *, count: int, first_seed: int
) -> list[tuple[str, tuple[str, bytes, str]]]:
    """Multipart parts whose bytes differ from ``image_parts``'s: a second ingest of the
    same seeds would dedupe onto the first batch's assets."""
    return [
        (
            "files",
            (
                f"more-{index}.png",
                write_image(tmp_path / f"more-{index}.png", seed=first_seed + index).read_bytes(),
                "image/png",
            ),
        )
        for index in range(count)
    ]


def _another_open_batch(
    client: TestClient,
    runner: InlineDispatcher | ManualDispatcher,
    tmp_path: Path,
    project_id: str,
    *,
    first_seed: int = 100,
) -> str:
    source_id = client.post(
        f"/projects/{project_id}/sources/images",
        files=_more_stills(tmp_path, count=2, first_seed=first_seed),
    ).json()["id"]
    job = client.post(f"/sources/{source_id}/ingest-jobs").json()
    runner.wait()
    batch_id: str = client.get(f"/ingest-jobs/{job['id']}").json()["batch_id"]
    assert client.post(f"/batches/{batch_id}/approve").status_code == 200
    assert client.post(f"/batches/{batch_id}/start").status_code == 200
    return batch_id


def _launch(client: TestClient, project_id: str, connection_id: str, **extra: Any) -> Any:
    return client.post(
        f"/projects/{project_id}/batches/pre-label",
        json={"connection_id": connection_id, "minimum_confidence": 0.35, **extra},
    )


def test_the_project_launch_fans_out_one_row_per_open_batch(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, in_annotation_batch: OpenBatch
) -> None:
    second = _another_open_batch(client, runner, tmp_path, in_annotation_batch.project_id)
    before = _pre_label_job_count(client)

    response = _launch(client, in_annotation_batch.project_id, in_annotation_batch.connection_id)

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["total"] == 2
    assert [item["batch_id"] for item in body["items"]] == [in_annotation_batch.id, second]
    assert all(item["job"]["type"] == "annotation.pre_label" for item in body["items"])
    assert all(item["joined"] is False for item in body["items"])
    assert {item["batch_name"] for item in body["items"]} == {
        client.get(f"/batches/{in_annotation_batch.id}").json()["name"],
        client.get(f"/batches/{second}").json()["name"],
    }
    assert _pre_label_job_count(client) == before + 2


def test_a_named_selection_launches_only_those_batches(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, in_annotation_batch: OpenBatch
) -> None:
    second = _another_open_batch(client, runner, tmp_path, in_annotation_batch.project_id)

    response = _launch(
        client,
        in_annotation_batch.project_id,
        in_annotation_batch.connection_id,
        batch_ids=[second],
    )

    assert response.status_code == 202, response.text
    assert [item["batch_id"] for item in response.json()["items"]] == [second]


def test_asking_again_joins_the_rows_already_in_flight(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manual = ManualDispatcher()
    with api_client(tmp_path / "ws", dispatcher=manual) as client:
        manual.bind(client.app.state.workspace_handle)
        batch = _open_batch(client, manual, tmp_path, monkeypatch, classes=[DETECTABLE])
        second = _another_open_batch(client, manual, tmp_path, batch.project_id)

        first = _launch(client, batch.project_id, batch.connection_id).json()
        again = _launch(client, batch.project_id, batch.connection_id).json()

        assert [item["job"]["id"] for item in again["items"]] == [
            item["job"]["id"] for item in first["items"]
        ]
        assert all(item["joined"] is True for item in again["items"])
        assert second in {item["batch_id"] for item in again["items"]}


def test_a_named_batch_of_another_project_is_404_and_creates_no_job(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, in_annotation_batch: OpenBatch
) -> None:
    other_project = project_with_schema(client, name="elsewhere", classes=[DETECTABLE])
    other_batch = batch_from_ingest(client, runner, tmp_path / "elsewhere", other_project, images=2)
    before = _pre_label_job_count(client)

    response = _launch(
        client,
        in_annotation_batch.project_id,
        in_annotation_batch.connection_id,
        batch_ids=[other_batch],
    )

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "BATCH_NOT_FOUND"
    assert _pre_label_job_count(client) == before


def test_a_named_draft_is_409_and_creates_no_job(
    client: TestClient, draft_batch: OpenBatch
) -> None:
    before = _pre_label_job_count(client)

    response = _launch(
        client, draft_batch.project_id, draft_batch.connection_id, batch_ids=[draft_batch.id]
    )

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "BATCH_NOT_IN_ANNOTATION"
    assert _pre_label_job_count(client) == before


def test_a_project_with_no_open_batch_is_409(client: TestClient, draft_batch: OpenBatch) -> None:
    response = _launch(client, draft_batch.project_id, draft_batch.connection_id)

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "BATCH_NOT_IN_ANNOTATION"
    assert "no batch open for annotation" in response.json()["message"]


def test_an_empty_batch_list_is_409_by_its_own_sentence(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    response = _launch(
        client, in_annotation_batch.project_id, in_annotation_batch.connection_id, batch_ids=[]
    )

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "BATCH_NOT_IN_ANNOTATION"
    assert "no batch named" in response.json()["message"]


def test_one_undetectable_pin_refuses_the_whole_request_naming_the_batch(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, polygon_only_batch: OpenBatch
) -> None:
    """A project-wide request is refused whole, not partly launched: the row the
    caller did not get is the one they cannot find out about afterwards."""
    before = _pre_label_job_count(client)
    lanes = client.get(f"/batches/{polygon_only_batch.id}").json()["name"]

    response = _launch(client, polygon_only_batch.project_id, polygon_only_batch.connection_id)

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "SCHEMA_HAS_NO_DETECTABLE_CLASS"
    assert f"batch {lanes!r}" in response.json()["message"]
    assert _pre_label_job_count(client) == before


def test_the_project_launch_shares_the_connection_gate(
    client: TestClient, in_annotation_batch: OpenBatch, segmenter_connection: str
) -> None:
    response = _launch(client, in_annotation_batch.project_id, segmenter_connection)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "UNSUPPORTED_PROMPT"


def test_the_project_launch_refuses_an_unknown_field(
    client: TestClient, in_annotation_batch: OpenBatch
) -> None:
    response = _launch(
        client, in_annotation_batch.project_id, in_annotation_batch.connection_id, batch_id="x"
    )

    assert response.status_code == 422, response.text
