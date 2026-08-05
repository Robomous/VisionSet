"""The annotation loop: ``get_job``, the lifecycle, iteration and per-asset progress."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from tests.mcp._flow import BBOX, call, error, ingested, open_batch, payload, tool_schemas


def _add(job_id: str, asset_id: str) -> dict[str, Any]:
    """Write one box and hand back the whole answer, `job_started` included."""
    return payload(
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


def _annotate(job_id: str, asset_id: str) -> None:
    _add(job_id, asset_id)


def _seeded_correction(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[str, str]:
    """A `pending` job whose one asset already carries a label. Returns `(job, asset)`.

    Annotate a batch, close it, and correct it: `initial_progress` starts an
    already-labeled asset at `annotated`, so the correction's job opens seeded
    and settled without anybody having written into it. It is the only shape in
    which a `pending` job holds annotations, which makes it the fixture for every
    write that addresses one.
    """
    _, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=1)
    asset_id = payload(call("next_pending_assets", job_id=job_id, count=1))["items"][0]["id"]
    _annotate(job_id, asset_id)
    payload(call("complete_job", job_id=job_id))
    payload(call("complete_batch", batch_id=batch_id))

    correction = str(
        payload(call("create_correction_batch", batch_id=batch_id, name="fixes"))["id"]
    )
    approved = payload(call("approve_batch", batch_id=correction))
    payload(call("start_batch", batch_id=correction))
    return str(approved["jobs"][0]["id"]), asset_id


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
    assert call("next_pending_assets", job_id=job_id, count=0).is_error


def test_a_job_cannot_be_completed_while_an_asset_is_unsettled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=2)
    assert error(call("complete_job", job_id=job_id))["message"]


def test_a_job_nobody_started_completes_anyway_because_the_first_write_started_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The friction #36 found, made unreachable rather than warned about (#109).

    Two of twelve real agent runs wrote every label and then called
    `complete_job` on a job still `pending`, because writing is gated on the
    *batch* and nothing forced a start until the very end. Both recovered, but
    the call was wasted. There is no `start_job` now: the annotation that
    settles the last asset is what moves the job, so the refusal those runs hit
    has no way to happen.
    """
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    assert payload(call("get_job", job_id=job_id))["state"] == "pending"
    asset_id = payload(call("next_pending_assets", job_id=job_id, count=1))["items"][0]["id"]
    _annotate(job_id, asset_id)

    assert payload(call("get_job", job_id=job_id))["state"] == "in_progress"
    assert payload(call("complete_job", job_id=job_id))["state"] == "completed"


def test_the_first_write_reports_the_start_and_a_later_one_does_not(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Both facts, never an invisible one: the agent is told the state moved.

    A start that happened silently would be a call doing something the caller
    did not ask for and cannot see, which is the objection #109 records against
    doing it in the kernel. Publishing it is what makes it adapter *policy*
    rather than a hidden side effect.
    """
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=2)
    first, second = payload(call("next_pending_assets", job_id=job_id, count=2))["items"]

    assert _add(job_id, first["id"])["job_started"] is True
    assert _add(job_id, second["id"])["job_started"] is False


def test_marking_an_asset_starts_a_pending_job_and_says_so(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Skipping is a write too: deciding there is nothing to label is doing the work."""
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    asset_id = payload(call("next_pending_assets", job_id=job_id, count=1))["items"][0]["id"]
    marked = payload(
        call("set_asset_progress", job_id=job_id, asset_id=asset_id, progress="skipped")
    )
    assert marked["job_started"] is True
    assert payload(call("get_job", job_id=job_id))["state"] == "in_progress"


def test_editing_a_seeded_label_starts_the_pending_job_it_belongs_to(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`update_annotations` reaches a `pending` job only here, and that is the point.

    Every other route to an annotation goes through `add_annotations`, which
    starts the job on the way in — so the one job that can be `pending` *and*
    already carry labels is a seeded correction, which is exactly the case an
    edit tool has to handle.
    """
    job_id, asset_id = _seeded_correction(monkeypatch, tmp_path)
    annotation = payload(call("list_asset_annotations", job_id=job_id, asset_id=asset_id))["items"][
        0
    ]
    edited = payload(
        call(
            "update_annotations",
            job_id=job_id,
            annotations=[
                {
                    "id": annotation["id"],
                    "label_class": "sign",
                    "geometry": {"type": "bbox", "x": 3.0, "y": 4.0, "width": 5.0, "height": 5.0},
                    "provenance": "human",
                }
            ],
        )
    )
    assert edited["job_started"] is True
    assert payload(call("get_job", job_id=job_id))["state"] == "in_progress"


def test_deleting_a_seeded_label_starts_the_pending_job_it_belongs_to(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The third write, on the same job shape, for :func:`update_annotations`' reason."""
    job_id, asset_id = _seeded_correction(monkeypatch, tmp_path)
    annotation = payload(call("list_asset_annotations", job_id=job_id, asset_id=asset_id))["items"][
        0
    ]
    removed = payload(call("delete_annotations", job_id=job_id, annotation_ids=[annotation["id"]]))
    assert removed == {"deleted": 1, "job_started": True}
    assert payload(call("get_job", job_id=job_id))["state"] == "in_progress"


def test_a_fully_seeded_job_can_be_closed_with_no_edits_at_all(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The case that decided `complete_job` auto-starts too (#109).

    A correction batch over labeled assets opens fully *settled* — every asset
    done, nothing to write, and `BatchService.approve`'s own docstring says it
    "can be completed with no edits at all". No write tool is ever reached, so
    nothing else could have started it, and without this the job would be
    unclosable over MCP now that `start_job` is gone.
    """
    job_id, _ = _seeded_correction(monkeypatch, tmp_path)
    job = payload(call("get_job", job_id=job_id))
    assert job["state"] == "pending"
    assert (job["progress"]["annotated"], job["progress"]["unannotated"]) == (1, 0)

    closed = payload(call("complete_job", job_id=job_id))
    assert closed["state"] == "completed"
    assert closed["job_started"] is True


def test_a_write_into_a_completed_job_starts_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Only `pending` moves. A closed job stays closed, and the write still lands.

    Writing here is legal — the gate is the batch, and its batch is still
    `in_annotation` — so this is the state where a naive "start it if it is not
    `in_progress`" would drag a finished job backwards. `JOB_TRANSITIONS` has no
    such edge, and the guard never asks it to: it checks for `pending` rather
    than catching an `InvalidTransition` and carrying on.
    """
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    asset_id = payload(call("next_pending_assets", job_id=job_id, count=1))["items"][0]["id"]
    _annotate(job_id, asset_id)
    assert payload(call("complete_job", job_id=job_id))["state"] == "completed"

    assert _add(job_id, asset_id)["job_started"] is False
    assert payload(call("get_job", job_id=job_id))["state"] == "completed"


def test_the_retired_start_job_is_not_advertised() -> None:
    """#109: the ceremony is absorbed, so the verb is gone rather than optional."""
    assert "start_job" not in tool_schemas()


def test_complete_job_no_longer_tells_an_agent_to_start_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """What #36's two-way test protected, held by the description that survives.

    That test asserted `start_job` and `complete_job` each named the other, so an
    agent reaching either first learned the loop had two ends. There is one end
    now, and the protection it owed — never leaving a reader to discover the
    start requirement from a refusal — is owed by `complete_job` alone: it has to
    say the start is not the caller's to make.
    """
    described = tool_schemas()["complete_job"].description or ""
    assert "start_job" not in described
    assert "job_started" in described
    assert "do not have to start" in described


def test_get_job_says_which_id_it_takes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """`ingest` also answers with an id, and it is not this one."""
    described = tool_schemas()["get_job"].description or ""
    assert "approve_batch" in described
    assert "ingest_job_id" in described


def test_skipping_an_asset_settles_it_without_writing_anything(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    asset_id = payload(call("next_pending_assets", job_id=job_id, count=1))["items"][0]["id"]
    marked = payload(
        call("set_asset_progress", job_id=job_id, asset_id=asset_id, progress="skipped")
    )
    assert marked == {"asset_id": asset_id, "progress": "skipped", "job_started": True}
    assert payload(call("complete_job", job_id=job_id))["state"] == "completed"


def test_writing_an_annotation_moves_its_asset_on_its_own(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
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
    """And the auto-start does not get in front of that gate (#109).

    A job in an `approved` batch is `pending`, which is the state the auto-start
    moves — so the batch gate is the one thing standing between a closed batch
    and a job silently marked as being worked on. `autostarted` goes through
    `JobService.start`, which asks `require_open_batch` first, so the refusal is
    the same sentence and nothing moved.
    """
    _, batch_id = ingested(monkeypatch, tmp_path, count=1)
    approved = payload(call("approve_batch", batch_id=batch_id))
    job_id = approved["jobs"][0]["id"]
    asset_id = payload(call("list_batch_assets", batch_id=batch_id))["items"][0]["id"]

    for refusal in (
        error(call("set_asset_progress", job_id=job_id, asset_id=asset_id, progress="skipped")),
        error(call("complete_job", job_id=job_id)),
        error(
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
        ),
    ):
        assert "no work happens in a batch nobody opened" in refusal["message"]

    assert payload(call("get_job", job_id=job_id))["state"] == "pending"


def test_an_asset_that_is_not_in_the_job_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from uuid import uuid4

    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1)
    refusal = error(
        call("set_asset_progress", job_id=job_id, asset_id=str(uuid4()), progress="skipped")
    )
    assert refusal["message"]
