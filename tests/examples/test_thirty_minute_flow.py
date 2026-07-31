"""The thirty-minute flow, run as a smoke test.

M6's exit criterion turned into a regression guard, the way its siblings guard
M1's and M2's. It runs the example **in process**, against the source tree, so
every push pays a second rather than the minute a wheel install costs — the
*wheel* half is CI's `thirty-minute-flow` job, which installs the artifact into
an empty virtual environment and runs the same file.

Two halves, deliberately, because they answer different questions. This one asks
"does the cycle still work?"; that one asks "does what we ship still work?", and
a wheel missing its entry points passes the first and fails the second.

The assertions are about *outcomes* — how many frames a clip yields, how many
boxes reach the dataset, what `data.yaml` says — never about the narration, which
is free to change.
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

# The example generates its own clip. Locally a missing binary is a skip; in CI,
# where VISIONSET_REQUIRE_FFMPEG=1, it is an error — a silently skipped video
# test looks exactly like a passing one. A *test* may reach into `tests/`, while
# the example it drives deliberately may not.
require_ffmpeg()

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "thirty_minute_flow.py"


@pytest.fixture(scope="module")
def example() -> Iterator[ModuleType]:
    spec = importlib.util.spec_from_file_location("thirty_minute_flow", EXAMPLE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    yield module
    del sys.modules[spec.name]


@pytest.fixture(scope="module")
def summary(example: ModuleType, tmp_path_factory: pytest.TempPathFactory) -> Any:
    return example.main(tmp_path_factory.mktemp("thirty-minute-flow"))


def test_the_clip_yields_one_frame_per_box(summary: Any, example: ModuleType) -> None:
    """Fifty is a property of the extraction, not a slice of it.

    Ten seconds at 5 fps is fifty frames, and the flow draws one box on each. If
    the clip ever yields fewer — a smaller frame size would do it, because the
    pattern stops moving enough for consecutive frames to differ and content
    addressing collapses them — the example refuses rather than quietly drawing
    fewer boxes.
    """
    assert summary.asset_count == example.BOX_COUNT
    assert summary.labelled_boxes == example.BOX_COUNT


def test_every_box_reaches_the_dataset(summary: Any, example: ModuleType) -> None:
    """The end-to-end claim in one assertion: fifty drawn, fifty exported.

    Between those two numbers sit the batch gate, the job, the schema version
    each annotation is judged against, the promotion that reads progress, the
    manifest that freezes the labels, and the exporter's own arithmetic.
    """
    assert summary.labelled_boxes == example.BOX_COUNT
    # One label file per asset, including the ones with nothing on them — a
    # missing file means "nobody looked" to a trainer, where an empty one means
    # "somebody looked and there is nothing here".
    assert summary.label_files == summary.asset_count


def test_the_dataset_declares_the_schema_s_classes_in_its_own_order(
    summary: Any, example: ModuleType
) -> None:
    """Not the classes the annotations happened to use, and not the alphabet."""
    assert summary.classes_in_data_yaml == tuple(one.name for one in example.CLASSES)


def test_the_release_verifies_and_names_its_manifest(summary: Any) -> None:
    assert len(summary.manifest_hash) == 64
    assert summary.export_directory.is_dir()


def test_the_flow_finishes_well_inside_its_ceiling(summary: Any, example: ModuleType) -> None:
    """The friction canary. It is minutes wide; this run is seconds.

    Asserted at a tenth of the ceiling here rather than at the ceiling itself:
    this half runs in process on a machine that is not installing anything, so
    the headroom that matters in CI is not the headroom that matters here, and a
    tenth still fails long before the gate would.
    """
    assert summary.seconds < example.WALL_CLOCK_CEILING_SECONDS / 10


def test_every_stage_is_named_and_timed(summary: Any) -> None:
    """Which is what makes a failure actionable rather than a traceback."""
    names = [name for name, _ in summary.stages]
    assert "ingest: decode, hash, store, and fill a batch" in names
    assert any(name.startswith("export as") for name in names)
    assert all(elapsed >= 0 for _, elapsed in summary.stages)
