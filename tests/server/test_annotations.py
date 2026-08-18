"""Annotations over HTTP: bulk writes, all-or-nothing, and which one was wrong.

Two claims carry the rest of this module. **Nothing partial ever lands** — a
payload with one bad box stores none of them, asserted by re-reading rather than
by trusting the status. And **a refusal names the position** it is about, because
nothing was written and the message alone cannot say which item it meant.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client
from tests.server._flow import (
    CENTERLINE,
    LANE,
    SIGN,
    a_box,
    asset_ids,
    batch_from_ingest,
    open_job,
    project_with_schema,
)
from tests.server._jobs import InlineDispatcher


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def working(client: TestClient, tmp_path: Path, runner: InlineDispatcher) -> tuple[str, str]:
    """A started job over a three-asset batch. Returns ``(batch_id, job_id)``.

    The schema is named here rather than taken as the default because this suite
    is the one that writes every geometry: `centerline` is the polyline class,
    and a route suite whose schema cannot express a lane cannot notice one being
    refused.
    """
    return open_job(client, runner, tmp_path, images=3, classes=[SIGN, LANE, CENTERLINE])


@pytest.fixture()
def assets(client: TestClient, working: tuple[str, str]) -> list[str]:
    return asset_ids(client, working[0])


def stored(client: TestClient, job_id: str, asset_id: str) -> list[dict[str, object]]:
    body = client.get(f"/jobs/{job_id}/assets/{asset_id}/annotations").json()
    items: list[dict[str, object]] = body["items"]
    return items


# --- writing ------------------------------------------------------------------


def test_a_box_comes_back_with_the_pinned_version_stamped_on_it(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    """`schema_version` is not on the request: the batch's pin is what is stored."""
    _, job_id = working

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0])])

    assert response.status_code == 201
    (written,) = response.json()["items"]
    assert written["schema_version"] == 1
    assert written["asset_id"] == assets[0]
    assert written["geometry"] == {
        "type": "bbox",
        "x": 1.0,
        "y": 2.0,
        "width": 30.0,
        "height": 40.0,
    }
    assert written["id"]


def test_writing_a_label_moves_the_asset_to_annotated(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working

    client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0])])

    assert client.get(f"/jobs/{job_id}/progress").json()["annotated"] == 1


def test_one_call_can_carry_labels_for_several_assets(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0]), a_box(assets[1])])

    assert response.json()["total"] == 2
    assert client.get(f"/jobs/{job_id}/progress").json()["annotated"] == 2


def test_a_box_wholly_outside_a_measured_asset_is_a_422(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working

    response = client.post(
        f"/jobs/{job_id}/annotations",
        json=[
            a_box(
                assets[0],
                geometry={"type": "bbox", "x": 33.0, "y": 12.0, "width": 5.0, "height": 5.0},
            )
        ],
    )

    assert response.status_code == 422
    assert response.json()["code"] == "ANNOTATION_GEOMETRY_OUT_OF_BOUNDS"


def test_a_box_partly_overlapping_a_measured_asset_is_stored(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working

    response = client.post(
        f"/jobs/{job_id}/annotations",
        json=[
            a_box(
                assets[0],
                geometry={"type": "bbox", "x": 31.0, "y": 12.0, "width": 5.0, "height": 5.0},
            )
        ],
    )

    assert response.status_code == 201
    assert response.json()["total"] == 1


def test_a_polygon_lands_under_the_class_that_declares_one(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working

    response = client.post(
        f"/jobs/{job_id}/annotations",
        json=[
            a_box(
                assets[0],
                label_class="lane",
                geometry={"type": "polygon", "points": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]},
                attributes={},
            )
        ],
    )

    assert response.status_code == 201
    assert response.json()["items"][0]["geometry"]["type"] == "polygon"


def test_a_polyline_lands_under_the_class_that_declares_one(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    """A lane written over REST, judged by the gates that already exist.

    Nothing new gates a polyline — the batch must be `in_annotation` and the
    asset's progress must allow a write — so the assertion worth making is that
    the *ordinary* path carries it, points and all, with no special case.
    """
    _, job_id = working

    response = client.post(
        f"/jobs/{job_id}/annotations",
        json=[
            a_box(
                assets[0],
                label_class="centerline",
                geometry={"type": "polyline", "points": [[0.0, 0.0], [4.0, 8.0], [9.0, 20.0]]},
                attributes={},
            )
        ],
    )

    assert response.status_code == 201
    written = response.json()["items"][0]["geometry"]
    assert written["type"] == "polyline"
    # The order of the points is the value, so it must survive the round trip.
    assert written["points"] == [[0.0, 0.0], [4.0, 8.0], [9.0, 20.0]]


def test_a_polyline_may_not_be_written_under_a_polygon_class(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    """The per-class geometry rule, which a new geometry must not weaken.

    `lane` declares `polygon`; a polyline under it is refused by
    `AnnotationService` exactly as any other mismatch is. Worth pinning because
    the two geometries share a payload shape — `points` alone would parse under
    either — so only the discriminator tells them apart.
    """
    _, job_id = working

    response = client.post(
        f"/jobs/{job_id}/annotations",
        json=[
            a_box(
                assets[0],
                label_class="lane",
                geometry={"type": "polyline", "points": [[0.0, 0.0], [4.0, 8.0]]},
                attributes={},
            )
        ],
    )

    assert response.status_code == 422
    assert response.json()["code"] == "DISALLOWED_GEOMETRY"


# --- reading ------------------------------------------------------------------


def test_an_asset_nobody_has_labeled_is_an_empty_page(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working

    assert stored(client, job_id, assets[0]) == []


def test_reading_is_not_gated_on_the_batch_being_open(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    """A label outlives the work that produced it; only writes need an open batch."""
    batch_id, job_id = working
    client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0])])
    for asset_id in assets[1:]:
        client.put(f"/jobs/{job_id}/assets/{asset_id}/progress", json={"progress": "skipped"})
    client.post(f"/jobs/{job_id}/complete")
    client.post(f"/batches/{batch_id}/complete")

    assert len(stored(client, job_id, assets[0])) == 1


def test_reading_an_asset_outside_the_job_is_404(
    client: TestClient, working: tuple[str, str]
) -> None:
    _, job_id = working

    response = client.get(f"/jobs/{job_id}/assets/{uuid4()}/annotations")

    assert response.status_code == 404
    assert response.json()["code"] == "ASSET_NOT_IN_JOB"


# --- updating and deleting ----------------------------------------------------


def test_an_update_replaces_the_stored_annotation_whole(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working
    (written,) = client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0])]).json()["items"]

    response = client.patch(
        f"/jobs/{job_id}/annotations",
        json=[
            {
                "id": written["id"],
                "label_class": "sign",
                "geometry": {"type": "bbox", "x": 9.0, "y": 9.0, "width": 1.0, "height": 1.0},
                "attributes": {"occluded": True},
                "provenance": "human",
            }
        ],
    )

    assert response.status_code == 200
    (updated,) = response.json()["items"]
    assert updated["id"] == written["id"]
    assert updated["asset_id"] == assets[0]
    assert updated["geometry"]["x"] == 9.0
    assert updated["attributes"] == {"occluded": True}


def test_deleting_the_last_annotation_moves_the_asset_back(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working
    (written,) = client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0])]).json()["items"]

    response = client.delete(f"/jobs/{job_id}/annotations", params={"id": written["id"]})

    assert response.status_code == 204
    assert response.content == b""
    assert stored(client, job_id, assets[0]) == []
    assert client.get(f"/jobs/{job_id}/progress").json()["unannotated"] == 3


def test_one_delete_takes_several_ids(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    """One transaction, however many ids — which is why they are query parameters."""
    _, job_id = working
    written = client.post(
        f"/jobs/{job_id}/annotations", json=[a_box(assets[0]), a_box(assets[0])]
    ).json()["items"]

    response = client.delete(
        f"/jobs/{job_id}/annotations", params={"id": [a["id"] for a in written]}
    )

    assert response.status_code == 204
    assert stored(client, job_id, assets[0]) == []


def test_deleting_with_no_ids_is_refused_by_the_signature(
    client: TestClient, working: tuple[str, str]
) -> None:
    _, job_id = working

    response = client.delete(f"/jobs/{job_id}/annotations")

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


# --- all or nothing, and which one was wrong ----------------------------------


def test_one_bad_annotation_in_a_payload_stores_none_of_them(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working

    response = client.post(
        f"/jobs/{job_id}/annotations",
        json=[a_box(assets[0]), a_box(assets[1]), a_box(assets[2], attributes={})],
    )

    assert response.status_code == 422
    assert response.json()["code"] == "MISSING_REQUIRED_ATTRIBUTE"
    for asset_id in assets:
        assert stored(client, job_id, asset_id) == []
    assert client.get(f"/jobs/{job_id}/progress").json()["annotated"] == 0


def test_a_refusal_names_the_position_it_is_about(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working

    response = client.post(
        f"/jobs/{job_id}/annotations",
        json=[a_box(assets[0]), a_box(assets[1]), a_box(assets[2], label_class="ghost")],
    )

    assert response.status_code == 422
    assert response.json()["code"] == "LABEL_CLASS_NOT_IN_SCHEMA"
    assert response.json()["detail"] == {"index": 2}


def test_an_update_that_is_refused_leaves_the_stored_one_alone(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working
    (written,) = client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0])]).json()["items"]

    response = client.patch(
        f"/jobs/{job_id}/annotations",
        json=[
            {
                "id": written["id"],
                "label_class": "sign",
                "geometry": {"type": "polygon", "points": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]},
                "attributes": {"occluded": True},
                "provenance": "human",
            }
        ],
    )

    assert response.status_code == 422
    assert response.json()["code"] == "DISALLOWED_GEOMETRY"
    assert response.json()["detail"] == {"index": 0}
    assert stored(client, job_id, assets[0]) == [written]


def test_one_unknown_id_deletes_none_of_them(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working
    (written,) = client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0])]).json()["items"]

    response = client.delete(
        f"/jobs/{job_id}/annotations", params={"id": [written["id"], str(uuid4())]}
    )

    assert response.status_code == 404
    assert response.json()["code"] == "ANNOTATION_NOT_FOUND"
    assert response.json()["detail"] == {"index": 1}
    assert stored(client, job_id, assets[0]) == [written]


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"label_class": "ghost"}, "LABEL_CLASS_NOT_IN_SCHEMA"),
        (
            {"geometry": {"type": "polygon", "points": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]}},
            "DISALLOWED_GEOMETRY",
        ),
        ({"attributes": {}}, "MISSING_REQUIRED_ATTRIBUTE"),
        ({"attributes": {"occluded": False, "weather": "dry"}}, "UNKNOWN_ATTRIBUTE"),
        ({"attributes": {"occluded": "yes"}}, "INVALID_ATTRIBUTE_VALUE"),
    ],
)
def test_every_schema_refusal_keeps_its_own_code(
    client: TestClient,
    working: tuple[str, str],
    assets: list[str],
    overrides: dict[str, object],
    code: str,
) -> None:
    """One 422 with five codes: the status is coarse and the code is the contract."""
    _, job_id = working

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0], **overrides)])

    assert response.status_code == 422
    assert response.json()["code"] == code


# --- the two things that would otherwise be 500s ------------------------------


def test_a_model_annotation_with_no_model_ref_is_422_not_500(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    """`Annotation` refuses this with a *pydantic* error, which reaches the
    catch-all handler. The parsing-time validator is what makes it a 422."""
    _, job_id = working

    response = client.post(
        f"/jobs/{job_id}/annotations", json=[a_box(assets[0], provenance="model")]
    )

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    "overrides",
    [
        {"confidence": 2.0},
        {"geometry": {"type": "bbox", "x": 0.0, "y": 0.0, "width": 0.0, "height": 1.0}},
        {"geometry": {"type": "polygon", "points": [[0.0, 0.0], [1.0, 1.0]]}},
        # One point is under the polyline minimum, and two identical ones are a
        # path with no length — the analogue of the zero-area box above.
        {"geometry": {"type": "polyline", "points": [[0.0, 0.0]]}},
        {"geometry": {"type": "polyline", "points": [[3.0, 3.0], [3.0, 3.0]]}},
    ],
)
def test_a_value_the_domain_cannot_hold_is_422_not_500(
    client: TestClient, working: tuple[str, str], assets: list[str], overrides: dict[str, object]
) -> None:
    _, job_id = working

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0], **overrides)])

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_a_geometry_with_no_type_cannot_pick_a_variant(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working

    response = client.post(
        f"/jobs/{job_id}/annotations",
        json=[a_box(assets[0], geometry={"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0})],
    )

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_a_misspelled_field_is_refused_rather_than_ignored(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    _, job_id = working

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0], schema_version=7)])

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


# --- the gates ----------------------------------------------------------------


def test_an_asset_in_a_body_the_job_does_not_carry_is_422(
    client: TestClient, working: tuple[str, str]
) -> None:
    """The same error is a 404 in a path. Only the status moves; the code does not."""
    _, job_id = working

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(str(uuid4()))])

    assert response.status_code == 422
    assert response.json()["code"] == "ASSET_NOT_IN_JOB"


def test_nothing_is_written_into_a_batch_nobody_opened(
    client: TestClient, tmp_path: Path, runner: InlineDispatcher
) -> None:
    project = project_with_schema(client)
    batch_id = batch_from_ingest(client, runner, tmp_path, project, images=2)
    client.post(f"/batches/{batch_id}/approve")
    job_id = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    asset_id = asset_ids(client, batch_id)[0]

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(asset_id)])

    assert response.status_code == 409
    assert response.json()["code"] == "BATCH_NOT_IN_ANNOTATION"


@pytest.mark.parametrize(
    ("settled", "walk"),
    [
        ("skipped", ("skipped",)),
        ("review_pending", ("annotated", "review_pending")),
        ("accepted", ("annotated", "review_pending", "accepted")),
    ],
)
def test_nothing_is_written_onto_an_asset_whose_labeling_is_over(
    client: TestClient,
    working: tuple[str, str],
    assets: list[str],
    settled: str,
    walk: tuple[str, ...],
) -> None:
    """The batch is wide open; it is this asset that is done. 409 ASSET_NOT_WRITABLE."""
    _, job_id = working
    asset_id = assets[0]
    for step in walk:
        client.put(f"/jobs/{job_id}/assets/{asset_id}/progress", json={"progress": step})

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(asset_id)])

    assert response.status_code == 409
    assert response.json()["code"] == "ASSET_NOT_WRITABLE"
    assert settled in response.json()["message"]
    # A sibling in the same open batch is untouched: the gate is per asset.
    assert client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[1])]).status_code == 201


def test_taking_a_skip_back_makes_the_asset_writable_again(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    """The refusal names a state, and the progress route is how a client leaves it."""
    _, job_id = working
    asset_id = assets[0]
    client.put(f"/jobs/{job_id}/assets/{asset_id}/progress", json={"progress": "skipped"})
    assert client.post(f"/jobs/{job_id}/annotations", json=[a_box(asset_id)]).status_code == 409

    client.put(f"/jobs/{job_id}/assets/{asset_id}/progress", json={"progress": "unannotated"})

    assert client.post(f"/jobs/{job_id}/annotations", json=[a_box(asset_id)]).status_code == 201


def test_nothing_is_written_after_the_batch_closes(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    batch_id, job_id = working
    for asset_id in assets:
        client.put(f"/jobs/{job_id}/assets/{asset_id}/progress", json={"progress": "skipped"})
    client.post(f"/jobs/{job_id}/complete")
    client.post(f"/batches/{batch_id}/complete")

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0])])

    assert response.status_code == 409
    assert response.json()["code"] == "BATCH_NOT_IN_ANNOTATION"


def test_nothing_is_written_after_the_job_finishes_even_with_the_batch_open(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    """The job gate, over HTTP, and the batch is deliberately left open.

    The sibling of the test above and the one it could not stand in for:
    completing a job does not complete its batch, so `BATCH_NOT_IN_ANNOTATION`
    never fired here and every write below answered 201. What the workspace then
    showed was a live editor over a job it had just been told was finished.
    """
    batch_id, job_id = working
    for asset_id in assets:
        client.post(f"/jobs/{job_id}/annotations", json=[a_box(asset_id)])
    assert client.post(f"/jobs/{job_id}/complete").status_code == 200
    assert client.get(f"/batches/{batch_id}").json()["state"] == "in_annotation"

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0])])

    assert response.status_code == 409
    assert response.json()["code"] == "JOB_FINISHED"
    # The declaration agrees with the refusal, which is the whole contract: a
    # client renders what the wire declares, and it now declares nothing here.
    rows = client.get(f"/batches/{batch_id}/assets").json()["items"]
    assert [row["allowed_actions"] for row in rows] == [[] for _ in rows]
    # And a progress move is refused by the same code, so a client cannot walk
    # around the write gate through the settle route.
    moved = client.put(f"/jobs/{job_id}/assets/{assets[0]}/progress", json={"progress": "skipped"})
    assert (moved.status_code, moved.json()["code"]) == (409, "JOB_FINISHED")


def test_an_open_job_still_declares_its_frames_writable(
    client: TestClient, working: tuple[str, str], assets: list[str]
) -> None:
    """The control for the test above: the gate is the job's state and nothing else."""
    batch_id, job_id = working

    rows = client.get(f"/batches/{batch_id}/assets").json()["items"]

    assert all("annotate" in row["allowed_actions"] for row in rows)


def test_writing_to_an_unknown_job_is_404(client: TestClient) -> None:
    response = client.post(f"/jobs/{uuid4()}/annotations", json=[a_box(str(uuid4()))])

    assert response.status_code == 404
    assert response.json()["code"] == "JOB_NOT_FOUND"


def test_an_annotation_route_refuses_a_request_with_no_token(client: TestClient) -> None:
    response = client.post(f"/jobs/{uuid4()}/annotations", json=[], headers={"Authorization": ""})

    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHORIZED"
