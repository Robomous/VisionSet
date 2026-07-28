"""The upload staging rules, without HTTP.

`test_wire_models.py`'s shape: these are pure functions with invariants worth
pinning on their own, and asserting them through a request would test the
routing instead. What a route does with the result is `test_sources.py`.
"""

from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path

import pytest
from fastapi import UploadFile

from visionset.server.uploads import FALLBACK_NAME, UPLOADS_DIRNAME, safe_name, stage


def part(name: str | None, content: bytes = b"bytes") -> UploadFile:
    return UploadFile(file=BytesIO(content), filename=name)


# --- naming ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("sent", "expected"),
    [
        ("clip.mp4", "clip.mp4"),
        ("../../etc/passwd", "passwd"),
        ("/absolute/photo.png", "photo.png"),
        (r"C:\Users\me\photo.png", "photo.png"),
        ("  spaced.png  ", "spaced.png"),
    ],
)
def test_a_filename_is_reduced_to_its_last_component(sent: str, expected: str) -> None:
    assert safe_name(sent) == expected


@pytest.mark.parametrize("sent", [None, "", "   ", ".", "..", "../", "evil\x00.png"])
def test_a_filename_that_names_nothing_usable_falls_back(sent: str | None) -> None:
    """Replaced, not refused: a badly named part is not a reason to lose a good upload."""
    assert safe_name(sent) == FALLBACK_NAME


# --- staging -----------------------------------------------------------------


def test_a_staged_part_lands_under_uploads_with_its_bytes(tmp_path: Path) -> None:
    staged = stage(tmp_path, [part("clip.mp4", b"video bytes")])

    assert staged.directory.parent == tmp_path / UPLOADS_DIRNAME
    assert staged.names == ("clip.mp4",)
    assert staged.only.read_bytes() == b"video bytes"


def test_the_same_bytes_under_the_same_name_stage_to_the_same_directory(tmp_path: Path) -> None:
    """What makes a repeated upload return the same `Source` rather than a second one."""
    first = stage(tmp_path, [part("clip.mp4", b"video bytes")])
    second = stage(tmp_path, [part("clip.mp4", b"video bytes")])

    assert first.directory == second.directory
    assert len(list((tmp_path / UPLOADS_DIRNAME).iterdir())) == 1


def test_different_bytes_stage_apart(tmp_path: Path) -> None:
    first = stage(tmp_path, [part("clip.mp4", b"one")])
    second = stage(tmp_path, [part("clip.mp4", b"two")])

    assert first.directory != second.directory


def test_the_same_bytes_under_a_different_name_stage_apart(tmp_path: Path) -> None:
    """The name is inside the digest: a file renamed is a different thing to offer."""
    first = stage(tmp_path, [part("a.png", b"same")])
    second = stage(tmp_path, [part("b.png", b"same")])

    assert first.directory != second.directory


def test_the_order_parts_arrive_in_does_not_fork_the_directory(tmp_path: Path) -> None:
    forward = stage(tmp_path, [part("a.png", b"one"), part("b.png", b"two")])
    backward = stage(tmp_path, [part("b.png", b"two"), part("a.png", b"one")])

    assert forward.directory == backward.directory
    assert forward.names == ("a.png", "b.png")


def test_two_parts_under_one_filename_both_survive(tmp_path: Path) -> None:
    """A directory source reads its files by name, so collapsing them would drop one."""
    staged = stage(tmp_path, [part("photo.png", b"one"), part("photo.png", b"two")])

    assert staged.names == ("photo.png", "photo-2.png")
    assert (staged.directory / "photo.png").read_bytes() == b"one"
    assert (staged.directory / "photo-2.png").read_bytes() == b"two"


def test_a_traversing_filename_cannot_escape_the_staging_directory(tmp_path: Path) -> None:
    staged = stage(tmp_path, [part("../../escaped.png", b"nope")])

    assert staged.names == ("escaped.png",)
    assert not (tmp_path.parent / "escaped.png").exists()


def test_nothing_is_left_behind_under_a_staging_name(tmp_path: Path) -> None:
    """The private directory is a rename away from being the published one."""
    stage(tmp_path, [part("a.png")])

    assert not [
        entry for entry in (tmp_path / UPLOADS_DIRNAME).iterdir() if entry.name.startswith(".")
    ]


def test_the_directory_is_named_for_the_whole_part_set(tmp_path: Path) -> None:
    """Pinned rather than described, so the addressing scheme cannot drift silently."""
    staged = stage(tmp_path, [part("a.png", b"one")])

    content = hashlib.sha256(b"one").hexdigest()
    assert staged.directory.name == hashlib.sha256(f"a.png:{content}\n".encode()).hexdigest()
