"""The column formatter, on its own.

Pure string functions, so they can be swept without running a command: a ragged
row, a cell wider than its header, a header wider than every cell, and the
trailing-space rule that makes the output diffable.
"""

from __future__ import annotations

import pytest

from visionset.cli._output import row, table, widths


def test_a_column_is_as_wide_as_its_widest_cell() -> None:
    assert widths(("ID", "NAME"), [("1", "alpha"), ("22", "b")]) == [2, 5]


def test_a_column_with_no_rows_is_as_wide_as_its_header() -> None:
    assert widths(("ID", "NAME"), []) == [2, 4]


def test_a_header_wider_than_every_cell_still_sets_the_width() -> None:
    assert widths(("DESCRIPTION",), [("x",)]) == [11]


def test_cells_are_left_justified_and_two_spaces_apart() -> None:
    assert row(("1", "alpha"), [2, 5]) == "1   alpha"


def test_the_last_cell_is_not_padded() -> None:
    # Trailing whitespace would make the output differ from what a person sees
    # and would break a naive equality assertion for no benefit.
    assert row(("1", "a"), [2, 5]) == "1   a"


def test_a_row_with_the_wrong_number_of_cells_raises() -> None:
    # ``strict=True`` on the zip. Silently dropping the extra cell would lose a
    # column from a listing and nothing would say so.
    with pytest.raises(ValueError):
        row(("1", "a", "extra"), [2, 5])


def test_the_header_prints_even_with_no_rows(capsys: pytest.CaptureFixture[str]) -> None:
    # What makes ``| tail -n +2`` stable whether or not anything matched.
    table(("ID", "NAME"), [])
    assert capsys.readouterr().out == "ID  NAME\n"


def test_a_table_prints_its_header_then_its_rows(capsys: pytest.CaptureFixture[str]) -> None:
    table(("ID", "NAME"), [("1", "alpha"), ("22", "b")])
    assert capsys.readouterr().out.splitlines() == ["ID  NAME", "1   alpha", "22  b"]
