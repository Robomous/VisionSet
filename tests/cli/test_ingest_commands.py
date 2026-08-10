"""``visionset ingest`` — one path in, one batch out, and the per-file report.

The two things worth pinning: the **dispatch** on ``is_dir()`` (one command
standing in for two registration methods), and that the failure modes which are
*not* ``VisionSetError`` — a missing path, a non-positive rate, ``--fps`` on a
folder — are refused by Click at exit 2 rather than reaching the kernel and
printing a traceback.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest
from tests.cli._flow import ok, payload, run, schemad_project, stills, workspace
from tests.fixtures.media import require_ffmpeg, write_corrupt_video, write_video

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


# --- refusals Click has to make ----------------------------------------------


def test_a_path_that_is_not_there_exits_two(root: Path, tmp_path: Path) -> None:
    # ``canonical_path`` raises ``FileNotFoundError``, which is not a
    # ``VisionSetError`` and would print a traceback.
    result = run(root, "ingest", str(tmp_path / "absent"), "-p", "road-signs")
    assert result.exit_code == 2, result.output


def test_a_non_positive_rate_exits_two(root: Path, tmp_path: Path) -> None:
    # ``register_video`` raises a bare ``ValueError`` for this, and Typer cannot
    # express ``gt=0`` — hence the explicit check.
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"")
    result = run(root, "ingest", str(clip), "-p", "road-signs", "--fps", "0")
    assert result.exit_code == 2, result.output
    assert "greater than zero" in result.output


def test_fps_on_a_directory_exits_two(root: Path, tmp_path: Path) -> None:
    # A rate has no meaning for stills, and silently ignoring it would let
    # somebody believe they had chosen one.
    result = run(root, "ingest", str(stills(tmp_path)), "-p", "road-signs", "--fps", "5")
    assert result.exit_code == 2, result.output
    assert "directory of stills" in result.output


def test_an_unknown_project_exits_one(root: Path, tmp_path: Path) -> None:
    result = run(root, "ingest", str(stills(tmp_path)), "-p", "nope")
    assert result.exit_code == 1, result.output
    assert result.stdout == ""


# --- a clip ------------------------------------------------------------------


def test_a_video_registers_at_the_rate_it_was_given(root: Path, tmp_path: Path) -> None:
    require_ffmpeg()
    # 96x72 rather than the fixture default: below roughly that, ``testsrc``'s
    # per-frame movement falls under what the encoder resolves, consecutive
    # frames come out byte-identical, and content addressing deduplicates them —
    # which would read as this command losing frames.
    clip = write_video(tmp_path / "clip.mp4", size=(96, 72), fps=10, duration_seconds=2.0)
    document = payload(root, "ingest", str(clip.path), "-p", "road-signs", "--fps", "5")
    assert document["source"]["kind"] == "video"
    assert document["source"]["video"]["extraction_fps"] == 5.0
    assert document["created"] == 10


def test_a_damaged_clip_says_how_much_of_it_arrived(root: Path, tmp_path: Path) -> None:
    """The partial report on stderr, where the person who typed the command is
    looking.

    Not on stdout: that carries the batch id and nothing else, which is what makes
    `BATCH=$(visionset ingest …)` work — and a damaged clip still fills a batch.
    """
    require_ffmpeg()
    clip = write_corrupt_video(tmp_path / "broken.mp4", size=(96, 72), fps=10, duration_seconds=2.0)

    result = run(root, "ingest", str(clip.path), "-p", "road-signs", "--fps", "5")

    assert result.exit_code == 0, result.output
    assert "broken.mp4" in result.stderr
    assert "re-ingest" in result.stderr
    assert "\n" not in result.stdout.strip()


def test_json_carries_the_partial_counts(root: Path, tmp_path: Path) -> None:
    """Wire parity: the CLI's `--json` and the REST job publish the same numbers."""
    require_ffmpeg()
    clip = write_corrupt_video(tmp_path / "broken.mp4", size=(96, 72), fps=10, duration_seconds=2.0)

    document = payload(root, "ingest", str(clip.path), "-p", "road-signs", "--fps", "5")

    assert document["failures"][0]["kind"] == "partial"
    assert document["failures"][0]["frames_produced"] == document["created"] > 0
    assert document["failures"][0]["frames_expected_estimate"] == 10
    # A partial is not a file the run could not read, so it is not in that count.
    assert document["failed"] == 0
    assert document["partial"] == 1


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
