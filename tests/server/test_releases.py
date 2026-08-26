"""Releases over HTTP: publishing, the byte-identical manifest, verify, split, export.

The manifest assertions are the acceptance criterion in executable form. What
comes back must hash to `manifest_hash`, and two publishes of an unchanged trunk
must produce the same bytes — neither survives a route that parses the document
and dumps it again, which is why the download streams the blob.

Export is exercised against `_exports.py`'s doubles rather than the shipped
`DummyExporter`: that one writes nothing, so an export that worked and one that
silently did nothing produce the same empty archive, and the lossy gate has
nothing to refuse.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client
from tests.server._exports import (
    BoxesOnlyExporter,
    LossyExporter,
    PolygonsOnlyExporter,
    TargetedExporter,
    WritingExporter,
    reset_exporters,
    with_exporters,
)
from tests.server._flow import (
    SIGN,
    asset_ids,
    batch_from_ingest,
    dataset_of,
    project_with_schema,
    promoted_dataset,
)
from tests.server._jobs import InlineDispatcher

from visionset.kernel.domain import MANIFEST_VERSION
from visionset.kernel.services.release_service import EXPORT_REPORT_FILENAME

RECIPE = {"train": 0.6, "val": 0.2, "test": 0.2, "seed": 42}


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made
    # `with_exporters` swaps a module global that the *worker* side of an export
    # reads, so putting it back is a fixture's job — see `reset_exporters`.
    reset_exporters()


@pytest.fixture()
def dataset(client: TestClient, tmp_path: Path, runner: InlineDispatcher) -> str:
    """A trunk with three labeled assets already promoted into it."""
    return promoted_dataset(client, runner, tmp_path)


@pytest.fixture()
def release(client: TestClient, dataset: str) -> str:
    return str(client.post(f"/datasets/{dataset}/releases", json={"tag": "v1"}).json()["id"])


# --- publishing ---------------------------------------------------------------


def test_publishing_freezes_the_trunk_and_answers_201(client: TestClient, dataset: str) -> None:
    response = client.post(f"/datasets/{dataset}/releases", json={"tag": "v1"})

    assert response.status_code == 201
    body = response.json()
    assert body["tag"] == "v1"
    assert body["dataset_id"] == dataset
    assert body["asset_count"] == 3
    assert body["annotation_count"] == 3
    assert body["schema_version"] == 1
    assert body["split"] is None
    assert len(body["manifest_hash"]) == 64
    assert body["created_at"]
    assert body["visionset_version"]


def test_a_split_recipe_comes_back_on_the_release(client: TestClient, dataset: str) -> None:
    body = client.post(f"/datasets/{dataset}/releases", json={"tag": "v1", "split": RECIPE}).json()

    assert body["split"] == RECIPE


def test_fractions_that_do_not_add_up_are_422_and_not_500(client: TestClient, dataset: str) -> None:
    """The trap: a pydantic error from a route body reaches the catch-all as a 500."""
    response = client.post(
        f"/datasets/{dataset}/releases",
        json={"tag": "v1", "split": {"train": 0.5, "val": 0.2, "test": 0.2}},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_a_fraction_outside_zero_to_one_is_422(client: TestClient, dataset: str) -> None:
    response = client.post(
        f"/datasets/{dataset}/releases",
        json={"tag": "v1", "split": {"train": 1.5, "val": -0.5, "test": 0.0}},
    )

    assert response.status_code == 422


def test_a_blank_tag_is_the_kernels_own_refusal(client: TestClient, dataset: str) -> None:
    response = client.post(f"/datasets/{dataset}/releases", json={"tag": "   "})

    assert response.status_code == 422
    assert response.json()["code"] == "INVALID_NAME"


def test_an_unknown_field_in_the_body_is_refused(client: TestClient, dataset: str) -> None:
    response = client.post(f"/datasets/{dataset}/releases", json={"tag": "v1", "notes": "hi"})

    assert response.status_code == 422


def test_reusing_a_tag_within_one_dataset_is_409(client: TestClient, dataset: str) -> None:
    client.post(f"/datasets/{dataset}/releases", json={"tag": "v1"})

    response = client.post(f"/datasets/{dataset}/releases", json={"tag": "v1"})

    assert response.status_code == 409
    assert response.json()["code"] == "RELEASE_TAG_TAKEN"


def test_tags_are_case_sensitive_because_a_tag_is_an_identifier(
    client: TestClient, dataset: str
) -> None:
    client.post(f"/datasets/{dataset}/releases", json={"tag": "v1.0"})

    assert client.post(f"/datasets/{dataset}/releases", json={"tag": "V1.0"}).status_code == 201


def test_publishing_an_empty_trunk_is_409(client: TestClient, tmp_path: Path) -> None:
    from tests.server._flow import project_with_schema

    dataset_id = dataset_of(client, project_with_schema(client, name="empty"))

    response = client.post(f"/datasets/{dataset_id}/releases", json={"tag": "v1"})

    assert response.status_code == 409
    assert response.json()["code"] == "EMPTY_RELEASE"


def test_release_publication_reports_active_schema_content_blockers(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    project_id = project_with_schema(
        client, classes=[SIGN, {"name": "car", "geometries": ["bbox"]}]
    )
    batch_id = batch_from_ingest(client, runner, tmp_path, project_id, images=1)
    client.post(f"/batches/{batch_id}/approve")
    client.post(f"/batches/{batch_id}/start")
    job_id = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job_id}/start")
    client.post(
        f"/projects/{project_id}/schema/versions",
        json={"classes": [SIGN]},
        params={"allow_destructive": True},
    )
    client.post(
        f"/jobs/{job_id}/annotations",
        json=[
            {
                "asset_id": asset_ids(client, batch_id)[0],
                "label_class": "car",
                "geometry": {"type": "bbox", "x": 1, "y": 2, "width": 30, "height": 40},
                "provenance": "human",
            }
        ],
    )
    client.post(f"/jobs/{job_id}/complete")
    client.post(f"/batches/{batch_id}/complete")
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)

    response = client.post(f"/datasets/{dataset_id}/releases", json={"tag": "v1"})

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA"
    assert body["detail"] == {"blockers": [{"label_class": "car", "annotations": 1, "assets": 1}]}
    assert client.get(f"/datasets/{dataset_id}/releases").json() == {"items": [], "total": 0}


def test_publishing_from_an_unknown_dataset_is_404(client: TestClient) -> None:
    response = client.post(f"/datasets/{uuid4()}/releases", json={"tag": "v1"})

    assert response.status_code == 404
    assert response.json()["code"] == "DATASET_NOT_FOUND"


# --- reading ------------------------------------------------------------------


def test_releases_list_in_the_envelope_oldest_first(client: TestClient, dataset: str) -> None:
    client.post(f"/datasets/{dataset}/releases", json={"tag": "v1"})
    client.post(f"/datasets/{dataset}/releases", json={"tag": "v2"})

    body = client.get(f"/datasets/{dataset}/releases").json()

    assert body["total"] == 2
    assert [release["tag"] for release in body["items"]] == ["v1", "v2"]


def test_a_dataset_with_no_releases_answers_with_an_empty_envelope(
    client: TestClient, dataset: str
) -> None:
    assert client.get(f"/datasets/{dataset}/releases").json() == {"items": [], "total": 0}


def test_a_release_is_addressable_on_its_own(client: TestClient, release: str) -> None:
    assert client.get(f"/releases/{release}").json()["id"] == release


def test_an_unknown_release_is_404_with_its_own_code(client: TestClient) -> None:
    response = client.get(f"/releases/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["code"] == "RELEASE_NOT_FOUND"


# --- the manifest, byte for byte ----------------------------------------------


def test_the_manifest_download_hashes_to_the_hash_the_release_names(
    client: TestClient, release: str
) -> None:
    """The acceptance criterion. A parse-and-re-dump route would not survive this."""
    manifest_hash = client.get(f"/releases/{release}").json()["manifest_hash"]

    response = client.get(f"/releases/{release}/manifest")

    assert response.status_code == 200
    assert hashlib.sha256(response.content).hexdigest() == manifest_hash


def test_the_manifest_is_served_as_json_and_parses(client: TestClient, release: str) -> None:
    response = client.get(f"/releases/{release}/manifest")

    assert response.headers["content-type"].startswith("application/json")
    document = response.json()
    assert document["manifest_version"] == MANIFEST_VERSION
    assert document["schema_version"] == 1
    assert len(document["assets"]) == 3


def test_the_manifest_is_cached_immutably_and_tagged_with_its_own_digest(
    client: TestClient, release: str
) -> None:
    manifest_hash = client.get(f"/releases/{release}").json()["manifest_hash"]

    headers = client.get(f"/releases/{release}/manifest").headers

    assert headers["etag"] == f'"{manifest_hash}"'
    assert "immutable" in headers["cache-control"]


def test_publishing_twice_from_an_unchanged_trunk_downloads_identical_bytes(
    client: TestClient, dataset: str
) -> None:
    first = client.post(f"/datasets/{dataset}/releases", json={"tag": "v1"}).json()
    second = client.post(f"/datasets/{dataset}/releases", json={"tag": "v2"}).json()

    assert first["manifest_hash"] == second["manifest_hash"]
    assert (
        client.get(f"/releases/{first['id']}/manifest").content
        == client.get(f"/releases/{second['id']}/manifest").content
    )


def test_curating_the_trunk_does_not_reach_backwards_into_a_published_release(
    client: TestClient, dataset: str
) -> None:
    published = client.post(f"/datasets/{dataset}/releases", json={"tag": "v1"}).json()
    removed = client.get(f"/datasets/{dataset}/assets").json()["items"][0]["id"]
    client.delete(f"/datasets/{dataset}/assets/{removed}")

    document = client.get(f"/releases/{published['id']}/manifest").json()

    assert len(document["assets"]) == 3
    assert client.get(f"/releases/{published['id']}").json()["asset_count"] == 3


@pytest.mark.parametrize("suffix", ["manifest", "verify", "assignment"])
def test_an_unknown_release_is_404_on_every_derived_read(client: TestClient, suffix: str) -> None:
    """The three reads derived from a release all refuse one that is not there."""
    assert client.get(f"/releases/{uuid4()}/{suffix}").status_code == 404


# --- verification -------------------------------------------------------------


def test_a_fresh_release_verifies_clean(client: TestClient, release: str) -> None:
    body = client.get(f"/releases/{release}/verify").json()

    assert body["ok"] is True
    assert body["manifest_intact"] is True
    assert body["checked"] == 3
    assert body["missing"] == []
    assert body["corrupt"] == []
    assert body["cache_mismatches"] == []


def test_a_deleted_content_blob_is_reported_as_missing(
    client: TestClient, tmp_path: Path, release: str
) -> None:
    document = client.get(f"/releases/{release}/manifest").json()
    gone = document["assets"][0]["content_hash"]
    (tmp_path / "ws" / "blobs" / gone[:2] / gone[2:4] / gone).unlink()

    body = client.get(f"/releases/{release}/verify").json()

    assert body["ok"] is False
    assert body["missing"] == [gone]
    assert body["corrupt"] == []


def test_an_altered_blob_is_reported_as_corrupt_rather_than_missing(
    client: TestClient, tmp_path: Path, release: str
) -> None:
    """Different faults, different remedies, so the two lists are never merged."""
    document = client.get(f"/releases/{release}/manifest").json()
    tampered = document["assets"][0]["content_hash"]
    path = tmp_path / "ws" / "blobs" / tampered[:2] / tampered[2:4] / tampered
    path.write_bytes(b"not what the hash says")

    body = client.get(f"/releases/{release}/verify").json()

    assert body["corrupt"] == [tampered]
    assert body["missing"] == []


# --- the split ----------------------------------------------------------------


def test_the_assignment_cuts_the_frozen_asset_set_into_folds(
    client: TestClient, dataset: str
) -> None:
    published = client.post(
        f"/datasets/{dataset}/releases", json={"tag": "v1", "split": RECIPE}
    ).json()

    body = client.get(f"/releases/{published['id']}/assignment").json()

    assert len(body["train"]) + len(body["val"]) + len(body["test"]) == 3


def test_the_assignment_is_the_same_answer_every_time(client: TestClient, dataset: str) -> None:
    published = client.post(
        f"/datasets/{dataset}/releases", json={"tag": "v1", "split": RECIPE}
    ).json()

    first = client.get(f"/releases/{published['id']}/assignment").json()
    second = client.get(f"/releases/{published['id']}/assignment").json()

    assert first == second


def test_a_release_published_without_a_recipe_has_no_assignment(
    client: TestClient, release: str
) -> None:
    """Not a defect: no recipe means one undivided set, and inventing folds would lie."""
    response = client.get(f"/releases/{release}/assignment")

    assert response.status_code == 404
    assert response.json()["code"] == "NO_SPLIT_RECIPE"


# --- export -------------------------------------------------------------------


def exported(client: TestClient, release: str, **params: Any) -> Any:
    """Run an export to completion and hand back the artifact response.

    The launch is a 202, so `response.content` is not the
    archive: the work happens in a job and the bytes come from a second route.
    This helper is what keeps the assertions below about *what was written*
    rather than about the plumbing that moved — and the job's own contract has
    its own tests in `test_background_jobs.py`.

    The `InlineDispatcher` behind `client` has already run the job by the time
    the launch responds, so nothing here polls.
    """
    launched = client.post(f"/releases/{release}/export", params=params)
    assert launched.status_code == 202, launched.text
    job_id = launched.json()["id"]
    settled = client.get(f"/background-jobs/{job_id}").json()
    assert settled["state"] == "succeeded", settled
    artifact = client.get(f"/background-jobs/{job_id}/artifact")
    assert artifact.status_code == 200, artifact.text
    return artifact


def _names_in(payload: bytes) -> set[str]:
    """The files in the archive. Directory entries are a zip artefact, not output."""
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return {entry.filename for entry in archive.infolist() if not entry.is_dir()}


def test_exporting_streams_back_an_archive_of_what_the_plugin_wrote(
    client: TestClient, release: str
) -> None:
    with_exporters(client.app, WritingExporter())

    response = exported(client, release, format="writing")

    assert response.headers["content-type"] == "application/zip"
    # …plus the compatibility report, which is attached to every export
    # output so the answer to "what would this format have dropped" travels
    # with the bytes and not only with the refusal.
    assert _names_in(response.content) == {
        "manifest.json",
        "images/listing.txt",
        EXPORT_REPORT_FILENAME,
    }


def test_an_export_can_be_addressed_to_a_target_instead_of_a_format(
    client: TestClient, release: str
) -> None:
    """The self-target of a format is the format, so this is the same export by another name."""
    with_exporters(client.app, WritingExporter())

    response = exported(client, release, target="writing")

    assert _names_in(response.content) == {
        "manifest.json",
        "images/listing.txt",
        EXPORT_REPORT_FILENAME,
    }


def test_both_target_and_format_is_422_and_so_is_neither(client: TestClient, release: str) -> None:
    with_exporters(client.app, WritingExporter())

    both = client.post(
        f"/releases/{release}/export", params={"format": "writing", "target": "writing"}
    )
    neither = client.post(f"/releases/{release}/export")

    for response in (both, neither):
        assert response.status_code == 422, response.text
        body = response.json()
        assert body["code"] == "VALIDATION_ERROR"
        (error,) = body["detail"]["errors"]
        assert (error["type"], error["loc"]) == ("value_error", ["query"])
        assert error["msg"] == "give exactly one of target and format"
    assert both.json()["detail"]["errors"][0]["input"] == {"target": "writing", "format": "writing"}
    assert neither.json()["detail"]["errors"][0]["input"] == {"target": None, "format": None}


def test_an_unknown_target_is_404_and_names_what_is_installed(
    client: TestClient, release: str
) -> None:
    with_exporters(client.app, WritingExporter())

    response = client.post(f"/releases/{release}/export", params={"target": "yolo99"})

    assert response.status_code == 404
    assert response.json()["code"] == "EXPORT_TARGET_NOT_FOUND"
    assert "writing" in response.json()["message"]


def test_a_target_narrows_its_format_and_the_plugin_is_handed_only_what_it_carries(
    client: TestClient, release: str
) -> None:
    """The release holds boxes; the trainer takes polygons; the format could write both."""
    with_exporters(client.app, TargetedExporter())

    refused = client.post(f"/releases/{release}/export", params={"target": "polygon-trainer"})
    assert refused.status_code == 409
    assert refused.json()["code"] == "LOSSY_EXPORT_NOT_CONSENTED"
    report = refused.json()["detail"]["compatibility"]
    assert (report["format"], report["target"]) == ("targeted", "polygon-trainer")
    (sign,) = [one for one in report["classes"] if one["status"] == "dropped"]
    assert sign["reason"] == "Polygon trainer does not accept a bbox, so the export drops it"

    # By format alone the same release is carried whole.
    whole = client.get(f"/releases/{release}/export-compatibility", params={"format": "targeted"})
    assert whole.json()["compatible"] is True
    assert whole.json()["target"] is None

    consented = exported(client, release, target="polygon-trainer", allow_lossy="true")
    with zipfile.ZipFile(io.BytesIO(consented.content)) as archive:
        assert archive.read("annotations.txt") == b"0"
        written = json.loads(archive.read(EXPORT_REPORT_FILENAME))
    assert written["target"] == "polygon-trainer"


def test_the_job_carries_the_target_and_the_resolved_format(
    client: TestClient, release: str
) -> None:
    with_exporters(client.app, TargetedExporter())

    launched = client.post(
        f"/releases/{release}/export", params={"target": "polygon-trainer", "allow_lossy": "true"}
    )
    settled = client.get(f"/background-jobs/{launched.json()['id']}").json()

    assert settled["result"]["format"] == "targeted"
    assert settled["result"]["target"] == "polygon-trainer"


def test_an_unknown_format_is_404_and_names_what_is_installed(
    client: TestClient, release: str
) -> None:
    with_exporters(client.app, WritingExporter())

    response = client.post(f"/releases/{release}/export", params={"format": "coco"})

    assert response.status_code == 404
    assert response.json()["code"] == "EXPORT_FORMAT_NOT_FOUND"
    assert "writing" in response.json()["message"]


def test_a_lossy_format_is_refused_until_the_caller_consents(
    client: TestClient, release: str
) -> None:
    with_exporters(client.app, LossyExporter())

    response = client.post(f"/releases/{release}/export", params={"format": "lossy"})

    assert response.status_code == 409
    assert response.json()["code"] == "LOSSY_EXPORT_NOT_CONSENTED"


def test_the_lossy_retry_is_the_identical_request_plus_one_parameter(
    client: TestClient, release: str
) -> None:
    """The gate convention: a 409 retry adds a query parameter and changes nothing else."""
    with_exporters(client.app, LossyExporter())
    client.post(f"/releases/{release}/export", params={"format": "lossy"})

    response = exported(client, release, format="lossy", allow_lossy="true")

    assert _names_in(response.content) == {"boxes-only.txt", EXPORT_REPORT_FILENAME}


def test_a_refused_lossy_export_writes_nothing_at_all(
    client: TestClient, tmp_path: Path, release: str
) -> None:
    with_exporters(client.app, LossyExporter())

    client.post(f"/releases/{release}/export", params={"format": "lossy"})

    assert not (tmp_path / "ws" / "exports").exists()


def test_consenting_to_loss_changes_nothing_for_a_lossless_format(
    client: TestClient, release: str
) -> None:
    with_exporters(client.app, WritingExporter())

    permitted = exported(client, release, format="writing", allow_lossy="true")
    plain = exported(client, release, format="writing")

    assert _names_in(permitted.content) == _names_in(plain.content)


def test_the_export_lands_under_the_workspaces_own_exports_directory(
    client: TestClient, tmp_path: Path, release: str
) -> None:
    """A sibling of `uploads/`, and server-owned in the same way."""
    with_exporters(client.app, WritingExporter())

    exported(client, release, format="writing")

    assert (tmp_path / "ws" / "exports" / release / "writing" / "manifest.json").is_file()


def test_re_exporting_describes_the_new_run_and_not_the_old_one(
    client: TestClient, tmp_path: Path, release: str
) -> None:
    """The handler clears the directory it owns, so a stale file cannot ride along."""
    with_exporters(client.app, WritingExporter())
    exported(client, release, format="writing")
    stale = tmp_path / "ws" / "exports" / release / "writing" / "left-over.txt"
    stale.write_text("from an earlier plugin")

    response = exported(client, release, format="writing")

    assert "left-over.txt" not in _names_in(response.content)
    assert not stale.exists()


def test_exporting_an_unknown_release_is_404(client: TestClient) -> None:
    with_exporters(client.app, WritingExporter())

    response = client.post(f"/releases/{uuid4()}/export", params={"format": "writing"})

    assert response.status_code == 404
    assert response.json()["code"] == "RELEASE_NOT_FOUND"


def test_the_format_parameter_is_required(client: TestClient, release: str) -> None:
    assert client.post(f"/releases/{release}/export").status_code == 422


def test_exporting_leaves_the_release_exactly_as_it_was(client: TestClient, release: str) -> None:
    """No row, no event, no log entry: an export reads a frozen artifact."""
    with_exporters(client.app, WritingExporter())
    before = client.get(f"/releases/{release}").json()

    client.post(f"/releases/{release}/export", params={"format": "writing"})

    assert client.get(f"/releases/{release}").json() == before


# --- what a format would drop -------------------------------------------------


def test_the_pre_flight_says_a_release_is_carried_whole(client: TestClient, release: str) -> None:
    with_exporters(client.app, BoxesOnlyExporter())

    body = client.get(
        f"/releases/{release}/export-compatibility", params={"format": "boxes-only"}
    ).json()

    assert body["compatible"] is True
    assert (body["excluded_annotations"], body["excluded_assets"]) == (0, 0)
    assert body["format"] == "boxes-only"
    assert body["format_is_lossy"] is False
    # Both declared classes appear, sorted, including the polygon one this flow's
    # schema declares and nobody labeled with — a class with zero annotations
    # excludes nothing, however unsupported its geometry, which is why the
    # release above is `compatible` at all.
    assert [one["label_class"] for one in body["classes"]] == ["lane", "sign"]
    lane, sign = body["classes"]
    assert (lane["status"], lane["annotations"]) == ("dropped", 0)
    assert (sign["status"], sign["reason"]) == ("supported", None)


def test_the_pre_flight_names_what_would_be_dropped(client: TestClient, release: str) -> None:
    with_exporters(client.app, PolygonsOnlyExporter())

    body = client.get(
        f"/releases/{release}/export-compatibility", params={"format": "polygons-only"}
    ).json()

    assert body["compatible"] is False
    assert body["excluded_annotations"] > 0
    (sign,) = [one for one in body["classes"] if one["status"] != "supported"]
    assert sign["status"] == "dropped"
    assert sign["reason"] == "polygons-only cannot place a bbox and drops it"


def test_the_pre_flight_writes_nothing_a_later_read_can_see(
    client: TestClient, release: str
) -> None:
    """A GET, and the release is immutable, so asking twice answers the same thing."""
    with_exporters(client.app, PolygonsOnlyExporter())
    url = f"/releases/{release}/export-compatibility"

    first = client.get(url, params={"format": "polygons-only"})
    second = client.get(url, params={"format": "polygons-only"})

    assert first.json() == second.json()


def test_an_unknown_format_is_404_from_the_pre_flight_too(client: TestClient, release: str) -> None:
    with_exporters(client.app, BoxesOnlyExporter())

    response = client.get(f"/releases/{release}/export-compatibility", params={"format": "nope"})

    assert response.status_code == 404
    assert response.json()["code"] == "EXPORT_FORMAT_NOT_FOUND"


def test_a_lossless_format_that_would_drop_a_class_is_refused_with_the_report(
    client: TestClient, release: str
) -> None:
    """The reason the report is in `detail`.

    A client that gets this 409 can render a consent dialog from it without a
    second round trip, and it is the same document the pre-flight returns.
    """
    with_exporters(client.app, PolygonsOnlyExporter())

    response = client.post(f"/releases/{release}/export", params={"format": "polygons-only"})

    assert response.status_code == 409
    assert response.json()["code"] == "LOSSY_EXPORT_NOT_CONSENTED"
    carried = response.json()["detail"]["compatibility"]
    assert carried["compatible"] is False
    assert carried["excluded_annotations"] > 0
    preview = client.get(
        f"/releases/{release}/export-compatibility", params={"format": "polygons-only"}
    )
    assert carried == preview.json()


def test_the_report_travels_inside_the_archive_as_well(client: TestClient, release: str) -> None:
    with_exporters(client.app, PolygonsOnlyExporter())

    response = exported(client, release, format="polygons-only", allow_lossy="true")

    assert EXPORT_REPORT_FILENAME in _names_in(response.content)
