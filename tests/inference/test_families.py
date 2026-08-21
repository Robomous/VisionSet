"""What kind of model a connection points at, and what that lets it be asked.

Two claims live here, and the second is the one that had never been made before:
that the family is *read* rather than guessed, and that what a client is told a
connection can do is derived from the same declaration the driver is chosen by. A
capability written out by hand beside that declaration would be a second encoding,
and the day it fell behind, a model that runs would declare nothing and no client
would offer it.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from tests.fixtures.local_inference import require_local_inference

from visionset.inference import families as families_module
from visionset.inference.families import capabilities_of, family_of
from visionset.inference.http_provider import HTTP_FAMILIES
from visionset.inference.registry import capabilities, families_served, registered
from visionset.inference.sam_provider import SAM_FAMILIES
from visionset.inference.stub_provider import STUB_FAMILIES
from visionset.inference.transformers_provider import DINO_FAMILIES
from visionset.kernel.domain import ConnectionType, ModelCapability
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

INSTALLED = registered().providers
_HTTP_POINT_FAMILIES = frozenset(
    family
    for family, capability in HTTP_FAMILIES.items()
    if capability is ModelCapability.POINT_SUGGEST
)
_HTTP_TEXT_FAMILIES = frozenset(
    family
    for family, capability in HTTP_FAMILIES.items()
    if capability is ModelCapability.TEXT_DETECT
)
SEGMENTER_FAMILIES = frozenset(SAM_FAMILIES) | frozenset(STUB_FAMILIES) | _HTTP_POINT_FAMILIES
DETECTOR_FAMILIES = frozenset(DINO_FAMILIES) | _HTTP_TEXT_FAMILIES
SUPPORTED_FAMILIES = families_served(INSTALLED)
"""The three declarations, read back from what is installed.

Named so the assertions below read as they always did, while what they are *about*
has moved: no longer constants this module owns, but the union of what the
discovered drivers declare.
"""


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


def test_every_published_checkpoint_this_build_curates_is_named() -> None:
    """The strings real checkpoints declare, read out of their configs.

    A checkpoint declares the variant it was *published* as rather than the half
    this build asks for, so these are the spellings a resolver actually meets:
    the SAM 2.1 ladder says ``sam2_video`` and ``facebook/sam3`` says
    ``sam3_video``. Missing one sends that model to the detector adapter, which
    then refuses a click with a sentence about text prompts.
    """
    assert {"sam2", "sam2_video", "sam3_video"} <= frozenset(SAM_FAMILIES)


@pytest.mark.parametrize(
    ("family", "what_it_is"),
    [
        ("sam3", "the concept detector nested at detector_config — it answers words"),
        ("sam3_tracker", "a config class no known checkpoint declares"),
        ("sam3_tracker_video", "the video tracker nested at tracker_config"),
    ],
)
def test_the_names_around_the_published_one_are_not_mistaken_for_it(
    family: str, what_it_is: str
) -> None:
    """The three near-misses, and why each is absent. This is a regression test.

    An earlier revision of this register carried ``sam3`` and ``sam3_tracker``,
    derived from the names of the ``transformers`` classes rather than read from a
    config, and the whole feature was unreachable: ``facebook/sam3`` declares
    ``sam3_video`` at the top level and neither of those anywhere a resolver
    looks. Every test agreed, because they had all been written against the same
    guess the implementation made.

    ``sam3`` is the worse of the two to admit. It is what the *detector* half
    declares, so serving it here would hand a text-prompt model to the point
    adapter — the confident wrong answer this module's opening warns about, rather
    than a gap somebody notices.
    """
    assert family not in SAM_FAMILIES, what_it_is


def test_the_nested_halves_of_a_config_are_not_offered_as_models() -> None:
    """A register of whole models, so an encoder half is refused rather than loaded.

    The runtime registers a ``model_type`` for every nested piece of these
    architectures as well as for the wholes. A connection naming one of those is
    something the resolver must decline; admitting it here would hand the adapter
    a config with no mask decoder in it and turn a refusal into a failure inside a
    forward pass.
    """
    halves = {
        "sam2_vision_model",
        "sam2_hiera_det_model",
        "sam3_vision_model",
        "sam3_mask_decoder",
        "sam3_detr_decoder",
    }
    assert not halves & SUPPORTED_FAMILIES


def test_the_two_families_are_disjoint_and_are_the_whole_of_what_is_supported() -> None:
    """What the refusal lists is what the installed drivers declare, so a family
    cannot be added to a driver and forgotten in the message.

    Disjointness is now a property of the *installation* rather than of two
    constants: two drivers claiming one family is refused at resolution, and here
    it would show as the point and text sets overlapping."""
    assert not SEGMENTER_FAMILIES & DETECTOR_FAMILIES
    assert SUPPORTED_FAMILIES == SEGMENTER_FAMILIES | DETECTOR_FAMILIES


# --- reading the family -------------------------------------------------------


def a_snapshot(cache_dir: Path, declaring: object) -> None:
    """Lay down the cache entry ``a_local``'s connection points at.

    A real snapshot in the hub's real layout, written rather than doubled: the
    thing worth proving is what this reads off a disk, and a fake reader agrees
    with whatever the test already believes.

    Every test that calls this needs the runtime, and calls
    ``require_local_inference`` first — not because reading a JSON file is heavy,
    but because :func:`family_of` refuses before it looks when the extra is
    absent, so on a base install there is no reading behaviour to assert. That
    refusal has its own test below, which runs everywhere.
    """
    snapshot = cache_dir / "models--some--segmenter" / "snapshots" / "deadbeef"
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / "config.json").write_text(json.dumps(declaring), encoding="utf-8")
    refs = cache_dir / "models--some--segmenter" / "refs"
    refs.mkdir(parents=True, exist_ok=True)
    (refs / "abc123").write_text("deadbeef", encoding="utf-8")


def test_an_unreadable_config_answers_empty_rather_than_raising(
    connections: InferenceConnectionService, tmp_path: Path
) -> None:
    """Reading the config and deciding what to do about it stay separate.

    This function's job is to report what the files say; the refusal for "they
    say nothing" is the resolver's, one level up. Nothing is written to the cache
    here, so there is no config to read at all.
    """
    require_local_inference()
    assert family_of(a_local(connections), cache_dir=tmp_path) == ""


def test_a_config_that_is_not_json_answers_empty_too(
    connections: InferenceConnectionService, tmp_path: Path
) -> None:
    """Damaged files are the other half of "it cannot say", and must not raise.

    The file is present, so the lookup succeeds and the parse is what fails —
    the path a truncated download leaves behind.
    """
    require_local_inference()
    snapshot = tmp_path / "models--some--segmenter" / "snapshots" / "deadbeef"
    snapshot.mkdir(parents=True)
    (snapshot / "config.json").write_text("{not json", encoding="utf-8")
    (tmp_path / "models--some--segmenter" / "refs").mkdir(parents=True)
    (tmp_path / "models--some--segmenter" / "refs" / "abc123").write_text("deadbeef")
    assert family_of(a_local(connections), cache_dir=tmp_path) == ""


def test_the_family_comes_from_the_config_and_never_from_the_model_id(
    connections: InferenceConnectionService, tmp_path: Path
) -> None:
    """A model id is something somebody typed; a config is what the publisher wrote.

    The connection here is named ``some/segmenter`` and its config declares a
    detector. Any resolver that read the name would answer the opposite of the
    truth, confidently, and pick the adapter that cannot run it.
    """
    require_local_inference()
    a_snapshot(tmp_path, {"model_type": "grounding-dino"})
    assert family_of(a_local(connections), cache_dir=tmp_path) == "grounding-dino"


def test_a_family_no_library_here_registers_is_still_read(
    connections: InferenceConnectionService, tmp_path: Path
) -> None:
    """The declaration is read, not resolved — which is what makes discovery open.

    ``transformers`` can only name a type it registers itself, so resolving
    through it silently closes the set of legible families to the set one library
    knows. A driver installed from outside this distribution serves families that
    are in no such set, and its connections would then be refused with "the
    downloaded config does not say what model type it is" while the config in
    front of the reader declares exactly what they have.
    """
    require_local_inference()
    a_snapshot(tmp_path, {"model_type": "acme_seg"})
    assert family_of(a_local(connections), cache_dir=tmp_path) == "acme_seg"


def test_a_build_without_the_runtime_cannot_look_and_says_so(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Not folded into the empty string, and the difference is what a caller records.

    "I looked and it declared nothing" is a finding. "I cannot look at all" is
    not, and recording it as one would let a machine that later installs the
    runtime go on believing an answer nobody ever produced.

    A readable config is laid down first, so the refusal is the absent runtime
    and not an empty cache the assertion would have been satisfied by anyway.
    """
    from visionset.kernel.errors import LocalInferenceUnavailable

    a_snapshot(tmp_path, {"model_type": "grounding-dino"})

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
    assert set(capabilities(INSTALLED)) == SUPPORTED_FAMILIES


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
