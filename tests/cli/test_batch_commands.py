"""``visionset batch`` — the one-way lifecycle, and the gate into the trunk."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest
from tests.cli._flow import (
    RENDERING,
    completed_batch,
    ingested_batch,
    jobs_of,
    ok,
    payload,
    plain,
    project,
    run,
    runner,
    started_batch,
    stills,
    workspace,
)
from tests.fixtures.media import write_images

from visionset.cli import batches as batch_commands
from visionset.cli.main import app
from visionset.inference import DEFAULT_MINIMUM_CONFIDENCE, PreLabelExclusionReason
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
from visionset.kernel.services import (
    WORKSPACE_ENV_VAR,
    DatasetService,
    ProjectService,
    WorkspaceService,
)


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return workspace(tmp_path)


def _trunk_size(root: Path, name: str) -> int:
    with WorkspaceService.open(root) as service:
        project = ProjectService(service).get_by_name(name)
        dataset = ProjectService(service).get_dataset(project.id)
        return len(DatasetService(service).assets(dataset.id))


class _FakePredictor:
    """A detector that returns one confident sign box for every requested asset —
    and, asked to, a sign polygon beside it."""

    def __init__(self, *, both_shapes: bool = False) -> None:
        self.minimum_confidences: list[float] = []
        self._both_shapes = both_shapes

    def predict(self, request: object) -> object:
        self.minimum_confidences.append(request.minimum_confidence)  # type: ignore[attr-defined]
        regions = (
            PredictedRegion(
                label="sign",
                confidence=0.9,
                geometry=BboxGeometry(x=1.0, y=2.0, width=3.0, height=4.0),
            ),
        )
        if self._both_shapes:
            regions += (
                PredictedRegion(
                    label="sign",
                    confidence=0.8,
                    geometry=PolygonGeometry(points=[(1.0, 1.0), (5.0, 1.0), (5.0, 5.0)]),
                ),
            )
        return (
            AssetPrediction(
                asset_id=target.asset_id, model_ref="acme/detector@abc123", regions=regions
            )
            for target in request.targets  # type: ignore[attr-defined]
        )


class _FakePool:
    def __init__(self, predictor: _FakePredictor, *, produces: frozenset[GeometryType]) -> None:
        self._predictor = predictor
        self._produces = produces

    def get(self, connection: object, *, workspace_root: Path) -> object:
        return self._predictor

    def served(self, connection: object, *, workspace_root: Path) -> ServedFamily:
        return ServedFamily(capability=ModelCapability.TEXT_DETECT, produces=self._produces)


@pytest.fixture()
def predicting(monkeypatch: pytest.MonkeyPatch) -> _FakePredictor:
    """Replace the process-wide pool at the seam the shared operation resolves."""
    predictor = _FakePredictor()
    monkeypatch.setattr(
        prelabel_module,
        "resident",
        lambda: _FakePool(predictor, produces=frozenset({GeometryType.BBOX})),
    )
    return predictor


@pytest.fixture()
def predicting_both_shapes(monkeypatch: pytest.MonkeyPatch) -> _FakePredictor:
    """The same seam, serving a model that declares a box and a polygon and
    answers one of each per asset — what `--geometry` chooses between."""
    predictor = _FakePredictor(both_shapes=True)
    monkeypatch.setattr(
        prelabel_module,
        "resident",
        lambda: _FakePool(predictor, produces=frozenset({GeometryType.BBOX, GeometryType.POLYGON})),
    )
    return predictor


def _connection(root: Path) -> str:
    """Create the local connection through the public CLI command."""
    return str(
        payload(
            root,
            "inference",
            "create",
            "detector",
            "--type",
            "local",
            "--model",
            "acme/detector",
            "--revision",
            "abc123",
            "--device",
            "cpu",
            "--precision",
            "fp32",
        )["id"]
    )


# --- list --------------------------------------------------------------------


def test_list_leads_with_the_id_and_names_the_state(root: Path, tmp_path: Path) -> None:
    name, batch = ingested_batch(root, tmp_path)
    rows = ok(root, "batch", "list", "-p", name).splitlines()
    assert rows[0].split() == ["ID", "NAME", "STATE", "SCHEMA", "ASSETS", "ANNOTATED", "SETTLED"]
    assert rows[1].split()[:5] == [batch, "stills", "draft", "-", "6"]


def test_settled_counts_the_settled_states_and_not_everything_touched(
    root: Path, tmp_path: Path
) -> None:
    """SETTLED is the kernel's ``SETTLED_PROGRESS``, not "anything but unannotated".

    The column was ``sum(counts) - unannotated``, which promoted every state
    somebody had merely reached. An asset awaiting review has outstanding work by
    the kernel's own definition — it is what stops a job completing — and it was
    reported as done.
    """
    name, batch = started_batch(root, tmp_path)
    job = jobs_of(root, batch)[0]
    ok(root, "job", "start", job)
    listing = ok(root, "job", "next", job, "-n", "100").splitlines()[1:]
    assets = [line.split()[0] for line in listing]
    ok(root, "job", "mark", job, assets[0], "--progress", "annotated")
    ok(root, "job", "mark", job, assets[1], "--progress", "annotated")
    ok(root, "job", "mark", job, assets[1], "--progress", "review_pending")
    ok(root, "job", "mark", job, assets[2], "--progress", "skipped")

    row = ok(root, "batch", "list", "-p", name).splitlines()[1].split()
    # One annotated and one skipped. The frame awaiting review is not settled,
    # and neither are the three nobody has opened.
    assert row[-1] == "2", row


def test_a_draft_shows_no_pinned_schema(root: Path, tmp_path: Path) -> None:
    # Approval is what pins a version, and it never moves after — so a draft
    # showing one would be a claim nothing supports.
    name, _ = ingested_batch(root, tmp_path)
    assert payload(root, "batch", "list", "-p", name)["items"][0]["schema_version"] is None


def test_list_json_carries_the_progress_counts(root: Path, tmp_path: Path) -> None:
    name, _ = started_batch(root, tmp_path)
    progress = payload(root, "batch", "list", "-p", name)["items"][0]["progress"]
    assert progress == {
        "unannotated": 6,
        "pre_labeled": 0,
        "annotated": 0,
        "skipped": 0,
        "review_pending": 0,
        "accepted": 0,
        "total": 6,
    }


def test_an_empty_listing_still_prints_its_header(root: Path, tmp_path: Path) -> None:
    ok(root, "project", "create", "empty")
    result = run(root, "batch", "list", "-p", "empty")
    assert len(result.stdout.splitlines()) == 1
    assert "no batches yet" in result.stderr


# --- approve -----------------------------------------------------------------


def test_approve_with_no_flag_cuts_one_job(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    result = run(root, "batch", "approve", batch)
    assert result.exit_code == 0, result.output
    assert "in 1 job(s)" in result.stderr
    assert len(jobs_of(root, batch)) == 1


def test_jobs_of_cuts_by_size(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    ok(root, "batch", "approve", batch, "--jobs-of", "3")
    assert len(jobs_of(root, batch)) == 2


def test_the_last_job_takes_the_remainder(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    ok(root, "batch", "approve", batch, "--jobs-of", "4")
    sizes = [
        int(line.split()[2]) for line in ok(root, "job", "list", "--batch", batch).splitlines()[1:]
    ]
    assert sizes == [4, 2]


def test_approve_pins_the_active_schema_version(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    assert payload(root, "batch", "approve", batch)["schema_version"] == 1


def test_jobs_of_zero_exits_two(root: Path, tmp_path: Path) -> None:
    # ``BySize.size`` is ``gt=0`` and a pydantic error would print a traceback,
    # so Click's ``min=1`` has to catch it first.
    _, batch = ingested_batch(root, tmp_path)
    result = run(root, "batch", "approve", batch, "--jobs-of", "0")
    assert result.exit_code == 2, result.output


def test_approving_twice_exits_one(root: Path, tmp_path: Path) -> None:
    # One-way: there is no route back to draft, because the jobs are already cut
    # against the pin.
    _, batch = ingested_batch(root, tmp_path)
    ok(root, "batch", "approve", batch)
    assert run(root, "batch", "approve", batch).exit_code == 1


def test_a_malformed_batch_id_exits_two(root: Path) -> None:
    # Click's ``UUID`` type, and the same call the API makes: a malformed id is
    # 422 rather than 404, because the request could not have named anything.
    assert run(root, "batch", "approve", "not-a-uuid").exit_code == 2


def test_an_unknown_batch_id_exits_one(root: Path) -> None:
    assert run(root, "batch", "approve", str(uuid4())).exit_code == 1


# --- start, complete ---------------------------------------------------------


def test_start_opens_an_approved_batch(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    ok(root, "batch", "approve", batch)
    assert payload(root, "batch", "start", batch)["state"] == "in_annotation"


def test_starting_a_draft_exits_one(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    assert run(root, "batch", "start", batch).exit_code == 1


def test_complete_with_an_outstanding_job_exits_one(root: Path, tmp_path: Path) -> None:
    # Derived means recomputed, not automatic.
    _, batch = started_batch(root, tmp_path)
    result = run(root, "batch", "complete", batch)
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


def test_complete_closes_a_finished_batch(root: Path, tmp_path: Path) -> None:
    name, _ = completed_batch(root, tmp_path)
    assert payload(root, "batch", "list", "-p", name)["items"][0]["state"] == "completed"


# --- approve --start ---------------------------------------------------------


def _state(root: Path, name: str, batch: str) -> str:
    listed = {row["id"]: row for row in payload(root, "batch", "list", "-p", name)["items"]}
    return str(listed[batch]["state"])


def test_approve_start_opens_the_batch_and_reports_both_steps(root: Path, tmp_path: Path) -> None:
    name, batch = ingested_batch(root, tmp_path)

    result = run(root, "batch", "approve", batch, "--start")

    assert result.exit_code == 0, result.output
    assert result.stdout == f"{batch}\n"
    assert "Approved batch 'stills' against schema version 1, in 1 job(s)." in result.stderr
    assert f"Batch {batch} is now in_annotation." in result.stderr
    assert _state(root, name, batch) == "in_annotation"


def test_approve_start_json_prints_the_started_batch(root: Path, tmp_path: Path) -> None:
    _, batch = ingested_batch(root, tmp_path)
    document = payload(root, "batch", "approve", batch, "--jobs-of", "3", "--start")
    assert document["id"] == batch
    assert document["state"] == "in_annotation"
    assert document["schema_version"] == 1
    assert len(jobs_of(root, batch)) == 2


def test_approve_start_without_a_schema_refuses_and_leaves_a_draft(
    root: Path, tmp_path: Path
) -> None:
    """The refusal is approve's own: nothing has moved, and the output says so."""
    project(root, "bare")
    batch = ok(root, "ingest", str(stills(tmp_path)), "--project", "bare")

    result = run(root, "batch", "approve", batch, "--start")

    assert result.exit_code == 1, result.output
    assert result.stdout == ""
    assert "Error:" in result.stderr
    assert "in_annotation" not in result.stderr
    assert _state(root, "bare", batch) == "draft"


# --- complete --promote ------------------------------------------------------


def _finish_jobs(root: Path, batch: str) -> None:
    """Every asset of every job marked ``annotated`` and every job closed."""
    for job in jobs_of(root, batch):
        ok(root, "job", "start", job)
        for line in ok(root, "job", "next", job, "-n", "100").splitlines()[1:]:
            ok(root, "job", "mark", job, line.split()[0], "--progress", "annotated")
        ok(root, "job", "complete", job)


def test_complete_promote_closes_the_batch_and_fills_the_trunk(root: Path, tmp_path: Path) -> None:
    name, batch = started_batch(root, tmp_path)
    _finish_jobs(root, batch)

    result = run(root, "batch", "complete", batch, "--promote")

    assert result.exit_code == 0, result.output
    assert result.stdout == f"{batch}\n"
    assert f"Batch {batch} is now completed." in result.stderr
    assert "Promoted 6 asset(s) into the dataset." in result.stderr
    assert _trunk_size(root, name) == 6


def test_complete_promote_json_carries_the_batch_and_the_promoted_page(
    root: Path, tmp_path: Path
) -> None:
    _, batch = started_batch(root, tmp_path)
    _finish_jobs(root, batch)

    document = payload(root, "batch", "complete", batch, "--promote")

    assert document["batch"]["id"] == batch
    assert document["batch"]["state"] == "completed"
    assert document["batch"]["promoted_asset_count"] == 6
    assert document["promoted"]["total"] == 6
    assert len(document["promoted"]["items"]) == 6


def test_complete_promote_over_assets_already_in_the_trunk_promotes_nothing(
    root: Path, tmp_path: Path
) -> None:
    """Promotion has no refusal of its own once `complete` has succeeded — `start`
    needs only `approved` and `promote` only `completed` — so the outcome left to
    pin is the idempotent one: a second batch over assets the trunk already
    holds closes, and the promote step reports zero rather than failing."""
    name, first = completed_batch(root, tmp_path)
    ok(root, "batch", "promote", first)
    second = ok(
        root, "ingest", str(tmp_path / "incoming"), "--project", name, "--batch-name", "again"
    )
    ok(root, "batch", "approve", second, "--start")
    _finish_jobs(root, second)

    result = run(root, "batch", "complete", second, "--promote")

    assert result.exit_code == 0, result.output
    assert f"Batch {second} is now completed." in result.stderr
    assert "Promoted 0 asset(s) into the dataset." in result.stderr
    assert payload(root, "batch", "promote", second) == {"items": [], "total": 0}
    assert _trunk_size(root, name) == 6


def test_complete_promote_with_an_outstanding_job_refuses_and_promotes_nothing(
    root: Path, tmp_path: Path
) -> None:
    name, batch = started_batch(root, tmp_path)

    result = run(root, "batch", "complete", batch, "--promote")

    assert result.exit_code == 1, result.output
    assert result.stdout == ""
    assert "Error:" in result.stderr
    assert _trunk_size(root, name) == 0


def test_batch_help_lists_the_composed_flags() -> None:
    approve = runner.invoke(app, ["batch", "approve", "--help"], env=RENDERING, color=True)
    complete = runner.invoke(app, ["batch", "complete", "--help"], env=RENDERING, color=True)
    assert "--start" in plain(approve.output)
    assert "--promote" in plain(complete.output)


# --- pre-label ---------------------------------------------------------------


def test_pre_label_by_connection_id_writes_every_untouched_asset(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    name, batch = started_batch(root, tmp_path)
    connection = _connection(root)

    result = run(root, "batch", "pre-label", batch, connection)

    assert result.exit_code == 0, result.output
    assert result.stdout == "6\n"
    assert "Pre-labeling 1/6 asset(s)." in result.stderr
    assert "Pre-labeling 6/6 asset(s)." in result.stderr
    assert "Pre-labeled 6 asset(s), wrote 6 annotation(s)." in result.stderr
    assert predicting.minimum_confidences == [DEFAULT_MINIMUM_CONFIDENCE] * 6
    assert payload(root, "batch", "list", "-p", name)["items"][0]["progress"]["pre_labeled"] == 6


def _mixed_schema_batch(root: Path, tmp_path: Path) -> str:
    """A started batch whose pinned schema a run can only partly ask for.

    Two classes a box can be written as, one that admits no box, and one failing
    both tests at once — the ordinary partial case, which the default
    ``SCHEMA_DOCUMENT`` (wholly askable) cannot show.
    """
    document = {
        "classes": [
            {"name": "sign", "geometries": ["bbox"]},
            {"name": "lane", "geometries": ["polygon"]},
            {
                "name": "crossing",
                "geometries": ["polygon"],
                "attributes": [{"name": "painted", "kind": "boolean", "required": True}],
            },
            {"name": "post", "geometries": ["bbox"]},
        ]
    }
    path = tmp_path / "mixed-schema.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    project(root, "crossings")
    ok(root, "schema", "apply", str(path), "--project", "crossings")
    batch = ok(
        root, "ingest", str(stills(tmp_path)), "--project", "crossings", "--batch-name", "stills"
    )
    ok(root, "batch", "approve", batch)
    ok(root, "batch", "start", batch)
    return batch


def test_every_reason_a_class_is_left_out_has_a_sentence() -> None:
    """A reason with no wording would print an empty pair of parentheses.

    The terminal has no build-time exhaustiveness check the way the browser's
    `Record` does, so the vocabulary and its prose are compared here instead.
    """
    assert set(batch_commands._EXCLUSION_PROSE) == set(PreLabelExclusionReason)


def test_pre_label_says_which_classes_it_asks_for(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    """The prompt, before the first forward pass rather than after the silence."""
    _, batch = started_batch(root, tmp_path)

    result = run(root, "batch", "pre-label", batch, _connection(root))

    assert result.exit_code == 0, result.output
    assert "Asking for 1 class(es): sign; what it finds lands as a box." in result.stderr
    assert "Not asking for" not in result.stderr


def test_pre_label_names_every_class_it_leaves_out_and_why(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    """A class absent from the prompt is visibly absent, with the reason beside it.

    `crossing` carries both reasons: told only that it admits no shape this
    model produces, somebody adds one and watches it stay absent from the next
    run.
    """
    batch = _mixed_schema_batch(root, tmp_path)

    result = run(root, "batch", "pre-label", batch, _connection(root))

    assert result.exit_code == 0, result.output
    assert "Asking for 2 class(es): sign, post; what it finds lands as a box." in result.stderr
    assert (
        "Not asking for 2 class(es): lane (no shape this model produces); "
        "crossing (no shape this model produces, requires an attribute a prediction "
        "cannot supply)." in result.stderr
    )


def test_pre_label_json_emits_the_complete_outcome(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    _, batch = started_batch(root, tmp_path)

    body = payload(root, "batch", "pre-label", batch, _connection(root))

    assert body["items"][0] == {
        "job_id": jobs_of(root, batch)[0],
        "assets_considered": 6,
        "assets_labeled": 6,
        "annotations_written": 6,
        "annotations_replaced": 0,
        "model_ref": "acme/detector@abc123",
        "stopped_early": False,
        "assets_skipped": 0,
        "regions_discarded": 0,
        "regions_out_of_bounds": 0,
    }


def test_batch_pre_label_json_reports_one_item_per_job(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    _, batch = started_batch(root, tmp_path)
    job = jobs_of(root, batch)[0]

    body = payload(root, "batch", "pre-label", batch, _connection(root))

    assert [item["job_id"] for item in body["items"]] == [job]
    assert body["annotations_written"] == body["items"][0]["annotations_written"]


def test_batch_pre_label_runs_a_job_at_a_time_across_two_jobs(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    _, batch = started_batch(root, tmp_path, jobs_of=3)
    jobs = jobs_of(root, batch)

    body = payload(root, "batch", "pre-label", batch, _connection(root))

    assert [item["job_id"] for item in body["items"]] == jobs
    assert [item["annotations_written"] for item in body["items"]] == [3, 3]
    assert body["annotations_written"] == 6


def test_batch_pre_label_with_no_open_job_notes_it_and_echoes_zero(
    root: Path, tmp_path: Path
) -> None:
    # Every job closed but the batch itself still ``in_annotation`` — reachable
    # because ``batch complete`` is a separate, deliberate step.
    _, batch = started_batch(root, tmp_path)
    for job in jobs_of(root, batch):
        ok(root, "job", "start", job)
        for line in ok(root, "job", "next", job, "-n", "100").splitlines()[1:]:
            ok(root, "job", "mark", job, line.split()[0], "--progress", "annotated")
        ok(root, "job", "complete", job)
    connection = _connection(root)

    result = run(root, "batch", "pre-label", batch, connection)

    assert result.exit_code == 0, result.output
    assert result.stdout == "0\n"
    assert "No open job to pre-label." in result.stderr


def test_pre_label_replace_model_labels_rewrites_the_first_runs_frames(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    _, batch = started_batch(root, tmp_path)
    connection = _connection(root)
    ok(root, "batch", "pre-label", batch, connection)

    result = run(root, "batch", "pre-label", batch, connection, "--replace-model-labels")

    assert result.exit_code == 0, result.output
    assert result.stdout == "6\n"
    assert "replaced 6 earlier model label(s)" in result.stderr
    body = payload(root, "batch", "pre-label", batch, connection, "--replace-model-labels")
    assert body["items"][0]["annotations_replaced"] == 6


def test_batch_pre_label_help_lists_the_replace_option() -> None:
    """Read under the pinned rendering: rich colours the option name in pieces, so
    the unstripped help never contains the flag as one string on CI."""
    result = runner.invoke(app, ["batch", "pre-label", "--help"], env=RENDERING, color=True)
    assert "--replace-model-labels" in plain(result.output)


def test_pre_label_resolves_a_connection_name_and_passes_its_confidence(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    _, batch = started_batch(root, tmp_path)
    _connection(root)

    assert (
        run(root, "batch", "pre-label", batch, "detector", "--minimum-confidence", "0.5").exit_code
        == 0
    )
    assert predicting.minimum_confidences == [0.5] * 6


def _both_shapes_batch(root: Path, tmp_path: Path, project_name: str = "crossings") -> str:
    """A started batch whose `sign` admits a box and a polygon, beside a
    polygon-only `lane` — the schema a two-shape model's selection shows on."""
    document = {
        "classes": [
            {"name": "sign", "geometries": ["bbox", "polygon"]},
            {"name": "lane", "geometries": ["polygon"]},
        ]
    }
    path = tmp_path / "both-shapes-schema.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    project(root, project_name)
    ok(root, "schema", "apply", str(path), "--project", project_name)
    batch = ok(
        root, "ingest", str(stills(tmp_path)), "--project", project_name, "--batch-name", "stills"
    )
    ok(root, "batch", "approve", batch)
    ok(root, "batch", "start", batch)
    return batch


def test_pre_label_geometry_narrows_what_a_two_shape_model_writes(
    root: Path, tmp_path: Path, predicting_both_shapes: _FakePredictor
) -> None:
    """`--geometry bbox` reaches the run: the boxes land, the polygons are
    counted as discarded, and the plan announced is the narrowed one."""
    batch = _both_shapes_batch(root, tmp_path)
    connection = _connection(root)

    result = run(root, "batch", "pre-label", batch, connection, "--geometry", "bbox")

    assert result.exit_code == 0, result.output
    assert result.stdout == "6\n"
    assert "Asking for 1 class(es): sign; what it finds lands as a box." in result.stderr
    assert "Not asking for 1 class(es): lane (no shape this model produces)." in result.stderr


def test_pre_label_without_geometry_writes_every_shape_the_model_produces(
    root: Path, tmp_path: Path, predicting_both_shapes: _FakePredictor
) -> None:
    batch = _both_shapes_batch(root, tmp_path)

    body = payload(root, "batch", "pre-label", batch, _connection(root))

    assert body["items"][0]["annotations_written"] == 12
    assert body["items"][0]["regions_discarded"] == 0


def test_pre_label_geometry_json_counts_the_discarded_shape(
    root: Path, tmp_path: Path, predicting_both_shapes: _FakePredictor
) -> None:
    batch = _both_shapes_batch(root, tmp_path)

    body = payload(root, "batch", "pre-label", batch, _connection(root), "--geometry", "polygon")

    assert body["items"][0]["annotations_written"] == 6
    assert body["items"][0]["regions_discarded"] == 6


def test_pre_label_geometry_repeats(
    root: Path, tmp_path: Path, predicting_both_shapes: _FakePredictor
) -> None:
    batch = _both_shapes_batch(root, tmp_path)

    body = payload(
        root,
        "batch",
        "pre-label",
        batch,
        _connection(root),
        "--geometry",
        "bbox",
        "--geometry",
        "polygon",
    )

    assert body["items"][0]["annotations_written"] == 12
    assert body["items"][0]["regions_discarded"] == 0


def test_pre_label_geometry_outside_what_the_model_produces_exits_1(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    _, batch = started_batch(root, tmp_path)

    result = run(root, "batch", "pre-label", batch, _connection(root), "--geometry", "polygon")

    assert result.exit_code == 1, result.output
    assert "does not answer in a polygon, only a box" in result.stderr
    assert result.stdout == ""
    assert predicting.minimum_confidences == []


def test_pre_label_geometry_outside_the_vocabulary_exits_2(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path)

    result = run(root, "batch", "pre-label", batch, _connection(root), "--geometry", "circle")

    assert result.exit_code == 2, result.output


def test_batch_pre_label_help_lists_the_geometry_option() -> None:
    result = runner.invoke(app, ["batch", "pre-label", "--help"], env=RENDERING, color=True)
    assert "--geometry" in plain(result.output)


def test_batch_help_lists_pre_label() -> None:
    assert "pre-label" in runner.invoke(app, ["batch", "--help"]).stdout


@pytest.mark.parametrize("minimum_confidence", ["-0.01", "1.01"])
def test_pre_label_rejects_a_confidence_outside_the_closed_unit_interval(
    root: Path, tmp_path: Path, minimum_confidence: str
) -> None:
    _, batch = started_batch(root, tmp_path)

    assert (
        run(
            root,
            "batch",
            "pre-label",
            batch,
            _connection(root),
            "--minimum-confidence",
            minimum_confidence,
        ).exit_code
        == 2
    )


def test_pre_label_refuses_a_draft_batch_without_writing_stdout(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    _, batch = ingested_batch(root, tmp_path)

    result = run(root, "batch", "pre-label", batch, _connection(root))

    assert result.exit_code == 1, result.output
    assert "Error: batch 'stills' is 'draft', not 'in_annotation'" in result.stderr
    assert result.stdout == ""


# --- promote -----------------------------------------------------------------


def test_promote_moves_the_finished_assets_into_the_trunk(root: Path, tmp_path: Path) -> None:
    name, batch = completed_batch(root, tmp_path)
    ids = ok(root, "batch", "promote", batch).splitlines()
    assert len(ids) == 6
    assert _trunk_size(root, name) == 6


def test_promoting_twice_adds_nothing(root: Path, tmp_path: Path) -> None:
    # A union against current membership, so a retried command is safe and the
    # change log stays quiet.
    name, batch = completed_batch(root, tmp_path)
    ok(root, "batch", "promote", batch)
    assert payload(root, "batch", "promote", batch) == {"items": [], "total": 0}
    assert _trunk_size(root, name) == 6


def test_promoting_an_unfinished_batch_exits_one(root: Path, tmp_path: Path) -> None:
    _, batch = started_batch(root, tmp_path)
    result = run(root, "batch", "promote", batch)
    assert result.exit_code == 1, result.output
    assert result.stdout == ""


# --- project pre-label ---------------------------------------------------------


def _second_started_batch(root: Path, tmp_path: Path, project_name: str) -> str:
    """Another started batch in the same project over images no other batch holds."""
    incoming = tmp_path / "more"
    write_images(incoming, count=2, first_seed=100)
    batch = ok(root, "ingest", str(incoming), "--project", project_name, "--batch-name", "more")
    ok(root, "batch", "approve", batch)
    ok(root, "batch", "start", batch)
    return batch


def test_project_pre_label_runs_every_open_batch(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    name, first = started_batch(root, tmp_path)
    second = _second_started_batch(root, tmp_path, name)
    connection = _connection(root)

    result = run(root, "project", "pre-label", name, connection)

    assert result.exit_code == 0, result.output
    assert result.stdout == "8\n"
    assert "Pre-labeling 'stills' 6/6 asset(s)." in result.stderr
    assert "Pre-labeling 'more' 2/2 asset(s)." in result.stderr
    assert (
        f"Batch 'stills' job {jobs_of(root, first)[0]}: "
        "pre-labeled 6 asset(s), wrote 6 annotation(s)." in result.stderr
    )
    assert (
        f"Batch 'more' job {jobs_of(root, second)[0]}: "
        "pre-labeled 2 asset(s), wrote 2 annotation(s)." in result.stderr
    )
    assert "Pre-labeled 2 batch(es), wrote 8 annotation(s)." in result.stderr
    listed = {row["id"]: row for row in payload(root, "batch", "list", "-p", name)["items"]}
    assert listed[first]["progress"]["pre_labeled"] == 6
    assert listed[second]["progress"]["pre_labeled"] == 2


def test_project_pre_label_narrows_to_the_named_batch(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    name, first = started_batch(root, tmp_path)
    second = _second_started_batch(root, tmp_path, name)

    result = run(root, "project", "pre-label", name, _connection(root), "--batch", second)

    assert result.exit_code == 0, result.output
    assert result.stdout == "2\n"
    listed = {row["id"]: row for row in payload(root, "batch", "list", "-p", name)["items"]}
    assert listed[first]["progress"]["pre_labeled"] == 0
    assert listed[second]["progress"]["pre_labeled"] == 2


def test_project_pre_label_json_lists_one_outcome_per_batch(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    name, first = started_batch(root, tmp_path)
    second = _second_started_batch(root, tmp_path, name)

    outcome = payload(root, "project", "pre-label", name, _connection(root))

    assert [item["batch_id"] for item in outcome["items"]] == [first, second]
    assert [item["batch_name"] for item in outcome["items"]] == ["stills", "more"]
    assert [item["job_id"] for item in outcome["items"]] == [
        jobs_of(root, first)[0],
        jobs_of(root, second)[0],
    ]
    assert [item["annotations_written"] for item in outcome["items"]] == [6, 2]
    assert outcome["annotations_written"] == 8


def test_project_pre_label_with_no_open_batch_exits_1_naming_the_project(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    name, _batch = ingested_batch(root, tmp_path)

    result = run(root, "project", "pre-label", name, _connection(root))

    assert result.exit_code == 1
    assert "has no batch open for annotation" in result.stderr


def test_project_pre_label_geometry_reaches_every_batch(
    root: Path, tmp_path: Path, predicting_both_shapes: _FakePredictor
) -> None:
    first = _both_shapes_batch(root, tmp_path)
    second = _second_started_batch(root, tmp_path, "crossings")

    outcome = payload(
        root, "project", "pre-label", "crossings", _connection(root), "--geometry", "bbox"
    )

    assert [item["batch_id"] for item in outcome["items"]] == [first, second]
    assert [item["annotations_written"] for item in outcome["items"]] == [6, 2]
    assert [item["regions_discarded"] for item in outcome["items"]] == [6, 2]


def test_project_pre_label_geometry_outside_what_the_model_produces_exits_1(
    root: Path, tmp_path: Path, predicting: _FakePredictor
) -> None:
    name, _first = started_batch(root, tmp_path)

    result = run(root, "project", "pre-label", name, _connection(root), "--geometry", "polygon")

    assert result.exit_code == 1, result.output
    assert "does not answer in a polygon, only a box" in result.stderr
    assert predicting.minimum_confidences == []


def test_project_pre_label_help_lists_the_geometry_option() -> None:
    result = runner.invoke(app, ["project", "pre-label", "--help"], env=RENDERING, color=True)
    assert "--geometry" in plain(result.output)


def test_project_help_lists_pre_label() -> None:
    assert "pre-label" in runner.invoke(app, ["project", "--help"]).stdout
