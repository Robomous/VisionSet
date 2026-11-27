"""Export, ingest and weight-download runs: each exact allowlist, read off the real handlers.

The handlers are the shipped ones, run through ``execute`` against a real
workspace; only the tracker is in memory, and only the network half of a
weight download is faked. So every key and unit asserted here is what the
shipped code hands a tracking server.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from tests.fixtures.media import write_corrupt_image, write_images
from tests.fixtures.tracking import (
    ENABLED,
    CancellingExecutor,
    FakeTracker,
    Recorded,
    runner_for,
    settled,
)
from tests.kernel.test_export_seam import ImageWriter
from tests.kernel.test_release_service import Fixture

from visionset.formats import registry as formats_registry
from visionset.inference import weights as weights_module
from visionset.jobs import REGISTRY, _tracking, export, ingest, weights
from visionset.jobs._tracking import (
    AttemptTracking,
    attempt_params,
    outcome_metrics,
    release_fields,
    result_params,
)
from visionset.jobs._worker import execute
from visionset.kernel.domain import (
    BackgroundJobSpec,
    BackgroundJobState,
    ConnectionType,
    DownloadSize,
    Release,
)
from visionset.kernel.services import (
    EXPORT_REPORT_FILENAME,
    InferenceConnectionService,
    IngestService,
    ProjectService,
    ReleaseService,
    SourceService,
    WorkspaceService,
)
from visionset.tracking import DatasetInput, RunStatus

SENSITIVE = "confidential"
FETCHED_BYTES = 4_000_000_000
COMMIT = "0123456789abcdef0123456789abcdef01234567"

ALWAYS_TAGS = {
    "visionset.job_id",
    "visionset.job_type",
    "visionset.execution_id",
    "visionset.attempt",
    "visionset.execution_source",
    "visionset.version",
    "visionset.job_state",
}


def _attempt(job_type: str) -> AttemptTracking:
    return AttemptTracking(
        settings=ENABLED, execution_id=uuid4(), job_id=uuid4(), job_type=job_type, attempt=1
    )


def _run(workspace: WorkspaceService, job_type: str, payload: dict[str, Any]) -> Any:
    job = workspace.job_queue.enqueue(BackgroundJobSpec(type=job_type, payload=payload))
    workspace.job_queue.claim("test")
    outcome = execute(REGISTRY[job_type], workspace.root, job.id, payload, 0, _attempt(job_type))
    assert _tracking.flush(10)
    return outcome


def _sent(run: Recorded) -> str:
    return repr((run.name, run.tags, run.params, run.metrics, run.datasets))


def _assert_nothing_sensitive(run: Recorded, *more: str) -> None:
    sent = _sent(run)
    for leaked in (SENSITIVE, "/tmp", "\\", ".png", ".zip", "exports/", "http", *more):
        assert leaked not in sent, leaked


# --- export ---------------------------------------------------------------------


@pytest.fixture()
def released(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Fixture, Release]]:
    fixture = Fixture(tmp_path, name=SENSITIVE)
    release = fixture.releases.publish(fixture.ready(), f"{SENSITIVE}-tag")
    monkeypatch.setattr(formats_registry, "exporters", lambda: {"image-writer": ImageWriter()})
    yield fixture, release
    fixture.close()


def _export_payload(release_id: UUID) -> dict[str, Any]:
    return export.payload_for(release_id, "image-writer", target=None, allow_lossy=False)


def test_an_export_sends_its_request_its_release_lineage_and_its_output_size(
    released: tuple[Fixture, Release], tracker: FakeTracker
) -> None:
    fixture, release = released

    outcome = _run(fixture.workspace, export.JOB_TYPE, _export_payload(release.id))

    [run] = tracker.runs.values()
    assert run.status is RunStatus.FINISHED
    assert set(run.tags) == ALWAYS_TAGS | {"visionset.release_id", "visionset.dataset_id"}
    assert run.tags["visionset.release_id"] == str(release.id)
    assert run.tags["visionset.dataset_id"] == str(release.dataset_id)
    assert run.params == {
        "export_format": "image-writer",
        "allow_lossy": False,
        "recipe_applied": False,
        "release_manifest_hash": release.manifest_hash,
        "release_schema_version": release.schema_version,
    }
    written = [
        path
        for path in (fixture.root / "exports" / str(release.id) / "image-writer").rglob("*")
        if path.is_file() and path.name != EXPORT_REPORT_FILENAME
    ]
    assert outcome.result["total_bytes"] == sum(path.stat().st_size for path in written) > 0
    assert {k: v for k, v in run.metrics.items() if k != "duration_seconds"} == {
        "processed_count": float(len(written)),
        "total_count": float(len(written)),
        "failures_count": 0.0,
        "output_bytes": float(outcome.result["total_bytes"]),
        "source_image_count": float(release.asset_count),
        "augmented_image_count": 0.0,
    }
    [dataset] = run.datasets
    assert dataset == DatasetInput(
        name=f"visionset-release-{release.id}",
        digest=release.manifest_hash[:32],
        source_type="visionset_release",
        source=json.dumps({"dataset_id": str(release.dataset_id), "release_id": str(release.id)}),
        profile=json.dumps(
            {
                "annotation_count": release.annotation_count,
                "asset_count": release.asset_count,
                "manifest_hash": release.manifest_hash,
                "schema_version": release.schema_version,
            }
        ),
        context="export",
    )
    assert len(dataset.digest) <= 36
    _assert_nothing_sensitive(run, str(fixture.root), "exports", "image-writer.zip")


def test_a_failed_export_keeps_its_error_and_sends_no_lineage(
    released: tuple[Fixture, Release], tracker: FakeTracker
) -> None:
    fixture, _ = released
    missing = uuid4()
    job = fixture.workspace.job_queue.enqueue(
        BackgroundJobSpec(type=export.JOB_TYPE, payload=_export_payload(missing))
    )

    runner_for(fixture.workspace).drain()

    stored = settled(fixture.workspace, job.id)
    assert stored.state is BackgroundJobState.FAILED
    assert str(missing) in (stored.error or "")
    [run] = tracker.runs.values()
    assert run.status is RunStatus.FAILED
    assert run.tags["visionset.error_class"] == "ReleaseNotFound"
    assert run.tags["visionset.release_id"] == str(missing)
    assert set(run.params) == {"export_format", "allow_lossy", "recipe_applied"}
    assert set(run.metrics) == {"duration_seconds"}
    assert run.datasets == []
    assert "visionset.dataset_id" not in run.tags


def test_a_cancelled_export_reads_nothing_and_sends_no_lineage(
    released: tuple[Fixture, Release], tracker: FakeTracker, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture, release = released
    reads: list[object] = []
    monkeypatch.setattr(_tracking, "read_record_fields", lambda *args: reads.append(args))
    job = fixture.workspace.job_queue.enqueue(
        BackgroundJobSpec(type=export.JOB_TYPE, payload=_export_payload(release.id))
    )

    runner_for(fixture.workspace, executor=CancellingExecutor(fixture.workspace)).drain()

    assert settled(fixture.workspace, job.id).state is BackgroundJobState.CANCELLED
    [run] = tracker.runs.values()
    assert run.status is RunStatus.KILLED
    assert reads == []
    assert run.datasets == []
    assert set(run.metrics) == {"duration_seconds"}


def test_an_unreadable_release_row_leaves_the_job_and_the_rest_of_its_run_intact(
    released: tuple[Fixture, Release], tracker: FakeTracker, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture, release = released
    job = fixture.workspace.job_queue.enqueue(
        BackgroundJobSpec(type=export.JOB_TYPE, payload=_export_payload(release.id))
    )
    calls = 0
    real_get = ReleaseService.get

    def get_then_fail(self: ReleaseService, release_id: UUID) -> Release:
        nonlocal calls
        calls += 1
        if calls > 1:
            raise RuntimeError(f"{SENSITIVE} {fixture.root}")
        return real_get(self, release_id)

    monkeypatch.setattr(ReleaseService, "get", get_then_fail)

    runner_for(fixture.workspace).drain()

    stored = settled(fixture.workspace, job.id)
    assert stored.state is BackgroundJobState.SUCCEEDED
    assert stored.result is not None and stored.result["release_id"] == str(release.id)
    [run] = tracker.runs.values()
    assert run.status is RunStatus.FINISHED
    assert run.datasets == []
    assert "release_manifest_hash" not in run.params
    assert run.metrics["output_bytes"] == float(stored.result["total_bytes"])
    _assert_nothing_sensitive(run, str(fixture.root))


def test_an_export_parameter_of_unexpected_shape_is_omitted() -> None:
    payload: dict[str, Any] = {
        "release_id": str(uuid4()),
        "format": "../../coco",
        "target": f"https://{SENSITIVE}.example/x",
        "allow_lossy": "yes",
        "recipe": {"name": f"{SENSITIVE} recipe", "spec": {"steps": []}},
    }

    assert attempt_params(export.JOB_TYPE, payload) == {"recipe_applied": True}
    assert attempt_params(export.JOB_TYPE, {}) == {}
    assert result_params(export.JOB_TYPE, {"recipe_hash": "f" * 64}) == {"recipe_hash": "f" * 64}
    for bad in ("F" * 64, "f" * 63, f"{SENSITIVE}", None, 7):
        assert result_params(export.JOB_TYPE, {"recipe_hash": bad}) == {}
    assert (
        outcome_metrics(
            export.JOB_TYPE,
            {"total_bytes": -1, "source_file_count": True, "augmented_file_count": "2"},
            processed=0,
            total=None,
            failures=0,
        )
        == {}
    )


def test_a_release_whose_hash_is_not_a_digest_names_no_dataset(
    released: tuple[Fixture, Release],
) -> None:
    _, release = released
    odd = release.model_copy(update={"manifest_hash": f"/{SENSITIVE}/manifest.json"})

    fields = release_fields(odd)

    assert fields.datasets == ()
    assert fields.params == {}
    assert fields.tags == {"visionset.dataset_id": str(release.dataset_id)}


# --- ingest ---------------------------------------------------------------------


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws")
    yield made
    made.close()


def test_an_ingest_sends_its_rows_own_counters_and_ids_and_no_names_or_paths(
    workspace: WorkspaceService, tracker: FakeTracker, tmp_path: Path
) -> None:
    folder = tmp_path / f"{SENSITIVE}-dir"
    write_images(folder, count=3, prefix=SENSITIVE)
    write_corrupt_image(folder / f"{SENSITIVE}_broken.png", seed=9)
    project = ProjectService(workspace).create(f"{SENSITIVE}-project")
    source = SourceService(workspace).register_images(project.id, folder)
    pending = IngestService(workspace).enqueue(source.id, batch_name=f"{SENSITIVE}-batch")

    outcome = _run(workspace, ingest.JOB_TYPE, ingest.payload_for(pending.id))

    row = IngestService(workspace).get(pending.id)
    assert (row.processed, row.total, len(row.failures)) == (4, 4, 1)
    [run] = tracker.runs.values()
    assert run.status is RunStatus.FINISHED
    assert set(run.tags) == ALWAYS_TAGS | {
        "visionset.ingest_job_id",
        "visionset.source_id",
        "visionset.batch_id",
    }
    assert run.tags["visionset.ingest_job_id"] == str(pending.id)
    assert run.tags["visionset.source_id"] == str(source.id)
    assert run.tags["visionset.batch_id"] == str(row.batch_id)
    assert run.params == {}
    assert {k: v for k, v in run.metrics.items() if k != "duration_seconds"} == {
        "processed_count": 4.0,
        "total_count": 4.0,
        "failures_count": 1.0,
        "asset_count": 3.0,
        "created_asset_count": 3.0,
    }
    assert outcome.result["created"] == 3
    assert run.datasets == []
    _assert_nothing_sensitive(run, str(tmp_path), "broken", "frame")


# --- weight download ------------------------------------------------------------


@pytest.fixture()
def downloadable(
    workspace: WorkspaceService, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> UUID:
    def download(connection: Any, *, into: Path, on_bytes: Any = None) -> Path:
        if callable(on_bytes):
            on_bytes(FETCHED_BYTES // 2)
        return tmp_path / f"{SENSITIVE}-cache"

    monkeypatch.setattr(weights_module, "download", download)
    monkeypatch.setattr(weights_module, "family_of", lambda *_, **__: "sam2")
    monkeypatch.setattr(
        weights_module,
        "download_size",
        lambda model_id, model_revision: DownloadSize(
            model_id=model_id,
            model_revision=model_revision,
            total_bytes=FETCHED_BYTES,
            file_count=2,
        ),
    )
    return (
        InferenceConnectionService(workspace)
        .create(
            f"{SENSITIVE}-connection",
            connection_type=ConnectionType.LOCAL,
            model_id="some-org/some-model",
            model_revision=COMMIT,
            device="cpu",
            precision="fp32",
            provider_id="sam",
        )
        .id
    )


def test_a_weight_download_sends_its_model_provenance_and_its_bytes(
    workspace: WorkspaceService, tracker: FakeTracker, downloadable: UUID, tmp_path: Path
) -> None:
    _run(workspace, weights.JOB_TYPE, weights.payload_for(downloadable))

    [run] = tracker.runs.values()
    assert run.status is RunStatus.FINISHED
    assert set(run.tags) == ALWAYS_TAGS | {"visionset.connection_id"}
    assert run.tags["visionset.connection_id"] == str(downloadable)
    assert run.params == {
        "model_id": "some-org/some-model",
        "model_revision": COMMIT,
        "model_provider": "sam",
        "model_family": "sam2",
    }
    assert {k: v for k, v in run.metrics.items() if k != "duration_seconds"} == {
        "bytes_done": float(FETCHED_BYTES),
        "bytes_total": float(FETCHED_BYTES),
    }
    assert run.datasets == []
    _assert_nothing_sensitive(run, str(tmp_path), "cache")


def test_a_revision_that_is_not_a_commit_and_a_model_id_that_is_a_path_are_omitted() -> None:
    assert result_params(weights.JOB_TYPE, {"model_id": "org/m", "model_revision": "main"}) == {
        "model_id": "org/m"
    }
    for model_id in (f"/{SENSITIVE}/weights", "https://hub.example/m", "a/b/c", "../m", None):
        assert (
            result_params(weights.JOB_TYPE, {"model_id": model_id, "model_revision": COMMIT}) == {}
        )


def test_weight_progress_is_named_in_bytes_and_never_as_a_count() -> None:
    assert outcome_metrics(weights.JOB_TYPE, {}, processed=10, total=None, failures=0) == {
        "bytes_done": 10.0
    }
    assert outcome_metrics(weights.JOB_TYPE, {}, processed=10, total=5, failures=0) == {
        "bytes_done": 10.0
    }
    assert outcome_metrics(weights.JOB_TYPE, {}, processed=0, total=None, failures=0) == {}
