# usage: from visionset.inference import LocalSamProvider
"""A ``PointSegmenter`` that answers a pointing gesture, here, in this process.

The counterpart to ``transformers_provider``: that one answers words and refuses
points, this one answers points and refuses words. Neither guesses at the other,
because a connection names one model and a model of this family genuinely cannot
do the other job.

**The whole design is one split.** A segmenter of this family reads the image
once into an embedding — the expensive half — and then answers any number of
clicks from that embedding almost for free. The design budget for the perceived
cost of a click is =<300 ms, and that is only reachable if refining a
suggestion never re-reads the image. ``transformers`` draws the same line the
design does: :meth:`get_image_embeddings` is the encode, and the processor
accepts ``original_sizes`` *without* ``images``, so the decode never touches a
pixel. The cache sits exactly on that seam.

**Nothing about the cache is visible through the port.** ``PointSegmenter`` must
stay implementable by something running in another building, so the caching is an
adapter's private business: the protocol
gets ``segment``, and a hosted segmenter is free to cache in whatever way its
own deployment allows, or not at all.

**And nothing about shapes happens here.** This answers with the mask the model
produced and stops. Which of its pieces are worth proposing, whether the holes
inside them are closed, how many vertices survive — every one of those is a
product decision a person adjusts, and it lives in ``masks`` above this line so
that a second segmenter inherits it rather than reimplementing it. The prompt's
points do not even reach this file's mask handling any more: choosing which
piece was meant is a question about the gesture, and it is answered where the
gesture's other consequences are.

The fp16 shims and the missing-extra error are ``transformers_provider``'s,
reused rather than respelled — same ``_fp16.forward_guard``, same
``_extra.imported``.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from io import BytesIO
from pathlib import Path
from typing import Any, Final
from uuid import UUID

from PIL import Image

from visionset.inference import _device, _fp16
from visionset.inference._extra import imported
from visionset.inference.cache import DEFAULT_EMBEDDING_CAPACITY, BoundedCache, KeyedLocks
from visionset.kernel.domain import (
    AssetSegmentation,
    PointPrompt,
    PredictionRequest,
    PredictionTarget,
    SegmentedMask,
)
from visionset.kernel.errors import UnsupportedPrompt

_CLASSES: Final[Mapping[str, tuple[str, str]]] = {
    "sam2": ("AutoProcessor", "Sam2Model"),
    "sam2_video": ("AutoProcessor", "Sam2Model"),
    "sam3_video": ("Sam3TrackerProcessor", "Sam3TrackerModel"),
}
"""Which ``transformers`` pair loads each family this adapter serves.

Keyed by exactly the members of :data:`~visionset.inference.families.SEGMENTER_FAMILIES`
that load through ``transformers`` at all — a test holds the two together, because a
family added to the register without an entry here would resolve to this adapter and
then fail inside a load with a ``KeyError`` rather than in a refusal. The single
exception is
:data:`~visionset.inference.stub_provider.STUB_FAMILY`, this build's own no-op
segmenter, which ``provider_for`` answers before reaching this adapter and which
therefore has no pair to name.

**SAM 3's entry names its processor and SAM 2's does not, and the asymmetry is the
point rather than an oversight.** ``AutoProcessor`` resolves against the
repository's own declared ``processor_class``, which is the right answer for SAM 2:
``facebook/sam2.1-hiera-base-plus`` declares ``Sam2VideoProcessor``, and that is
what the shipped adapter has always loaded. Asked the same question about
``facebook/sam3`` it answers **``Sam3VideoProcessor``** — measured, not predicted —
which is the video path and not a thing a single-image click can be expressed to.
Naming ``Sam3TrackerProcessor`` is what keeps the point prompt reaching a processor
that takes points.

The model class is named for the same reason and SAM 2's has been since this
adapter shipped: a config declaring the video variant loads into the promptable
image model deliberately. ``transformers`` says so itself when it happens, and
names the older case while doing it — *"You are using a model of type
``sam3_video`` to instantiate a model of type ``sam3_tracker``. This may be
expected if you are loading a checkpoint that shares a subset of the architecture
(e.g., loading a ``sam2_video`` checkpoint into ``Sam2Model``)"*. That warning is
left where a reader can see it, on the shipped adapter's own precedent.

**Both rows are measured against a real load, not reasoned about.** Asking
``from_pretrained(..., output_loading_info=True)`` for ``facebook/sam3`` on CPU
reports ``missing_keys: 0``, ``unexpected_keys: 0``, ``mismatched_keys: 0`` — the
same clean result recorded below for SAM 2, so every parameter the tracker needs
came out of the checkpoint and no weight is left randomly initialised. A point
prompt then runs the whole way through: ``get_image_embeddings`` returns an
embedding, the forward answers ``pred_masks`` of ``(1, 1, 3, 288, 288)`` beside
``iou_scores`` of ``(1, 1, 3)``, and ``post_process_masks`` lifts them to
``(1, 3, 240, 320)`` — three masks at the asset's own size, which is exactly the
shape ``_segments`` below already reads.

``Sam3TrackerModel`` and ``Sam2Model`` agree signature for signature on everything
below this line — ``get_image_embeddings(pixel_values, **kwargs)``, ``forward``'s
full keyword list, and ``post_process_masks(masks, original_sizes, …)`` — which is
why one adapter serves both and only these two names move.
"""

POSITIVE: Final = 1
NEGATIVE: Final = 0
"""What this family calls a point that says *this* and one that says *not that*.

The domain spells the same distinction as two tuples on
:class:`~visionset.kernel.domain.PointPrompt`, which is how a person thinks about
it. These two integers are how the model does, and the translation between them
is exactly the kind of thing that lives in an adapter.
"""


def points_and_labels(prompt: PointPrompt) -> tuple[list[list[float]], list[int]]:
    """The prompt as this family wants it: one flat point list, one label list.

    Pure, and separated from the forward for the same reason ``regions_from`` is
    in the detector adapter — positive and negative points arriving in the wrong
    order, or with the labels off by one, is a bug that needs no GPU to catch and
    would otherwise need one to see.

    Order is positives then negatives. Nothing in the model depends on it, and
    fixing it makes the conversion testable by equality rather than by set
    comparison.
    """
    points = [[float(x), float(y)] for x, y in prompt.positive]
    labels = [POSITIVE] * len(points)
    points += [[float(x), float(y)] for x, y in prompt.negative]
    labels += [NEGATIVE] * (len(points) - len(labels))
    return points, labels


def best_of(iou_scores: list[float]) -> tuple[int, float]:
    """Which of the multi-mask answers to offer, and how sure it is.

    A segmenter of this family answers a single click with several masks at
    different scales — the object, the part, the whole — because a click is
    ambiguous about which was meant. Offering all three would make the user
    disambiguate a thing they did not ask about; offering the highest-scoring one
    is what the model's own IoU head is for, and refining with a second click is
    how the design says to resolve the ambiguity instead (D2).
    """
    if not iou_scores:
        return 0, 0.0
    best = max(range(len(iou_scores)), key=lambda index: iou_scores[index])
    return best, min(1.0, max(0.0, float(iou_scores[best])))


class LocalSamProvider:
    """Runs a point-promptable segmenter here, on this machine.

    Satisfies :class:`~visionset.kernel.ports.PointSegmenter` structurally — its
    sibling satisfies ``ModelProvider`` the same way — and is built by the
    composition root that has already decided this connection's model is of this
    family.

    One instance per connection, held across requests by the provider cache —
    which is what makes the embedding cache inside it worth anything. A provider
    built fresh per click would have an empty cache every time and would pay the
    encode on every click, which is the exact latency failure D5 names.
    """

    def __init__(
        self,
        model_id: str,
        model_revision: str,
        *,
        family: str,
        device: str,
        precision: str | None,
        cache_dir: Path,
        connection_name: str = "",
        embedding_capacity: int = DEFAULT_EMBEDDING_CAPACITY,
    ) -> None:
        self._model_id = model_id
        self._model_revision = model_revision
        self._family = family
        self._device = device
        self._precision = precision
        self._cache_dir = cache_dir
        self._connection_name = connection_name
        self._loaded: tuple[Any, Any, str, bool] | None = None
        self._embeddings: BoundedCache[UUID, tuple[Any, tuple[int, int]]] = BoundedCache(
            embedding_capacity
        )
        self._encoding: KeyedLocks[UUID] = KeyedLocks()
        self._encodes = 0

    @property
    def model_ref(self) -> str:
        """``id@revision`` — the string an accepted annotation will carry."""
        return f"{self._model_id}@{self._model_revision}"

    @property
    def encodes(self) -> int:
        """How many times an image has actually been read into an embedding.

        Exposed because it is the only externally visible difference between a
        cache that works and one that does not: both answer correctly, and only
        this counter separates one click's worth of work from two. The test that
        proves D5's encode-once behaviour reads it, and would pass on a bypassed
        cache without it.
        """
        return self._encodes

    def segment(self, request: PredictionRequest) -> Iterator[AssetSegmentation]:
        """One answer per target, yielded as each finishes.

        Raises:
            UnsupportedPrompt: the request asks with words, and this is a
                segmenter. It answers places.
            LocalInferenceUnavailable: the optional runtime is not installed.
        """
        if not isinstance(request.prompt, PointPrompt):
            raise UnsupportedPrompt(
                f"{self.model_ref} answers point prompts; it was asked with "
                f"{request.prompt.kind!r}, which it has no way to interpret"
            )
        points, labels = points_and_labels(request.prompt)
        torch = imported("torch")
        for target in request.targets:
            yield self._one(
                target,
                points=points,
                labels=labels,
                torch=torch,
                minimum_confidence=request.minimum_confidence,
            )

    def _one(
        self,
        target: PredictionTarget,
        *,
        points: list[list[float]],
        labels: list[int],
        torch: Any,
        minimum_confidence: float,
    ) -> AssetSegmentation:
        """One image, one prompt, one mask at most."""
        processor, model, device, half = self._ready()
        embedding, size = self._embedding(
            target, processor=processor, model=model, device=device, torch=torch, half=half
        )
        height, width = size
        inputs = processor(
            original_sizes=[[height, width]],
            input_points=[[points]],
            input_labels=[[labels]],
            return_tensors="pt",
        ).to(device)
        with _fp16.forward_guard(torch, device_type=device.split(":")[0], half=half):
            outputs = model(
                input_points=inputs["input_points"],
                input_labels=inputs["input_labels"],
                image_embeddings=embedding,
                multimask_output=True,
            )
        return AssetSegmentation(
            asset_id=target.asset_id,
            model_ref=self.model_ref,
            segments=self._segments(
                outputs, processor=processor, size=size, minimum_confidence=minimum_confidence
            ),
        )

    def _segments(
        self,
        outputs: Any,
        *,
        processor: Any,
        size: tuple[int, int],
        minimum_confidence: float,
    ) -> tuple[SegmentedMask, ...]:
        """The chosen mask and its score, or nothing at all.

        Empty rather than raising, in both of the ways this can come back with no
        answer — the model was not sure enough, or the mask it produced is empty.
        A click on a patch of sky is an ordinary thing to do and "no suggestion"
        is the honest reply to it.

        **No shape is decided here.** This used to trace and simplify an outline
        and return a polygon, which put a product's choices behind a port. The
        mask crosses intact and the pipeline above makes the shape.

        **There is no label.** Pointing says *where*, not *what*: this model has
        no vocabulary. The editor already knows which class is active — that is
        what chose the geometry kinds — so a name invented here would be a
        second, worse source for something the caller already holds.
        """
        lifted = processor.post_process_masks(
            outputs.pred_masks, original_sizes=[list(size)], binarize=True
        )[0]
        scores = [float(value) for value in outputs.iou_scores.flatten().tolist()]
        chosen, confidence = best_of(scores)
        if confidence < minimum_confidence:
            return ()
        mask = lifted.reshape(-1, *lifted.shape[-2:])[chosen]
        return (SegmentedMask(mask=mask.tolist(), score=confidence),)

    def _embedding(
        self,
        target: PredictionTarget,
        *,
        processor: Any,
        model: Any,
        device: str,
        torch: Any,
        half: bool,
    ) -> tuple[Any, tuple[int, int]]:
        """This asset's image embedding, computed once and kept.

        The encode is a forward pass like any other, so it runs inside the same
        ``forward_guard`` the decode uses — nothing here trains, and the graph
        autograd would otherwise build sits in device memory at the exact moment
        the request's largest allocation is live. **That guard is also the whole
        of why no cache entry pins the encoder's activations**, because it enters
        ``no_grad`` on both of its branches, so nothing the encode returns has a
        ``grad_fn`` to keep.

        **What comes back is a list of feature maps, not a tensor**, and it is
        cached exactly as handed over. Detaching it here rather than relying on
        the guard is the obvious-looking move, and it does not work: a
        ``.detach()`` on this line answered ``AttributeError: 'list' object has
        no attribute 'detach'`` for every click, on every supported model,
        because the multi-scale maps arrive together in a list. Measured against
        the locked ``transformers`` rather than reasoned about from the name —
        ``Sam2Model`` and ``Sam3TrackerModel`` both declare
        ``get_image_embeddings(...) -> list[torch.Tensor]``, and both decorate it
        ``@torch.no_grad()``, which is a second reason after the guard that there
        is nothing here to detach.

        Keyed on ``asset_id`` alone, which is sound because assets are
        content-addressed: the bytes behind an id cannot change, so a hit can
        never be stale. Editing the *connection* is what would invalidate these,
        and that replaces the whole provider rather than reaching in here.

        **Once means once even when two clicks arrive together.** The route is a
        plain ``def``, so FastAPI answers concurrent suggests in parallel
        threadpool threads; a bare check-then-compute let two clicks on the same
        un-encoded asset both encode it, which is the most expensive thing this
        adapter does. The lock is taken per asset, so a click on another asset
        neither waits for this one nor is waited for.

        The cache is read twice on purpose. The first read is the common case and
        takes no lock at all; the second is what the loser of a race sees, and
        without it the winner's work would be redone by everybody who queued
        behind it.
        """
        held = self._embeddings.get(target.asset_id)
        if held is not None:
            return held
        with self._encoding.for_key(target.asset_id):
            held = self._embeddings.get(target.asset_id)
            if held is not None:
                return held
            image = Image.open(BytesIO(target.content)).convert("RGB")
            size = (image.height, image.width)
            inputs = processor(images=image, return_tensors="pt").to(device)
            self._encodes += 1
            with _fp16.forward_guard(torch, device_type=device.split(":")[0], half=half):
                embedding = model.get_image_embeddings(inputs["pixel_values"])
            return self._embeddings.put(target.asset_id, (embedding, size))

    def _ready(self) -> tuple[Any, Any, str, bool]:
        if self._loaded is None:
            self._loaded = self._load()
        return self._loaded

    def _load(self) -> tuple[Any, Any, str, bool]:
        """Processor and model, once per provider.

        **Which pair is loaded is the connection's family's answer, not this
        method's.** :data:`_CLASSES` holds it, one row per family, and the argument
        for each row is written there. What stays here is everything that does not
        vary: the device resolution, the dtype, and ``local_files_only``, because
        nothing on a load path may reach the network.

        **``transformers`` warns here on every load, and the warning is expected.**
        The published SAM 2 checkpoints declare ``model_type: sam2_video``, so
        loading one into ``Sam2Model`` prints *"You are using a model of type
        ``sam2_video`` to instantiate a model of type ``sam2``"*. Why that is the
        right class rather than a mistake is argued where the families are
        declared, in ``families.py``; what is worth recording at the load site is
        that it was **measured** and not assumed. Asking
        ``from_pretrained(..., output_loading_info=True)`` for
        ``facebook/sam2.1-hiera-base-plus`` reports ``missing_keys: 0``,
        ``unexpected_keys: 0``, ``mismatched_keys: 0`` and no errors — every
        parameter this class needs came out of the checkpoint and nothing in the
        checkpoint went unused, so no weight is left randomly initialised.

        The alternative class does not fit: ``Sam2VideoModel.forward`` takes an
        ``inference_session`` and a frame index, which is the video-tracking path
        and has no way to answer a point on a single image.

        The warning is therefore left where a reader can see it. Silencing it
        would hide the same sentence on the day a checkpoint genuinely does not
        match, and that day it is the only warning there is.
        """
        torch = imported("torch")
        transformers = imported("transformers")
        device, half = _device.resolved(
            torch,
            device=self._device,
            precision=self._precision,
            connection_name=self._connection_name,
        )
        common = {
            "revision": self._model_revision,
            "cache_dir": str(self._cache_dir),
            "local_files_only": True,
        }
        processor_class, model_class = _CLASSES[self._family]
        processor = getattr(transformers, processor_class).from_pretrained(self._model_id, **common)
        model = getattr(transformers, model_class).from_pretrained(
            self._model_id,
            dtype=torch.float16 if half else torch.float32,
            **common,
        )
        return processor, model.to(device).eval(), device, half
