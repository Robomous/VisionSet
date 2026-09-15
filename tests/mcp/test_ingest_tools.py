"""``ingest`` / ``list_sources`` / ``backfill_thumbnails``.

``ingest`` is the one tool standing for two parity candidates, so what is
pinned here is chiefly that the refusals happen at this level rather than
reaching the kernel as tracebacks — and, above all, that a video is refused with
a sentence an agent can act on rather than one it will try to work around.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest
from tests.fixtures.media import write_image, write_images, write_unsupported_file
from tests.mcp._flow import call, error, payload, schema

from visionset.kernel.services import IngestService, ProjectService, WorkspaceService


def test_a_directory_of_stills_becomes_one_batch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    write_images(tmp_path / "incoming", count=3)
    result = payload(call("ingest", project=named, path=str(tmp_path / "incoming")))
    assert result["created"] == 3
    assert result["deduplicated"] == 0
    assert result["failed"] == 0
    assert result["source"]["kind"] == "image_directory"
    assert result["batch_id"]


def test_the_run_id_is_not_called_job_id_because_no_tool_can_read_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Observed on a real agent run: `job_id` taken straight to `get_job`.

    It was refused, correctly and unhelpfully — the two words named different
    things and only one of them was reachable, since `get_ingest_job` was
    deliberately dropped. The id still travels, because it is what a support
    conversation about a run is about, but under a name that cannot be mistaken
    for the annotation job `approve_batch` has not cut yet.
    """
    named = schema(monkeypatch, tmp_path)
    write_images(tmp_path / "incoming", count=1)
    result = payload(call("ingest", project=named, path=str(tmp_path / "incoming")))

    assert "job_id" not in result
    assert UUID(result["ingest_job_id"])
    assert error(call("get_job", job_id=result["ingest_job_id"]))["message"]


def test_ingesting_the_same_directory_again_creates_nothing_new(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Registration is idempotent and content addressing does the rest, which is
    # exactly why there is no `resume_ingest` tool: re-running is the remedy.
    named = schema(monkeypatch, tmp_path)
    write_images(tmp_path / "incoming", count=2)
    first = payload(call("ingest", project=named, path=str(tmp_path / "incoming")))
    second = payload(call("ingest", project=named, path=str(tmp_path / "incoming")))
    assert second["created"] == 0
    assert second["deduplicated"] == 2
    assert second["source"]["id"] == first["source"]["id"]


def test_a_file_that_is_not_an_image_is_reported_and_the_run_carries_on(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    write_images(tmp_path / "incoming", count=2)
    write_unsupported_file(tmp_path / "incoming" / "notes.txt")
    result = payload(call("ingest", project=named, path=str(tmp_path / "incoming")))
    assert result["created"] == 2
    assert len(result["failures"]) == 1
    # `IngestFailure.name` is whatever the run's own loop was holding, which for a
    # directory walk is the full path rather than the basename. Worth knowing
    # rather than worth changing: unlike `Source.locator` and `Asset.uri`, which are
    # deliberately unpublished, this one already travels on the wire through
    # `IngestFailureOut` and is the same string the REST API and the CLI report.
    assert result["failures"][0]["name"].endswith("notes.txt")
    assert result["failures"][0]["kind"] == "unsupported"
    assert "notes.txt" not in result["failures"][0]["reason"]


def test_a_missing_path_is_refused_before_any_work(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # `canonical_path` resolves strictly and would raise FileNotFoundError, which
    # is outside the VisionSetError tree and would reach the client as a
    # traceback's text rather than as a refusal.
    named = schema(monkeypatch, tmp_path)
    refusal = error(call("ingest", project=named, path=str(tmp_path / "nowhere")))
    assert "no such path" in refusal["message"]


def test_a_video_is_refused_and_told_where_import_actually_lives(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The refusal this tool exists to make well.

    An agent told only "not supported" goes looking for another route — a second
    tool, a re-encode, a decoder beside the workspace — so the message has to say
    where video import is *and* that there is nothing here to find.
    """
    named = schema(monkeypatch, tmp_path)
    clip = tmp_path / "drive.mp4"
    clip.write_bytes(b"not really a video, and it never gets read")

    message = error(call("ingest", project=named, path=str(clip)))["message"]

    assert "is not a directory" in message
    assert "imported in the browser" in message
    assert "Ingest screen" in message
    assert "No tool here decodes video" in message


def test_a_lone_image_gets_the_same_refusal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The branch is `is_dir()`, not a suffix list, and the sentence stays true."""
    named = schema(monkeypatch, tmp_path)
    photo = write_image(tmp_path / "one.png")

    message = error(call("ingest", project=named, path=str(photo)))["message"]

    assert "directory of still images" in message


def test_the_batch_can_be_named(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    named = schema(monkeypatch, tmp_path)
    write_images(tmp_path / "incoming", count=1)
    result = payload(
        call("ingest", project=named, path=str(tmp_path / "incoming"), batch_name="first pass")
    )
    listed = payload(call("list_batches", project=named))
    assert [b["name"] for b in listed["items"]] == ["first pass"]
    assert listed["items"][0]["id"] == result["batch_id"]


def test_sources_are_listed_without_the_path_they_live_at(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = schema(monkeypatch, tmp_path)
    write_images(tmp_path / "incoming", count=1)
    payload(call("ingest", project=named, path=str(tmp_path / "incoming")))
    listed = payload(call("list_sources", project=named))
    assert listed["total"] == 1
    # `name` is the last component only. The absolute path describes this machine's
    # disk and is not published anywhere.
    assert listed["items"][0]["name"] == "incoming"
    assert "path" not in listed["items"][0]


def test_backfill_reports_a_project_whose_previews_are_already_cached(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Ingest caches a preview for everything it writes, so the ordinary answer is
    # "nothing to do" — idempotent, and not an error.
    named = schema(monkeypatch, tmp_path)
    write_images(tmp_path / "incoming", count=2)
    payload(call("ingest", project=named, path=str(tmp_path / "incoming")))
    report = payload(call("backfill_thumbnails", project=named))
    assert report["examined"] == 0
    assert report["filled"] == []


def test_backfill_fills_a_preview_that_was_never_rendered(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "ws"
    named = schema(monkeypatch, tmp_path)
    write_images(tmp_path / "incoming", count=1)
    payload(call("ingest", project=named, path=str(tmp_path / "incoming")))
    # Clear the cached hash by hand — the state an asset written before the cache
    # existed is in, which is the only thing this tool is for.
    with WorkspaceService.open(root) as service:
        project_id = ProjectService(service).get_by_name(named).id
        with service.unit_of_work() as uow:
            asset = uow.assets.list(project_id)[0]
            uow.assets.update(asset.model_copy(update={"thumbnail_hash": None}))
    report = payload(call("backfill_thumbnails", project=named))
    assert report["examined"] == 1
    assert len(report["filled"]) == 1
    with WorkspaceService.open(root) as service:
        project_id = ProjectService(service).get_by_name(named).id
        refreshed = IngestService(service).asset(project_id, UUID(report["filled"][0]))
        assert refreshed.thumbnail_hash is not None
