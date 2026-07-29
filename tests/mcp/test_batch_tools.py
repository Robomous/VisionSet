"""The batch lifecycle, the two listings, and promotion into the trunk."""

from __future__ import annotations

from pathlib import Path

import pytest
from tests.mcp._flow import BBOX, call, error, ingested, open_batch, payload, schema


def test_a_freshly_ingested_batch_is_a_draft_with_no_jobs_and_no_pin(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)
    batch = payload(call("get_batch", batch_id=batch_id))
    assert batch["state"] == "draft"
    assert batch["schema_version"] is None
    assert batch["jobs"] == []
    assert batch["asset_count"] == 2


def test_approval_pins_the_active_schema_and_cuts_one_job_by_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=4)
    approved = payload(call("approve_batch", batch_id=batch_id))
    assert approved["state"] == "approved"
    assert approved["schema_version"] == 1
    assert len(approved["jobs"]) == 1
    assert approved["jobs"][0]["asset_count"] == 4


def test_jobs_of_cuts_the_batch_into_segments(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=5)
    approved = payload(call("approve_batch", batch_id=batch_id, jobs_of=2))
    # An exact partition: 5 assets in jobs of 2 is 2 + 2 + 1, never a dropped one.
    assert sorted(j["asset_count"] for j in approved["jobs"]) == [1, 2, 2]


def test_jobs_of_zero_is_a_malformed_request_rather_than_a_domain_refusal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # `BySize.size` is `gt=0` and constructing one with zero raises a pydantic
    # ValidationError, which is not a VisionSetError. `ge=1` on the parameter is
    # what stops it ever being constructed.
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)
    result = call("approve_batch", batch_id=batch_id, jobs_of=0)
    assert result.isError


def test_the_lifecycle_is_one_way(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=1)
    payload(call("approve_batch", batch_id=batch_id))
    assert "cannot become" in error(call("approve_batch", batch_id=batch_id))["message"]
    payload(call("start_batch", batch_id=batch_id))
    assert "cannot become" in error(call("start_batch", batch_id=batch_id))["message"]


def test_starting_a_batch_that_was_never_approved_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=1)
    assert "cannot become" in error(call("start_batch", batch_id=batch_id))["message"]


def test_approving_an_empty_batch_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from tests.fixtures.media import write_unsupported_file

    named = schema(monkeypatch, tmp_path)
    (tmp_path / "incoming").mkdir()
    write_unsupported_file(tmp_path / "incoming" / "notes.txt")
    result = payload(call("ingest", project=named, path=str(tmp_path / "incoming")))
    assert error(call("approve_batch", batch_id=result["batch_id"]))["message"]


def test_a_batch_cannot_be_completed_while_a_job_is_outstanding(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Derived means recomputed, not automatic.
    _, batch_id, _ = open_batch(monkeypatch, tmp_path, count=2)
    assert error(call("complete_batch", batch_id=batch_id))["message"]


def test_listing_batch_assets_names_the_job_each_belongs_to(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=3)
    listed = payload(call("list_batch_assets", batch_id=batch_id))
    assert listed["total"] == 3
    assert {a["job_id"] for a in listed["items"]} == {job_id}
    assert {a["progress"] for a in listed["items"]} == {"unannotated"}


def test_a_draft_batch_lists_its_assets_with_no_job_and_no_progress(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Both null exactly while the batch is a draft, which is honest rather than
    # lossy: a draft genuinely has no jobs to belong to.
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)
    listed = payload(call("list_batch_assets", batch_id=batch_id))
    assert [a["job_id"] for a in listed["items"]] == [None, None]
    assert [a["progress"] for a in listed["items"]] == [None, None]


def test_paging_bounds_the_response_and_leaves_the_total_alone(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=5)
    first = payload(call("list_batch_assets", batch_id=batch_id, limit=2))
    second = payload(call("list_batch_assets", batch_id=batch_id, limit=2, offset=2))
    assert len(first["items"]) == 2
    assert len(second["items"]) == 2
    # `total` is the size of the whole batch, so a caller pages until it has seen
    # that many rather than until the number moves.
    assert first["total"] == second["total"] == 5
    assert {a["id"] for a in first["items"]}.isdisjoint({a["id"] for a in second["items"]})


def test_an_offset_past_the_end_is_an_empty_page_and_not_a_refusal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)
    assert payload(call("list_batch_assets", batch_id=batch_id, offset=99)) == {
        "items": [],
        "total": 2,
    }


def test_promotion_carries_only_the_settled_assets_and_leaves_a_skip_behind(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=2)
    payload(call("start_job", job_id=job_id))
    pending = payload(call("next_pending_assets", job_id=job_id, count=2))["items"]
    payload(
        call(
            "add_annotations",
            job_id=job_id,
            annotations=[
                {
                    "asset_id": pending[0]["id"],
                    "label_class": "sign",
                    "geometry": BBOX,
                    "provenance": "model",
                    "model_ref": "probe@1",
                }
            ],
        )
    )
    payload(
        call("set_asset_progress", job_id=job_id, asset_id=pending[1]["id"], progress="skipped")
    )
    payload(call("complete_job", job_id=job_id))
    payload(call("complete_batch", batch_id=batch_id))

    promoted = payload(call("promote_batch", batch_id=batch_id))
    assert [a["id"] for a in promoted["items"]] == [pending[0]["id"]]
    # A union against what is there, so the second call adds nothing.
    assert payload(call("promote_batch", batch_id=batch_id)) == {"items": [], "total": 0}


def test_promoting_an_incomplete_batch_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _ = open_batch(monkeypatch, tmp_path, count=1)
    assert error(call("promote_batch", batch_id=batch_id))["message"]


def test_a_malformed_batch_id_is_refused_before_the_kernel_sees_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The same call the API makes: a value that could not have named anything is
    # a malformed request, not a missing resource.
    ingested(monkeypatch, tmp_path, count=1)
    refusal = error(call("get_batch", batch_id="not-a-uuid"))
    assert "must be a UUID" in refusal["message"]
