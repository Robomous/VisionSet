"""`CuratedModel`: what a provider may offer by name, and what it may not.

A curated list is read while somebody is still choosing, so a wrong entry is not
found by a failure — it is found by a download that fetched something else, or by
a form stating half a requirement and offering the button anyway.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import CuratedModel

#: A real commit, from the checkpoint the connection form defaults to.
COMMIT = "b7320756a13354e7530a63935656d35b2f91a290"


def entry(**overrides: object) -> CuratedModel:
    """A valid entry with one thing changed, so a refusal is attributable."""
    fields: dict[str, object] = {
        "model_id": "facebook/sam2.1-hiera-base-plus",
        "model_revision": COMMIT,
        "family": "sam2_video",
        "hint": "base-plus — the balanced default",
    }
    fields.update(overrides)
    return CuratedModel(**fields)  # type: ignore[arg-type]


def test_a_whole_entry_is_accepted() -> None:
    """Every other test here asserts a refusal; without this one a model that
    refused everything would pass the file."""
    model = entry()
    assert model.model_revision == COMMIT
    assert model.family == "sam2_video"
    assert model.access_note is None


@pytest.mark.parametrize("field", ["model_id", "family", "hint"])
@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_a_field_that_says_nothing_is_refused(field: str, blank: str) -> None:
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
    """The abbreviated hash is the one worth spelling out: it is a real commit and
    still refused, because two revisions can share a prefix."""
    with pytest.raises(ValidationError, match="40-character commit"):
        entry(model_revision=revision)


def test_the_refusal_says_what_a_moving_pointer_costs() -> None:
    """The rule is not guessable from the field name, so the sentence carries the
    reason — and a message asserted only by its code could lose it."""
    with pytest.raises(ValidationError, match="would describe whatever it pointed at last"):
        entry(model_revision="main")


def test_an_access_requirement_is_stated_whole_or_not_at_all() -> None:
    """Half a requirement is worse than none: the form offers the button anyway."""
    with pytest.raises(ValidationError, match="together or not at all"):
        entry(access_note="Meta grants access by request.")
    with pytest.raises(ValidationError, match="together or not at all"):
        entry(access_url="https://huggingface.co/facebook/sam3")


def test_a_gated_entry_carries_both_halves() -> None:
    """The positive path, so the rule above is a pairing and not a ban."""
    model = entry(
        model_id="facebook/sam3",
        access_note="Meta publishes these weights under the SAM License.",
        access_url="https://huggingface.co/facebook/sam3",
    )
    assert model.access_url == "https://huggingface.co/facebook/sam3"


def test_a_size_cannot_be_carried_here() -> None:
    """The retired field, pinned so it cannot come back by habit."""
    with pytest.raises(ValidationError, match="total_bytes"):
        entry(total_bytes=311_949_047)


def test_an_entry_does_not_change_under_whoever_is_holding_it() -> None:
    model = entry()
    with pytest.raises(ValidationError):
        model.family = "grounding-dino"  # type: ignore[misc]
