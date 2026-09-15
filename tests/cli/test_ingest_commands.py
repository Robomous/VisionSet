"""``visionset ingest`` — one directory in, one batch out, and the per-file report.

The two things worth pinning: that a **video is refused here by name**, pointing
at browser import rather than falling back to anything, and that the failure
modes which are *not* ``VisionSetError`` — a missing path, a file where a
directory belongs — are refused by Click at exit 2 rather than reaching the
kernel and printing a traceback.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest
from tests.cli._flow import (
    ok,
    payload,
    run,
    schemad_project,
    stills,
    usage_error,
    workspace,
)

from visionset.kernel.domain import SourceKind
from visionset.kernel.services import (
    WORKSPACE_ENV_VAR,
    BatchService,
    ProjectService,
    SourceService,
    WorkspaceService,
)


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    root = workspace(tmp_path)
    schemad_project(root, tmp_path)
    return root


def _sources(root: Path) -> list[SourceKind]:
    with WorkspaceService.open(root) as service:
        project = ProjectService(service).get_by_name("road-signs")
        return [s.kind for s in SourceService(service).list(project.id)]


def _batch_size(root: Path, batch: str) -> int:
    with WorkspaceService.open(root) as service:
        return len(BatchService(service).assets(UUID(batch)))


# --- a directory of stills ---------------------------------------------------


def test_the_batch_id_is_the_only_thing_on_stdout(root: Path, tmp_path: Path) -> None:
    result = run(root, "ingest", str(stills(tmp_path)), "-p", "road-signs")
    assert result.exit_code == 0, result.output
    assert "\n" not in result.stdout.strip()
    assert _batch_size(root, result.stdout.strip()) == 6


def test_a_directory_registers_as_an_image_source(root: Path, tmp_path: Path) -> None:
    ok(root, "ingest", str(stills(tmp_path)), "-p", "road-signs")
    assert _sources(root) == [SourceKind.IMAGE_DIRECTORY]


def test_the_batch_takes_the_sources_name_by_default(root: Path, tmp_path: Path) -> None:
    ok(root, "ingest", str(stills(tmp_path)), "-p", "road-signs")
    rows = ok(root, "batch", "list", "-p", "road-signs").splitlines()
    assert rows[1].split()[1] == "incoming"


def test_batch_name_overrides_it(root: Path, tmp_path: Path) -> None:
    ok(root, "ingest", str(stills(tmp_path)), "-p", "road-signs", "--batch-name", "day-one")
    rows = ok(root, "batch", "list", "-p", "road-signs").splitlines()
    assert rows[1].split()[1] == "day-one"


def test_a_file_that_is_not_an_image_is_reported_and_the_run_carries_on(
    root: Path, tmp_path: Path
) -> None:
    result = run(root, "ingest", str(stills(tmp_path, stray=True)), "-p", "road-signs")
    assert result.exit_code == 0, result.output
    assert "notes.txt" in result.stderr
    assert _batch_size(root, result.stdout.strip()) == 6


def test_json_carries_the_counts_and_the_failures(root: Path, tmp_path: Path) -> None:
    document = payload(root, "ingest", str(stills(tmp_path, stray=True)), "-p", "road-signs")
    assert document["created"] == 6
    assert document["deduplicated"] == 0
    assert document["failed"] == 1
    assert document["failures"][0]["kind"] == "unsupported"
    assert document["source"]["kind"] == "image_directory"


def test_ingesting_the_same_folder_twice_creates_no_new_assets(root: Path, tmp_path: Path) -> None:
    # Registration is idempotent and content addressing does the rest, which is
    # why an interrupted run needs no ``--resume``: you run the same line again.
    folder = stills(tmp_path)
    ok(root, "ingest", str(folder), "-p", "road-signs")
    document = payload(root, "ingest", str(folder), "-p", "road-signs")
    assert document["created"] == 0
    assert document["deduplicated"] == 6
    assert _sources(root) == [SourceKind.IMAGE_DIRECTORY]


# --- --start: ingest, approve, start, in one line ----------------------------


def _state(root: Path, name: str, batch: str) -> str:
    listed = {row["id"]: row for row in payload(root, "batch", "list", "-p", name)["items"]}
    return str(listed[batch]["state"])


def test_start_opens_the_batch_it_filled_and_reports_every_step(root: Path, tmp_path: Path) -> None:
    result = run(root, "ingest", str(stills(tmp_path)), "-p", "road-signs", "--start")

    assert result.exit_code == 0, result.output
    batch = result.stdout.strip()
    assert "\n" not in batch
    assert "Ingested 6 new and 0 already-known assets" in result.stderr
    assert "Approved batch 'incoming' against schema version 1, in 1 job(s)." in result.stderr
    assert f"Batch {batch} is now in_annotation." in result.stderr
    assert _state(root, "road-signs", batch) == "in_annotation"


def test_start_json_prints_the_started_batch(root: Path, tmp_path: Path) -> None:
    document = payload(root, "ingest", str(stills(tmp_path)), "-p", "road-signs", "--start")
    assert document["state"] == "in_annotation"
    assert document["schema_version"] == 1
    assert document["asset_count"] == 6
    assert _state(root, "road-signs", document["id"]) == "in_annotation"


def test_start_without_a_schema_names_the_step_that_refused_and_the_draft_it_left(
    root: Path, tmp_path: Path
) -> None:
    """The ingest has already committed when approve refuses, so the batch exists
    and the output has to say so — the refusal's sentence alone would leave a
    reader guessing whether anything was written."""
    ok(root, "project", "create", "bare")

    result = run(root, "ingest", str(stills(tmp_path)), "-p", "bare", "--start")

    assert result.exit_code == 1, result.output
    assert result.stdout == ""
    assert "Error:" in result.stderr
    listed = payload(root, "batch", "list", "-p", "bare")["items"]
    assert [b["state"] for b in listed] == ["draft"]
    assert f"The approve step refused; batch {listed[0]['id']} is draft." in result.stderr


# --- refusals Click has to make ----------------------------------------------


def test_a_path_that_is_not_there_exits_two(root: Path, tmp_path: Path) -> None:
    # ``canonical_path`` raises ``FileNotFoundError``, which is not a
    # ``VisionSetError`` and would print a traceback.
    result = run(root, "ingest", str(tmp_path / "absent"), "-p", "road-signs")
    assert result.exit_code == 2, result.output


def test_a_video_is_refused_and_told_where_import_lives(root: Path, tmp_path: Path) -> None:
    """The one refusal this command exists to make well.

    A usage error, not a traceback and not a fallback: nothing in this process
    decodes video, so the answer has to name the screen that does. The message is
    asserted because "unsupported" on its own would send somebody looking for a
    flag that is never coming.
    """
    clip = tmp_path / "drive.mp4"
    clip.write_bytes(b"not really a video, and it never gets read")

    result = run(root, "ingest", str(clip), "-p", "road-signs")

    assert result.exit_code == 2, result.output
    message = usage_error(result)
    assert "is not a directory" in message
    assert "imported in the browser" in message
    assert "visionset server" in message
    assert "Ingest screen" in message


def test_a_file_that_is_not_a_video_gets_the_same_refusal(root: Path, tmp_path: Path) -> None:
    """The branch is ``is_dir()``, not a suffix list — and the sentence stays true.

    Pointing ``ingest`` at one photograph has always been a mistake; it is the
    folder that is the source. The message says "a directory of still images",
    which answers this case as well as the clip one.
    """
    directory = stills(tmp_path)
    single = next(iter(sorted(directory.iterdir())))

    result = run(root, "ingest", str(single), "-p", "road-signs")

    assert result.exit_code == 2, result.output
    assert "directory of still images" in usage_error(result)


def test_an_unknown_project_exits_one(root: Path, tmp_path: Path) -> None:
    result = run(root, "ingest", str(stills(tmp_path)), "-p", "nope")
    assert result.exit_code == 1, result.output
    assert result.stdout == ""


# --- the preview backfill ----------------------------------------------------


def test_backfill_reports_a_project_whose_previews_are_already_there(
    root: Path, tmp_path: Path
) -> None:
    # Ingest caches a preview per asset, so the backfill is a no-op — and its
    # report says examined 0 rather than pretending to have done work.
    ok(root, "ingest", str(stills(tmp_path)), "-p", "road-signs")
    document = payload(root, "backfill-thumbnails", "-p", "road-signs")
    assert document["examined"] == 0
    assert document["filled"] == []
    assert document["unreadable"] == []


def test_backfill_says_what_it_examined_on_stderr(root: Path, tmp_path: Path) -> None:
    ok(root, "ingest", str(stills(tmp_path)), "-p", "road-signs")
    result = run(root, "backfill-thumbnails", "-p", "road-signs")
    assert result.exit_code == 0, result.output
    assert "Examined 0 asset(s)" in result.stderr
