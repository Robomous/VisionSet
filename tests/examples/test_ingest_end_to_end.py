"""The ingest example, run as a smoke test.

M2's exit criterion turned into a regression guard, the way
``test_sdk_end_to_end.py`` guards M1's: if a source stops registering, a decode
stops deduplicating, or a progress counter stops being written, this fails long
before anyone runs the example by hand. The assertions are about *outcomes* —
how many assets a ten-second clip yields, what a re-run creates, what the job
row says — never about the printed narration, which is free to change.

The example is not part of the ``visionset`` package (it demonstrates the SDK
from outside it), so it is loaded from its path rather than imported by name.
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from tests.fixtures.media import require_ffmpeg

from visionset.kernel.domain import IngestFailureKind, IngestState

# The example generates its own clip and needs the binary to do it. Locally that
# is a skip; in CI, where VISIONSET_REQUIRE_FFMPEG=1, it is an error — a
# silently skipped video test looks exactly like a passing one. This is the
# right use of the fixture module: a *test* may reach into `tests/`, while the
# example it drives deliberately may not.
require_ffmpeg()

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "ingest_end_to_end.py"


@pytest.fixture(scope="module")
def example() -> Iterator[ModuleType]:
    spec = importlib.util.spec_from_file_location("ingest_end_to_end", EXAMPLE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered while it executes so dataclasses and pydantic can resolve the
    # module by name; removed afterwards so the test leaves sys.modules as found.
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        del sys.modules[spec.name]


@pytest.fixture(scope="module")
def summary(example: ModuleType, tmp_path_factory: pytest.TempPathFactory) -> Any:
    return example.main(tmp_path_factory.mktemp("workspace") / "ingest-e2e")


def test_ten_seconds_at_five_frames_a_second_is_fifty_assets(summary: Any) -> None:
    """The milestone's headline number, and it is a count of *distinct* frames.

    Fifty extraction slots and fifty assets only agree because the clip is large
    enough for consecutive frames to differ — content addressing collapses any
    that do not, which is why the example does not use the fixtures' 64x48.
    """
    assert len(summary.asset_ids) == 50
    assert len(set(summary.asset_ids)) == 50


def test_a_clip_reports_its_progress_without_knowing_its_total(summary: Any) -> None:
    """`total` is NULL for a clip by design: `VideoMetadata` carries no frame count."""
    progress = summary.clip_progress
    assert progress.state is IngestState.COMPLETED
    assert progress.processed == 50
    assert progress.total is None
    assert progress.failures == ()


def test_the_batch_partitions_into_two_equal_jobs(summary: Any) -> None:
    """An exact partition: disjoint, and their union is the batch."""
    assert summary.job_sizes == (25, 25)
    assert sum(summary.job_sizes) == len(summary.asset_ids)


def test_re_ingesting_the_same_source_creates_nothing(summary: Any) -> None:
    """Idempotency is a consequence of content addressing, not of bookkeeping."""
    rerun = summary.rerun
    assert rerun.created == 0
    assert rerun.deduplicated == 50
    assert rerun.failed == 0
    assert set(rerun.asset_ids) == set(summary.asset_ids)
    # A second batch, because the first froze at approval. A batch is an
    # ephemeral unit of work and two of them may name the same assets.
    assert rerun.batch_id != summary.clip_batch_id


def test_the_same_clip_at_another_rate_is_a_new_source_of_known_frames(summary: Any) -> None:
    """Decomposition parameters belong to the source; identity belongs to the bytes.

    One clip registered at two rates is two sources — and the coarser one's ten
    frames land exactly on grid points the finer run already produced, so the
    project gains nothing. That alignment holds because the fps filter rounds
    *up* onto the grid; it is a property of this extractor, not a promise
    the port makes about every rate pair.
    """
    assert summary.coarse_source_id != summary.clip_source_id
    assert len(summary.coarse.assets) == 10
    assert summary.coarse.created == 0
    assert set(summary.coarse.asset_ids) <= set(summary.asset_ids)


def test_a_directory_states_its_total_and_reports_what_it_could_not_read(summary: Any) -> None:
    """The other path: countable up front, and one stray file does not fail the run."""
    progress = summary.image_progress
    assert progress.state is IngestState.COMPLETED
    assert progress.total == 4
    assert progress.processed == 4

    images = summary.images
    assert images.created == 3
    assert images.failed == 1
    (failure,) = images.failures
    assert failure.kind is IngestFailureKind.UNSUPPORTED
    assert failure.name.endswith("notes.txt")
    # The report is a table, not a list of sentences: the reason never repeats
    # the name, so a surface can group by kind.
    assert "notes.txt" not in failure.reason


def test_every_asset_carries_a_cached_preview(summary: Any) -> None:
    """Thumbnails, filled at ingest on both paths — frames included."""
    assert summary.asset_count == 53  # 50 frames + 3 stills, counted once each
    assert summary.thumbnailed == summary.asset_count


def test_every_ingest_announced_itself_and_the_first_preceded_the_approval(summary: Any) -> None:
    """Emission follows the commit, so the bus has the whole story in order."""
    events = summary.events
    assert events.count("ingest_completed") == 4
    assert events.count("batch_approved") == 1
    assert events.index("ingest_completed") < events.index("batch_approved")
