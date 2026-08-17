"""What the runtime's presence decides, and the adapter's tensor-to-domain half.

Two subjects, both reachable without a GPU:

- the half of `provider_for` that turns on whether the optional runtime is
  installed here — the refusal that names the install command when it is not,
  and structural conformance to the port when it is. The refusals that turn on
  the *connection* instead are `test_providers.py`'s, beside the resolution
  they belong to;
- `regions_from`, the conversion the adapter does after a forward — the one part
  of running a model that can be wrong in a way no weights are needed to see.

What is deliberately *not* here is a real forward pass. That needs the extra, a
GPU and gigabytes of weights, and a test that mocked all three would be asserting
against its own fixture. The forward's one measured hazard has its own file:
`test_fp16.py`.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from tests.fixtures.local_inference import require_local_inference, without_the_extra
from tests.inference.stubs import PNG, Inputs, StubTorch

from visionset.inference import LocalTransformersProvider, provider_for, transformers_provider
from visionset.inference import providers as providers_module
from visionset.inference.nms import DEFAULT_IOU_THRESHOLD
from visionset.inference.transformers_provider import prompt_text, regions_from
from visionset.kernel.domain import (
    ConnectionSetupState,
    ConnectionType,
    InferenceConnection,
    PointPrompt,
    PredictionRequest,
    PredictionTarget,
    TextPrompt,
)
from visionset.kernel.errors import (
    InferenceOutOfMemory,
    LocalInferenceUnavailable,
    UnsupportedPrompt,
)
from visionset.kernel.ports import ModelProvider


def local(
    setup_state: ConnectionSetupState = ConnectionSetupState.NOT_SET_UP,
) -> InferenceConnection:
    return InferenceConnection(
        name="local-gd",
        connection_type=ConnectionType.LOCAL,
        model_id="some/model",
        model_revision="abc123",
        device="cuda",
        precision="fp16",
        setup_state=setup_state,
    )


# --- resolving a connection to something that can answer ----------------------


@without_the_extra
def test_a_ready_connection_without_the_runtime_names_the_install_command(
    tmp_path: Path,
) -> None:
    """The missing-extra refusal, unstubbed, in the kernel's vocabulary.

    An `ImportError` reaching a caller would be an exception from outside the
    kernel's tree, which is the rule `ReleaseService._read_manifest` states and
    `_extra.imported` keeps one layer out.
    """
    with pytest.raises(LocalInferenceUnavailable) as raised:
        provider_for(local(ConnectionSetupState.READY), workspace_root=tmp_path)
    assert 'pip install "visionset[local-inference]"' in str(raised.value)


def test_a_ready_local_connection_resolves_to_a_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Structural conformance, asserted on the instance.

    `isinstance` against a `Protocol` works on an instance and not on a class
    carrying data members — the distinction `formats/registry.py` already
    documents — so this is the strongest form the check can take.

    The declared family is stubbed because `tmp_path` holds no weights and there
    is nothing to read one from. That is refused rather than resolved
    to a fallback, so a real config is now the difference between this test
    building a provider and it exercising the refusal that has its own test.
    """
    require_local_inference()

    monkeypatch.setattr(providers_module, "family_of", lambda *_, **__: "grounding-dino")
    built = provider_for(local(ConnectionSetupState.READY), workspace_root=tmp_path)
    assert isinstance(built, ModelProvider)


def test_building_a_provider_loads_no_weights(tmp_path: Path) -> None:
    """Construction is cheap, so asking "could this run?" is cheap.

    The model is read on the first `predict` and not before, which is what lets a
    surface build one to answer a question rather than to do work.
    """
    built = LocalTransformersProvider(
        "some/model",
        "abc123",
        device="cpu",
        precision=None,
        cache_dir=tmp_path,
    )
    assert built.model_ref == "some/model@abc123"


def test_the_model_ref_pairs_the_id_with_the_revision(tmp_path: Path) -> None:
    """What every answer is stamped with, and what an annotation will carry.

    A bare id would make "which model produced this label" unanswerable the
    moment the pointer moved, which is the whole reason the revision is required
    on the connection.
    """
    built = LocalTransformersProvider(
        "IDEA-Research/grounding-dino-base",
        "deadbeef",
        device="cpu",
        precision=None,
        cache_dir=tmp_path,
    )
    assert built.model_ref == "IDEA-Research/grounding-dino-base@deadbeef"


# --- prompts ------------------------------------------------------------------


def test_a_detector_refuses_a_pointing_prompt(tmp_path: Path) -> None:
    """Refused rather than approximated, and refused before anything is loaded.

    A detector handed points has not been asked a harder question; it has been
    asked a different one, and guessing which box the click meant would invent an
    answer nobody could check.
    """
    built = LocalTransformersProvider(
        "some/model", "abc123", device="cpu", precision=None, cache_dir=tmp_path
    )
    request = PredictionRequest(
        targets=(
            PredictionTarget(asset_id=uuid4(), content=b"not a real image", media_type="image/png"),
        ),
        prompt=PointPrompt(positive=((10.0, 20.0),)),
    )
    with pytest.raises(UnsupportedPrompt):
        next(built.predict(request))


def test_phrases_become_the_punctuation_the_tokenizer_was_trained_on() -> None:
    """Model-specific spelling, at the model-specific end.

    The port carries a tuple of phrases because that is what a caller means.
    Turning it into one lowercase full-stopped string is this family of
    detector's convention and belongs nowhere near the kernel.
    """
    assert prompt_text(TextPrompt(phrases=("Dog", " cat "))) == "dog. cat."


# --- raw output to domain regions ---------------------------------------------


def convert(
    boxes: list[list[float]],
    scores: list[float],
    labels: list[str],
    *,
    minimum_confidence: float = 0.0,
    iou_threshold: float | None = DEFAULT_IOU_THRESHOLD,
) -> tuple:
    return regions_from(
        boxes,
        scores,
        labels,
        minimum_confidence=minimum_confidence,
        iou_threshold=iou_threshold,
    )


def test_corner_boxes_become_a_corner_and_a_size() -> None:
    """The post-processor's convention is not the domain's."""
    (one,) = convert([[10.0, 20.0, 40.0, 60.0]], [0.9], ["dog"])
    assert (one.geometry.x, one.geometry.y) == (10.0, 20.0)
    assert (one.geometry.width, one.geometry.height) == (30.0, 40.0)
    assert one.label == "dog"
    assert one.confidence == 0.9


def test_a_degenerate_box_is_dropped_rather_than_raising() -> None:
    """The domain refuses a zero-area box, and one bad detection must not cost
    every good one beside it."""
    kept = convert(
        [[10.0, 20.0, 10.0, 60.0], [0.0, 0.0, 5.0, 5.0]],
        [0.9, 0.8],
        ["dog", "cat"],
    )
    assert [one.label for one in kept] == ["cat"]


def test_a_confidence_just_over_one_is_clamped_rather_than_refused() -> None:
    """Float arithmetic, not meaning: the domain's [0, 1] bound is about the
    second and a model answering 1.0000001 is doing the first."""
    (one,) = convert([[0.0, 0.0, 5.0, 5.0]], [1.0000001], ["dog"])
    assert one.confidence == 1.0


def test_answers_below_the_requested_floor_do_not_come_back() -> None:
    kept = convert(
        [[0.0, 0.0, 5.0, 5.0], [100.0, 100.0, 105.0, 105.0]],
        [0.9, 0.1],
        ["dog", "cat"],
        minimum_confidence=0.5,
    )
    assert [one.label for one in kept] == ["dog"]


def test_duplicate_detections_are_suppressed_before_they_leave_the_adapter() -> None:
    """**The mutation gate for the second spike finding.**

    Three boxes over one instance is what the Phase 0 run measured at usable
    thresholds, measured. This test goes red the moment the
    suppression call is dropped from `regions_from` — which is the failure that
    would otherwise reach a write gate as three labels on one dog and be noticed
    only in a count somebody did not trust.
    """
    kept = convert(
        [[10.0, 10.0, 50.0, 50.0], [12.0, 11.0, 51.0, 49.0], [11.0, 12.0, 49.0, 51.0]],
        [0.7, 0.9, 0.6],
        ["dog", "dog", "dog"],
    )
    assert len(kept) == 1
    assert kept[0].confidence == 0.9


def test_suppression_can_be_turned_off_but_is_not_off_by_default() -> None:
    """Configurable, per the finding; on by default, because the finding is
    that raw output is not usable without it."""
    raw = convert(
        [[10.0, 10.0, 50.0, 50.0], [12.0, 11.0, 51.0, 49.0]],
        [0.7, 0.9],
        ["dog", "dog"],
        iou_threshold=None,
    )
    assert len(raw) == 2
    # Still ranked, so "off" means "nothing removed" rather than "nothing done".
    assert [one.confidence for one in raw] == [0.9, 0.7]

    assert (
        len(
            convert(
                [[10.0, 10.0, 50.0, 50.0], [12.0, 11.0, 51.0, 49.0]], [0.7, 0.9], ["dog", "dog"]
            )
        )
        == 1
    )


def test_mismatched_result_lengths_are_a_failure_rather_than_a_silent_truncation() -> None:
    """`zip(strict=True)`, because three parallel lists that disagree mean the
    post-processor changed shape and a short answer would read as a quiet model."""
    with pytest.raises(ValueError):
        convert([[0.0, 0.0, 5.0, 5.0]], [0.9, 0.8], ["dog", "cat"])


# --- what a full device is answered with --------------------------------------

OUT_OF_MEMORY = "CUDA out of memory. Tried to allocate 2.44 GiB. GPU 0 has 8.00 GiB in total"
"""What an allocator writes when the device cannot fit the next tensor."""


class _StarvedClass:
    """A ``transformers`` auto-class that cannot fit the weights it was asked for."""

    @staticmethod
    def from_pretrained(*_: Any, **__: Any) -> Any:
        raise RuntimeError(OUT_OF_MEMORY)


class _HeavyClass:
    """A ``transformers`` auto-class whose weights load, but do not fit the device."""

    @staticmethod
    def from_pretrained(*_: Any, **__: Any) -> _HeavyClass:
        return _HeavyClass()

    def to(self, _: str) -> Any:
        raise RuntimeError(OUT_OF_MEMORY)


class _StarvedModel:
    """A detector whose forward cannot fit its activations."""

    def __call__(self, **_: Any) -> Any:
        raise RuntimeError(OUT_OF_MEMORY)


class _BrokenModel:
    """A detector whose forward dies of an ordinary defect."""

    def __call__(self, **_: Any) -> Any:
        raise RuntimeError("expected scalar type Half but found Float")


class _Processor:
    """Enough of a processor for the adapter to reach its forward and no more."""

    def __call__(self, **_: Any) -> Inputs:
        return Inputs(input_ids="ids", pixel_values="pixels")


def detector(cache_dir: Path) -> LocalTransformersProvider:
    return LocalTransformersProvider(
        "some/model", "abc123", device="cpu", precision=None, cache_dir=cache_dir
    )


def a_request() -> PredictionRequest:
    return PredictionRequest(
        targets=(PredictionTarget(asset_id=uuid4(), content=PNG, media_type="image/png"),),
        prompt=TextPrompt(phrases=("cat",)),
    )


def test_a_load_that_runs_out_of_memory_is_refused_with_a_remedy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The detector's half of the rule its sibling adapter also carries.

    Both are wired rather than one, because a driver that refuses well and a
    driver beside it that answers an incident id is the inconsistency this whole
    change exists to remove.
    """
    transformers = SimpleNamespace(
        AutoProcessor=_StarvedClass, AutoModelForZeroShotObjectDetection=_StarvedClass
    )
    monkeypatch.setattr(
        transformers_provider,
        "imported",
        lambda name: StubTorch() if name == "torch" else transformers,
    )
    with pytest.raises(InferenceOutOfMemory) as raised:
        list(detector(tmp_path).predict(a_request()))
    said = str(raised.value)
    assert "some/model@abc123" in said
    assert "smaller model" in said


def test_moving_a_loaded_model_onto_a_full_device_is_refused_with_a_remedy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`.to(device)` is the load's largest allocation, and the wrap covers it too.

    Both classes load cleanly here, unlike the case above — so this is the test
    that actually reaches `model.to(device)`, the call `_load`'s docstring names
    as the largest single allocation a connection ever makes.
    """
    transformers = SimpleNamespace(
        AutoProcessor=_HeavyClass, AutoModelForZeroShotObjectDetection=_HeavyClass
    )
    monkeypatch.setattr(
        transformers_provider,
        "imported",
        lambda name: StubTorch() if name == "torch" else transformers,
    )
    with pytest.raises(InferenceOutOfMemory) as raised:
        list(detector(tmp_path).predict(a_request()))
    said = str(raised.value)
    assert "some/model@abc123" in said
    assert "smaller model" in said


def test_a_forward_that_runs_out_of_memory_is_refused_with_a_remedy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    built = detector(tmp_path)
    monkeypatch.setattr(built, "_ready", lambda: (_Processor(), _StarvedModel(), "cpu", False))
    monkeypatch.setattr(transformers_provider, "imported", lambda _: StubTorch())
    with pytest.raises(InferenceOutOfMemory) as raised:
        list(built.predict(a_request()))
    assert "some/model@abc123" in str(raised.value)


def test_a_forward_that_fails_for_another_reason_is_still_a_defect(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Anything that is not an allocation failure keeps its traceback and its incident id."""
    built = detector(tmp_path)
    monkeypatch.setattr(built, "_ready", lambda: (_Processor(), _BrokenModel(), "cpu", False))
    monkeypatch.setattr(transformers_provider, "imported", lambda _: StubTorch())
    with pytest.raises(RuntimeError, match="scalar type"):
        list(built.predict(a_request()))
