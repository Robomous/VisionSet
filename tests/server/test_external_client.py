"""The acceptance walk: a third-party client drives the whole cycle over HTTP.

Its own module, the way `test_openapi_contract.py` is #25's, and it deliberately
uses **none** of `tests/server/_flow.py`. The helpers exist so the other modules
can get to the interesting part; the point of this one is that the whole walk is
visible in a single function, with nothing shortened and nothing reached for
in-process.

The rule it enforces is the milestone's, not this task's: **the official UI gets
no private endpoints.** Every line below is something the medical-app scenario
does over HTTP with a bearer token, and if any step needed the SDK the contract
would be incomplete.

#29 took the walk as far as a closed batch. #30 carries it to the end of the
cycle — curate, freeze, verify, export, and reach the pixels — because those were
the steps that made "the client can do everything" false.
"""

from __future__ import annotations

import io
import zipfile
from collections.abc import Iterator
from hashlib import sha256
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.media import write_image
from tests.server._api import api_client
from tests.server._runner import RecordingRunner

from visionset.kernel.services.release_service import EXPORT_REPORT_FILENAME


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

    Parsing is conditional on the content type rather than on there being a body,
    because since #30 the walk also fetches an archive and two images — and those
    still deserve the status assertion even though there is no JSON to hand back.
    """
    assert response.status_code in expected, (
        f"{response.request.method} {response.request.url.path} -> "
        f"{response.status_code} {response.text}"
    )
    if not response.content:
        return None
    if not response.headers.get("content-type", "").startswith("application/json"):
        return response.content
    return response.json()


def test_an_external_client_drives_the_cycle_from_ingest_to_an_exported_release(
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

    # 7. Curate. Promotion is the one gate into the trunk, and it takes what was
    #    annotated or accepted — the two skipped assets stay out by design.
    promoted = ok(client.post(f"/batches/{batch}/promote"), 200)
    assert promoted["total"] == 2

    dataset = ok(client.get(f"/projects/{project}/dataset"), 200)["id"]
    assert ok(client.get(f"/datasets/{dataset}/stats"), 200) == {
        "dataset_id": dataset,
        "asset_count": 2,
        "annotated_asset_count": 2,
        "annotation_count": 2,
        "classes": [{"label_class": "nodule", "annotations": 2, "assets": 2}],
    }

    (entry,) = ok(client.get(f"/datasets/{dataset}/changes"), 200)["items"]
    assert entry["operation"] == "promote"
    assert entry["subject_ids"][0] == batch

    # 8. Freeze it. The manifest is hash-pinned evidence, so what comes back down
    #    the wire must be exactly the bytes the release names — the acceptance
    #    criterion, and the thing a re-serializing route would quietly break.
    release = ok(
        client.post(
            f"/datasets/{dataset}/releases",
            json={"tag": "v1", "split": {"train": 0.5, "val": 0.25, "test": 0.25, "seed": 7}},
        ),
        201,
    )
    assert release["asset_count"] == 2
    assert release["annotation_count"] == 2

    document = client.get(f"/releases/{release['id']}/manifest")
    ok(document, 200)
    assert sha256(document.content).hexdigest() == release["manifest_hash"]
    assert document.headers["ETag"] == f'"{release["manifest_hash"]}"'
    assert len(document.json()["assets"]) == 2

    # Publishing again from an unchanged trunk gives the same bytes, which is
    # what makes a release reproducible rather than merely recorded.
    again = ok(client.post(f"/datasets/{dataset}/releases", json={"tag": "v1-again"}), 201)
    assert again["manifest_hash"] == release["manifest_hash"]

    assert ok(client.get(f"/releases/{release['id']}/verify"), 200)["ok"] is True

    folds = ok(client.get(f"/releases/{release['id']}/assignment"), 200)
    assert len(folds["train"]) + len(folds["val"]) + len(folds["test"]) == 2

    # 9. Export it. Which formats exist is a property of the deployment, so the
    #    client asks rather than assuming — and the archive comes back inline.
    installed = ok(client.get("/formats"), 200)
    assert "dummy" in {row["name"] for row in installed["items"]}

    archive = client.post(f"/releases/{release['id']}/export", params={"format": "dummy"})
    ok(archive, 200)
    assert archive.headers["content-type"] == "application/zip"
    # `dummy` writes no annotations at all, so the only thing in the archive
    # is the compatibility report every export carries.
    assert zipfile.ZipFile(io.BytesIO(archive.content)).namelist() == [EXPORT_REPORT_FILENAME]

    # 10. And reach the pixels. An annotator or a gallery renders these directly,
    #     so the media type has to be right and the bytes have to be the originals.
    asset = listing["items"][0]
    picture = client.get(f"/projects/{project}/assets/{asset['id']}/content")
    ok(picture, 200)
    assert picture.headers["content-type"] == "image/png"
    assert sha256(picture.content).hexdigest() == asset["content_hash"]
    assert "immutable" in picture.headers["Cache-Control"]

    preview = client.get(f"/projects/{project}/assets/{asset['id']}/thumbnail")
    ok(preview, 200)
    assert preview.headers["content-type"] == "image/jpeg"
    assert preview.headers["ETag"] == f'"{asset["thumbnail_hash"]}"'


def test_the_whole_walk_is_refused_without_a_token(client: TestClient) -> None:
    """The contract is bearer-authenticated end to end, not only at the edges."""
    for method, path in (
        ("get", "/projects/00000000-0000-0000-0000-000000000000/batches"),
        ("get", "/batches/00000000-0000-0000-0000-000000000000"),
        ("post", "/batches/00000000-0000-0000-0000-000000000000/approve"),
        ("get", "/jobs/00000000-0000-0000-0000-000000000000"),
        ("get", "/jobs/00000000-0000-0000-0000-000000000000/next"),
        ("post", "/jobs/00000000-0000-0000-0000-000000000000/annotations"),
        ("get", "/datasets/00000000-0000-0000-0000-000000000000/stats"),
        ("post", "/datasets/00000000-0000-0000-0000-000000000000/releases"),
        ("get", "/releases/00000000-0000-0000-0000-000000000000/manifest"),
        ("post", "/releases/00000000-0000-0000-0000-000000000000/export"),
        ("get", "/formats"),
        (
            "get",
            "/projects/00000000-0000-0000-0000-000000000000/assets/"
            "00000000-0000-0000-0000-000000000000/content",
        ),
    ):
        response = client.request(method, path, headers={"Authorization": ""})
        assert response.status_code == 401, path
        assert response.json()["code"] == "UNAUTHORIZED"
