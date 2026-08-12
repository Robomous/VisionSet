"""The harness that keeps ``exit_code == 2`` assertions honest.

A usage error is a ``typer.BadParameter``, and Typer prints those inside a rich
``Panel`` — unlike ``cli/_errors.py``'s domain errors, which are a plain
``typer.secho`` and cannot wrap. The panel word-wraps, so a phrase can stop being
a substring of the output while remaining perfectly correct on screen.

Two things stop that from being a coin toss, and this module is what holds them
in place. ``_flow.run`` pins the width, so the wrap point is the suite's choice
rather than the terminal's; ``_flow.usage_error`` puts the lines back together,
so an assertion reads the message rather than the layout. Neither is guarded by
the tests that *use* them — a wrap that stops happening reddens nothing — which
is exactly how #535 came to fail under ``pytest -n auto`` and pass under
``pytest``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from click.testing import Result
from tests.cli._flow import NARROW, run, usage_error

from visionset.kernel.services import WORKSPACE_ENV_VAR

WRAPPED = "greater than zero"
"""A phrase the pinned width splits, chosen because nothing about it varies.

``--fps 0`` is refused in the CLI's own words and **interpolates no path**, so the
panel's layout is a function of the pinned width alone. The sibling refusal —
``--fps`` against a folder — embeds ``tmp_path``, whose length moves the wrap
point and differs under xdist, which is the very accident this module exists to
take out of the suite. A guard written on that one fails the way #535 failed.
"""


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


def _refusal(tmp_path: Path) -> Result:
    """A non-positive rate: refused before the workspace is ever opened."""
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"")
    return run(tmp_path / "ws", "ingest", str(clip), "-p", "road-signs", "--fps", "0")


def test_the_panel_is_rendered_at_the_pinned_width(tmp_path: Path) -> None:
    # Rich asks ``os.get_terminal_size`` about the *process's* file descriptors,
    # never the ``CliRunner``'s buffers — so without this pin the panel is as
    # wide as the developer's terminal under a plain ``pytest``, and 80 columns
    # under an xdist worker, whose stdout is a pipe. Same test, two layouts.
    result = _refusal(tmp_path)
    borders = [line for line in result.output.splitlines() if line.startswith(("╭", "│", "╰"))]
    assert borders, result.output
    assert {len(line) for line in borders} == {int(NARROW)}


def test_the_pinned_width_actually_splits_a_phrase_a_test_asserts(tmp_path: Path) -> None:
    # The other half of the pin, and the one that would rot silently: a width
    # that no longer wraps anything leaves every ``usage_error`` call decorative,
    # and nothing else in the suite would notice. This is the assertion that
    # notices.
    assert WRAPPED not in _refusal(tmp_path).output


def test_usage_error_puts_the_split_phrase_back_together(tmp_path: Path) -> None:
    assert WRAPPED in usage_error(_refusal(tmp_path))
