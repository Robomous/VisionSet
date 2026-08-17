"""The point-prompt adapter, driven by real tensors rather than stand-ins.

**Why this module exists, stated plainly: the suite it sits beside could not see
the bug that broke auto-labeling.** ``get_image_embeddings`` answers a *list* of
multi-scale feature maps, and an adapter that reached for a tensor's own method
on that list raised ``AttributeError`` for every click, on every model. Every
test in ``test_sam_provider`` stayed green through it, because the stand-in they
drive answers whatever the adapter happens to ask for — which is the property
that makes a stub cheap and the property that makes it blind.

So the tests here hold the two claims a stub structurally cannot make:

- the library still returns what the adapter is written against, and
- what the library actually produces survives the adapter's own conversions.

**No weights are downloaded and none are needed.** The image processor
constructs from its own defaults, and the tensors are made here — so this runs
under the ``HF_HUB_OFFLINE=1`` the inference job sets, and adds no seconds and no
gigabytes to it. What is deliberately *not* covered is a real forward pass:
building a model small enough to run in CI means hand-shrinking an internal
backbone config, which pins this suite to transformers' private shapes and buys
nothing these two claims do not already cover. A real forward is what the
running stack proves, by somebody clicking.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.fixtures.local_inference import require_local_inference
from tests.fixtures.media import write_image
from tests.inference.stubs import StubTorch

from visionset.inference import sam_provider
from visionset.inference.sam_provider import LocalSamProvider
from visionset.kernel.domain import PointPrompt, PredictionRequest, PredictionTarget

ASSET_SIZE = (20, 24)
"""Width and height of the picture every case here points at.

Not one pixel, which is what the neighbouring modules use and what this file
started with. The mask crosses at the *asset's* size — ``_embedding`` reads it
off the decoded image and ``post_process_masks`` lifts to it — so a one-pixel
asset makes the one assertion worth making here trivially true.
"""


def test_both_segmenter_classes_still_answer_a_list_of_feature_maps() -> None:
    """The assumption the adapter is built on, read off the library itself.

    A whole class of breakage is invisible until something calls a tensor method
    on this, so it is worth asserting directly rather than only through a path
    that happens to exercise it. If a future release answers a tensor, or a
    dataclass, this fails here — naming the library and the method — instead of
    failing as an ``AttributeError`` inside somebody's click.

    Both classes, because the adapter serves both and they are separate code in
    ``transformers``; a change landing in one and not the other is exactly the
    shape of thing a single-class assertion would miss.
    """
    require_local_inference()
    from transformers.models.sam2.modeling_sam2 import Sam2Model
    from transformers.models.sam3_tracker.modeling_sam3_tracker import Sam3TrackerModel

    for model_class in (Sam2Model, Sam3TrackerModel):
        # ``str`` because the annotation is evaluated: it arrives as a
        # ``types.GenericAlias``, not as the source text.
        annotation = str(inspect.signature(model_class.get_image_embeddings).return_annotation)
        assert annotation == "list[torch.Tensor]", (
            f"{model_class.__name__}.get_image_embeddings now declares {annotation!r}; "
            "the adapter caches what it returns without inspecting it, and "
            "sam_provider._embedding's docstring is written against a list"
        )


class _RealTensorModel:
    """A segmenter answering in real tensors, shaped the way the real one does.

    Fake in that it computes nothing and real in every way the adapter can
    observe: ``get_image_embeddings`` answers a **list** of ``torch.Tensor``, as
    both shipped classes declare, and the forward answers ``pred_masks`` of
    ``(batch, objects, masks, h, w)`` beside ``iou_scores`` — the ranks a real
    one produces, which is what lets a real image processor post-process them.

    Splitting it this way is deliberate. Running an actual forward would mean
    shrinking an internal backbone config by hand to fit a CI runner, which pins
    this file to shapes ``transformers`` does not publish; what the adapter can
    actually get wrong is its own handling of the tensors, and those are real.
    """

    def __init__(self, torch: Any, *, lit: bool) -> None:
        self._torch = torch
        self._lit = lit
        self.embeddings_seen: list[Any] = []

    def get_image_embeddings(self, pixel_values: Any) -> list[Any]:
        torch = self._torch
        # Three, because the real encoder answers with three feature levels. The
        # count is what a caller could mishandle; the values are never read.
        return [torch.zeros(1, 8, 4, 4), torch.zeros(1, 16, 2, 2), torch.zeros(1, 32, 1, 1)]

    def __call__(
        self, *, input_points: Any, input_labels: Any, image_embeddings: Any, **_: Any
    ) -> Any:
        from types import SimpleNamespace

        torch = self._torch
        self.embeddings_seen.append(image_embeddings)
        # Deliberately not the asset's size. A real decoder answers at its own
        # working resolution and the *processor* lifts to the asset — so writing
        # the asset's size in here would quietly make the lift a no-op and
        # retire the one assertion this file exists for.
        logits = torch.full((1, 1, 3, 8, 8), 4.0 if self._lit else -4.0)
        return SimpleNamespace(pred_masks=logits, iou_scores=torch.tensor([[[0.10, 0.90, 0.20]]]))


def _provider(
    monkeypatch: pytest.MonkeyPatch, *, lit: bool = True
) -> tuple[LocalSamProvider, _RealTensorModel]:
    """The shipped adapter over a real processor and real tensors.

    Only ``_ready`` is replaced — the seam every test in this package uses — so
    everything from the prompt conversion down to the mask that crosses the port
    is the code that ships. The processor is the real one, built from its own
    defaults rather than fetched: it is what turns the prompt into tensors and
    what lifts the mask, and both are steps the adapter trusts it for.
    """
    import torch
    from transformers import Sam2ImageProcessor, Sam2Processor

    processor = Sam2Processor(image_processor=Sam2ImageProcessor())
    model = _RealTensorModel(torch, lit=lit)
    provider = LocalSamProvider(
        "some/segmenter",
        "abc123",
        family="sam2",
        device="cpu",
        precision=None,
        cache_dir=Path("/nowhere"),
        connection_name="local",
    )
    monkeypatch.setattr(provider, "_ready", lambda: (processor, model, "cpu", False))
    # The fp16 guard's own stand-in, which is what the rest of this package
    # drives too: the guard is tested in `test_fp16`, and a real `torch.autocast`
    # here would be a second subject in a test about tensor handling.
    monkeypatch.setattr(sam_provider, "imported", lambda _: StubTorch())
    return provider, model


def _asked(tmp_path: Path) -> PredictionRequest:
    """One click on a real picture, generated rather than committed.

    Through ``tests.fixtures.media`` because that is the one door to test media
    in this suite — nothing here hand-rolls an encoder, and no image is tracked.
    """
    content = write_image(tmp_path / "asset.png", size=ASSET_SIZE).read_bytes()
    return PredictionRequest(
        targets=(PredictionTarget(asset_id=uuid4(), content=content, media_type="image/png"),),
        prompt=PointPrompt(positive=((10.0, 12.0),)),
    )


def test_a_real_mask_tensor_crosses_the_port_at_the_assets_own_size(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The library's own post-processing, and the adapter's conversion of it.

    ``post_process_masks`` is real here, so the tensor the adapter reshapes,
    indexes and converts is one ``transformers`` produced rather than one a
    stub described. The size assertion is the load-bearing half: the mask
    crosses at the asset's pixels, which is what makes the coordinates in the
    shape above it mean anything.
    """
    require_local_inference()
    provider, _ = _provider(monkeypatch)
    width, height = ASSET_SIZE

    (answer,) = list(provider.segment(_asked(tmp_path)))

    (segment,) = answer.segments
    assert segment.score == pytest.approx(0.90), "the highest-scoring mask, by its own head"
    assert len(segment.mask) == height, "one row per pixel row of the asset, not of the decoder"
    assert len(segment.mask[0]) == width
    assert all(bool(pixel) for pixel in segment.mask[0]), "a lit mask arrives lit"


def test_the_cache_holds_the_list_of_feature_maps_the_encode_answered(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The regression this module was written for.

    The encode answers a list of real tensors, and the adapter has to carry it
    to the cache and to the decoder without reaching into it. Reaching in is not
    hypothetical — a ``detach()`` on this line shipped and made every click a
    500, while every stub-driven test stayed green, because a stub answers
    whatever it is asked for and a list does not.
    """
    require_local_inference()
    import torch

    provider, model = _provider(monkeypatch)
    request = _asked(tmp_path)
    asset = request.targets[0].asset_id
    width, height = ASSET_SIZE

    list(provider.segment(request))

    held = provider._embeddings.get(asset)
    assert held is not None, "the encode was cached"
    cached, size = held
    assert size == (height, width), "the picture's own size, read from the decoded image"
    assert isinstance(cached, list) and len(cached) == 3, "the feature maps arrive together"
    assert all(isinstance(each, torch.Tensor) for each in cached)
    assert model.embeddings_seen == [cached], "the decoder was handed that same object"


def test_an_all_dark_mask_tensor_is_an_answer_with_nothing_in_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A click on empty sky, through the real binarizer rather than a literal.

    Worth its own case because the emptiness is produced here by real logits
    crossing a real threshold, so it also pins that ``binarize=True`` means what
    the adapter assumes it means.
    """
    require_local_inference()
    provider, _ = _provider(monkeypatch, lit=False)

    (answer,) = list(provider.segment(_asked(tmp_path)))

    (segment,) = answer.segments
    assert not any(any(row) for row in segment.mask), "nothing lit, and still a mask"
