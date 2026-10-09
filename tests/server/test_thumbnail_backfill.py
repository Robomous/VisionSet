"""The thumbnail-backfill launch: 202 and a row, a refusal before one, and the joined run."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from tests.fixtures.media import write_image
from tests.server._api import api_client
from tests.server._flow import project_with_schema
from tests.server._jobs import ManualDispatcher

from visionset.kernel.services import IngestService, WorkspaceService
from visionset.wire import thumbnail_backfill


@pytest.fixture()
def runner() -> ManualDispatcher:
    return ManualDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: ManualDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


def _project_without_previews(
    client: TestClient, tmp_path: Path, runner: ManualDispatcher
) -> tuple[str, str]:
    project_id = project_with_schema(client)
    written = write_image(tmp_path / "one.png", seed=7).read_bytes()
    source_id = client.post(
        f"/projects/{project_id}/sources/images",
        files=[("files", ("one.png", written, "image/png"))],
    ).json()["id"]
    client.post(f"/sources/{source_id}/ingest-jobs")
    runner.run()
    asset_id = client.get(f"/projects/{project_id}/assets").json()["items"][0]["id"]
    engine = create_engine(f"sqlite:///{tmp_path / 'ws' / 'visionset.db'}")
    with engine.begin() as connection:
        connection.execute(text("UPDATE asset SET thumbnail_hash = NULL"))
    engine.dispose()
    return project_id, asset_id


def _thumbnail(client: TestClient, project_id: str, asset_id: str) -> int:
    return client.get(f"/projects/{project_id}/assets/{asset_id}/thumbnail").status_code


def test_a_launch_is_202_with_the_job_to_poll(
    client: TestClient, tmp_path: Path, runner: ManualDispatcher
) -> None:
    project_id, _ = _project_without_previews(client, tmp_path, runner)
    wakes = runner.wakes

    response = client.post(f"/projects/{project_id}/thumbnail-backfill-jobs")

    assert response.status_code == 202, response.text
    body = response.json()
    assert response.headers["Location"] == f"/background-jobs/{body['id']}"
    assert body["type"] == "assets.backfill_thumbnails"
    assert body["state"] == "queued"
    assert runner.wakes == wakes + 1


def test_the_job_fills_the_preview_and_its_result_is_the_shared_projection(
    client: TestClient, tmp_path: Path, runner: ManualDispatcher
) -> None:
    project_id, asset_id = _project_without_previews(client, tmp_path, runner)
    assert _thumbnail(client, project_id, asset_id) == 404
    job_id = client.post(f"/projects/{project_id}/thumbnail-backfill-jobs").json()["id"]

    runner.run()

    job = client.get(f"/background-jobs/{job_id}").json()
    assert job["state"] == "succeeded", job
    assert job["result"] == {
        "project_id": project_id,
        "examined": 1,
        "filled": [asset_id],
        "missing": [],
        "unreadable": [],
    }
    assert _thumbnail(client, project_id, asset_id) == 200
    with WorkspaceService.open(tmp_path / "ws") as workspace:
        again = IngestService(workspace).backfill_thumbnails(UUID(project_id))
    assert thumbnail_backfill(again)["examined"] == 0


def test_an_unknown_project_is_404_and_queues_nothing(
    client: TestClient, runner: ManualDispatcher
) -> None:
    response = client.post(f"/projects/{uuid4()}/thumbnail-backfill-jobs")

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"
    assert client.get("/background-jobs").json()["total"] == 0
    assert runner.wakes == 0


def test_a_launch_while_a_pass_is_live_joins_it(
    client: TestClient, tmp_path: Path, runner: ManualDispatcher
) -> None:
    project_id, _ = _project_without_previews(client, tmp_path, runner)
    other = project_with_schema(client, name="other")

    first = client.post(f"/projects/{project_id}/thumbnail-backfill-jobs").json()
    second = client.post(f"/projects/{project_id}/thumbnail-backfill-jobs").json()
    elsewhere = client.post(f"/projects/{other}/thumbnail-backfill-jobs").json()

    assert second["id"] == first["id"]
    assert elsewhere["id"] != first["id"]
    runner.run()
    third = client.post(f"/projects/{project_id}/thumbnail-backfill-jobs").json()
    assert third["id"] != first["id"]
