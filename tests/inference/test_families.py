"""What kind of model a connection points at, and what that lets it be asked.

Two claims live here, and the second is the one that had never been made before:
that the family is *read* rather than guessed, and that what a client is told a
connection can do is derived from the same sets the adapters are chosen from. A
capability written out by hand beside those sets would be a second encoding, and
the day it fell behind, a model that runs would declare nothing and no client
would offer it.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from visionset.inference import families as families_module
from visionset.inference.families import (
    CAPABILITY_BY_FAMILY,
    DETECTOR_FAMILIES,
    SEGMENTER_FAMILIES,
    SUPPORTED_FAMILIES,
    capabilities_of,
    family_of,
)
from visionset.kernel.domain import ConnectionType, ModelCapability
from visionset.kernel.services import InferenceConnectionService, WorkspaceService


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws", name="families")
    try:
        yield made
    finally:
        made.close()


@pytest.fixture()
def connections(workspace: WorkspaceService) -> InferenceConnectionService:
    return InferenceConnectionService(workspace)


def a_local(connections: InferenceConnectionService) -> Any:
    return connections.create(
        "local",
        connection_type=ConnectionType.LOCAL,
        model_id="some/segmenter",
        model_revision="abc123",
        device="cuda",
        precision="fp16",
    )


# --- the sets themselves ------------------------------------------------------


def test_both_spellings_of_the_one_architecture_are_named() -> None:
    """A set rather than a string, and both members are load-bearing today."""
    assert {"sam2", "sam2_video"} <= SEGMENTER_FAMILIES


def test_the_two_families_are_disjoint_and_are_the_whole_of_what_is_supported() -> None:
    """What the refusal lists is derived, so a family cannot be added to one set
    and forgotten in the message."""
    assert not SEGMENTER_FAMILIES & DETECTOR_FAMILIES
    assert SUPPORTED_FAMILIES == SEGMENTER_FAMILIES | DETECTOR_FAMILIES


# --- reading the family -------------------------------------------------------


def test_an_unreadable_config_answers_empty_rather_than_raising(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reading the config and deciding what to do about it stay separate.

    This function's job is to report what the files say; the refusal for "they
    say nothing" is the resolver's, one level up.
    """

    class Broken:
        class AutoConfig:
            @staticmethod
            def from_pretrained(*_: Any, **__: Any) -> Any:
                raise OSError("nothing in the cache")

    monkeypatch.setattr(families_module, "imported", lambda _: Broken())
    assert family_of(a_local(connections), cache_dir=tmp_path) == ""


def test_the_family_comes_from_the_config_and_never_from_the_model_id(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A model id is something somebody typed; a config is what the publisher wrote.

    The connection here is named ``some/segmenter`` and its config declares a
    detector. Any resolver that read the name would answer the opposite of the
    truth, confidently, and pick the adapter that cannot run it.
    """

    class Detector:
        class AutoConfig:
            @staticmethod
            def from_pretrained(*_: Any, **__: Any) -> Any:
                return type("Config", (), {"model_type": "grounding-dino"})()

    monkeypatch.setattr(families_module, "imported", lambda _: Detector())
    assert family_of(a_local(connections), cache_dir=tmp_path) == "grounding-dino"


def test_a_build_without_the_runtime_cannot_look_and_says_so(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Not folded into the empty string, and the difference is what a caller records.

    "I looked and it declared nothing" is a finding. "I cannot look at all" is
    not, and recording it as one would let a machine that later installs the
    runtime go on believing an answer nobody ever produced.
    """
    from visionset.kernel.errors import LocalInferenceUnavailable

    def _absent(_: str) -> Any:
        raise LocalInferenceUnavailable("no runtime here")

    monkeypatch.setattr(families_module, "imported", _absent)
    with pytest.raises(LocalInferenceUnavailable):
        family_of(a_local(connections), cache_dir=tmp_path)


# --- what a family lets a connection be asked for -----------------------------


@pytest.mark.parametrize("family", sorted(SEGMENTER_FAMILIES))
def test_every_segmenter_family_answers_points(family: str) -> None:
    assert capabilities_of(family) == [ModelCapability.POINT_SUGGEST]


@pytest.mark.parametrize("family", sorted(DETECTOR_FAMILIES))
def test_every_detector_family_answers_words(family: str) -> None:
    assert capabilities_of(family) == [ModelCapability.TEXT_DETECT]


def test_the_mapping_covers_exactly_what_this_build_can_run() -> None:
    """The derivation, asserted rather than trusted.

    A family that has an adapter and no capability is invisible to every client
    that filters on the declaration — the model runs and nothing offers it. A
    capability for a family with no adapter is the opposite lie. Deriving the map
    from the two sets makes both impossible; this is what says so out loud.
    """
    assert set(CAPABILITY_BY_FAMILY) == SUPPORTED_FAMILIES


@pytest.mark.parametrize(
    ("model_family", "why"),
    [
        (None, "nobody has read this connection's config yet"),
        ("", "somebody read it and it declared nothing"),
        ("totally-unknown-net", "this build has no adapter for that type"),
    ],
)
def test_nothing_is_declared_where_nothing_is_known(model_family: str | None, why: str) -> None:
    """Three ways to know nothing, and one answer: declare nothing.

    They are the same answer to a *client*, which is why they collapse here. What
    separates them is the remedy, and a remedy belongs where there is room for a
    sentence rather than in a vocabulary something switches on.
    """
    assert capabilities_of(model_family) == [], why
