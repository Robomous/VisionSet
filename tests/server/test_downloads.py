"""Reaching an asset's bytes: content, preview, media types and caching.

The API's first non-JSON responses. Two things are worth asserting past "it came
back": the `Content-Type` is what the ingest actually probed rather than a guess,
and the bytes are the ones that went in — a route that re-encoded on the way out
would pass a length check and fail this.

The caching pair is asserted together because it is one claim: identity is
content, so the URL's bytes cannot change, so `immutable` is honest and the hash
is the right `ETag`.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.media import write_image
from tests.server._api import api_client
from tests.server._flow import batch_from_ingest, project_with_schema
from tests.server._jobs import InlineDispatcher

from visionset.kernel.domain import ImageFormat
from visionset.kernel.ports import THUMBNAIL_FORMAT
from visionset.server.routes.assets import _MEDIA_TYPES


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def ingested(client: TestClient, tmp_path: Path, runner: InlineDispatcher) -> tuple[str, str, bytes]:
    """``(project_id, asset_id, the bytes that were uploaded)`` for one still."""
    project_id = project_with_schema(client)
    written = write_image(tmp_path / "one.png", seed=7).read_bytes()
    source_id = client.post(
        f"/projects/{project_id}/sources/images",
        files=[("files", ("one.png", written, "image/png"))],
    ).json()["id"]
    job = client.post(f"/sources/{source_id}/ingest-jobs").json()
    runner.wait()
    batch_id = client.get(f"/ingest-jobs/{job['id']}").json()["batch_id"]
    asset_id = client.get(f"/batches/{batch_id}/assets").json()["items"][0]["id"]
    return project_id, asset_id, written


# --- the media-type table -----------------------------------------------------


def test_every_image_format_has_a_media_type() -> None:
    """Indexed directly by the route, so a new member must arrive with its type.

    Read off the enum rather than restated, the `ProgressCounts` bargain: adding
    a format without a media type fails here instead of quietly degrading every
    download of it.
    """
    assert set(_MEDIA_TYPES) == set(ImageFormat)


def test_the_thumbnail_format_is_one_of_them() -> None:
    """The route indexes the table with it, so it cannot be a format nobody mapped."""
    assert THUMBNAIL_FORMAT in _MEDIA_TYPES


# --- the asset itself ---------------------------------------------------------


def test_an_asset_is_readable_by_id_under_its_project(
    client: TestClient, ingested: tuple[str, str, bytes]
) -> None:
    project_id, asset_id, _ = ingested

    body = client.get(f"/projects/{project_id}/assets/{asset_id}").json()

    assert body["id"] == asset_id
    assert body["project_id"] == project_id
    assert body["format"] == "png"
    assert len(body["content_hash"]) == 64


def test_an_unknown_asset_is_404_with_its_own_code(client: TestClient) -> None:
    project_id = project_with_schema(client)

    response = client.get(f"/projects/{project_id}/assets/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["code"] == "ASSET_NOT_FOUND"


def test_an_asset_of_another_project_reads_as_missing(
    client: TestClient, ingested: tuple[str, str, bytes]
) -> None:
    _, asset_id, _ = ingested
    elsewhere = client.post("/projects", json={"name": "elsewhere"}).json()["id"]

    response = client.get(f"/projects/{elsewhere}/assets/{asset_id}")

    assert response.status_code == 404
    assert response.json()["code"] == "ASSET_NOT_FOUND"


def test_an_unknown_project_is_refused_as_the_project(client: TestClient) -> None:
    response = client.get(f"/projects/{uuid4()}/assets/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


# --- the content --------------------------------------------------------------


def test_the_content_download_is_the_bytes_that_were_uploaded(
    client: TestClient, ingested: tuple[str, str, bytes]
) -> None:
    project_id, asset_id, written = ingested

    response = client.get(f"/projects/{project_id}/assets/{asset_id}/content")

    assert response.status_code == 200
    assert response.content == written


def test_the_content_type_is_what_the_ingest_probed(
    client: TestClient, ingested: tuple[str, str, bytes]
) -> None:
    project_id, asset_id, _ = ingested

    response = client.get(f"/projects/{project_id}/assets/{asset_id}/content")

    assert response.headers["content-type"] == "image/png"


def test_the_content_url_is_immutable_and_tagged_with_the_content_hash(
    client: TestClient, ingested: tuple[str, str, bytes]
) -> None:
    project_id, asset_id, _ = ingested
    content_hash = client.get(f"/projects/{project_id}/assets/{asset_id}").json()["content_hash"]

    headers = client.get(f"/projects/{project_id}/assets/{asset_id}/content").headers

    assert headers["etag"] == f'"{content_hash}"'
    assert headers["cache-control"] == "public, max-age=31536000, immutable"


def test_the_content_of_an_unknown_asset_is_404(client: TestClient) -> None:
    project_id = project_with_schema(client)

    response = client.get(f"/projects/{project_id}/assets/{uuid4()}/content")

    assert response.status_code == 404
    assert response.json()["code"] == "ASSET_NOT_FOUND"


def test_a_content_blob_that_is_gone_is_damage_rather_than_a_404(
    client: TestClient, tmp_path: Path, ingested: tuple[str, str, bytes]
) -> None:
    """A recorded hash with no blob is a guarantee failing, and 5xx stays opaque."""
    project_id, asset_id, _ = ingested
    digest = client.get(f"/projects/{project_id}/assets/{asset_id}").json()["content_hash"]
    (tmp_path / "ws" / "blobs" / digest[:2] / digest[2:4] / digest).unlink()

    with TestClient(client.app, headers=client.headers, raise_server_exceptions=False) as opaque:
        response = opaque.get(f"/projects/{project_id}/assets/{asset_id}/content")

    assert response.status_code == 500
    assert response.json()["code"] == "WORKSPACE_CORRUPT"
    assert digest not in response.text


# --- the preview --------------------------------------------------------------


def test_the_thumbnail_download_is_a_jpeg(
    client: TestClient, ingested: tuple[str, str, bytes]
) -> None:
    project_id, asset_id, _ = ingested

    response = client.get(f"/projects/{project_id}/assets/{asset_id}/thumbnail")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.content.startswith(b"\xff\xd8\xff")


def test_the_thumbnail_is_not_the_original(
    client: TestClient, ingested: tuple[str, str, bytes]
) -> None:
    """A preview is a re-encode at a pinned size, so it must not be the source bytes."""
    project_id, asset_id, written = ingested

    preview = client.get(f"/projects/{project_id}/assets/{asset_id}/thumbnail").content

    assert preview != written


def test_the_thumbnail_url_is_immutable_and_tagged_with_the_thumbnail_hash(
    client: TestClient, ingested: tuple[str, str, bytes]
) -> None:
    project_id, asset_id, _ = ingested
    body = client.get(f"/projects/{project_id}/assets/{asset_id}").json()

    headers = client.get(f"/projects/{project_id}/assets/{asset_id}/thumbnail").headers

    assert headers["etag"] == f'"{body["thumbnail_hash"]}"'
    assert "immutable" in headers["cache-control"]


def test_an_asset_with_no_cached_preview_is_refused_by_its_own_code(
    client: TestClient, tmp_path: Path, ingested: tuple[str, str, bytes]
) -> None:
    """NULL is an ordinary state with a real remedy, so it gets a code of its own."""
    project_id, asset_id, _ = ingested
    from sqlalchemy import create_engine, text

    engine = create_engine(f"sqlite:///{tmp_path / 'ws' / 'visionset.db'}")
    with engine.begin() as connection:
        connection.execute(text("UPDATE asset SET thumbnail_hash = NULL"))
    engine.dispose()

    response = client.get(f"/projects/{project_id}/assets/{asset_id}/thumbnail")

    assert response.status_code == 404
    assert response.json()["code"] == "THUMBNAIL_NOT_CACHED"
    assert "backfill" in response.json()["message"]


def test_the_thumbnail_of_an_unknown_asset_is_404(client: TestClient) -> None:
    project_id = project_with_schema(client)

    response = client.get(f"/projects/{project_id}/assets/{uuid4()}/thumbnail")

    assert response.status_code == 404
    assert response.json()["code"] == "ASSET_NOT_FOUND"


# --- the contract these routes declare ----------------------------------------


def test_the_binary_routes_declare_their_content_type_in_the_spec(client: TestClient) -> None:
    """Left alone, FastAPI documents a 200 as `application/json` for all of them."""
    spec = client.app.openapi()

    content = spec["paths"]["/projects/{project_id}/assets/{asset_id}/content"]["get"]
    assert set(content["responses"]["200"]["content"]) == {
        "image/jpeg",
        "image/png",
        # An asset ingested before the pipeline probed formats really is served this way, and a
        # generated client believes exactly what the contract declares.
        "application/octet-stream",
    }

    thumbnail = spec["paths"]["/projects/{project_id}/assets/{asset_id}/thumbnail"]["get"]
    assert set(thumbnail["responses"]["200"]["content"]) == {"image/jpeg"}


def test_the_binary_routes_are_protected_like_every_other(client: TestClient) -> None:
    with TestClient(client.app) as anonymous:
        response = anonymous.get(f"/projects/{uuid4()}/assets/{uuid4()}/content")

    assert response.status_code == 401


# --- the project's own asset listing (#208) ------------------------------------
#
# The third asset listing, and the one that had been missing: the other two
# window a batch and the curated trunk. What is asserted here is the wire — the
# envelope, the window, and that `total` counts the project rather than the page.


def test_a_project_with_no_assets_answers_an_empty_page_rather_than_404(
    client: TestClient,
) -> None:
    project_id = client.post("/projects", json={"name": "empty"}).json()["id"]

    response = client.get(f"/projects/{project_id}/assets")

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0}


def test_the_listing_carries_every_asset_of_the_project(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    project_id = project_with_schema(client)
    batch_from_ingest(client, runner, tmp_path, project_id, images=4)

    body = client.get(f"/projects/{project_id}/assets").json()

    assert body["total"] == 4
    assert len(body["items"]) == 4


def test_limit_bounds_the_page_and_total_still_counts_the_project(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    """What the Overview's six tiles and its `+N` overflow are computed from."""
    project_id = project_with_schema(client)
    batch_from_ingest(client, runner, tmp_path, project_id, images=5)

    body = client.get(f"/projects/{project_id}/assets", params={"limit": 2}).json()

    assert len(body["items"]) == 2
    assert body["total"] == 5


def test_the_order_is_the_same_on_every_call(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    """Stability is the property the gallery actually needs.

    Nothing records arrival order (#216), so this cannot assert recency — but a
    listing that reshuffled between polls would make the tiles jump under a
    cursor, which is worse than an arbitrary six.
    """
    project_id = project_with_schema(client)
    batch_from_ingest(client, runner, tmp_path, project_id, images=5)

    first = [asset["id"] for asset in client.get(f"/projects/{project_id}/assets").json()["items"]]
    again = [asset["id"] for asset in client.get(f"/projects/{project_id}/assets").json()["items"]]

    assert first == again


def test_a_window_is_a_prefix_of_the_whole_listing(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    """A client paging with `limit` sees the same sequence it would have seen whole."""
    project_id = project_with_schema(client)
    batch_from_ingest(client, runner, tmp_path, project_id, images=5)

    whole = [asset["id"] for asset in client.get(f"/projects/{project_id}/assets").json()["items"]]
    windowed = client.get(f"/projects/{project_id}/assets", params={"limit": 2, "offset": 1}).json()

    assert [asset["id"] for asset in windowed["items"]] == whole[1:3]


def test_an_offset_past_the_end_is_an_empty_page_and_not_an_error(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    project_id = project_with_schema(client)
    batch_from_ingest(client, runner, tmp_path, project_id, images=2)

    response = client.get(f"/projects/{project_id}/assets", params={"offset": 99})

    assert response.status_code == 200
    assert (response.json()["items"], response.json()["total"]) == ([], 2)


def test_an_asset_carries_the_thumbnail_hash_a_tile_decides_on(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    """A NULL hash is a placeholder tile, not a broken image — so it must travel."""
    project_id = project_with_schema(client)
    batch_from_ingest(client, runner, tmp_path, project_id, images=1)

    (asset,) = client.get(f"/projects/{project_id}/assets").json()["items"]

    assert "thumbnail_hash" in asset
    assert (asset["width"], asset["height"]) != (None, None)


def test_the_listing_never_reaches_into_another_project(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    mine = project_with_schema(client, name="mine")
    theirs = project_with_schema(client, name="theirs")
    batch_from_ingest(client, runner, tmp_path, mine, images=3)

    assert client.get(f"/projects/{mine}/assets").json()["total"] == 3
    assert client.get(f"/projects/{theirs}/assets").json()["total"] == 0


def test_listing_an_unknown_project_is_404_project_not_found(client: TestClient) -> None:
    response = client.get(f"/projects/{uuid4()}/assets")

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


def test_a_non_positive_limit_is_refused_rather_than_silently_ignored(
    client: TestClient,
) -> None:
    project_id = client.post("/projects", json={"name": "empty"}).json()["id"]

    assert client.get(f"/projects/{project_id}/assets", params={"limit": 0}).status_code == 422
