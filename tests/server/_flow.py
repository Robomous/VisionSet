"""Getting an API into a state where annotation can happen, over HTTP.

Three modules need the same first four steps — a project, a schema, some
uploaded stills, and a batch that an ingest filled — before they can test
anything about batches, jobs or annotations. Written once here rather than
copied three times, the `_api.py` / `_jobs.py` precedent: plain functions in a
private module, and still no `conftest.py` anywhere.

`test_external_client.py` deliberately does **not** use any of this. Its whole
point is that the walk is visible, so it spells every request out.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Final

from fastapi.testclient import TestClient
from tests.fixtures.media import write_image
from tests.server._jobs import InlineDispatcher

#: A bbox class with one required boolean, which is what makes an annotation
#: payload able to be wrong in an interesting way.
SIGN: Final[dict[str, Any]] = {
    "name": "sign",
    "geometry": "bbox",
    "attributes": [{"name": "occluded", "kind": "boolean", "required": True}],
}
LANE: Final[dict[str, Any]] = {"name": "lane", "geometry": "polygon"}
#: The lane geometry. NOT in the default schema: four tests elsewhere count the
#: classes `project_with_schema` declares, so a suite that needs a lane passes
#: `classes=[SIGN, LANE, CENTERLINE]` rather than widening what everyone gets.
CENTERLINE: Final[dict[str, Any]] = {"name": "centerline", "geometry": "polyline"}


def image_parts(tmp_path: Path, count: int) -> list[tuple[str, tuple[str, bytes, str]]]:
    """``count`` distinct generated PNGs, as multipart parts."""
    return [
        (
            "files",
            (
                f"{index}.png",
                write_image(tmp_path / f"{index}.png", seed=index).read_bytes(),
                "image/png",
            ),
        )
        for index in range(count)
    ]


def project_with_schema(
    client: TestClient, name: str = "road-signs", classes: list[dict[str, Any]] | None = None
) -> str:
    """A project carrying version 1 of a schema. Returns the project id."""
    project_id: str = client.post("/projects", json={"name": name}).json()["id"]
    client.post(
        f"/projects/{project_id}/schema/versions",
        json={"classes": [SIGN, LANE] if classes is None else classes},
    )
    return project_id


def batch_from_ingest(
    client: TestClient,
    runner: InlineDispatcher,
    tmp_path: Path,
    project_id: str,
    *,
    images: int = 3,
) -> str:
    """Upload stills, run an ingest to completion, and return the batch it filled."""
    source_id = client.post(
        f"/projects/{project_id}/sources/images", files=image_parts(tmp_path, images)
    ).json()["id"]
    job = client.post(f"/sources/{source_id}/ingest-jobs").json()
    runner.wait()
    batch_id: str = client.get(f"/ingest-jobs/{job['id']}").json()["batch_id"]
    return batch_id


def open_job(
    client: TestClient,
    runner: InlineDispatcher,
    tmp_path: Path,
    *,
    images: int = 3,
    classes: list[dict[str, Any]] | None = None,
) -> tuple[str, str]:
    """A batch approved into one started job, ready to be annotated.

    Returns ``(batch_id, job_id)``.
    """
    project_id = project_with_schema(client, classes=classes)
    batch_id = batch_from_ingest(client, runner, tmp_path, project_id, images=images)
    client.post(f"/batches/{batch_id}/approve")
    client.post(f"/batches/{batch_id}/start")
    job_id: str = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job_id}/start")
    return batch_id, job_id


def asset_ids(client: TestClient, batch_id: str) -> list[str]:
    """Every asset of the batch, in membership order."""
    items = client.get(f"/batches/{batch_id}/assets").json()["items"]
    return [asset["id"] for asset in items]


def a_box(asset_id: str, **overrides: Any) -> dict[str, Any]:
    """A valid ``sign``: a bbox carrying the one attribute the class requires."""
    body: dict[str, Any] = {
        "asset_id": asset_id,
        "label_class": "sign",
        "geometry": {"type": "bbox", "x": 1.0, "y": 2.0, "width": 30.0, "height": 40.0},
        "attributes": {"occluded": False},
        "provenance": "human",
    }
    return {**body, **overrides}


def annotated_batch(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, *, images: int = 3
) -> tuple[str, str]:
    """A completed batch whose assets all carry a label, ready to be promoted.

    Where `open_job` stops at "an annotator could start", this goes all the way
    to "there is finished work to curate" — which is where every dataset and
    release test begins.

    Returns ``(project_id, batch_id)``.
    """
    project_id = project_with_schema(client)
    batch_id = batch_from_ingest(client, runner, tmp_path, project_id, images=images)
    client.post(f"/batches/{batch_id}/approve")
    client.post(f"/batches/{batch_id}/start")
    job_id: str = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job_id}/start")
    client.post(
        f"/jobs/{job_id}/annotations",
        json=[a_box(asset_id) for asset_id in asset_ids(client, batch_id)],
    )
    client.post(f"/jobs/{job_id}/complete")
    client.post(f"/batches/{batch_id}/complete")
    return project_id, batch_id


def dataset_of(client: TestClient, project_id: str) -> str:
    """The project's one dataset id."""
    found: str = client.get(f"/projects/{project_id}/dataset").json()["id"]
    return found


def promoted_dataset(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, *, images: int = 3
) -> str:
    """A dataset with a completed batch's labeled assets already in it."""
    project_id, batch_id = annotated_batch(client, runner, tmp_path, images=images)
    client.post(f"/batches/{batch_id}/promote")
    return dataset_of(client, project_id)
