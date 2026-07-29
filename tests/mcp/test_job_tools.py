"""The annotation loop: ``get_job``, the lifecycle, iteration and per-asset progress."""

from __future__ import annotations

from pathlib import Path

import pytest
from tests.mcp._flow import BBOX, call, error, ingested, open_batch, payload


def _annotate(job_id: str, asset_id: str) -> None:
    payload(
        call(
            "add_annotations",
            job_id=job_id,
            annotations=[
                {
                    "asset_id": asset_id,
                    "label_class": "sign",
                    "geometry": BBOX,
                    "provenance": "model",
                    "model_ref": "probe@1",
                }
            ],
        )
    )


def test_a_job_names_the_batch_and_the_schema_its_work_is_judged_against(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # An `AnnotationJob` records only its task group, so `batch_id` is added here
    # — without it a caller holding a job id has no route to the pinned version.
    _, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=2)
    job = payload(call("get_job", job_id=job_id))
    assert job["batch_id"] == batch_id
    assert job["batch_state"] == "in_annotation"
    assert job["schema_version"] == 1
    assert job["progress"]["unannotated"] == 2


def test_next_pending_returns_only_unannotated_assets_and_shrinks_as_you_work(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=3)
    payload(call("start_job", job_id=job_id))
    first = payload(call("next_pending_assets", job_id=job_id, count=10))
    assert first["total"] == 3
    _annotate(job_id, first["items"][0]["id"])
    second = payload(call("next_pending_assets", job_id=job_id, count=10))
    assert second["total"] == 2
    assert first["items"][0]["id"] not in {a["id"] for a in second["items"]}


def test_the_loop_terminates_with_an_empty_page(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=2)
    payload(call("start_job", job_id=job_id))
    for asset in payload(call("next_pending_assets", job_id=job_id, count=10))["items"]:
        _annotate(job_id, asset["id"])
    assert payload(call("next_pending_assets", job_id=job_id, count=10)) == {
        "items": [],
        "total": 0,
    }


def test_asking_for_no_assets_is_a_malformed_request(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # `next_pending` refuses a non-positive count with a bare ValueError, so `ge=1`
    # on the parameter has to stop it arriving.
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    assert call("next_pending_assets", job_id=job_id, count=0).isError


def test_a_job_cannot_be_completed_while_an_asset_is_unsettled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=2)
    payload(call("start_job", job_id=job_id))
    assert error(call("complete_job", job_id=job_id))["message"]


def test_skipping_an_asset_settles_it_without_writing_anything(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    payload(call("start_job", job_id=job_id))
    asset_id = payload(call("next_pending_assets", job_id=job_id, count=1))["items"][0]["id"]
    marked = payload(
        call("set_asset_progress", job_id=job_id, asset_id=asset_id, progress="skipped")
    )
    assert marked == {"asset_id": asset_id, "progress": "skipped"}
    assert payload(call("complete_job", job_id=job_id))["state"] == "completed"


def test_writing_an_annotation_moves_its_asset_on_its_own(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    payload(call("start_job", job_id=job_id))
    asset_id = payload(call("next_pending_assets", job_id=job_id, count=1))["items"][0]["id"]
    _annotate(job_id, asset_id)
    assert payload(call("get_job", job_id=job_id))["progress"]["annotated"] == 1


def test_re_marking_the_state_an_asset_already_holds_is_not_a_refusal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    asset_id = payload(call("next_pending_assets", job_id=job_id, count=1))["items"][0]["id"]
    payload(call("set_asset_progress", job_id=job_id, asset_id=asset_id, progress="skipped"))
    payload(call("set_asset_progress", job_id=job_id, asset_id=asset_id, progress="skipped"))


def test_an_illegal_progress_move_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # `accepted` is terminal, and `review_pending` is only reachable from
    # `annotated`. The transition table says so and nothing here restates it.
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    asset_id = payload(call("next_pending_assets", job_id=job_id, count=1))["items"][0]["id"]
    refusal = error(
        call("set_asset_progress", job_id=job_id, asset_id=asset_id, progress="accepted")
    )
    assert "cannot become" in refusal["message"]


def test_nothing_may_be_written_into_a_batch_nobody_opened(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=1)
    approved = payload(call("approve_batch", batch_id=batch_id))
    job_id = approved["jobs"][0]["id"]
    asset_id = payload(call("list_batch_assets", batch_id=batch_id))["items"][0]["id"]
    assert error(call("start_job", job_id=job_id))["message"]
    assert error(call("set_asset_progress", job_id=job_id, asset_id=asset_id, progress="skipped"))[
        "message"
    ]


def test_an_asset_that_is_not_in_the_job_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from uuid import uuid4

    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    refusal = error(
        call("set_asset_progress", job_id=job_id, asset_id=str(uuid4()), progress="skipped")
    )
    assert refusal["message"]
