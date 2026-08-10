"""The point-prompt adapter: what it refuses, what it answers, and what it caches.

Every test here runs with no torch, no GPU and no ``local-inference`` extra —
the adapter's own seams (``_ready``, and ``imported`` for torch) are the two
places a stand-in goes in, and the rest of the path is the shipped code.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.inference.stubs import StubModel, StubProcessor, StubTorch, blank, disc

from visionset.inference import sam_provider
from visionset.inference.sam_provider import (
    NEGATIVE,
    POSITIVE,
    LocalSamProvider,
    best_of,
    points_and_labels,
)
from visionset.kernel.domain import (
    PointPrompt,
    PolygonGeometry,
    PredictionRequest,
    PredictionTarget,
    TextPrompt,
)
from visionset.kernel.errors import UnsupportedPrompt

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
    b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00"
    b"\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)
"""A real one-pixel PNG, because the adapter genuinely decodes what it is handed."""


def built(
    monkeypatch: pytest.MonkeyPatch,
    *,
    masks: list[list[list[bool]]] | None = None,
    scores: list[float] | None = None,
) -> tuple[LocalSamProvider, StubProcessor, StubModel]:
    """A provider whose model is a script, with everything else as shipped."""
    processor = StubProcessor(masks or [disc(20)], scores or [0.9])
    model = StubModel(masks or [disc(20)], scores or [0.9])
    provider = LocalSamProvider(
        "some/segmenter",
        "abc123",
        device="cpu",
        precision=None,
        cache_dir=Path("/nowhere"),
        connection_name="local",
    )
    monkeypatch.setattr(provider, "_ready", lambda: (processor, model, "cpu", False))
    monkeypatch.setattr(sam_provider, "imported", lambda _: StubTorch())
    return provider, processor, model


def target(asset_id: Any = None) -> PredictionTarget:
    return PredictionTarget(asset_id=asset_id or uuid4(), content=PNG, media_type="image/png")


def asked(prompt: PointPrompt, *targets: PredictionTarget) -> PredictionRequest:
    return PredictionRequest(targets=targets or (target(),), prompt=prompt)


def one_click() -> PointPrompt:
    return PointPrompt(positive=((10.0, 12.0),))


# --- the prompt conversion ----------------------------------------------------


def test_positives_come_first_and_each_point_gets_its_own_label() -> None:
    points, labels = points_and_labels(
        PointPrompt(positive=((1.0, 2.0), (3.0, 4.0)), negative=((5.0, 6.0),))
    )
    assert points == [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]]
    assert labels == [POSITIVE, POSITIVE, NEGATIVE]


def test_a_prompt_with_no_negatives_still_labels_every_point() -> None:
    points, labels = points_and_labels(one_click())
    assert len(points) == len(labels) == 1


# --- choosing among the multi-mask answers ------------------------------------


def test_the_highest_scoring_mask_is_the_one_offered() -> None:
    """A click is ambiguous about scale; the model's own IoU head is what resolves it."""
    assert best_of([0.2, 0.91, 0.5]) == (1, 0.91)


def test_a_score_outside_the_domains_bounds_is_clamped_rather_than_refused() -> None:
    assert best_of([1.0000001])[1] == 1.0


# --- what it refuses ----------------------------------------------------------


def test_a_text_prompt_is_refused_because_this_model_answers_places(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The counterpart of the detector adapter's refusal, which stays as it is."""
    provider, _, _ = built(monkeypatch)
    with pytest.raises(UnsupportedPrompt, match="point prompts"):
        list(provider.predict(asked(TextPrompt(phrases=("cat",)))))  # type: ignore[arg-type]


# --- what it answers ----------------------------------------------------------


def test_a_click_comes_back_as_one_polygon_carrying_the_models_confidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, _, _ = built(monkeypatch, masks=[disc(20)], scores=[0.87])
    (answer,) = list(provider.predict(asked(one_click())))

    assert answer.model_ref == "some/segmenter@abc123"
    (region,) = answer.regions
    assert isinstance(region.geometry, PolygonGeometry)
    assert region.confidence == pytest.approx(0.87)


def test_the_label_is_empty_because_pointing_says_where_and_not_what(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The editor already knows the active class; a name invented here would be a worse copy."""
    provider, _, _ = built(monkeypatch)
    (answer,) = list(provider.predict(asked(one_click())))
    assert answer.regions[0].label == ""


def test_an_empty_mask_is_an_ordinary_answer_with_nothing_in_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, _, _ = built(monkeypatch, masks=[blank()], scores=[0.9])
    (answer,) = list(provider.predict(asked(one_click())))
    assert answer.regions == ()


def test_a_model_less_sure_than_the_caller_asked_answers_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, _, _ = built(monkeypatch, masks=[disc(20)], scores=[0.3])
    request = PredictionRequest(targets=(target(),), prompt=one_click(), minimum_confidence=0.8)
    (answer,) = list(provider.predict(request))
    assert answer.regions == ()
    assert answer.model_ref == "some/segmenter@abc123", "still says who was asked"


def test_the_polygon_is_the_blob_under_the_click_and_not_a_speck(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Through the adapter: the positive points have to actually reach the tracer.

    A speck in the topmost row owns the topmost-leftmost lit pixel, so without
    the points this answers ``()`` — the speck traces to one point and a polygon
    needs three. The click is on the disc, and the disc is what comes back.
    """
    speckled = [list(row) for row in disc(20)]
    speckled[0][63] = True
    provider, _, _ = built(monkeypatch, masks=[speckled], scores=[0.9])

    prompt = PointPrompt(positive=((32.0, 32.0),))
    (answer,) = list(provider.predict(asked(prompt)))

    (region,) = answer.regions
    assert isinstance(region.geometry, PolygonGeometry)
    xs = [x for x, _ in region.geometry.points]
    ys = [y for _, y in region.geometry.points]
    assert min(xs) >= 12 and max(xs) <= 52, "the disc's extent, not the speck at x=63"
    assert max(ys) > 40, "and its full height, so this is the disc and not a fragment"


def test_negative_points_do_not_choose_the_blob(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A negative says what the shape is not; by selection time the shape is already made."""
    speckled = [list(row) for row in disc(20)]
    speckled[0][63] = True
    provider, _, _ = built(monkeypatch, masks=[speckled], scores=[0.9])

    prompt = PointPrompt(positive=((32.0, 32.0),), negative=((63.0, 0.0),))
    (answer,) = list(provider.predict(asked(prompt)))

    (region,) = answer.regions
    assert isinstance(region.geometry, PolygonGeometry)
    assert max(x for x, _ in region.geometry.points) <= 52, "still the disc"


def test_negative_points_reach_the_model_alongside_the_positive_ones(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, _, model = built(monkeypatch)
    prompt = PointPrompt(positive=((10.0, 12.0),), negative=((30.0, 30.0),))
    list(provider.predict(asked(prompt)))
    (points, labels) = model.prompts[0]
    assert points == [[[[10.0, 12.0], [30.0, 30.0]]]]
    assert labels == [[[POSITIVE, NEGATIVE]]]


# --- the embedding cache (D5) -------------------------------------------------


def test_a_second_click_on_the_same_asset_decodes_without_encoding_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D5's encode-once behaviour, and the test the PR body names for the cache mutation.

    Turn the cache off — return the computed embedding without holding it — and
    ``encodes`` becomes 2 while every assertion about the *answer* stays true.
    That is exactly why the counter exists: correctness cannot tell these two
    implementations apart, and the latency budget is the whole feature.
    """
    provider, processor, model = built(monkeypatch)
    asset = uuid4()

    list(provider.predict(asked(one_click(), target(asset))))
    list(provider.predict(asked(PointPrompt(positive=((11.0, 13.0),)), target(asset))))

    assert provider.encodes == 1, "the image is read once"
    assert model.encodes == 1
    assert processor.encodes == 1
    assert processor.decodes == 2, "but both clicks were answered"
    assert model.embeddings_seen == ["embedding-1", "embedding-1"]


def test_a_different_asset_pays_its_own_encode(monkeypatch: pytest.MonkeyPatch) -> None:
    provider, _, model = built(monkeypatch)
    list(provider.predict(asked(one_click(), target())))
    list(provider.predict(asked(one_click(), target())))
    assert provider.encodes == 2
    assert model.embeddings_seen == ["embedding-1", "embedding-2"]


def test_the_cache_is_bounded_and_evicts_the_least_recently_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, _, _ = built(monkeypatch)
    monkeypatch.setattr(provider, "_embeddings", type(provider._embeddings)(2))
    first, second, third = target(), target(), target()

    for one in (first, second, third, first):
        list(provider.predict(asked(one_click(), one)))

    assert provider.encodes == 4, "the first asset was evicted by the third and re-encoded"
