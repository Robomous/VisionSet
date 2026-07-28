"""#29's acceptance criterion: a third-party client drives a job start to finish.

Its own module, the way `test_openapi_contract.py` is #25's, and it deliberately
uses **none** of `tests/server/_flow.py`. The helpers exist so the other modules
can get to the interesting part; the point of this one is that the whole walk is
visible in a single function, with nothing shortened and nothing reached for
in-process.

The rule it enforces is the milestone's, not this task's: **the official UI gets
no private endpoints.** Every line below is something the medical-app scenario
does over HTTP with a bearer token, and if any step needed the SDK the contract
would be incomplete.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.media import write_image
from tests.server._api import api_client
from tests.server._runner import RecordingRunner


@pytest.fixture()
def runner() -> RecordingRunner:
    return RecordingRunner()


@pytest.fixture()
def client(tmp_path: Path, runner: RecordingRunner) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", runner=runner) as made:
        yield made


def ok(response: Any, *expected: int) -> Any:
    """The parsed body, after asserting the status is one the walk expects.

    Every request is checked. A walk that only asserts its final state passes
    just as happily when a step in the middle answered 404 and the next one
    happened not to need it.
    """
    assert response.status_code in expected, (
        f"{response.request.method} {response.request.url.path} -> "
        f"{response.status_code} {response.text}"
    )
    return response.json() if response.content else None


def test_an_external_client_drives_a_job_from_ingest_to_a_closed_batch(
    client: TestClient, tmp_path: Path, runner: RecordingRunner
) -> None:
    # 1. A project, and the labeling contract its work will be judged against.
    project = ok(client.post("/projects", json={"name": "chest-xray"}), 201)["id"]
    ok(
        client.post(
            f"/projects/{project}/schema/versions",
            json={
                "classes": [
                    {
                        "name": "nodule",
                        "geometry": "bbox",
                        "attributes": [{"name": "malignant", "kind": "boolean", "required": True}],
                    }
                ]
            },
        ),
        201,
    )

    # 2. Offer it some data. Registration is upload-only: the client has bytes,
    #    not a path on the server's filesystem.
    parts = [
        (
            "files",
            (f"{i}.png", write_image(tmp_path / f"{i}.png", seed=i).read_bytes(), "image/png"),
        )
        for i in range(4)
    ]
    source = ok(client.post(f"/projects/{project}/sources/images", files=parts), 201)["id"]

    # 3. Launch the run and poll it. 202 means the row exists and the work does
    #    not, so the first poll always finds something.
    launched = client.post(f"/sources/{source}/ingest-jobs", json={"batch_name": "study-a"})
    ingest_job = ok(launched, 202)
    assert launched.headers["Location"] == f"/ingest-jobs/{ingest_job['id']}"
    assert ingest_job["state"] == "pending"

    runner.wait()
    finished = ok(client.get(f"/ingest-jobs/{ingest_job['id']}"), 200)
    assert finished["state"] == "completed"
    assert finished["processed"] == 4
    assert finished["failures"] == []
    batch = finished["batch_id"]

    # 4. Freeze it. Two jobs, so the walk proves a batch completes only when all
    #    of its jobs do rather than when the first one does.
    approved = ok(
        client.post(
            f"/batches/{batch}/approve", json={"partition": {"kind": "by_size", "size": 2}}
        ),
        200,
    )
    assert approved["state"] == "approved"
    assert approved["schema_version"] == 1
    assert ok(client.post(f"/batches/{batch}/start"), 200)["state"] == "in_annotation"

    jobs = ok(client.get(f"/batches/{batch}/jobs"), 200)
    assert jobs["total"] == 2

    # 5. Work each job the way an annotator client would: take the next assets,
    #    submit labels, close it.
    for job in jobs["items"]:
        job_id = job["id"]
        assert ok(client.post(f"/jobs/{job_id}/start"), 200)["state"] == "in_progress"

        waiting = ok(client.get(f"/jobs/{job_id}/next", params={"n": 10}), 200)["items"]
        assert len(waiting) == 2

        first, second = waiting
        written = ok(
            client.post(
                f"/jobs/{job_id}/annotations",
                json=[
                    {
                        "asset_id": first["id"],
                        "label_class": "nodule",
                        "geometry": {
                            "type": "bbox",
                            "x": 4.0,
                            "y": 5.0,
                            "width": 12.0,
                            "height": 8.0,
                        },
                        "attributes": {"malignant": False},
                        "provenance": "human",
                    }
                ],
            ),
            201,
        )
        assert written["items"][0]["schema_version"] == 1

        # Reading them back is how a client that reconnects restores its canvas.
        reread = ok(client.get(f"/jobs/{job_id}/assets/{first['id']}/annotations"), 200)
        assert reread["items"] == written["items"]

        # The label moved the first asset on its own; the second is a decision.
        ok(
            client.put(
                f"/jobs/{job_id}/assets/{second['id']}/progress", json={"progress": "skipped"}
            ),
            200,
        )
        assert ok(client.get(f"/jobs/{job_id}/progress"), 200) == {
            "unannotated": 0,
            "annotated": 1,
            "skipped": 1,
            "review_pending": 0,
            "accepted": 0,
            "total": 2,
        }

        assert ok(client.post(f"/jobs/{job_id}/complete"), 200)["state"] == "completed"

    # 6. The batch closes once every job has, and the gallery listing reports
    #    where each asset ended up.
    completed = ok(client.post(f"/batches/{batch}/complete"), 200)
    assert completed["state"] == "completed"
    assert completed["progress"] == {
        "unannotated": 0,
        "annotated": 2,
        "skipped": 2,
        "review_pending": 0,
        "accepted": 0,
        "total": 4,
    }

    listing = ok(client.get(f"/batches/{batch}/assets", params={"limit": 2}), 200)
    assert listing["total"] == 4
    assert len(listing["items"]) == 2
    assert all(asset["job_id"] for asset in listing["items"])
    assert all(asset["progress"] in {"annotated", "skipped"} for asset in listing["items"])


def test_the_whole_walk_is_refused_without_a_token(client: TestClient) -> None:
    """The contract is bearer-authenticated end to end, not only at the edges."""
    for method, path in (
        ("get", "/projects/00000000-0000-0000-0000-000000000000/batches"),
        ("get", "/batches/00000000-0000-0000-0000-000000000000"),
        ("post", "/batches/00000000-0000-0000-0000-000000000000/approve"),
        ("get", "/jobs/00000000-0000-0000-0000-000000000000"),
        ("get", "/jobs/00000000-0000-0000-0000-000000000000/next"),
        ("post", "/jobs/00000000-0000-0000-0000-000000000000/annotations"),
    ):
        response = client.request(method, path, headers={"Authorization": ""})
        assert response.status_code == 401, path
        assert response.json()["code"] == "UNAUTHORIZED"
