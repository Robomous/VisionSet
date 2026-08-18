"""The batch lifecycle, the two listings, and promotion into the trunk."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from tests.mcp._flow import (
    BBOX,
    CENTERLINE,
    SCHEMA_CLASSES,
    call,
    call_destructive,
    error,
    ingested,
    open_batch,
    payload,
    schema,
)

from visionset.inference import weights as weights_module
from visionset.kernel.domain import PRE_LABEL_JOB_TYPE, DownloadSize
from visionset.kernel.services import WorkspaceService
from visionset.mcp import batches as mcp_batches


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
    assert result.is_error


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


# --- re-pinning: the second half of "add a class while annotating" ------------


def test_a_class_created_mid_batch_reaches_it_with_no_second_call(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """#381: an agent that adds a class can draw with it, without knowing repin exists.

    This was *create the class, then re-pin* — two calls, and an agent that made
    only the first was left holding a class its own batch would refuse. Adding a
    class is additive, so the version now takes every open batch with it and the
    tool says which ones it took.
    """
    project, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2)

    published = payload(
        call(
            "create_schema_version",
            project=project,
            classes=[*SCHEMA_CLASSES, {"name": "crossing", "geometries": ["bbox"]}],
        )
    )

    assert published["published"]["version"] == 2
    assert published["advanced_batches"] == [batch_id]
    assert payload(call("get_batch", batch_id=batch_id))["schema_version"] == 2


def test_repinning_after_that_is_a_no_op_rather_than_an_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The old two-call sequence still works, and its second call now does nothing.

    An agent written against the previous behaviour is not broken by this: a
    re-pin onto the version already pinned returns the batch unwritten.
    """
    project, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2)
    payload(
        call(
            "create_schema_version",
            project=project,
            classes=[*SCHEMA_CLASSES, {"name": "crossing", "geometries": ["bbox"]}],
        )
    )

    assert payload(call("repin_batch", batch_id=batch_id))["schema_version"] == 2


def test_a_narrowing_repin_names_the_flag_that_retries_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project, batch_id, _job = open_batch(monkeypatch, tmp_path, count=1)
    payload(
        call(
            "create_schema_version",
            project=project,
            classes=[{"name": "crossing", "geometries": ["bbox"]}],
            allow_destructive=True,
        )
    )

    refused = error(call("repin_batch", batch_id=batch_id))

    assert refused["retry_with"] == "allow_destructive"
    assert (
        payload(call("repin_batch", batch_id=batch_id, allow_destructive=True))["schema_version"]
        == 2
    )


def test_a_repin_that_would_orphan_this_batchs_labels_offers_no_retry(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`retry_with` is null, which is the whole reason it is published instead of a code."""
    project, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=1)
    asset_id = payload(call("next_pending_assets", job_id=job_id))["items"][0]["id"]
    payload(
        call(
            "create_schema_version",
            project=project,
            classes=[{"name": "crossing", "geometries": ["bbox"]}],
            allow_destructive=True,
        )
    )
    payload(
        call(
            "add_annotations",
            job_id=job_id,
            annotations=[
                {
                    "asset_id": asset_id,
                    "label_class": "sign",
                    "geometry": BBOX,
                    "provenance": "human",
                }
            ],
        )
    )

    refused = error(call("repin_batch", batch_id=batch_id, allow_destructive=True))

    assert refused["retry_with"] is None
    assert "sign" in refused["message"]
    assert payload(call("get_batch", batch_id=batch_id))["schema_version"] == 1


# --- membership editing -------------------------------------------------------


def _members(batch_id: str) -> list[str]:
    return [str(a["id"]) for a in payload(call("list_batch_assets", batch_id=batch_id))["items"]]


def test_an_agent_can_move_an_asset_between_two_draft_batches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The whole capability in one walk, which is how an agent would meet it."""
    project, source = ingested(monkeypatch, tmp_path, count=3)
    target = str(payload(call("create_batch", project=project, name="hand-cut"))["id"])
    moving = _members(source)[0]

    added = payload(call("add_batch_assets", batch_id=target, asset_ids=[moving]))
    removed = payload(call("remove_batch_assets", batch_id=source, asset_ids=[moving]))

    assert added["changed"] == [moving]
    assert added["asset_count"] == 1
    assert removed["changed"] == [moving]
    assert _members(target) == [moving]
    assert moving not in _members(source)


def test_membership_edits_that_change_nothing_report_that_they_changed_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Idempotent both ways, and legible: an agent must not read a no-op as work."""
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)
    held = _members(batch_id)

    assert payload(call("add_batch_assets", batch_id=batch_id, asset_ids=held))["changed"] == []
    stranger = str(uuid4())
    assert (
        payload(call("remove_batch_assets", batch_id=batch_id, asset_ids=[stranger]))["changed"]
        == []
    )
    assert _members(batch_id) == held


def test_membership_is_refused_once_the_batch_is_approved(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """And the refusal names the remedy, which is the whole reason it is legible."""
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)
    held = _members(batch_id)
    payload(call("approve_batch", batch_id=batch_id))

    refusal = error(call("remove_batch_assets", batch_id=batch_id, asset_ids=[held[0]]))

    assert "skipped" in refusal["message"]
    # `retry_with` is null rather than a flag name: no flag lifts this, and an
    # agent told otherwise would loop.
    assert refusal["retry_with"] is None
    assert _members(batch_id) == held


def test_the_batch_declares_the_capability_the_tools_enforce(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """What an agent should read before calling, agreeing with what happens if it does."""
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)
    assert "edit_membership" in payload(call("get_batch", batch_id=batch_id))["allowed_actions"]

    payload(call("approve_batch", batch_id=batch_id))

    assert "edit_membership" not in payload(call("get_batch", batch_id=batch_id))["allowed_actions"]


# --- delete, behind the destructive gate --------------------------------------


def test_deleting_a_batch_reports_what_went_and_then_it_is_gone(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The receipt is the batch as it was, read before the delete, jobs and all."""
    _, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=2)

    gone = payload(call_destructive("delete_batch", batch_id=batch_id, confirm=True))["deleted"]
    assert gone["id"] == batch_id
    assert gone["state"] == "in_annotation"
    assert [job["id"] for job in gone["jobs"]] == [job_id]

    assert error(call("get_batch", batch_id=batch_id))["message"] != ""


def test_deleting_without_confirming_changes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The refusal names the flag, and the batch is still there to be asked about."""
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)

    envelope = error(call_destructive("delete_batch", batch_id=batch_id))
    assert envelope["retry_with"] == "confirm"

    assert payload(call("get_batch", batch_id=batch_id))["state"] == "draft"


def test_a_completed_batch_refuses_and_names_no_flag_that_would_work(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The state gate runs before the confirmation one, so `confirm` is not the remedy."""
    _, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=1)
    waiting = payload(call("next_pending_assets", job_id=job_id))["items"]
    payload(
        call("set_asset_progress", job_id=job_id, asset_id=waiting[0]["id"], progress="skipped")
    )
    payload(call("complete_job", job_id=job_id))
    payload(call("complete_batch", batch_id=batch_id))

    envelope = error(call_destructive("delete_batch", batch_id=batch_id, confirm=True))
    assert envelope["retry_with"] is None
    assert "completed" in envelope["message"]

    assert payload(call("get_batch", batch_id=batch_id))["state"] == "completed"


def test_the_tool_is_absent_from_the_default_listing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A tool an agent is never shown cannot be called with a flag."""
    _, batch_id = ingested(monkeypatch, tmp_path, count=1)

    refused = call("delete_batch", batch_id=batch_id, confirm=True)

    assert refused.is_error
    assert payload(call("get_batch", batch_id=batch_id))["state"] == "draft"


# --- pre-labeling: launches a job and answers with it, before waiting on it ----


@pytest.fixture(autouse=True)
def _local_runtime_is_present(monkeypatch: pytest.MonkeyPatch) -> None:
    """This module's connections are never real; the runtime check would refuse
    every one of them for a reason no test here is about."""
    monkeypatch.setattr(mcp_batches, "require_local_inference", lambda: None)


def _connection(monkeypatch: pytest.MonkeyPatch, *, family: str, capability: str) -> str:
    """A `ready` local connection whose model declares ``capability``.

    `download_connection_weights` blocks, so by the time it answers the family
    is already on the row — the family has to be faked *before* that call, the
    same ordering `tests/server/test_prelabel_route.py` learned from
    `fetch_weights` reading it the moment the transfer finishes.
    """
    monkeypatch.setattr(weights_module, "download", lambda connection, *, into, on_bytes=None: into)
    monkeypatch.setattr(
        weights_module,
        "download_size",
        lambda model_id, model_revision: DownloadSize(
            model_id=model_id,
            model_revision=model_revision,
            total_bytes=4_000_000_000,
            file_count=2,
        ),
    )
    monkeypatch.setattr(weights_module, "family_of", lambda *_, **__: family)
    created = payload(
        call(
            "create_inference_connection",
            name=f"c-{uuid4().hex[:8]}",
            connection_type="local",
            model_id=f"some/{family}",
            model_revision="v1",
            device="cpu",
            precision="fp32",
        )
    )
    ready = payload(call("download_connection_weights", connection=created["id"]))
    assert ready["setup_state"] == "ready", ready
    assert ready["capabilities"] == [capability], ready
    return str(created["id"])


def _pre_label_job_count(tmp_path: Path) -> int:
    """How many pre-label jobs this workspace has ever queued.

    Read through the kernel rather than a tool: no MCP tool lists background
    jobs, and `_flow.py`'s own rule is that state read back for an assertion
    goes through the SDK precisely because the tool under test cannot also be
    the evidence.
    """
    workspace = WorkspaceService.open(tmp_path / "ws")
    try:
        return len(workspace.job_queue.list(types={PRE_LABEL_JOB_TYPE}))
    finally:
        workspace.close()


def test_pre_labeling_launches_a_job_and_returns_it_to_poll(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2)
    connection_id = _connection(monkeypatch, family="grounding-dino", capability="text_detect")

    launched = payload(call("pre_label_batch", batch_id=batch_id, connection=connection_id))["job"]

    assert launched["state"] == "queued"
    assert launched["type"] == PRE_LABEL_JOB_TYPE
    assert _pre_label_job_count(tmp_path) == 1


def test_asking_twice_joins_the_run_already_in_flight(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Nothing here ever drains the queue, so the first launch is still
    `queued` when the second call asks — an MCP session has no dispatcher of
    its own to race against."""
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2)
    connection_id = _connection(monkeypatch, family="grounding-dino", capability="text_detect")

    first = payload(call("pre_label_batch", batch_id=batch_id, connection=connection_id))["job"]
    second = payload(call("pre_label_batch", batch_id=batch_id, connection=connection_id))["job"]

    assert first["id"] == second["id"]
    assert _pre_label_job_count(tmp_path) == 1


def test_a_batch_that_is_not_being_annotated_is_refused_and_queues_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)
    connection_id = _connection(monkeypatch, family="grounding-dino", capability="text_detect")

    refusal = error(call("pre_label_batch", batch_id=batch_id, connection=connection_id))

    assert refusal["message"]
    assert _pre_label_job_count(tmp_path) == 0


def test_a_point_prompt_connection_is_refused_before_a_job_exists(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2)
    connection_id = _connection(monkeypatch, family="visionset_stub", capability="point_suggest")

    refusal = error(call("pre_label_batch", batch_id=batch_id, connection=connection_id))

    assert refusal["message"]
    assert _pre_label_job_count(tmp_path) == 0


def test_a_schema_with_no_box_class_is_refused_before_a_job_exists(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2, classes=[CENTERLINE])
    connection_id = _connection(monkeypatch, family="grounding-dino", capability="text_detect")

    refusal = error(call("pre_label_batch", batch_id=batch_id, connection=connection_id))

    assert refusal["message"]
    assert _pre_label_job_count(tmp_path) == 0


def test_the_batch_declares_pre_label_only_while_in_annotation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project, batch_id = ingested(monkeypatch, tmp_path, count=2)
    assert "pre_label" not in payload(call("get_batch", batch_id=batch_id))["allowed_actions"]

    payload(call("approve_batch", batch_id=batch_id))
    payload(call("start_batch", batch_id=batch_id))

    assert "pre_label" in payload(call("get_batch", batch_id=batch_id))["allowed_actions"]
