"""`keypoints` and the class keypoint spec over HTTP, from the schema to the release."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Final

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client
from tests.server._flow import SIGN, batch_from_ingest, dataset_of, project_with_schema
from tests.server._jobs import InlineDispatcher
from tests.server.test_point_cloud_routes import upload_scans

from visionset.kernel.domain import KEYPOINTS_MANIFEST_VERSION

SPEC: Final[dict[str, Any]] = {
    "names": ["left_eye", "right_eye", "nose"],
    "skeleton": [[2, 0], [0, 1], [1, 2]],
}
FACE: Final[dict[str, Any]] = {"name": "face", "geometries": ["keypoints"], "keypoints": SPEC}
#: A keypoints class with no spec, so any count of at least one is accepted.
POSE: Final[dict[str, Any]] = {"name": "pose", "geometries": ["keypoints"]}
#: Two points at one pixel, and one of each visibility state.
POINTS: Final = [[1.5, 2.25], [1.5, 2.25], [20.0, 10.5]]
VISIBILITY: Final = [2, 1, 0]


def _keypoints(asset_id: str, points: Any, label_class: str = "face", **geometry: Any) -> Any:
    return {
        "asset_id": asset_id,
        "label_class": label_class,
        "geometry": {"type": "keypoints", "points": points, **geometry},
        "attributes": {},
        "provenance": "human",
    }


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    return project_with_schema(client, classes=[SIGN, FACE, POSE])


@pytest.fixture()
def working(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, project: str
) -> tuple[str, str, str]:
    """``(batch_id, job_id, asset_id)`` for a started one-image job."""
    batch_id = batch_from_ingest(client, runner, tmp_path, project, images=1)
    client.post(f"/batches/{batch_id}/approve")
    client.post(f"/batches/{batch_id}/start")
    job_id: str = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job_id}/start")
    (asset,) = client.get(f"/batches/{batch_id}/assets").json()["items"]
    return batch_id, job_id, asset["id"]


def _stored(client: TestClient, job_id: str, asset_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = client.get(
        f"/jobs/{job_id}/assets/{asset_id}/annotations"
    ).json()["items"]
    return items


def _post_raw(client: TestClient, job_id: str, text: str) -> Any:
    return client.post(
        f"/jobs/{job_id}/annotations",
        content=text.encode(),
        headers={"Content-Type": "application/json"},
    )


# --- the spec on a schema ------------------------------------------------------


def test_the_spec_is_published_and_read_back_verbatim(client: TestClient, project: str) -> None:
    classes = {
        one["name"]: one for one in client.get(f"/projects/{project}/schema").json()["classes"]
    }

    assert classes["face"]["keypoints"] == SPEC


def test_a_class_without_a_spec_answers_null(client: TestClient, project: str) -> None:
    classes = {
        one["name"]: one for one in client.get(f"/projects/{project}/schema").json()["classes"]
    }

    assert classes["sign"]["keypoints"] is None
    assert classes["pose"]["keypoints"] is None


def test_names_are_stored_stripped(client: TestClient) -> None:
    created = client.post("/projects", json={"name": "faces"}).json()["id"]
    spec = {"names": ["  left_eye ", "nose"], "skeleton": [[0, 1]]}

    response = client.post(
        f"/projects/{created}/schema/versions",
        json={"classes": [{"name": "face", "geometries": ["keypoints"], "keypoints": spec}]},
    )

    assert response.status_code == 201, response.text
    assert response.json()["published"]["classes"][0]["keypoints"]["names"] == ["left_eye", "nose"]


@pytest.mark.parametrize(
    ("label_class", "wording"),
    [
        (
            {**FACE, "keypoints": {"names": ["a", "b"], "skeleton": [[0, 2]]}},
            "names keypoint 2",
        ),
        ({**FACE, "keypoints": {"names": ["a", "b"], "skeleton": [[1, 1]]}}, "to itself"),
        (
            {**FACE, "keypoints": {"names": ["a", "b"], "skeleton": [[0, 1], [1, 0]]}},
            "appears twice",
        ),
        ({**FACE, "keypoints": {"names": ["a", " "]}}, "non-blank"),
        ({**FACE, "keypoints": {"names": ["Nose", "nose"]}}, "share a name"),
        ({**FACE, "keypoints": {"names": []}}, "at least 1 item"),
        ({**FACE, "geometries": ["bbox"]}, "does not accept the keypoints geometry"),
    ],
    ids=[
        "out-of-range",
        "self-loop",
        "duplicate-edge",
        "blank",
        "repeated",
        "empty",
        "no-geometry",
    ],
)
def test_an_invalid_spec_is_422_in_the_kernels_wording(
    client: TestClient, label_class: dict[str, Any], wording: str
) -> None:
    created = client.post("/projects", json={"name": "faces"}).json()["id"]

    response = client.post(f"/projects/{created}/schema/versions", json={"classes": [label_class]})

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert wording in response.text
    assert client.get(f"/projects/{created}/schema/versions").json()["total"] == 0


@pytest.mark.parametrize("index", [True, 1.0, "1", -1], ids=["bool", "float", "string", "negative"])
def test_a_skeleton_index_is_a_non_negative_json_integer(client: TestClient, index: Any) -> None:
    created = client.post("/projects", json={"name": "faces"}).json()["id"]
    spec = {"names": ["a", "b"], "skeleton": [[0, index]]}

    response = client.post(
        f"/projects/{created}/schema/versions",
        json={"classes": [{**FACE, "keypoints": spec}]},
    )

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_a_draft_holds_an_unfinished_spec_and_publish_refuses_it(
    client: TestClient, project: str
) -> None:
    unfinished = {"names": ["left_eye", ""], "skeleton": [[0, 5]]}
    face = {**FACE, "keypoints": unfinished}

    saved = client.put(f"/projects/{project}/schema/drafts/curated", json={"classes": [face]})

    assert saved.status_code == 200, saved.text
    read = client.get(f"/projects/{project}/schema/drafts/curated").json()
    assert read["classes"][0]["keypoints"] == unfinished
    refused = client.post(
        f"/projects/{project}/schema/drafts/curated/publish",
        json={"revision": read["revision"]},
        params={"allow_destructive": "true"},
    )
    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "INVALID_SCHEMA"


def test_a_draft_spec_round_trips_and_publishes(client: TestClient, project: str) -> None:
    widened = {"names": [*SPEC["names"]], "skeleton": [[0, 1]]}
    classes = [SIGN, {**FACE, "keypoints": widened}, POSE]
    saved = client.put(f"/projects/{project}/schema/drafts/curated", json={"classes": classes})
    assert saved.json()["classes"][1]["keypoints"] == widened

    published = client.post(
        f"/projects/{project}/schema/drafts/curated/publish",
        json={"revision": saved.json()["revision"]},
    )

    assert published.status_code == 201, published.text
    assert published.json()["published"]["classes"][1]["keypoints"] == widened


def test_a_draft_class_without_a_spec_answers_null(client: TestClient, project: str) -> None:
    saved = client.put(f"/projects/{project}/schema/drafts/curated", json={"classes": [SIGN]})

    assert saved.json()["classes"][0]["keypoints"] is None


# --- annotations ---------------------------------------------------------------


def test_keypoints_are_stored_and_read_back_unchanged(
    client: TestClient, working: tuple[str, str, str]
) -> None:
    _, job_id, asset = working

    written = client.post(
        f"/jobs/{job_id}/annotations",
        json=[_keypoints(asset, POINTS, visibility=VISIBILITY)],
    )

    assert written.status_code == 201, written.text
    expected = {"type": "keypoints", "points": POINTS, "visibility": VISIBILITY}
    assert written.json()["items"][0]["geometry"] == expected
    assert [one["geometry"] for one in _stored(client, job_id, asset)] == [expected]


def test_unknown_visibility_stays_absent(client: TestClient, working: tuple[str, str, str]) -> None:
    _, job_id, asset = working

    client.post(f"/jobs/{job_id}/annotations", json=[_keypoints(asset, POINTS)])

    (stored,) = _stored(client, job_id, asset)
    assert stored["geometry"] == {"type": "keypoints", "points": POINTS}


def test_an_update_replaces_the_points_and_their_visibility(
    client: TestClient, working: tuple[str, str, str]
) -> None:
    _, job_id, asset = working
    (created,) = client.post(
        f"/jobs/{job_id}/annotations",
        json=[_keypoints(asset, POINTS, visibility=VISIBILITY)],
    ).json()["items"]
    moved = [[3.0, 4.0], [5.0, 6.0], [3.0, 4.0]]

    updated = client.patch(
        f"/jobs/{job_id}/annotations",
        json=[
            {
                "id": created["id"],
                "label_class": "face",
                "geometry": {"type": "keypoints", "points": moved, "visibility": [0, 2, 1]},
                "provenance": "human",
            }
        ],
    )

    assert updated.status_code == 200, updated.text
    (stored,) = _stored(client, job_id, asset)
    assert stored["geometry"] == {"type": "keypoints", "points": moved, "visibility": [0, 2, 1]}


@pytest.mark.parametrize("count", [2, 4])
def test_a_count_other_than_the_specs_is_keypoint_count_mismatch(
    client: TestClient, working: tuple[str, str, str], count: int
) -> None:
    _, job_id, asset = working
    points = [[float(n), float(n)] for n in range(count)]

    refused = client.post(f"/jobs/{job_id}/annotations", json=[_keypoints(asset, points)])

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "KEYPOINT_COUNT_MISMATCH"
    assert _stored(client, job_id, asset) == []


def test_an_update_to_another_count_is_keypoint_count_mismatch(
    client: TestClient, working: tuple[str, str, str]
) -> None:
    _, job_id, asset = working
    (created,) = client.post(
        f"/jobs/{job_id}/annotations", json=[_keypoints(asset, POINTS)]
    ).json()["items"]

    refused = client.patch(
        f"/jobs/{job_id}/annotations",
        json=[
            {
                "id": created["id"],
                "label_class": "face",
                "geometry": {"type": "keypoints", "points": POINTS[:2]},
                "provenance": "human",
            }
        ],
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "KEYPOINT_COUNT_MISMATCH"
    assert [one["geometry"]["points"] for one in _stored(client, job_id, asset)] == [POINTS]


@pytest.mark.parametrize("count", [1, 5])
def test_a_class_without_a_spec_takes_any_count(
    client: TestClient, working: tuple[str, str, str], count: int
) -> None:
    _, job_id, asset = working
    points = [[float(n), float(n)] for n in range(count)]

    written = client.post(
        f"/jobs/{job_id}/annotations", json=[_keypoints(asset, points, label_class="pose")]
    )

    assert written.status_code == 201, written.text
    assert written.json()["items"][0]["geometry"]["points"] == points


@pytest.mark.parametrize("literal", ["1e999", "-1e999", "NaN", "Infinity"])
def test_a_nonfinite_coordinate_is_a_validation_error(
    client: TestClient, working: tuple[str, str, str], literal: str
) -> None:
    _, job_id, asset = working
    template = json.dumps([_keypoints(asset, [[1.0, 2.0], [3.0, 4.0], [5.0, 0.123456]])])

    refused = _post_raw(client, job_id, template.replace("0.123456", literal))

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "VALIDATION_ERROR"
    assert _stored(client, job_id, asset) == []


@pytest.mark.parametrize(
    "visibility",
    [[2, 1, True], [2, 1, 3], [2, 1, None], None, [2, 1], [2.0, 1, 0], ["2", 1, 0]],
    ids=["bool", "three", "null-state", "null", "short", "float", "string"],
)
def test_an_invalid_visibility_is_a_validation_error(
    client: TestClient, working: tuple[str, str, str], visibility: Any
) -> None:
    _, job_id, asset = working

    refused = client.post(
        f"/jobs/{job_id}/annotations",
        json=[_keypoints(asset, POINTS, visibility=visibility)],
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "VALIDATION_ERROR"
    assert _stored(client, job_id, asset) == []


def test_keypoints_on_a_scan_are_invalid_annotation(
    client: TestClient, runner: InlineDispatcher
) -> None:
    project = project_with_schema(client, name="scans", classes=[POSE])
    source = upload_scans(client, project, frame="lidar_flu").json()
    ingest = client.post(f"/sources/{source['id']}/ingest-jobs").json()
    runner.wait()
    batch_id = client.get(f"/ingest-jobs/{ingest['id']}").json()["batch_id"]
    client.post(f"/batches/{batch_id}/approve")
    client.post(f"/batches/{batch_id}/start")
    job_id = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job_id}/start")
    scan = client.get(f"/batches/{batch_id}/assets").json()["items"][0]["id"]

    refused = client.post(
        f"/jobs/{job_id}/annotations", json=[_keypoints(scan, [[1.0, 1.0]], label_class="pose")]
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "INVALID_ANNOTATION"
    assert _stored(client, job_id, scan) == []


def test_no_points_is_a_validation_error(client: TestClient, working: tuple[str, str, str]) -> None:
    _, job_id, asset = working

    refused = client.post(
        f"/jobs/{job_id}/annotations", json=[_keypoints(asset, [], label_class="pose")]
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "VALIDATION_ERROR"


# --- releases and export -------------------------------------------------------


def _released(client: TestClient, project: str, batch_id: str, job_id: str) -> str:
    client.post(f"/jobs/{job_id}/complete")
    client.post(f"/batches/{batch_id}/complete")
    client.post(f"/batches/{batch_id}/promote")
    response = client.post(f"/datasets/{dataset_of(client, project)}/releases", json={"tag": "v1"})
    assert response.status_code == 201, response.text
    release_id: str = response.json()["id"]
    return release_id


@pytest.fixture()
def released(client: TestClient, project: str, working: tuple[str, str, str]) -> tuple[str, str]:
    """``(release_id, asset_id)`` for a release holding one face with visibility."""
    batch_id, job_id, asset = working
    written = client.post(
        f"/jobs/{job_id}/annotations", json=[_keypoints(asset, POINTS, visibility=VISIBILITY)]
    )
    assert written.status_code == 201, written.text
    return _released(client, project, batch_id, job_id), asset


def test_a_release_holding_keypoints_is_manifest_version_11_with_both_verbatim(
    client: TestClient, released: tuple[str, str]
) -> None:
    release_id, _ = released

    document = client.get(f"/releases/{release_id}/manifest").json()

    assert document["manifest_version"] == KEYPOINTS_MANIFEST_VERSION == 11
    classes = {one["name"]: one for one in document["classes"]}
    assert classes["face"]["keypoints"] == SPEC
    assert "keypoints" not in classes["sign"]
    (geometry,) = [one["geometry"] for asset in document["assets"] for one in asset["annotations"]]
    assert geometry == {"type": "keypoints", "points": POINTS, "visibility": VISIBILITY}


def test_a_release_without_keypoints_keeps_its_earlier_version(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    project = project_with_schema(client, name="boxes")
    batch_id = batch_from_ingest(client, runner, tmp_path, project, images=1)
    client.post(f"/batches/{batch_id}/approve")
    client.post(f"/batches/{batch_id}/start")
    job_id = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job_id}/start")
    (asset,) = client.get(f"/batches/{batch_id}/assets").json()["items"]
    box = {"type": "bbox", "x": 1.0, "y": 2.0, "width": 10.0, "height": 8.0}
    client.post(
        f"/jobs/{job_id}/annotations",
        json=[
            {
                "asset_id": asset["id"],
                "label_class": "sign",
                "geometry": box,
                "attributes": {"occluded": False},
                "provenance": "human",
            }
        ],
    )

    release_id = _released(client, project, batch_id, job_id)

    document = client.get(f"/releases/{release_id}/manifest").json()
    assert document["manifest_version"] == 3
    assert all("keypoints" not in one for one in document["classes"])


def test_every_export_reports_the_keypoints_class_dropped(
    client: TestClient, released: tuple[str, str]
) -> None:
    release_id, _ = released

    report = client.get(
        f"/releases/{release_id}/export-compatibility", params={"format": "coco"}
    ).json()

    (face,) = [one for one in report["classes"] if one["label_class"] == "face"]
    assert face["status"] == "dropped"
    assert face["annotations"] == 1
    assert "keypoints" in face["reason"]
    assert report["compatible"] is False


def test_an_export_dropping_keypoints_is_refused_without_consent(
    client: TestClient, released: tuple[str, str], tmp_path: Path
) -> None:
    release_id, _ = released

    refused = client.post(f"/releases/{release_id}/export", params={"format": "coco"})

    assert refused.status_code == 409, refused.text
    assert refused.json()["code"] == "LOSSY_EXPORT_NOT_CONSENTED"
    (face,) = [
        one
        for one in refused.json()["detail"]["compatibility"]["classes"]
        if one["label_class"] == "face"
    ]
    assert face["status"] == "dropped"
    assert not (tmp_path / "ws" / "exports").exists()
