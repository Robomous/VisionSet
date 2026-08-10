"""Resolution and residency: which adapter answers, and how often one is built.

The refusals here are the ones a caller can act on, and each names what to do.
The pool is what makes the embedding cache inside a provider worth anything —
a provider rebuilt per request carries an empty cache into every click.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from visionset.inference import providers as providers_module
from visionset.inference.providers import (
    DETECTOR_FAMILIES,
    SEGMENTER_FAMILIES,
    SUPPORTED_FAMILIES,
    ProviderPool,
    family_of,
    provider_for,
    resident,
)
from visionset.inference.sam_provider import LocalSamProvider
from visionset.inference.transformers_provider import LocalTransformersProvider
from visionset.kernel.domain import ConnectionType, InferenceConnection
from visionset.kernel.errors import (
    InferenceConnectionNotRunnable,
    InferenceConnectionNotSetUp,
    LocalInferenceUnavailable,
)
from visionset.kernel.services import InferenceConnectionService, WorkspaceService


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws", name="providers")
    try:
        yield made
    finally:
        made.close()


@pytest.fixture()
def connections(workspace: WorkspaceService) -> InferenceConnectionService:
    return InferenceConnectionService(workspace)


def a_local(
    connections: InferenceConnectionService, name: str = "seg", *, ready: bool = True
) -> InferenceConnection:
    made = connections.create(
        name,
        connection_type=ConnectionType.LOCAL,
        model_id="some/segmenter",
        model_revision="abc123",
        device="cpu",
        precision="fp32",
    )
    return connections.record_weights_ready(made.id) if ready else made


def an_http(connections: InferenceConnectionService) -> InferenceConnection:
    return connections.create(
        "hosted",
        connection_type=ConnectionType.HTTP,
        model_id="some/model",
        model_revision="v1",
        endpoint_url="https://example.invalid/predict",
    )


def no_extra_needed(monkeypatch: pytest.MonkeyPatch, family: str) -> None:
    """Pretend the optional runtime is installed and declares that family."""
    monkeypatch.setattr(providers_module, "require", lambda: None)
    monkeypatch.setattr(providers_module, "family_of", lambda *_, **__: family)


# --- refusals -----------------------------------------------------------------


def test_a_connection_without_weights_is_told_which_action_fixes_it(
    connections: InferenceConnectionService, tmp_path: Path
) -> None:
    connection = a_local(connections, ready=False)
    with pytest.raises(InferenceConnectionNotSetUp, match="download_weights"):
        provider_for(connection, workspace_root=tmp_path)


def test_an_http_connection_is_refused_because_this_build_has_no_adapter(
    connections: InferenceConnectionService, tmp_path: Path
) -> None:
    with pytest.raises(InferenceConnectionNotRunnable, match="http connection"):
        provider_for(an_http(connections), workspace_root=tmp_path)


def test_a_missing_runtime_is_reported_after_the_connections_own_state(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Order matters: "your weights are not here" is fixable from where the caller stands."""

    def absent() -> None:
        raise LocalInferenceUnavailable('install it with: pip install "visionset[local-inference]"')

    monkeypatch.setattr(providers_module, "require", absent)
    with pytest.raises(LocalInferenceUnavailable, match="local-inference"):
        provider_for(a_local(connections), workspace_root=tmp_path)

    # ...and the not-set-up connection still gets its own answer rather than this one.
    with pytest.raises(InferenceConnectionNotSetUp):
        provider_for(a_local(connections, "other", ready=False), workspace_root=tmp_path)


# --- which family answers -----------------------------------------------------


def test_a_segmenter_config_resolves_to_the_point_prompt_adapter(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    no_extra_needed(monkeypatch, "sam2")
    assert isinstance(provider_for(a_local(connections), workspace_root=tmp_path), LocalSamProvider)


def test_the_video_variant_of_the_architecture_resolves_to_the_point_prompt_adapter(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The spelling the suggested default actually declares.

    The published SAM 2 checkpoints — the connection form's own pre-filled model
    among them — say ``sam2_video``. Reading that as a detector refused a click
    with a sentence about text prompts, which is not merely unhelpful: it
    describes some other model.
    """
    no_extra_needed(monkeypatch, "sam2_video")
    assert isinstance(provider_for(a_local(connections), workspace_root=tmp_path), LocalSamProvider)


def test_a_detector_config_resolves_to_the_text_prompt_adapter(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The older and more common case — and now a named family rather than the fallback."""
    no_extra_needed(monkeypatch, "grounding-dino")
    assert isinstance(
        provider_for(a_local(connections), workspace_root=tmp_path), LocalTransformersProvider
    )


def test_an_unknown_model_type_is_refused_rather_than_handed_to_a_family(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The second half: a guess produces a message that lies about the model.

    The refusal names the type that was declared — so a reader can see what their
    config says — and lists what this build does run, which is the only thing
    they can act on.
    """
    no_extra_needed(monkeypatch, "totally-unknown-net")
    with pytest.raises(InferenceConnectionNotRunnable) as raised:
        provider_for(a_local(connections), workspace_root=tmp_path)

    message = str(raised.value)
    assert "totally-unknown-net" in message
    assert all(family in message for family in SUPPORTED_FAMILIES)


def test_a_config_that_declares_no_type_is_refused_too(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The unreadable-config case reaches the same rule by the same route.

    ``family_of`` answers ``""`` when it cannot read a config, and ``""`` is not
    a family. Resolving it to one would pick an adapter by coin toss and report
    the loss as that adapter's prompt kind.
    """
    no_extra_needed(monkeypatch, "")
    with pytest.raises(InferenceConnectionNotRunnable) as raised:
        provider_for(a_local(connections), workspace_root=tmp_path)

    message = str(raised.value)
    assert "some/segmenter" in message
    assert all(family in message for family in SUPPORTED_FAMILIES)


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

    monkeypatch.setattr(providers_module, "imported", lambda _: Broken())
    assert family_of(a_local(connections), cache_dir=tmp_path) == ""


def test_both_spellings_of_the_one_architecture_are_named() -> None:
    """A set rather than a string, and both members are load-bearing today."""
    assert {"sam2", "sam2_video"} <= SEGMENTER_FAMILIES


def test_the_two_families_are_disjoint_and_are_the_whole_of_what_is_supported() -> None:
    """What the refusal lists is derived, so a family cannot be added to one set
    and forgotten in the message."""
    assert not SEGMENTER_FAMILIES & DETECTOR_FAMILIES
    assert SUPPORTED_FAMILIES == SEGMENTER_FAMILIES | DETECTOR_FAMILIES


def test_an_unsupported_model_leaves_nothing_behind_for_the_next_request(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The pool's rule holds for this refusal as it does for the others."""
    no_extra_needed(monkeypatch, "totally-unknown-net")
    pool = ProviderPool()
    with pytest.raises(InferenceConnectionNotRunnable):
        pool.get(a_local(connections), workspace_root=tmp_path)
    assert len(pool) == 0
    assert pool.builds == 0


# --- residency ----------------------------------------------------------------


def test_asking_twice_for_the_same_connection_builds_one_provider(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    no_extra_needed(monkeypatch, "sam2")
    connection = a_local(connections)
    pool = ProviderPool()

    first = pool.get(connection, workspace_root=tmp_path)
    second = pool.get(connection, workspace_root=tmp_path)

    assert first is second
    assert pool.builds == 1


def test_editing_a_connection_builds_a_new_provider(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Changing the model id, the device or the precision must not keep serving the old one."""
    no_extra_needed(monkeypatch, "sam2")
    connection = a_local(connections)
    pool = ProviderPool()
    pool.get(connection, workspace_root=tmp_path)

    edited = connections.update(connection.id, device="cuda")
    pool.get(edited, workspace_root=tmp_path)

    assert pool.builds == 2


def test_the_pool_is_bounded(
    connections: InferenceConnectionService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    no_extra_needed(monkeypatch, "sam2")
    pool = ProviderPool(capacity=1)
    pool.get(a_local(connections, "one"), workspace_root=tmp_path)
    pool.get(a_local(connections, "two"), workspace_root=tmp_path)
    assert len(pool) == 1


def test_a_refused_connection_leaves_nothing_behind_for_the_next_request(
    connections: InferenceConnectionService, tmp_path: Path
) -> None:
    pool = ProviderPool()
    with pytest.raises(InferenceConnectionNotSetUp):
        pool.get(a_local(connections, ready=False), workspace_root=tmp_path)
    assert len(pool) == 0
    assert pool.builds == 0


def test_the_process_wide_pool_is_one_object() -> None:
    assert resident() is resident()
