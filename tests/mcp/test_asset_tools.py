"""``get_asset_image`` — the acceptance walk for "an agent can see what it annotates".

The claim under test is not "bytes came back" but "the numbers beside the bytes
say which frame to write coordinates in". A preview whose ``scale`` were wrong
would produce annotations that are individually plausible and uniformly wrong.
"""

from __future__ import annotations

import base64
import io
from pathlib import Path

import pytest
from PIL import Image as PillowImage
from tests.fixtures.media import write_images
from tests.mcp._flow import call, error, ingested, payload, schema

from visionset.kernel.domain import ImageFormat
from visionset.kernel.ports import DEFAULT_THUMBNAIL_MAX_EDGE, THUMBNAIL_FORMAT
from visionset.mcp.assets import SUFFIXES


def _image_block(result: object) -> object:
    blocks = [b for b in result.content if b.type == "image"]  # type: ignore[attr-defined]
    assert len(blocks) == 1, result.content  # type: ignore[attr-defined]
    return blocks[0]


def _first_asset(named: str, batch_id: str) -> str:
    listed = payload(call("list_batch_assets", batch_id=batch_id))
    return str(listed["items"][0]["id"])


def test_a_preview_comes_back_as_image_content_with_the_rows_own_dimensions(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named, batch_id = ingested(monkeypatch, tmp_path, count=1)
    asset_id = _first_asset(named, batch_id)
    listed = payload(call("list_batch_assets", batch_id=batch_id))["items"][0]

    result = call("get_asset_image", project=named, asset_id=asset_id)
    assert not result.is_error
    block = _image_block(result)
    assert block.mime_type == "image/jpeg"  # type: ignore[attr-defined]

    meta = result.structured_content
    assert meta is not None
    # The acceptance criterion: the dimensions the tool reports match the Asset row.
    assert (meta["width"], meta["height"]) == (listed["width"], listed["height"])
    assert meta["content_hash"] == listed["content_hash"]
    assert meta["resolution"] == "thumbnail"


def test_the_bytes_decode_to_an_image_of_the_size_the_answer_claims(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Measured, never derived: the port caps an *edge*, so the preview's size is a
    # function of the aspect ratio and of whether it was smaller to begin with.
    named, batch_id = ingested(monkeypatch, tmp_path, count=1)
    result = call("get_asset_image", project=named, asset_id=_first_asset(named, batch_id))
    block = _image_block(result)
    with PillowImage.open(io.BytesIO(base64.b64decode(block.data))) as opened:  # type: ignore[attr-defined]
        assert opened.size == (
            result.structured_content["image_width"],  # type: ignore[index]
            result.structured_content["image_height"],  # type: ignore[index]
        )
        assert opened.format == "JPEG"


def test_a_large_asset_is_previewed_smaller_and_the_scale_says_by_how_much(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The whole reason four numbers travel. An agent measuring a box on the
    # returned pixels has to multiply by `scale` to reach the frame annotations
    # live in, and nothing downstream could detect the mistake if it did not.
    named = schema(monkeypatch, tmp_path)
    write_images(tmp_path / "big", count=1, size=(1024, 512))
    batch_id = payload(call("ingest", project=named, path=str(tmp_path / "big")))["batch_id"]

    meta = call(
        "get_asset_image", project=named, asset_id=_first_asset(named, batch_id)
    ).structured_content
    assert meta is not None
    assert (meta["width"], meta["height"]) == (1024, 512)
    assert max(meta["image_width"], meta["image_height"]) == DEFAULT_THUMBNAIL_MAX_EDGE
    assert meta["scale"] == pytest.approx(1024 / meta["image_width"])
    assert meta["scale"] > 1


def test_an_asset_smaller_than_the_cap_is_never_enlarged_and_scales_by_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named, batch_id = ingested(monkeypatch, tmp_path, count=1)
    meta = call(
        "get_asset_image", project=named, asset_id=_first_asset(named, batch_id)
    ).structured_content
    assert meta is not None
    assert (meta["image_width"], meta["image_height"]) == (meta["width"], meta["height"])
    assert meta["scale"] == 1.0


def test_asking_for_full_resolution_returns_the_original_bytes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    write_images(tmp_path / "big", count=1, size=(400, 300))
    batch_id = payload(call("ingest", project=named, path=str(tmp_path / "big")))["batch_id"]
    asset_id = _first_asset(named, batch_id)

    result = call("get_asset_image", project=named, asset_id=asset_id, full=True)
    block = _image_block(result)
    assert block.mime_type == "image/png"  # type: ignore[attr-defined]
    meta = result.structured_content
    assert meta is not None
    assert meta["resolution"] == "full"
    assert (meta["image_width"], meta["image_height"]) == (400, 300)
    assert meta["scale"] == 1.0
    with PillowImage.open(io.BytesIO(base64.b64decode(block.data))) as opened:  # type: ignore[attr-defined]
        assert opened.size == (400, 300)


def test_a_missing_preview_names_the_tool_that_renders_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from visionset.kernel.services import ProjectService, WorkspaceService

    root = tmp_path / "ws"
    named, batch_id = ingested(monkeypatch, tmp_path, count=1)
    asset_id = _first_asset(named, batch_id)
    with WorkspaceService.open(root) as service:
        project_id = ProjectService(service).get_by_name(named).id
        with service.unit_of_work() as uow:
            asset = uow.assets.list(project_id)[0]
            uow.assets.update(asset.model_copy(update={"thumbnail_hash": None}))

    refusal = error(call("get_asset_image", project=named, asset_id=asset_id))
    assert "backfill_thumbnails" in (refusal["hint"] or "")
    assert "full=true" in (refusal["hint"] or "")
    # And the remedy it names actually works.
    payload(call("backfill_thumbnails", project=named))
    assert not call("get_asset_image", project=named, asset_id=asset_id).is_error


def test_an_unknown_asset_is_refused_in_the_envelope(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from uuid import uuid4

    named, _ = ingested(monkeypatch, tmp_path, count=1)
    assert error(call("get_asset_image", project=named, asset_id=str(uuid4())))["message"]


def test_a_malformed_asset_id_is_refused_before_the_kernel_sees_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named, _ = ingested(monkeypatch, tmp_path, count=1)
    assert (
        "must be a UUID"
        in error(call("get_asset_image", project=named, asset_id="not-a-uuid"))["message"]
    )


def test_every_image_format_has_a_media_type() -> None:
    # The `ProgressCounts` bargain: a format added to the enum without an entry
    # fails here rather than crashing one download in a thousand, or serving the
    # bytes under the wrong type.
    assert set(SUFFIXES) == set(ImageFormat)
    assert SUFFIXES[THUMBNAIL_FORMAT] == "jpeg"


def test_the_description_states_the_cap_the_port_actually_pins() -> None:
    # The number is spelled out in the docstring because a docstring cannot be an
    # f-string. This is the tripwire that keeps the two in step.
    from visionset.mcp.assets import get_asset_image

    assert str(DEFAULT_THUMBNAIL_MAX_EDGE) in (get_asset_image.__doc__ or "")


def test_list_project_assets_includes_one_removed_from_its_batch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named, batch_id = ingested(monkeypatch, tmp_path, count=3)
    members = payload(call("list_batch_assets", batch_id=batch_id))["items"]
    removed = str(members[0]["id"])
    call("remove_batch_assets", batch_id=batch_id, asset_ids=[removed])

    listed = payload(call("list_project_assets", project=named))

    assert listed["total"] == 3
    assert removed in {item["id"] for item in listed["items"]}
    assert removed not in {
        item["id"] for item in payload(call("list_batch_assets", batch_id=batch_id))["items"]
    }


def test_list_project_assets_pages_with_a_stable_total(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named, _ = ingested(monkeypatch, tmp_path, count=3)
    everything = payload(call("list_project_assets", project=named))["items"]

    page = payload(call("list_project_assets", project=named, limit=2, offset=1))
    past = payload(call("list_project_assets", project=named, offset=9))

    assert page["total"] == 3
    assert page["items"] == everything[1:3]
    assert past == {"items": [], "total": 3}


def test_list_project_assets_puts_the_newest_ingest_first(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named, first_batch = ingested(monkeypatch, tmp_path, count=2)
    write_images(tmp_path / "later", count=2, first_seed=100)
    second_batch = payload(call("ingest", project=named, path=str(tmp_path / "later")))["batch_id"]

    def ids(batch_id: str) -> set[str]:
        return {i["id"] for i in payload(call("list_batch_assets", batch_id=batch_id))["items"]}

    listed = [item["id"] for item in payload(call("list_project_assets", project=named))["items"]]

    assert set(listed[:2]) == ids(second_batch)
    assert set(listed[2:]) == ids(first_batch)
