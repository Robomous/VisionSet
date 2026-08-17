"""`CuratedModel`: what a provider may offer by name, and what it may not.

Every rule here exists because the alternative is an entry that *looks* right on
screen. A curated list is read while somebody is still choosing, so a wrong entry
is not discovered by a failure — it is discovered by a download that fetched
something else, or by a form stating half a requirement and offering the button
anyway.

The revision rule carries most of the weight. It is the one that makes the rest of
an entry true: a pinned snapshot has one config, one family and one size, so an
entry that pinned a branch would be describing whatever that branch pointed at
when somebody last looked.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import CuratedModel

#: A real commit, from the checkpoint the connection form has defaulted to.
COMMIT = "b7320756a13354e7530a63935656d35b2f91a290"


def entry(**overrides: object) -> CuratedModel:
    """A valid entry, with whatever the case under test wants changed.

    A helper rather than a fixture because most cases change one field and assert
    the model refuses it: building from a known-good baseline is what makes the
    refusal attributable to that one change.
    """
    fields: dict[str, object] = {
        "model_id": "facebook/sam2.1-hiera-base-plus",
        "model_revision": COMMIT,
        "family": "sam2_video",
        "hint": "base-plus — the balanced default",
    }
    fields.update(overrides)
    return CuratedModel(**fields)  # type: ignore[arg-type]


def test_a_whole_entry_is_accepted() -> None:
    """The positive path, and it is not optional.

    Every other test in this file asserts a refusal. Without this one, a model
    that refused *everything* would pass the file — which is the shape of a
    broken validator rather than a strict one.
    """
    model = entry()
    assert model.model_id == "facebook/sam2.1-hiera-base-plus"
    assert model.model_revision == COMMIT
    assert model.family == "sam2_video"
    assert model.access_note is None
    assert model.access_url is None


@pytest.mark.parametrize("field", ["model_id", "family", "hint"])
@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_a_field_that_says_nothing_is_refused(field: str, blank: str) -> None:
    """Whitespace is not a value, in any of the three fields that must speak."""
    with pytest.raises(ValidationError, match="non-blank"):
        entry(**{field: blank})


@pytest.mark.parametrize(
    "revision",
    [
        pytest.param("main", id="a branch"),
        pytest.param("v1.0", id="a tag"),
        pytest.param(COMMIT[:7], id="an abbreviated hash"),
        pytest.param(COMMIT.upper(), id="upper-case hex"),
        pytest.param("g" * 40, id="forty characters that are not hex"),
        pytest.param(COMMIT + "0", id="forty-one characters"),
        pytest.param("", id="nothing at all"),
    ],
)
def test_a_revision_that_is_not_a_commit_is_refused(revision: str) -> None:
    """Each of these is a way of naming something that is not a snapshot.

    The abbreviated hash is the one worth spelling out: it is a real commit and it
    is still refused, because two revisions can share a prefix and the entry would
    then be ambiguous rather than merely stale.
    """
    with pytest.raises(ValidationError, match="40-character commit"):
        entry(model_revision=revision)


def test_the_refusal_says_what_a_moving_pointer_costs() -> None:
    """A reader who pinned a branch is told why, not only that.

    The rule is not guessable from the field name, so the sentence carries the
    reason — and a message asserted only by its code would let that reason be
    edited away without anything noticing.
    """
    with pytest.raises(ValidationError, match="would describe whatever it pointed at last"):
        entry(model_revision="main")


def test_an_access_requirement_is_stated_whole_or_not_at_all() -> None:
    """Half a requirement is worse than none: the form offers the button anyway."""
    with pytest.raises(ValidationError, match="together or not at all"):
        entry(access_note="Meta grants access by request.")
    with pytest.raises(ValidationError, match="together or not at all"):
        entry(access_url="https://huggingface.co/facebook/sam3")


def test_a_gated_entry_carries_both_halves() -> None:
    """The positive path for the pair, so the rule above is a pairing and not a ban."""
    model = entry(
        model_id="facebook/sam3",
        access_note="Meta publishes these weights under the SAM License.",
        access_url="https://huggingface.co/facebook/sam3",
    )
    assert model.access_note is not None
    assert model.access_url == "https://huggingface.co/facebook/sam3"


def test_a_size_cannot_be_carried_here() -> None:
    """The retired field, pinned so it cannot come back by habit.

    A download's cost is read live and ahead of the confirmation. An entry
    carrying its own copy would be a second encoding that only ever gets read
    while somebody is still deciding — so nothing would notice it going stale.
    """
    with pytest.raises(ValidationError, match="total_bytes"):
        entry(total_bytes=311_949_047)


def test_an_entry_does_not_change_under_whoever_is_holding_it() -> None:
    """Frozen, because a provider's declaration is read by more than one caller."""
    model = entry()
    with pytest.raises(ValidationError):
        model.family = "grounding-dino"  # type: ignore[misc]
