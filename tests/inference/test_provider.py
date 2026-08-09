"""The composition root's refusals, and the adapter's tensor-to-domain half.

Two subjects, both reachable without the optional runtime and without a GPU:

- `provider_for`, which answers "can this connection predict here?" and must
  refuse with a sentence rather than a `None` or a stack trace;
- `regions_from`, the conversion the adapter does after a forward — the one part
  of running a model that can be wrong in a way no weights are needed to see.

What is deliberately *not* here is a real forward pass. That needs the extra, a
GPU and gigabytes of weights, and a test that mocked all three would be asserting
against its own fixture. The forward's one measured hazard has its own file:
`test_fp16.py`.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from uuid import uuid4

import pytest

from visionset.inference import MODULES, LocalTransformersProvider, provider_for
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
    InferenceConnectionNotRunnable,
    InferenceConnectionNotSetUp,
    LocalInferenceUnavailable,
    UnsupportedPrompt,
)
from visionset.kernel.ports import ModelProvider

EXTRA_INSTALLED = all(importlib.util.find_spec(name) is not None for name in MODULES)


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


def remote() -> InferenceConnection:
    return InferenceConnection(
        name="remote",
        connection_type=ConnectionType.HTTP,
        model_id="some/model",
        model_revision="abc123",
        endpoint_url="https://example.invalid/predict",
        setup_state=ConnectionSetupState.READY,
    )


# --- resolving a connection to something that can answer ----------------------


def test_a_local_connection_without_weights_is_refused_by_state(tmp_path: Path) -> None:
    """And the message names the action that fixes it.

    "Not set up" alone tells an operator what they already knew; the remedy is
    the point, and it is a real one — the identical call succeeds after the
    download.
    """
    with pytest.raises(InferenceConnectionNotSetUp) as raised:
        provider_for(local(), workspace_root=tmp_path)
    assert "download_weights" in str(raised.value)


def test_an_http_connection_is_refused_because_this_build_has_no_adapter(
    tmp_path: Path,
) -> None:
    """A different refusal from the one above, deliberately.

    No state change fixes this and no wait helps — the adapter that would speak
    to an endpoint is a later slice — so it must not be the error whose whole
    meaning is "change the state and resubmit".
    """
    with pytest.raises(InferenceConnectionNotRunnable) as raised:
        provider_for(remote(), workspace_root=tmp_path)
    assert "http" in str(raised.value)


def test_the_connections_own_state_is_reported_before_the_machines(tmp_path: Path) -> None:
    """Order of the two checks, and it matters to whoever reads the answer.

    A not-set-up connection on a machine with no extra has two problems. Telling
    somebody to run a `pip install` when what they needed was a download sends
    them to the wrong place; the state is the one they can act on from where they
    are standing.
    """
    with pytest.raises(InferenceConnectionNotSetUp):
        provider_for(local(), workspace_root=tmp_path)


@pytest.mark.skipif(EXTRA_INSTALLED, reason="the local runtime is installed here")
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


@pytest.mark.skipif(not EXTRA_INSTALLED, reason="needs the local-inference extra")
def test_a_ready_local_connection_resolves_to_a_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Structural conformance, asserted on the instance.

    `isinstance` against a `Protocol` works on an instance and not on a class
    carrying data members — the distinction `formats/registry.py` already
    documents — so this is the strongest form the check can take.

    The declared family is stubbed because `tmp_path` holds no weights and there
    is nothing to read one from. Since #456 that is refused rather than resolved
    to a fallback, so a real config is now the difference between this test
    building a provider and it exercising the refusal that has its own test.
    """
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
    on the connection (`cf. #421`).
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
    thresholds (#418, findings comment). This test goes red the moment the
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
