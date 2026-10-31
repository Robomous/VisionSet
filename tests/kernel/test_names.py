"""The write-time limits on names and release tags (#969)."""

from __future__ import annotations

import pytest

from visionset.kernel.domain import derived_name, normalize_name, normalize_release_tag
from visionset.kernel.errors import InvalidName


@pytest.mark.parametrize("name", ["a\nb", "a\tb", "a\x00b", "a b", "x" * 256])
def test_a_name_that_breaks_a_listing_is_refused_on_write(name: str) -> None:
    with pytest.raises(InvalidName):
        normalize_name(name, what="project")


@pytest.mark.parametrize("name", ["x" * 255, "road signs", "señales", "🚗 cars"])
def test_ordinary_names_still_pass(name: str) -> None:
    assert normalize_name(name, what="project") == name


@pytest.mark.parametrize("name", ["a\nb", "x" * 5000])
def test_a_lookup_still_reaches_a_name_stored_before_the_rule(name: str) -> None:
    assert normalize_name(name, what="project", lookup=True) == name


@pytest.mark.parametrize("tag", ["../../evil", "a/b", "a b", ".hidden", "-v1", "x" * 129, "v\n1"])
def test_a_tag_that_is_not_a_portable_slug_is_refused(tag: str) -> None:
    with pytest.raises(InvalidName):
        normalize_release_tag(tag)


@pytest.mark.parametrize("tag", ["v1", "V1.0", "2026-10-31", "v1.0+build_2", "x" * 128])
def test_ordinary_tags_still_pass(tag: str) -> None:
    assert normalize_release_tag(tag) == tag


def test_a_tag_lookup_skips_the_slug_rule() -> None:
    assert normalize_release_tag("a/b", lookup=True) == "a/b"


def test_a_derived_name_is_made_storable_rather_than_refused() -> None:
    assert derived_name("dash\tcam\n", what="batch") == "dash cam"
    assert derived_name("x" * 300, what="batch") == "x" * 255
    with pytest.raises(InvalidName):
        derived_name("\t\n", what="batch")
