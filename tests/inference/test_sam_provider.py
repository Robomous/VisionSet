"""The point-prompt adapter: what it refuses, what it answers, and what it caches.

Every test here runs with no torch, no GPU and no ``local-inference`` extra —
the adapter's own seams (``_ready``, and ``imported`` for torch) are the two
places a stand-in goes in, and the rest of the path is the shipped code.

**What it answers is a mask, and nothing here is about shape any more.** Which
piece of a mask is the answer, whether its gaps are closed and how many vertices
survive all moved above this port so a caller can reach them; those rules are
tested in ``test_masks``, and the whole stack from a click to a polygon is
tested through the route in ``tests/server/test_suggest.py``. What is left here
is the adapter's own job: refuse a prompt it cannot take, hand over the
highest-scoring mask intact, and encode an image once.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.inference.stubs import StubModel, StubProcessor, StubTorch, blank, disc

from visionset.inference import sam_provider
from visionset.inference.families import SEGMENTER_FAMILIES
from visionset.inference.sam_provider import (
    NEGATIVE,
    POSITIVE,
    LocalSamProvider,
    best_of,
    points_and_labels,
)
from visionset.kernel.domain import (
    PointPrompt,
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
    family: str = "sam2",
    model: StubModel | None = None,
    torch: StubTorch | None = None,
) -> tuple[LocalSamProvider, StubProcessor, StubModel]:
    """A provider whose model is a script, with everything else as shipped.

    ``model`` and ``torch`` are injectable for the tests that watch the encode
    itself — a model that reports the guard it ran under needs to hold the same
    torch stand-in the provider is handed, which a fresh-per-call stub cannot be.
    """
    processor = StubProcessor(masks or [disc(20)], scores or [0.9])
    model = model or StubModel(masks or [disc(20)], scores or [0.9])
    provider = LocalSamProvider(
        "some/segmenter",
        "abc123",
        family=family,
        device="cpu",
        precision=None,
        cache_dir=Path("/nowhere"),
        connection_name="local",
    )
    monkeypatch.setattr(provider, "_ready", lambda: (processor, model, "cpu", False))
    monkeypatch.setattr(sam_provider, "imported", lambda _: torch or StubTorch())
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
        list(provider.segment(asked(TextPrompt(phrases=("cat",)))))  # type: ignore[arg-type]


# --- what it answers ----------------------------------------------------------


def test_a_click_comes_back_as_the_mask_carrying_the_models_confidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, _, _ = built(monkeypatch, masks=[disc(20)], scores=[0.87])
    (answer,) = list(provider.segment(asked(one_click())))

    assert answer.model_ref == "some/segmenter@abc123"
    (segment,) = answer.segments
    assert segment.score == pytest.approx(0.87)
    assert segment.mask == disc(20), "handed over intact, with no shape decided"


def test_the_mask_crosses_at_the_assets_own_size(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Coordinates downstream are the asset's pixels, so the grid has to be too."""
    provider, _, _ = built(monkeypatch, masks=[disc(20)], scores=[0.9])
    (answer,) = list(provider.segment(asked(one_click())))
    grid = answer.segments[0].mask
    assert (len(grid), len(grid[0])) == (len(disc(20)), len(disc(20)[0]))


def test_an_empty_mask_is_an_ordinary_answer_with_nothing_in_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A click on sky. Empty rather than raising, and still saying who was asked."""
    provider, _, _ = built(monkeypatch, masks=[blank()], scores=[0.9])
    (answer,) = list(provider.segment(asked(one_click())))
    assert answer.segments[0].mask == blank(), "an empty grid is a mask, not an absence"


def test_a_model_less_sure_than_the_caller_asked_answers_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, _, _ = built(monkeypatch, masks=[disc(20)], scores=[0.3])
    request = PredictionRequest(targets=(target(),), prompt=one_click(), minimum_confidence=0.8)
    (answer,) = list(provider.segment(request))
    assert answer.segments == ()
    assert answer.model_ref == "some/segmenter@abc123", "still says who was asked"


def test_negative_points_reach_the_model_alongside_the_positive_ones(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, _, model = built(monkeypatch)
    prompt = PointPrompt(positive=((10.0, 12.0),), negative=((30.0, 30.0),))
    list(provider.segment(asked(prompt)))
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

    list(provider.segment(asked(one_click(), target(asset))))
    list(provider.segment(asked(PointPrompt(positive=((11.0, 13.0),)), target(asset))))

    assert provider.encodes == 1, "the image is read once"
    assert model.encodes == 1
    assert processor.encodes == 1
    assert processor.decodes == 2, "but both clicks were answered"
    assert model.embeddings_seen == ["embedding-1", "embedding-1"]


def test_a_different_asset_pays_its_own_encode(monkeypatch: pytest.MonkeyPatch) -> None:
    provider, _, model = built(monkeypatch)
    list(provider.segment(asked(one_click(), target())))
    list(provider.segment(asked(one_click(), target())))
    assert provider.encodes == 2
    assert model.embeddings_seen == ["embedding-1", "embedding-2"]


def test_the_cache_is_bounded_and_evicts_the_least_recently_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, _, _ = built(monkeypatch)
    monkeypatch.setattr(provider, "_embeddings", type(provider._embeddings)(2))
    first, second, third = target(), target(), target()

    for one in (first, second, third, first):
        list(provider.segment(asked(one_click(), one)))

    assert provider.encodes == 4, "the first asset was evicted by the third and re-encoded"


# --- the encode's guard, and what the cache is allowed to hold ----------------


class _GuardWatchingModel(StubModel):
    """A model whose encode reports which guard it ran under.

    ``forward_guard``'s one observable fingerprint on a stub torch is the
    ``grid_sample`` shim it installs for exactly the duration of the forward —
    the same fingerprint ``test_fp16`` reads — so the encode checking whether
    the shim is in place is the encode checking it is inside the guard.
    """

    def __init__(self, masks: Any, scores: Any, torch: StubTorch) -> None:
        super().__init__(masks, scores)
        self._torch = torch
        self._pristine = torch.nn.functional.grid_sample
        self.guarded_encodes: list[bool] = []

    def get_image_embeddings(self, pixel_values: Any) -> str:
        self.guarded_encodes.append(self._torch.nn.functional.grid_sample is not self._pristine)
        return super().get_image_embeddings(pixel_values)


class _Graphed:
    """A tensor the way autograd hands one over: a graph attached, until detached."""

    def __init__(self, *, detached: bool = False) -> None:
        self.requires_grad = not detached
        self.grad_fn = None if detached else object()

    def detach(self) -> _Graphed:
        return _Graphed(detached=True)


class _GraphedModel(StubModel):
    """A model whose embeddings carry an autograd graph, as a real forward's would."""

    def get_image_embeddings(self, pixel_values: Any) -> _Graphed:
        super().get_image_embeddings(pixel_values)
        return _Graphed()


def test_the_encode_runs_inside_the_forward_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    """The encoder is the largest forward of the request, so it runs under the
    same no-grad guard the decoder does — not beside it with autograd on."""
    torch = StubTorch()
    model = _GuardWatchingModel([disc(20)], [0.9], torch)
    provider, _, _ = built(monkeypatch, model=model, torch=torch)

    list(provider.segment(asked(one_click())))

    assert model.guarded_encodes == [True], "the encode ran outside the forward guard"


def test_the_cached_embedding_carries_no_autograd_graph(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """What the cache holds is the embedding alone, never the encoder's graph —
    an entry pinning the activations behind a ``grad_fn`` is many times the
    size the cache's bound was reasoned about."""
    provider, _, _ = built(monkeypatch, model=_GraphedModel([disc(20)], [0.9]))
    asset = uuid4()

    list(provider.segment(asked(one_click(), target(asset))))

    held = provider._embeddings.get(asset)
    assert held is not None
    cached, _ = held
    assert cached.requires_grad is False
    assert cached.grad_fn is None


# --- which classes a family loads through -------------------------------------


class _Loaded:
    """Whatever ``from_pretrained`` handed back, remembering how it was asked for."""

    def __init__(self, model_id: str, options: dict[str, Any]) -> None:
        self.model_id = model_id
        self.options = options

    def to(self, _: str) -> _Loaded:
        return self

    def eval(self) -> _Loaded:
        return self


class _Recorder:
    """A stand-in ``transformers`` that records which classes a load reached for.

    Deliberately answers *every* attribute rather than only the expected ones, so
    a row naming a class this build does not ship fails on the assertion about
    which names were asked for rather than on an ``AttributeError`` that would
    read as a broken stub.
    """

    def __init__(self) -> None:
        self.asked: list[str] = []
        self.loaded: list[_Loaded] = []

    def __getattr__(self, name: str) -> Any:
        self.asked.append(name)
        recorder = self

        class _Class:
            @staticmethod
            def from_pretrained(model_id: str, **options: Any) -> _Loaded:
                made = _Loaded(model_id, options)
                recorder.loaded.append(made)
                return made

        return _Class

    def load(self, provider: LocalSamProvider, monkeypatch: pytest.MonkeyPatch) -> None:
        torch = StubTorch()
        monkeypatch.setattr(
            sam_provider, "imported", lambda name: torch if name == "torch" else self
        )
        provider._load()


def a_provider(family: str) -> LocalSamProvider:
    return LocalSamProvider(
        "some/segmenter",
        "abc123",
        family=family,
        device="cpu",
        precision=None,
        cache_dir=Path("/nowhere"),
        connection_name="local",
    )


def test_the_class_table_covers_every_segmenter_family() -> None:
    """The two registers agree, and nothing else makes them.

    The resolver sends a connection here on the strength of its family being in
    ``SEGMENTER_FAMILIES``; the loader then looks that family up in ``_CLASSES``.
    A family added to the first and forgotten in the second resolves to this
    adapter and dies on a ``KeyError`` inside a load — past every refusal, in a
    place whose message names a dictionary rather than a model.
    """
    assert set(sam_provider._CLASSES) == SEGMENTER_FAMILIES


@pytest.mark.parametrize(
    ("family", "expected"),
    [
        ("sam2", ["AutoProcessor", "Sam2Model"]),
        ("sam2_video", ["AutoProcessor", "Sam2Model"]),
        ("sam3_video", ["Sam3TrackerProcessor", "Sam3TrackerModel"]),
    ],
)
def test_each_family_loads_through_its_own_classes(
    family: str, expected: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Named rather than resolved, for the half that cannot be resolved correctly.

    SAM 2 keeps ``AutoProcessor`` because the repositories it is pointed at
    declare a processor that takes points. Asked about ``facebook/sam3`` the same
    call answers ``Sam3VideoProcessor`` — measured against the real repository —
    which is the video path, so resolving there would hand this adapter something
    no single-image click can be expressed to and the failure would surface inside
    a call rather than in a refusal.
    """
    recorder = _Recorder()
    recorder.load(a_provider(family), monkeypatch)
    assert recorder.asked == expected


def test_a_load_never_reaches_the_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Weights are fetched when somebody asks for them and at no other time.

    Both halves of the load carry it, which is what the assertion checks: a
    processor quietly downloading its own config on first use would defeat the
    rule as thoroughly as the model doing it, and it is the easier of the two to
    leave out when a row is added.
    """
    recorder = _Recorder()
    recorder.load(a_provider("sam3_video"), monkeypatch)
    assert [one.options["local_files_only"] for one in recorder.loaded] == [True, True]
    assert {one.options["revision"] for one in recorder.loaded} == {"abc123"}
