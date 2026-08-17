"""The shipped no-op segmenter: what resolves it, and what it answers.

Every test here runs on a **base install** — no torch, no weights, no network —
which is the whole claim being made. The stand-in exists so that the path from a
click to a shape can be walked against a real server on every pull request, and
a stand-in that needed the runtime would not have closed that gap at all.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError
from tests.fixtures.media import write_image

from visionset.inference.families import capabilities_of
from visionset.inference.providers import provider_for
from visionset.inference.stub_provider import (
    SCORE,
    STUB_FAMILIES,
    STUB_FAMILY,
    STUB_MODEL_ID,
    StubSegmenter,
)
from visionset.inference.weights import fetch_weights, measure
from visionset.kernel.domain import (
    ConnectionSetupState,
    ConnectionType,
    InferenceConnection,
    ModelCapability,
    PointPrompt,
    PredictionRequest,
    PredictionTarget,
    TextPrompt,
)
from visionset.kernel.errors import InferenceConnectionNotSetUp, UnsupportedPrompt
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

SIZE = (60, 48)
"""Width and height of the picture these cases point at.

Not square, so a mask that came back transposed is a failure here rather than a
coincidence — the reason the real-tensor module gives for its own size.
"""


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws", name="stub")
    try:
        yield made
    finally:
        made.close()


@pytest.fixture()
def connections(workspace: WorkspaceService) -> InferenceConnectionService:
    return InferenceConnectionService(workspace)


def a_stub(
    connections: InferenceConnectionService, *, name: str = "built-in"
) -> InferenceConnection:
    return connections.create(
        name,
        connection_type=ConnectionType.LOCAL,
        model_id=STUB_MODEL_ID,
        model_revision="stub",
        device="cpu",
        precision="fp32",
    )


def asked(tmp_path: Path, at: tuple[float, float] = (30.0, 24.0)) -> PredictionRequest:
    content = write_image(tmp_path / "asset.png", size=SIZE).read_bytes()
    return PredictionRequest(
        targets=(PredictionTarget(asset_id=uuid4(), content=content, media_type="image/png"),),
        prompt=PointPrompt(positive=(at,)),
    )


def lit_columns(mask: object, row: int) -> list[int]:
    rows = list(mask)  # type: ignore[call-overload]
    return [x for x, pixel in enumerate(rows[row]) if pixel]


# --- what it answers ----------------------------------------------------------


def test_the_mask_is_the_assets_own_size(tmp_path: Path) -> None:
    """The rule every geometry downstream depends on, and it is the whole reason
    this reads the picture rather than answering a fixed grid."""
    width, height = SIZE
    (answer,) = list(StubSegmenter(connection_name="s").segment(asked(tmp_path)))

    (segment,) = answer.segments
    assert len(segment.mask) == height
    assert all(len(row) == width for row in segment.mask)


def test_the_square_is_centred_on_the_click_rather_than_on_the_picture(
    tmp_path: Path,
) -> None:
    """A stand-in answering the same shape wherever it was clicked would pass a
    pipeline that dropped the prompt on the floor, which is one of the things
    the suite driving this exists to catch."""
    left = list(StubSegmenter(connection_name="s").segment(asked(tmp_path, at=(12.0, 24.0))))
    right = list(StubSegmenter(connection_name="s").segment(asked(tmp_path, at=(48.0, 24.0))))

    left_lit = lit_columns(left[0].segments[0].mask, 24)
    right_lit = lit_columns(right[0].segments[0].mask, 24)
    assert left_lit and right_lit
    assert max(left_lit) < min(right_lit), "two clicks, two places"


def test_a_click_near_an_edge_is_clamped_rather_than_refused(tmp_path: Path) -> None:
    """The route above has already established the point is on the asset, so the
    only case left is a click close to a border — where the honest answer is the
    part of the square that exists."""
    (answer,) = list(StubSegmenter(connection_name="s").segment(asked(tmp_path, at=(0.0, 0.0))))

    mask = answer.segments[0].mask
    assert lit_columns(mask, 0) == list(range(len(lit_columns(mask, 0)))), "starts at the border"
    assert not any(mask[-1]), "and does not wrap round to the far side"


def test_the_score_clears_any_default_minimum(tmp_path: Path) -> None:
    """A stand-in that were sometimes filtered would make a suite's failures
    depend on a threshold somebody is free to change."""
    (answer,) = list(StubSegmenter(connection_name="s").segment(asked(tmp_path)))
    assert answer.segments[0].score == SCORE == pytest.approx(0.99)


def test_the_answer_says_it_was_a_stand_in(tmp_path: Path) -> None:
    (answer,) = list(StubSegmenter(connection_name="s").segment(asked(tmp_path)))
    assert answer.model_ref == f"{STUB_MODEL_ID}@stub"


def test_a_text_prompt_is_refused_in_the_real_adapters_words(tmp_path: Path) -> None:
    """The refusals have to match the thing this stands in for, or a client
    handles one and not the other."""
    content = write_image(tmp_path / "asset.png", size=SIZE).read_bytes()
    request = PredictionRequest(
        targets=(PredictionTarget(asset_id=uuid4(), content=content, media_type="image/png"),),
        prompt=TextPrompt(phrases=("cat",)),  # type: ignore[arg-type]
    )
    with pytest.raises(UnsupportedPrompt, match="point prompts"):
        list(StubSegmenter(connection_name="s").segment(request))


def test_a_prompt_carrying_no_positive_point_cannot_be_built_at_all() -> None:
    """Which is why the segmenter has no empty-prompt branch.

    ``positive`` carries ``min_length=1``, so "nothing to centre on" is a state
    the domain refuses rather than one an adapter handles. Asserted rather than
    assumed, because the alternative is an unreachable branch that reads as
    coverage.
    """
    with pytest.raises(ValidationError):
        PointPrompt(negative=((10.0, 10.0),))  # type: ignore[call-arg]


# --- how it is reached --------------------------------------------------------


def test_the_reserved_id_resolves_without_the_runtime(
    connections: InferenceConnectionService, workspace: WorkspaceService
) -> None:
    """The load-bearing one. This suite runs on a base install, so a resolution
    reaching ``require()`` would fail here — which is exactly what would happen
    if the branch moved below it."""
    made = connections.record_weights_ready(a_stub(connections).id, model_family=STUB_FAMILY)

    resolved = provider_for(made, workspace_root=workspace.root)

    assert isinstance(resolved, StubSegmenter)


def test_a_stub_connection_that_was_never_set_up_is_still_refused(
    connections: InferenceConnectionService, workspace: WorkspaceService
) -> None:
    """The lifecycle this exercises is the real lifecycle: a stub reaches
    ``ready`` through the same action every other connection does, and skipping
    that would make the browser suite walk a path nobody else walks."""
    made = a_stub(connections)
    assert made.setup_state is ConnectionSetupState.NOT_SET_UP

    with pytest.raises(InferenceConnectionNotSetUp, match="download_weights"):
        provider_for(made, workspace_root=workspace.root)


def test_setting_one_up_reaches_ready_without_a_hub_or_a_config(
    connections: InferenceConnectionService, workspace: WorkspaceService
) -> None:
    """No network, no weights, no ``transformers`` — and the family is *recorded*
    because there is no config to read one from."""
    made = a_stub(connections)
    phases: list[str] = []

    ready = fetch_weights(workspace, made.id, on_progress=phases.append)

    assert ready.setup_state is ConnectionSetupState.READY
    assert ready.model_family == STUB_FAMILY
    assert any("stand-in" in phase for phase in phases), "it says why it fetched nothing"


def test_its_download_costs_nothing_and_says_so_without_asking_anybody() -> None:
    """The setup form asks this before a connection exists, so it has to answer
    on a base install too."""
    size = measure(STUB_MODEL_ID, "stub")
    assert (size.total_bytes, size.file_count) == (0, 0)


def test_it_declares_the_capability_that_makes_the_editor_offer_the_tool() -> None:
    """Derived from :data:`STUB_FAMILIES` rather than written twice — the
    property that made listing the family there worth doing."""
    assert STUB_FAMILY in STUB_FAMILIES
    assert capabilities_of(STUB_FAMILY) == [ModelCapability.POINT_SUGGEST]
