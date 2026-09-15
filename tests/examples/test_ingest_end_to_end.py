"""The ingest example, run as a smoke test.

M2's exit criterion turned into a regression guard, the way
``test_sdk_end_to_end.py`` guards M1's: if a source stops registering, a decode
stops deduplicating, or a progress counter stops being written, this fails long
before anyone runs the example by hand. The assertions are about *outcomes* —
how many assets a folder of stills yields, what a re-run creates, what the job
row says — never about the printed narration, which is free to change.

**It needs no media binary**, and neither does the example. Video is imported in
a browser now, so there is no clip to generate and no decoder to gate on: a
contributor with nothing but Python on PATH runs this.

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

from visionset.kernel.domain import IngestFailureKind, IngestState

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


def test_a_folder_of_fifty_photographs_is_fifty_assets(summary: Any) -> None:
    """The milestone's headline number, and it is a count of *distinct* images.

    Fifty files and fifty assets only agree because the stills differ from each
    other — content addressing collapses any that do not, which is why the
    example's pixels are seeded per index rather than repeated.
    """
    assert len(summary.asset_ids) == 50
    assert len(set(summary.asset_ids)) == 50


def test_a_directory_states_its_total_and_reports_what_it_could_not_read(summary: Any) -> None:
    """Countable up front, and one stray file does not fail the run."""
    progress = summary.progress
    assert progress.state is IngestState.COMPLETED
    assert progress.total == 51  # fifty photographs and the stray note
    assert progress.processed == 51

    (failure,) = progress.failures
    assert failure.kind is IngestFailureKind.UNSUPPORTED
    assert failure.name.endswith("notes.txt")
    # The report is a table, not a list of sentences: the reason never repeats
    # the name, so a surface can group by kind.
    assert "notes.txt" not in failure.reason


def test_the_batch_partitions_into_two_equal_jobs(summary: Any) -> None:
    """An exact partition: disjoint, and their union is the batch."""
    assert summary.job_sizes == (25, 25)
    assert sum(summary.job_sizes) == len(summary.asset_ids)


def test_re_ingesting_the_same_source_creates_nothing(summary: Any) -> None:
    """Idempotency is a consequence of content addressing, not of bookkeeping."""
    rerun = summary.rerun
    assert rerun.created == 0
    assert rerun.deduplicated == 50
    assert rerun.failed == 1  # the stray note is reported every run, not remembered
    assert set(rerun.asset_ids) == set(summary.asset_ids)
    # A second batch, because the first froze at approval. A batch is an
    # ephemeral unit of work and two of them may name the same assets.
    assert rerun.batch_id != summary.batch_id


def test_a_second_folder_is_a_new_source_of_partly_known_bytes(summary: Any) -> None:
    """Origin belongs to the source; identity belongs to the bytes.

    Two folders are two sources, and the overlap between them is not new data:
    the frames the second shares with the first collapse onto the assets that
    already exist, keeping the origin of the first sighting.
    """
    assert summary.second_source_id != summary.source_id
    assert len(summary.second.assets) == 10
    assert summary.second.created == 8
    assert summary.second.deduplicated == 2


def test_every_asset_carries_a_cached_preview(summary: Any) -> None:
    """Thumbnails, filled at ingest for every image the run stored."""
    assert summary.asset_count == 58  # 50 + 8 new in the second folder
    assert summary.thumbnailed == summary.asset_count


def test_every_ingest_announced_itself_and_the_first_preceded_the_approval(summary: Any) -> None:
    """Emission follows the commit, so the bus has the whole story in order."""
    events = summary.events
    assert events.count("ingest_completed") == 3
    assert events.count("batch_approved") == 1
    assert events.index("ingest_completed") < events.index("batch_approved")
