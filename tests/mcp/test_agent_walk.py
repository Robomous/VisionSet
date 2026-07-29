"""The whole cycle, driven by an agent, in one function.

The `tests/server/test_external_client.py` precedent, for the same reason: the
point is that the *entire* walk is visible at once, so this module deliberately
uses **none** of `_flow.py`'s ladder helpers. Every call's outcome is asserted
rather than only the final state, because a walk that quietly skipped a step and
still ended up in the right place would prove nothing.

It also stands in for #36, which owns the published transcript: if this passes, an
agent holding nothing but a workspace can produce a released, verified, exported
dataset — including looking at the pixels before labelling them.
"""

from __future__ import annotations

import base64
import io
from pathlib import Path
from typing import Any

import pytest
from mcp.types import CallToolResult
from PIL import Image as PillowImage
from tests.fixtures.media import write_images
from tests.mcp._flow import call

from visionset.kernel.services import WorkspaceService


def ok(result: CallToolResult) -> dict[str, Any]:
    """Every step asserts, and an error envelope is a failure here."""
    assert not result.isError, result.content
    assert result.structuredContent is not None
    assert "error" not in result.structuredContent, result.structuredContent
    return result.structuredContent


def test_an_agent_can_take_a_folder_of_images_to_an_exported_release(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "ws"
    WorkspaceService.init(root).close()
    monkeypatch.setenv("VISIONSET_WORKSPACE", str(root))
    write_images(tmp_path / "incoming", count=4, size=(640, 480))

    # 1. Discover an empty workspace and make somewhere to work.
    assert ok(call("list_projects")) == {"items": [], "total": 0}
    created = ok(call("create_project", name="road-signs", description="signage survey"))
    assert created["project"]["name"] == "road-signs"

    # 2. Declare the contract before any work is judged against it.
    schema = ok(
        call(
            "create_schema_version",
            project="road-signs",
            classes=[
                {"name": "sign", "geometry": "bbox"},
                {"name": "empty-road", "geometry": "classification_tag"},
            ],
        )
    )
    assert schema["version"] == 1
    assert ok(call("get_schema", project="road-signs"))["active_version"] == 1

    # 3. Read the folder in. One call, synchronous, and the batch comes back.
    run = ok(call("ingest", project="road-signs", path=str(tmp_path / "incoming")))
    assert (run["created"], run["deduplicated"], run["failed"]) == (4, 0, 0)
    batch_id = run["batch_id"]

    # 4. Freeze it, pin the schema, cut it in two, and open it for work.
    approved = ok(call("approve_batch", batch_id=batch_id, jobs_of=2))
    assert approved["schema_version"] == 1
    assert len(approved["jobs"]) == 2
    started = ok(call("start_batch", batch_id=batch_id))
    assert started["state"] == "in_annotation"

    # 5. Work each job: look, then label. This is the part that makes it an
    #    annotator rather than an operator.
    for job in started["jobs"]:
        job_id = job["id"]
        assert ok(call("start_job", job_id=job_id))["state"] == "in_progress"
        pending = ok(call("next_pending_assets", job_id=job_id, count=10))
        assert pending["total"] == 2

        for index, asset in enumerate(pending["items"]):
            seen = call("get_asset_image", project="road-signs", asset_id=asset["id"])
            frame = ok(seen)
            block = next(b for b in seen.content if b.type == "image")
            with PillowImage.open(io.BytesIO(base64.b64decode(block.data))) as opened:
                assert opened.size == (frame["image_width"], frame["image_height"])

            # A 640x480 asset previews at 256x192, so the agent measured on a
            # frame 2.5x smaller than the one coordinates live in. Scaling is not
            # optional, and nothing downstream could detect the omission.
            assert (frame["width"], frame["height"]) == (640, 480)
            assert frame["scale"] == pytest.approx(640 / frame["image_width"])
            assert frame["scale"] > 1

            if index == 0:
                measured = {"x": 10.0, "y": 12.0, "width": 40.0, "height": 30.0}
                scaled = {k: v * frame["scale"] for k, v in measured.items()}
                written = ok(
                    call(
                        "add_annotations",
                        job_id=job_id,
                        annotations=[
                            {
                                "asset_id": asset["id"],
                                "label_class": "sign",
                                "geometry": {"type": "bbox", **scaled},
                                "provenance": "model",
                                "model_ref": "walkthrough@1",
                                "confidence": 0.82,
                            }
                        ],
                    )
                )
                assert written["items"][0]["geometry"]["width"] == pytest.approx(
                    40.0 * frame["scale"]
                )
                # In the asset's own frame, not the preview's — the box has to fit
                # the real image, which is the whole reason `scale` is published.
                assert written["items"][0]["geometry"]["x"] < frame["width"]
            else:
                ok(
                    call(
                        "set_asset_progress",
                        job_id=job_id,
                        asset_id=asset["id"],
                        progress="skipped",
                    )
                )

        assert ok(call("next_pending_assets", job_id=job_id, count=10))["total"] == 0
        assert ok(call("complete_job", job_id=job_id))["state"] == "completed"

    # 6. Close the batch and move the finished work into the trunk. The two
    #    skipped assets stay behind, which is what a skip is for.
    assert ok(call("complete_batch", batch_id=batch_id))["state"] == "completed"
    assert ok(call("promote_batch", batch_id=batch_id))["total"] == 2

    stats = ok(call("dataset_stats", project="road-signs"))
    assert (stats["asset_count"], stats["annotation_count"]) == (2, 2)
    assert stats["classes"] == [{"label_class": "sign", "annotations": 2, "assets": 2}]
    # A declared class nobody used is absent, not zero.
    assert "empty-road" not in {c["label_class"] for c in stats["classes"]}

    # 7. Freeze, check, and write it where something can train on it.
    release = ok(
        call(
            "publish_release",
            project="road-signs",
            tag="v1.0",
            split={"train": 0.5, "val": 0.25, "test": 0.25, "seed": 7},
        )
    )
    assert (release["asset_count"], release["annotation_count"]) == (2, 2)
    assert ok(call("list_releases", project="road-signs"))["total"] == 1
    assert ok(call("verify_release", project="road-signs", tag="v1.0"))["ok"] is True

    assert ok(call("list_formats"))["items"] == [{"name": "dummy", "lossy": False}]
    exported = ok(
        call(
            "export_release",
            project="road-signs",
            tag="v1.0",
            format="dummy",
            dest=str(tmp_path / "out"),
        )
    )
    assert exported["release_id"] == release["id"]
    assert Path(exported["directory"]).is_dir()

    # 8. And the walk ends on a refusal it also asserts: the release is immutable,
    #    so the tag cannot be reused.
    reused = call("publish_release", project="road-signs", tag="v1.0")
    assert not reused.isError
    assert reused.structuredContent is not None
    assert "error" in reused.structuredContent
