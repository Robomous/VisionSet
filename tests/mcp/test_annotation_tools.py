"""The three annotation writes and the read that supplies their ids.

The two things worth pinning hardest: every write is all-or-nothing, and when one
item is bad the refusal carries the position in the list the caller sent — which
is recoverable nowhere else, because nothing landed to count from.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.mcp._flow import (
    BBOX,
    CENTERLINE,
    SCHEMA_CLASSES,
    call,
    error,
    open_batch,
    payload,
)


def _label(asset_id: str, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "asset_id": asset_id,
        "label_class": "sign",
        "geometry": BBOX,
        "provenance": "model",
        "model_ref": "probe@1",
        "confidence": 0.9,
    }
    return {**body, **overrides}


def _job_with_assets(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    count: int = 2,
    classes: list[dict[str, Any]] | None = None,
) -> tuple[str, list[str]]:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=count, classes=classes)
    assets = payload(call("next_pending_assets", job_id=job_id, count=count))["items"]
    return job_id, [a["id"] for a in assets]


def test_a_written_annotation_comes_back_with_the_pinned_version_stamped_in(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # `schema_version` is not an input — the service stamps the batch's pin over
    # whatever it was handed, which is why `AnnotationInput` omits the field.
    job_id, assets = _job_with_assets(monkeypatch, tmp_path)
    written = payload(call("add_annotations", job_id=job_id, annotations=[_label(assets[0])]))
    assert written["total"] == 1
    assert written["items"][0]["schema_version"] == 1
    assert written["items"][0]["provenance"] == "model"
    assert written["items"][0]["model_ref"] == "probe@1"
    assert written["items"][0]["geometry"] == BBOX


def test_an_asset_with_nothing_on_it_lists_an_empty_collection(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job_id, assets = _job_with_assets(monkeypatch, tmp_path)
    assert payload(call("list_asset_annotations", job_id=job_id, asset_id=assets[0])) == {
        "items": [],
        "total": 0,
    }


def test_a_bad_item_refuses_the_whole_write_and_names_its_position(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job_id, assets = _job_with_assets(monkeypatch, tmp_path)
    refusal = error(
        call(
            "add_annotations",
            job_id=job_id,
            annotations=[
                _label(assets[0]),
                _label(assets[1]),
                _label(assets[0], label_class="pedestrian"),
            ],
        )
    )
    assert refusal["index"] == 2
    # All-or-nothing: the two good ones did not land either, which is exactly why
    # the index is the only thing identifying the offending item.
    assert payload(call("list_asset_annotations", job_id=job_id, asset_id=assets[0]))["total"] == 0


def test_the_geometry_must_match_the_one_its_class_is_bound_to(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job_id, assets = _job_with_assets(monkeypatch, tmp_path)
    refusal = error(
        call(
            "add_annotations",
            job_id=job_id,
            annotations=[
                _label(
                    assets[0],
                    geometry={"type": "polygon", "points": [[0, 0], [4, 0], [4, 4]]},
                )
            ],
        )
    )
    assert refusal["index"] == 0


def test_an_agent_can_write_a_lane(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """#223's whole point, over the surface the story is about.

    The lane workflow is *agent pre-labels, human reviews*, so the polyline has to
    be writable by a tool call and nothing else. Nothing about the tool changed to
    allow it: `add_annotations` takes the domain's own `Geometry`, so widening the
    union widened the tool's `$defs` and its validator in one move.
    """
    job_id, assets = _job_with_assets(monkeypatch, tmp_path, classes=[*SCHEMA_CLASSES, CENTERLINE])

    written = payload(
        call(
            "add_annotations",
            job_id=job_id,
            annotations=[
                _label(
                    assets[0],
                    label_class="centerline",
                    geometry={"type": "polyline", "points": [[1, 2], [5, 9], [9, 20]]},
                    attributes={},
                )
            ],
        )
    )

    (stored,) = written["items"]
    assert stored["geometry"]["type"] == "polyline"
    assert stored["geometry"]["points"] == [[1.0, 2.0], [5.0, 9.0], [9.0, 20.0]]


def test_a_one_point_polyline_is_a_malformed_request_not_a_domain_refusal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Which of the two failure shapes a bad lane gets, asserted rather than assumed.

    `min_length=2` lives on `PolylineGeometry`, which the tool takes directly, so
    the *input validator* rejects it and the result is `isError` carrying the
    field path — not the domain envelope an `add_annotations` refusal uses. That
    is the documented split (`docs/mcp.md`): a malformed request and a refused one
    are different answers, and an agent branches on them differently. Pinned
    because the obvious expectation is the other one.
    """
    job_id, assets = _job_with_assets(monkeypatch, tmp_path, classes=[*SCHEMA_CLASSES, CENTERLINE])
    result = call(
        "add_annotations",
        job_id=job_id,
        annotations=[
            _label(
                assets[0],
                label_class="centerline",
                geometry={"type": "polyline", "points": [[0, 0]]},
                attributes={},
            )
        ],
    )

    assert result.is_error
    text = "".join(getattr(item, "text", "") for item in result.content)
    assert "too_short" in text


def test_an_attribute_the_class_does_not_declare_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job_id, assets = _job_with_assets(monkeypatch, tmp_path)
    assert error(
        call(
            "add_annotations",
            job_id=job_id,
            annotations=[_label(assets[0], attributes={"colour": "red"})],
        )
    )["message"]


def test_provenance_model_without_a_reference_is_a_malformed_request(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # A domain model validator on `AnnotationInput`'s own fields, so it fires
    # during argument parsing rather than reaching the service.
    job_id, assets = _job_with_assets(monkeypatch, tmp_path)
    assert call(
        "add_annotations",
        job_id=job_id,
        annotations=[{**_label(assets[0]), "model_ref": None}],
    ).is_error


def test_a_geometry_with_no_type_cannot_pick_a_variant(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The wart the domain union brings with it, pinned rather than hidden: the
    # discriminator carries a default, so the generated schema shows `type` as
    # optional, but pydantic reads the tag out of the input dict to select the
    # variant and fails without it. The tool description says to spell it out.
    job_id, assets = _job_with_assets(monkeypatch, tmp_path)
    result = call(
        "add_annotations",
        job_id=job_id,
        annotations=[_label(assets[0], geometry={"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0})],
    )
    assert result.is_error
    assert "union_tag_not_found" in result.content[0].text or "type" in result.content[0].text


def test_an_update_replaces_the_whole_value_and_keeps_the_stored_asset(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job_id, assets = _job_with_assets(monkeypatch, tmp_path)
    written = payload(call("add_annotations", job_id=job_id, annotations=[_label(assets[0])]))
    annotation_id = written["items"][0]["id"]
    moved = {"type": "bbox", "x": 5.0, "y": 5.0, "width": 2.0, "height": 2.0}
    updated = payload(
        call(
            "update_annotations",
            job_id=job_id,
            annotations=[
                {
                    "id": annotation_id,
                    "label_class": "sign",
                    "geometry": moved,
                    "provenance": "human",
                }
            ],
        )
    )
    assert updated["items"][0]["geometry"] == moved
    assert updated["items"][0]["provenance"] == "human"
    # The stored asset always wins — there is no way to move a label to another
    # image, which is why `AnnotationEdit` has no `asset_id` at all.
    assert updated["items"][0]["asset_id"] == assets[0]


def test_deleting_takes_no_confirmation_and_moves_the_asset_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # One of exactly two kernel methods exempt from `confirm`: removing a label is
    # the annotator edit loop, and the batch gate is the guard.
    job_id, assets = _job_with_assets(monkeypatch, tmp_path)
    written = payload(call("add_annotations", job_id=job_id, annotations=[_label(assets[0])]))
    assert payload(
        call("delete_annotations", job_id=job_id, annotation_ids=[written["items"][0]["id"]])
    ) == {"deleted": 1, "job_started": False}
    assert payload(call("get_job", job_id=job_id))["progress"]["unannotated"] == 2


def test_a_repeated_id_counts_once_and_an_unknown_one_blames_its_own_position(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job_id, assets = _job_with_assets(monkeypatch, tmp_path)
    written = payload(
        call("add_annotations", job_id=job_id, annotations=[_label(assets[0]), _label(assets[1])])
    )
    first, second = (a["id"] for a in written["items"])
    assert payload(
        call("delete_annotations", job_id=job_id, annotation_ids=[first, first, second])
    ) == {"deleted": 2, "job_started": False}

    written = payload(call("add_annotations", job_id=job_id, annotations=[_label(assets[0])]))
    stranger = str(uuid4())
    refusal = error(
        call(
            "delete_annotations",
            job_id=job_id,
            annotation_ids=[written["items"][0]["id"], stranger],
        )
    )
    assert refusal["index"] == 1


def test_no_write_reaches_a_batch_that_is_not_open(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job_id, assets = _job_with_assets(monkeypatch, tmp_path, count=1)
    payload(call("set_asset_progress", job_id=job_id, asset_id=assets[0], progress="skipped"))
    payload(call("complete_job", job_id=job_id))
    batch_id = payload(call("get_job", job_id=job_id))["batch_id"]
    payload(call("complete_batch", batch_id=batch_id))
    assert error(call("add_annotations", job_id=job_id, annotations=[_label(assets[0])]))["message"]
