"""Registering a source over HTTP: upload, list, read, refuse.

`test_projects.py`'s shape — a two-line fixture over `_api.py`, assertions at
the wire (status and `code`), and a closing guard sweep. What the kernel does
with a source is `tests/kernel/test_source_service.py`; nothing here restates it.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.media import write_image, write_video
from tests.server._api import api_client

# Above `testsrc`'s resolution floor: below roughly 96x72 its per-frame movement
# falls under the scaler and consecutive frames come out byte-identical, which
# ingest then deduplicates. See `docs/examples.md`.
CLIP_SIZE = (160, 120)


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    response = client.post("/projects", json={"name": "road-signs"})
    assert response.status_code == 201, response.text
    project_id: str = response.json()["id"]
    return project_id


def image_part(tmp_path: Path, name: str, seed: int = 0) -> tuple[str, tuple[str, bytes, str]]:
    path = write_image(tmp_path / "made" / name, seed=seed)
    return ("files", (name, path.read_bytes(), "image/png"))


def post_images(client: TestClient, project: str, *parts: Any) -> Any:
    return client.post(f"/projects/{project}/sources/images", files=list(parts))


def post_video(client: TestClient, project: str, clip: Path, **form: Any) -> Any:
    return client.post(
        f"/projects/{project}/sources/video",
        files={"file": (clip.name, clip.read_bytes(), "video/mp4")},
        data=form,
    )


@pytest.fixture()
def clip(tmp_path: Path) -> Path:
    """A real clip. `write_video` is what requires ffmpeg, so image tests stay free of it."""
    return write_video(tmp_path / "made" / "drive.mp4", size=CLIP_SIZE).path


# --- registering stills ------------------------------------------------------


def test_uploading_images_registers_a_directory_source(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    response = post_images(client, project, image_part(tmp_path, "a.png", 1))

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["kind"] == "image_directory"
    assert body["project_id"] == project
    assert body["video"] is None


def test_nothing_is_decoded_at_registration(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    """A file that is not an image registers fine and is reported at ingest instead."""
    (tmp_path / "made").mkdir(parents=True, exist_ok=True)
    (tmp_path / "made" / "notes.txt").write_bytes(b"not an image")

    response = post_images(client, project, ("files", ("notes.txt", b"not an image", "text/plain")))

    assert response.status_code == 201, response.text


def test_uploading_the_same_images_again_returns_the_same_source(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    """Staging is content-addressed and registration is idempotent on the path."""
    first = post_images(client, project, image_part(tmp_path, "a.png", 1))
    second = post_images(client, project, image_part(tmp_path, "a.png", 1))

    assert first.json()["id"] == second.json()["id"]


def test_a_traversing_filename_is_reduced_to_its_last_component(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    path = write_image(tmp_path / "made" / "a.png", seed=1)
    response = post_images(
        client, project, ("files", ("../../escaped.png", path.read_bytes(), "image/png"))
    )

    assert response.status_code == 201, response.text
    assert not (tmp_path / "escaped.png").exists()


def test_uploading_images_to_an_unknown_project_is_404(client: TestClient, tmp_path: Path) -> None:
    response = post_images(client, str(uuid4()), image_part(tmp_path, "a.png"))

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


# --- the display name (#245) -------------------------------------------------


def test_a_stated_name_becomes_the_source_name(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    response = client.post(
        f"/projects/{project}/sources/images",
        files=[image_part(tmp_path, "a.png", 1)],
        data={"name": "dashcam morning run"},
    )

    assert response.status_code == 201, response.text
    assert response.json()["name"] == "dashcam morning run"


def test_an_unnamed_upload_is_still_called_by_its_staged_digest(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    """The pre-#245 default, pinned as the default rather than fixed by stealth.

    Staging is content-addressed, so the directory an upload registers is named
    by a sha-256 digest — which is what an upload that states no name is called.
    Whether the UI *offers* a name is its business; the wire must not invent one.
    """
    response = post_images(client, project, image_part(tmp_path, "a.png", 1))

    assert response.status_code == 201, response.text
    name = response.json()["name"]
    assert len(name) == 64 and set(name) <= set("0123456789abcdef")


def test_reuploading_with_a_new_name_renames_the_same_source(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    """Identity is the content-addressed path; the name is a label on it."""
    first = client.post(
        f"/projects/{project}/sources/images",
        files=[image_part(tmp_path, "a.png", 1)],
        data={"name": "one"},
    )
    second = client.post(
        f"/projects/{project}/sources/images",
        files=[image_part(tmp_path, "a.png", 1)],
        data={"name": "two"},
    )

    assert second.json()["id"] == first.json()["id"]
    assert second.json()["name"] == "two"


def test_a_nameless_reupload_keeps_the_stated_name(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    named = client.post(
        f"/projects/{project}/sources/images",
        files=[image_part(tmp_path, "a.png", 1)],
        data={"name": "kept"},
    )
    again = post_images(client, project, image_part(tmp_path, "a.png", 1))

    assert again.json()["id"] == named.json()["id"]
    assert again.json()["name"] == "kept"


def test_a_blank_name_is_422_with_the_kernel_wording(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    """#28's rule: the domain refuses with a mapped error, so no wire validator
    restates it — the refusal below is ``InvalidName``'s own."""
    response = client.post(
        f"/projects/{project}/sources/images",
        files=[image_part(tmp_path, "a.png", 1)],
        data={"name": "   "},
    )

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "INVALID_NAME"


# --- registering a clip ------------------------------------------------------


def test_uploading_a_clip_registers_a_video_source(
    client: TestClient, project: str, clip: Path
) -> None:
    response = post_video(client, project, clip, extraction_fps=5)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["kind"] == "video"
    assert body["name"] == "drive.mp4"
    assert body["video"]["extraction_fps"] == 5
    # The rate the file was shot at, which is not the rate we cut it at.
    assert body["video"]["fps"] == 10
    assert (body["video"]["width"], body["video"]["height"]) == CLIP_SIZE


def test_a_clip_registered_at_two_rates_is_two_sources(
    client: TestClient, project: str, clip: Path
) -> None:
    """The rate is part of what the source is — `docs/sources.md`."""
    slow = post_video(client, project, clip, extraction_fps=1)
    fast = post_video(client, project, clip, extraction_fps=5)

    assert slow.json()["id"] != fast.json()["id"]


def test_the_default_rate_is_one_frame_per_second(
    client: TestClient, project: str, clip: Path
) -> None:
    response = post_video(client, project, clip)

    assert response.json()["video"]["extraction_fps"] == 1.0


def test_a_non_positive_rate_is_422_before_anything_is_written(
    client: TestClient, project: str, clip: Path
) -> None:
    """`gt=0` on the form field, so the kernel's bare `ValueError` is unreachable."""
    response = post_video(client, project, clip, extraction_fps=0)

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_uploading_something_that_is_not_a_video_is_422(client: TestClient, project: str) -> None:
    response = client.post(
        f"/projects/{project}/sources/video",
        files={"file": ("notes.txt", b"not a video", "text/plain")},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "UNSUPPORTED_MEDIA"


# --- reading -----------------------------------------------------------------


def test_listing_a_project_with_no_sources_is_an_empty_page(
    client: TestClient, project: str
) -> None:
    response = client.get(f"/projects/{project}/sources")

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0}


def test_listing_returns_every_source_of_that_project(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    post_images(client, project, image_part(tmp_path, "a.png", 1))
    post_images(client, project, image_part(tmp_path, "b.png", 2))

    body = client.get(f"/projects/{project}/sources").json()

    assert body["total"] == 2
    assert len(body["items"]) == 2


def test_reading_a_source_by_id(client: TestClient, project: str, tmp_path: Path) -> None:
    created = post_images(client, project, image_part(tmp_path, "a.png", 1)).json()

    response = client.get(f"/sources/{created['id']}")

    assert response.status_code == 200
    assert response.json() == created


def test_a_source_never_publishes_its_path(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    """It is a server-side path inside the workspace, and no client can use one."""
    body = post_images(client, project, image_part(tmp_path, "a.png", 1)).json()

    assert "path" not in body
    assert set(body) == {"id", "project_id", "kind", "name", "registered_at", "video"}


def test_reading_an_unknown_source_is_404(client: TestClient) -> None:
    response = client.get(f"/sources/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["code"] == "SOURCE_NOT_FOUND"


def test_a_malformed_source_id_is_422_not_404(client: TestClient) -> None:
    response = client.get("/sources/not-a-uuid")

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_listing_sources_of_an_unknown_project_is_404(client: TestClient) -> None:
    response = client.get(f"/projects/{uuid4()}/sources")

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


# --- the guard ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/projects/{project}/sources/images"),
        ("POST", "/projects/{project}/sources/video"),
        ("GET", "/projects/{project}/sources"),
        ("GET", "/sources/00000000-0000-0000-0000-000000000000"),
        ("POST", "/sources/00000000-0000-0000-0000-000000000000/ingest-jobs"),
        ("GET", "/sources/00000000-0000-0000-0000-000000000000/ingest-jobs"),
    ],
)
def test_every_source_route_refuses_a_request_with_no_token(
    client: TestClient, project: str, method: str, path: str
) -> None:
    response = client.request(method, path.format(project=project), headers={"Authorization": ""})

    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHORIZED"
