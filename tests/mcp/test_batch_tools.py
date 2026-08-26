"""The batch lifecycle, the two listings, and promotion into the trunk."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.fixtures.media import write_images
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
    project,
    schema,
)

from visionset.inference import prelabel as prelabel_module
from visionset.kernel.domain import (
    AssetPrediction,
    BboxGeometry,
    GeometryType,
    ModelCapability,
    PolygonGeometry,
    PredictedRegion,
    ServedFamily,
)


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


# --- approve with start, complete with promote --------------------------------


def test_approving_with_start_opens_the_batch_and_says_so(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)

    approved = payload(call("approve_batch", batch_id=batch_id, start=True))

    assert approved["state"] == "in_annotation"
    assert approved["started"] is True
    assert approved["schema_version"] == 1
    assert [j["state"] for j in approved["jobs"]] == ["pending"]
    assert payload(call("get_batch", batch_id=batch_id))["state"] == "in_annotation"


def test_approving_without_start_reports_that_nothing_was_started(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)
    approved = payload(call("approve_batch", batch_id=batch_id))
    assert approved["state"] == "approved"
    assert approved["started"] is False


def test_approving_with_start_and_no_schema_refuses_and_leaves_a_draft(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    write_images(tmp_path / "incoming", count=1)
    batch_id = payload(call("ingest", project=named, path=str(tmp_path / "incoming")))["batch_id"]

    refusal = error(call("approve_batch", batch_id=batch_id, start=True))

    assert "schema" in refusal["message"]
    assert payload(call("get_batch", batch_id=batch_id))["state"] == "draft"


def _finished(job_id: str) -> None:
    """Every asset of the job marked ``annotated`` and the job closed."""
    for asset in payload(call("next_pending_assets", job_id=job_id, count=100))["items"]:
        payload(
            call("set_asset_progress", job_id=job_id, asset_id=asset["id"], progress="annotated")
        )
    payload(call("complete_job", job_id=job_id))


def test_completing_with_promote_fills_the_trunk_and_counts_what_moved(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=2)
    _finished(job_id)

    completed = payload(call("complete_batch", batch_id=batch_id, promote=True))

    assert completed["state"] == "completed"
    assert completed["promoted"] == 2
    assert completed["promoted_asset_count"] == 2
    assert payload(call("promote_batch", batch_id=batch_id)) == {"items": [], "total": 0}


def test_completing_without_promote_moves_nothing_into_the_trunk(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=2)
    _finished(job_id)

    completed = payload(call("complete_batch", batch_id=batch_id))

    assert completed["state"] == "completed"
    assert completed["promoted"] == 0
    assert completed["promoted_asset_count"] == 0


def test_completing_with_promote_over_assets_already_in_the_trunk_counts_zero(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Promotion has no refusal of its own once `complete` has succeeded — `promote`
    needs only `completed` — so the outcome left to pin is the idempotent one: a
    second batch over assets the trunk already holds closes, and `promoted` is
    zero rather than an error."""
    named, first, job_id = open_batch(monkeypatch, tmp_path, count=2)
    _finished(job_id)
    payload(call("complete_batch", batch_id=first, promote=True))
    again = payload(call("ingest", project=named, path=str(tmp_path / "incoming")))
    second = str(again["batch_id"])
    opened = payload(call("approve_batch", batch_id=second, start=True))
    _finished(str(opened["jobs"][0]["id"]))

    completed = payload(call("complete_batch", batch_id=second, promote=True))

    assert completed["state"] == "completed"
    assert completed["promoted"] == 0
    assert completed["promoted_asset_count"] == 2


def test_completing_with_promote_while_a_job_is_outstanding_promotes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _ = open_batch(monkeypatch, tmp_path, count=2)
    assert error(call("complete_batch", batch_id=batch_id, promote=True))["message"]
    read = payload(call("get_batch", batch_id=batch_id))
    assert read["state"] == "in_annotation"
    assert read["promoted_asset_count"] == 0


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


# --- pre-labeling: blocks, and answers with what it wrote ---------------------


class _FakePredictor:
    """A `ModelProvider` that answers from a script, structurally conforming to
    the port `pre_label` narrows to — `tests/inference/test_prelabel.py`'s
    `FakeModelProvider`, minimal for this file's own purpose."""

    def __init__(self, *, model_ref: str, regions: tuple[PredictedRegion, ...]) -> None:
        self.model_ref = model_ref
        self._regions = regions

    def predict(self, request: object) -> object:
        return (
            AssetPrediction(
                asset_id=target.asset_id, model_ref=self.model_ref, regions=self._regions
            )
            for target in request.targets  # type: ignore[attr-defined]
        )


class _FakeSegmenter:
    """Structurally a point segmenter and nothing a text prompt could reach: no
    `predict` at all, which is what makes `isinstance(runner, ModelProvider)`
    false and lets `pre_label` refuse it before this is ever asked anything."""


class _FakePool:
    def __init__(
        self, runner: object, *, produces: frozenset[GeometryType] = frozenset({GeometryType.BBOX})
    ) -> None:
        self._runner = runner
        self._produces = produces

    def get(self, connection: object, *, workspace_root: Path) -> object:
        return self._runner

    def served(self, connection: object, *, workspace_root: Path) -> ServedFamily:
        if isinstance(self._runner, _FakeSegmenter):
            return ServedFamily(
                capability=ModelCapability.POINT_SUGGEST, produces=frozenset({GeometryType.POLYGON})
            )
        return ServedFamily(capability=ModelCapability.TEXT_DETECT, produces=self._produces)


def _predicting(
    monkeypatch: pytest.MonkeyPatch,
    *,
    kind: str = "detector",
    label: str = "sign",
    both_shapes: bool = False,
) -> None:
    """Stand in for what a connection resolves to, the way `pre_label`'s own
    kernel suite does through its `pool` parameter — the MCP tool exposes no
    such parameter, since an agent has no business choosing a fake one, so this
    reaches the same seam through the module-level pool `pre_label` asks for
    when none is passed.

    ``both_shapes`` makes it a model declaring a box and a polygon and answering
    one of each per asset — the shape a geometry selection is about.
    """
    regions = (
        PredictedRegion(
            label=label, confidence=0.9, geometry=BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0)
        ),
    )
    if both_shapes:
        regions += (
            PredictedRegion(
                label=label,
                confidence=0.8,
                geometry=PolygonGeometry(points=[(1.0, 1.0), (5.0, 1.0), (5.0, 5.0)]),
            ),
        )
    runner = (
        _FakeSegmenter()
        if kind == "segmenter"
        else _FakePredictor(model_ref="acme/detector@abc123", regions=regions)
    )
    produces = (
        frozenset({GeometryType.BBOX, GeometryType.POLYGON})
        if both_shapes
        else frozenset({GeometryType.BBOX})
    )
    monkeypatch.setattr(prelabel_module, "resident", lambda: _FakePool(runner, produces=produces))


def _connection() -> str:
    """A configured local connection. Nothing here downloads its weights: the
    resolution `pre_label` would build a runner from is faked by `_predicting`
    in every test that reaches it, so a connection only has to exist."""
    created = payload(
        call(
            "create_inference_connection",
            name=f"c-{uuid4().hex[:8]}",
            connection_type="local",
            model_id="some/grounding-dino",
            model_revision="v1",
            device="cpu",
            precision="fp32",
        )
    )
    return str(created["id"])


#: A schema a run can only partly ask for: one class a box can be written as,
#: one that admits no box, and one failing both tests at once. The partial case
#: is the one the plan exists for — the total one is already refused.
MIXED_CLASSES: list[dict[str, Any]] = [
    {"name": "sign", "geometries": ["bbox"]},
    {"name": "centerline", "geometries": ["polyline"]},
    {
        "name": "crossing",
        "geometries": ["polygon"],
        "attributes": [{"name": "painted", "kind": "boolean", "required": True}],
    },
]


def test_pre_labeling_blocks_and_returns_what_it_wrote(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=2)
    connection_id = _connection()
    _predicting(monkeypatch, label="sign")

    outcome = payload(call("pre_label_batch", batch_id=batch_id, connection=connection_id))

    assert outcome["annotations_written"] == 2
    assert outcome["items"] == [
        {
            "job_id": job_id,
            "assets_considered": 2,
            "assets_labeled": 2,
            "annotations_written": 2,
            "annotations_replaced": 0,
            "model_ref": "acme/detector@abc123",
            "assets_skipped": 0,
            "regions_discarded": 0,
            "regions_out_of_bounds": 0,
            "plan": {
                "schema_version": 1,
                "asked_classes": ["sign"],
                "produces": ["bbox"],
                "excluded_classes": [],
            },
        }
    ]
    assert payload(call("get_batch", batch_id=batch_id))["progress"]["pre_labeled"] == 2


def test_pre_labeling_a_batch_runs_one_item_per_open_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=4)
    approved = payload(call("approve_batch", batch_id=batch_id, jobs_of=2))
    job_ids = [j["id"] for j in approved["jobs"]]
    payload(call("start_batch", batch_id=batch_id))
    connection_id = _connection()
    _predicting(monkeypatch, label="sign")

    outcome = payload(call("pre_label_batch", batch_id=batch_id, connection=connection_id))

    assert len(job_ids) == 2
    assert {item["job_id"] for item in outcome["items"]} == set(job_ids)
    assert outcome["annotations_written"] == sum(
        item["annotations_written"] for item in outcome["items"]
    )
    assert outcome["annotations_written"] == 4


def test_pre_labeling_a_batch_with_no_open_job_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=1)
    asset_id = payload(call("list_batch_assets", batch_id=batch_id))["items"][0]["id"]
    payload(call("set_asset_progress", job_id=job_id, asset_id=asset_id, progress="skipped"))
    payload(call("complete_job", job_id=job_id))
    connection_id = _connection()

    outcome = payload(call("pre_label_batch", batch_id=batch_id, connection=connection_id))

    assert outcome == {"items": [], "annotations_written": 0}


def test_a_replacing_run_rewrites_the_frames_the_first_run_labeled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2)
    connection_id = _connection()
    _predicting(monkeypatch, label="sign")
    call("pre_label_batch", batch_id=batch_id, connection=connection_id)

    again = payload(
        call(
            "pre_label_batch",
            batch_id=batch_id,
            connection=connection_id,
            replace_model_labels=True,
        )
    )

    item = again["items"][0]
    assert item["assets_considered"] == 2
    assert item["annotations_written"] == 2
    assert item["annotations_replaced"] == 2
    assert payload(call("get_batch", batch_id=batch_id))["progress"]["pre_labeled"] == 2


def test_a_run_that_labeled_nothing_says_what_it_asked_about(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The counters alone are the silence this key exists to end.

    The model answers `centerline`, which the prompt never asked for, so every
    region is discarded and nothing is labeled. An agent reading only
    `assets_labeled: 0` cannot tell that from a model that found nothing; the
    prompt beside it is what makes the two distinguishable without a second call.
    """
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2, classes=MIXED_CLASSES)
    connection_id = _connection()
    _predicting(monkeypatch, label="centerline")

    outcome = payload(call("pre_label_batch", batch_id=batch_id, connection=connection_id))
    item = outcome["items"][0]

    assert item["assets_labeled"] == 0
    assert item["plan"]["asked_classes"] == ["sign"]
    assert item["plan"]["excluded_classes"] == [
        {"name": "centerline", "reasons": ["no_producible_geometry"]},
        {"name": "crossing", "reasons": ["no_producible_geometry", "required_attribute"]},
    ]


def test_the_plan_names_the_prompt_and_every_class_left_out_of_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Both halves, in the schema's own order, and both reasons where both hold.

    `crossing` carries two: an agent told only that it admits no box would add
    one and watch the class stay absent from the next run's prompt.
    """
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2, classes=MIXED_CLASSES)
    connection_id = _connection()
    _predicting(monkeypatch)

    plan = payload(call("get_pre_label_plan", batch_id=batch_id, connection=connection_id))

    assert plan == {
        "schema_version": 1,
        "asked_classes": ["sign"],
        "produces": ["bbox"],
        "excluded_classes": [
            {"name": "centerline", "reasons": ["no_producible_geometry"]},
            {"name": "crossing", "reasons": ["no_producible_geometry", "required_attribute"]},
        ],
    }


def test_the_plan_runs_no_model(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2)
    connection_id = _connection()
    _predicting(monkeypatch)
    plan = payload(call("get_pre_label_plan", batch_id=batch_id, connection=connection_id))
    assert plan["asked_classes"] == ["sign"]
    assert plan["produces"] == ["bbox"]
    assert payload(call("get_batch", batch_id=batch_id))["progress"]["pre_labeled"] == 0


def test_the_plan_refuses_a_point_prompt_connection(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2)
    connection_id = _connection()
    _predicting(monkeypatch, kind="segmenter")
    refusal = error(call("get_pre_label_plan", batch_id=batch_id, connection=connection_id))
    assert "answers places rather than words" in refusal["message"]


def test_the_plan_refuses_a_schema_with_no_box_class(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Refused rather than answered with an empty prompt.

    Pre-labeling this batch is impossible rather than merely unproductive, and
    the run refuses with the same sentence — so an agent gets one answer from
    both tools instead of an empty list from one and a refusal from the other.
    """
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2, classes=[CENTERLINE])
    connection_id = _connection()
    _predicting(monkeypatch)

    refusal = error(call("get_pre_label_plan", batch_id=batch_id, connection=connection_id))

    assert "no class that a box can be written as" in refusal["message"]


def test_the_plan_refuses_a_batch_that_is_not_being_annotated(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)
    connection_id = _connection()
    _predicting(monkeypatch)

    refusal = error(call("get_pre_label_plan", batch_id=batch_id, connection=connection_id))

    assert refusal["message"]


def test_a_batch_that_is_not_being_annotated_is_refused_and_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=2)
    connection_id = _connection()
    _predicting(monkeypatch, label="sign")

    refusal = error(call("pre_label_batch", batch_id=batch_id, connection=connection_id))

    assert refusal["message"]


def test_a_point_prompt_connection_is_refused_before_anything_is_asked(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2)
    connection_id = _connection()
    _predicting(monkeypatch, kind="segmenter")

    refusal = error(call("pre_label_batch", batch_id=batch_id, connection=connection_id))

    assert refusal["message"]
    assert payload(call("get_batch", batch_id=batch_id))["progress"]["review_pending"] == 0


def test_a_schema_with_no_box_class_is_refused_and_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2, classes=[CENTERLINE])
    connection_id = _connection()
    _predicting(monkeypatch, label="sign")

    refusal = error(call("pre_label_batch", batch_id=batch_id, connection=connection_id))

    # The same sentence the plan tool refuses with, which is what makes one
    # answer out of two tools a property a reader can check rather than a claim.
    assert "no class that a box can be written as" in refusal["message"]
    assert payload(call("get_batch", batch_id=batch_id))["progress"]["review_pending"] == 0


#: A class admitting both shapes a two-shape model answers in, beside one only
#: a polygon could land on — what a boxes-only selection leaves out.
BOTH_SHAPES_CLASSES: list[dict[str, Any]] = [
    {"name": "sign", "geometries": ["bbox", "polygon"]},
    {"name": "lane", "geometries": ["polygon"]},
]


def test_the_plan_reports_the_selected_shapes_and_what_they_leave_out(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2, classes=BOTH_SHAPES_CLASSES)
    connection_id = _connection()
    _predicting(monkeypatch, both_shapes=True)

    every = payload(call("get_pre_label_plan", batch_id=batch_id, connection=connection_id))
    boxes = payload(
        call(
            "get_pre_label_plan",
            batch_id=batch_id,
            connection=connection_id,
            geometries=["bbox"],
        )
    )

    assert every["produces"] == ["bbox", "polygon"]
    assert every["asked_classes"] == ["sign", "lane"]
    assert boxes["produces"] == ["bbox"]
    assert boxes["asked_classes"] == ["sign"]
    assert boxes["excluded_classes"] == [{"name": "lane", "reasons": ["no_producible_geometry"]}]


def test_a_selection_writes_only_those_shapes_and_the_run_reports_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The round trip: `geometries` on the tool reaches the run, so a model
    answering a box and a polygon per asset writes the boxes and counts the
    polygons as discarded — and omitted, it writes both."""
    project, batch_id, _job = open_batch(
        monkeypatch, tmp_path, count=2, classes=BOTH_SHAPES_CLASSES
    )
    connection_id = _connection()
    _predicting(monkeypatch, both_shapes=True)

    outcome = payload(
        call("pre_label_batch", batch_id=batch_id, connection=connection_id, geometries=["bbox"])
    )
    item = outcome["items"][0]

    assert outcome["annotations_written"] == 2
    assert item["regions_discarded"] == 2
    assert item["plan"]["produces"] == ["bbox"]
    assert item["plan"]["asked_classes"] == ["sign"]

    other = _another_open_batch(monkeypatch, tmp_path, project)
    unselected = payload(call("pre_label_batch", batch_id=other, connection=connection_id))
    unselected_item = unselected["items"][0]
    assert unselected["annotations_written"] == 4
    assert unselected_item["regions_discarded"] == 0
    assert unselected_item["plan"]["produces"] == ["bbox", "polygon"]


def test_a_selection_outside_what_the_model_produces_is_refused_and_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _job = open_batch(monkeypatch, tmp_path, count=2)
    connection_id = _connection()
    _predicting(monkeypatch)

    plan = error(
        call(
            "get_pre_label_plan",
            batch_id=batch_id,
            connection=connection_id,
            geometries=["polygon"],
        )
    )
    run = error(
        call("pre_label_batch", batch_id=batch_id, connection=connection_id, geometries=["polygon"])
    )

    # One sentence from both tools, and it names both sides: what was asked
    # for and what the model does answer in.
    assert plan["message"] == run["message"]
    assert "does not answer in a polygon" in run["message"]
    assert "only a box" in run["message"]
    assert payload(call("get_batch", batch_id=batch_id))["progress"]["pre_labeled"] == 0


def test_the_batch_declares_pre_label_only_while_in_annotation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project, batch_id = ingested(monkeypatch, tmp_path, count=2)
    assert "pre_label" not in payload(call("get_batch", batch_id=batch_id))["allowed_actions"]

    payload(call("approve_batch", batch_id=batch_id))
    payload(call("start_batch", batch_id=batch_id))

    assert "pre_label" in payload(call("get_batch", batch_id=batch_id))["allowed_actions"]


def test_listing_batch_assets_can_narrow_by_progress_and_order_by_confidence(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, job_id = open_batch(monkeypatch, tmp_path, count=3)
    ids = [a["id"] for a in payload(call("list_batch_assets", batch_id=batch_id))["items"]]
    payload(call("set_asset_progress", job_id=job_id, asset_id=ids[2], progress="skipped"))

    narrowed = payload(call("list_batch_assets", batch_id=batch_id, progress=["skipped"]))
    assert (narrowed["total"], [a["id"] for a in narrowed["items"]]) == (1, [ids[2]])

    ordered = payload(call("list_batch_assets", batch_id=batch_id, sort="confidence"))
    assert [a["id"] for a in ordered["items"]] == ids
    assert {a["annotation_count"] for a in ordered["items"]} == {0}
    assert {a["min_confidence"] for a in ordered["items"]} == {None}


def test_an_unknown_sort_or_progress_value_is_a_malformed_request(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # `sort` and `progress` are typed on the domain enums, `set_asset_progress`'s
    # `progress` idiom: the tool's inputSchema advertises the legal values and
    # the MCP boundary itself refuses an unknown one before the body runs, so
    # there is no manual parsing here to raise a bare traceback instead.
    _, batch_id, _ = open_batch(monkeypatch, tmp_path, count=2)

    bad_sort = call("list_batch_assets", batch_id=batch_id, sort="size")
    assert bad_sort.is_error
    assert "confidence" in bad_sort.content[0].text

    bad_progress = call("list_batch_assets", batch_id=batch_id, progress=["nope"])
    assert bad_progress.is_error
    assert "annotated" in bad_progress.content[0].text


def test_an_empty_progress_list_means_no_filter(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id, _ = open_batch(monkeypatch, tmp_path, count=2)
    assert payload(call("list_batch_assets", batch_id=batch_id, progress=[]))["total"] == 2


def test_a_job_filter_lists_only_that_jobs_assets(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, batch_id = ingested(monkeypatch, tmp_path, count=4)
    approved = payload(call("approve_batch", batch_id=batch_id, jobs_of=2))
    payload(call("start_batch", batch_id=batch_id))
    first = approved["jobs"][0]["id"]

    listed = payload(call("list_batch_assets", batch_id=batch_id, job_id=first))

    assert listed["total"] == 2
    assert {a["job_id"] for a in listed["items"]} == {first}


# --- pre-labeling a project: the batch, fanned out ----------------------------


def _another_open_batch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, project: str) -> str:
    incoming = tmp_path / "more"
    write_images(incoming, count=2, first_seed=100)
    created = payload(call("ingest", project=project, path=str(incoming)))
    batch_id = str(created["batch_id"])
    payload(call("approve_batch", batch_id=batch_id))
    payload(call("start_batch", batch_id=batch_id))
    return batch_id


def test_pre_labeling_a_project_runs_every_open_batch_and_reports_each(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project, first, job_id = open_batch(monkeypatch, tmp_path, count=2)
    second = _another_open_batch(monkeypatch, tmp_path, project)
    connection_id = _connection()
    _predicting(monkeypatch, label="sign")

    outcome = payload(call("pre_label_project", project=project, connection=connection_id))

    assert [item["batch_id"] for item in outcome["items"]] == [first, second]
    assert outcome["items"][0]["job_id"] == job_id
    assert all(item["annotations_written"] == 2 for item in outcome["items"])
    assert all(item["plan"]["asked_classes"] == ["sign"] for item in outcome["items"])
    assert outcome["annotations_written"] == 4
    assert payload(call("get_batch", batch_id=second))["progress"]["pre_labeled"] == 2


def test_pre_labeling_a_project_narrows_to_the_named_batches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project, first, _job = open_batch(monkeypatch, tmp_path, count=2)
    second = _another_open_batch(monkeypatch, tmp_path, project)
    connection_id = _connection()
    _predicting(monkeypatch, label="sign")

    outcome = payload(
        call("pre_label_project", project=project, connection=connection_id, batch_ids=[second])
    )

    assert [item["batch_id"] for item in outcome["items"]] == [second]
    assert payload(call("get_batch", batch_id=first))["progress"]["pre_labeled"] == 0


def test_pre_labeling_a_project_carries_the_selection_to_every_batch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project, first, job_id = open_batch(monkeypatch, tmp_path, count=2, classes=BOTH_SHAPES_CLASSES)
    second = _another_open_batch(monkeypatch, tmp_path, project)
    connection_id = _connection()
    _predicting(monkeypatch, both_shapes=True)

    outcome = payload(
        call("pre_label_project", project=project, connection=connection_id, geometries=["bbox"])
    )

    assert [item["batch_id"] for item in outcome["items"]] == [first, second]
    assert outcome["items"][0]["job_id"] == job_id
    assert all(item["annotations_written"] == 2 for item in outcome["items"])
    assert all(item["regions_discarded"] == 2 for item in outcome["items"])
    assert all(item["plan"]["produces"] == ["bbox"] for item in outcome["items"])


def test_pre_labeling_a_project_refuses_a_selection_outside_what_the_model_produces(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project, first, _job = open_batch(monkeypatch, tmp_path, count=2)
    connection_id = _connection()
    _predicting(monkeypatch)

    refusal = error(
        call("pre_label_project", project=project, connection=connection_id, geometries=["polygon"])
    )

    assert "does not answer in a polygon" in refusal["message"]
    assert payload(call("get_batch", batch_id=first))["progress"]["pre_labeled"] == 0


def test_pre_labeling_a_project_with_no_open_batch_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project, _batch = ingested(monkeypatch, tmp_path, count=2)
    connection_id = _connection()
    _predicting(monkeypatch, label="sign")

    refusal = error(call("pre_label_project", project=project, connection=connection_id))

    assert "has no batch open for annotation" in refusal["message"]
