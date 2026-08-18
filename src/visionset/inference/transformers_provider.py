# usage: from visionset.inference import LocalTransformersProvider
"""A ``ModelProvider`` that runs a zero-shot detector in this process.

**Neutral foundations.** This adapter is written against ``transformers`` and
takes its weights from their original source. It is not written against any
third-party inference framework, and none is a dependency of this distribution.

**The model is loaded once, lazily, and never at construction.** Building a
provider is what a composition root does while deciding whether it needs one;
reading gigabytes off disk is what the first ``predict`` does. The split matters
because a surface may construct one to ask a question — is this connection
usable — and paying a load for the answer would make asking expensive.

**Everything about which model this is lives here**, which is the boundary
``kernel/ports/model_provider.py`` draws: the prompt string a detector wants
(lowercase phrases separated by full stops), the second threshold its
post-processor takes, the fact that its boxes arrive as corners rather than as a
corner and a size. The port carries none of it, and the kernel does not know this
file exists.

Two measured findings are implemented rather than remembered: half precision
needs shims (``_fp16``), and raw output needs cross-box suppression (``nms``).
Both have tests that fail if they are removed.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from io import BytesIO
from pathlib import Path
from typing import Any, Final

from PIL import Image

from visionset.inference import _device, _fp16, _memory
from visionset.inference._extra import imported
from visionset.inference.nms import DEFAULT_IOU_THRESHOLD, suppressed
from visionset.inference.weights import HuggingFaceWeights, cache_root
from visionset.kernel.domain import (
    AssetPrediction,
    BboxGeometry,
    CuratedModel,
    DownloadSize,
    InferenceConnection,
    ModelCapability,
    PredictedRegion,
    PredictionRequest,
    PredictionTarget,
    TextPrompt,
)
from visionset.kernel.errors import UnsupportedPrompt

DEFAULT_TEXT_THRESHOLD: Final = 0.25
"""How sure the model must be that a box matches a *phrase*, as opposed to that
it is an object at all.

A detector of this family scores those two things separately, which is why one
``minimum_confidence`` on the port cannot stand in for both: that one is the box
score, the value the answer publishes and a caller compares against. This is the
text side, it never leaves this file, and 0.25 is the value the spike's runs
used.
"""


def regions_from(
    boxes: Sequence[Sequence[float]],
    scores: Sequence[float],
    labels: Sequence[str],
    *,
    minimum_confidence: float,
    iou_threshold: float | None,
) -> tuple[PredictedRegion, ...]:
    """Turn one image's raw detections into domain regions, suppressed and sorted.

    Pure, over plain numbers — which is the point of it being a function rather
    than four lines inside :meth:`LocalTransformersProvider.predict`. The
    conversion and the suppression are the two things about this adapter that can
    be wrong in a way no GPU is needed to see, so they are the two things a test
    can drive with literals.

    ``boxes`` arrive as ``(x1, y1, x2, y2)`` — corners, the post-processor's
    convention — and leave as a corner and a size, which is
    :class:`~visionset.kernel.domain.BboxGeometry`'s. A box that survived
    thresholding with zero width or height is dropped rather than raised on: the
    domain refuses a zero-area box, and failing a whole batch over one degenerate
    detection would lose every good answer beside it.

    ``iou_threshold`` of ``None`` disables suppression. It is the only way to get
    the raw output, it is not the default, and a caller reaching for it is asking
    for the duplicates the spike measured.
    """
    regions = []
    for (x1, y1, x2, y2), score, label in zip(boxes, scores, labels, strict=True):
        if score < minimum_confidence:
            continue
        width, height = x2 - x1, y2 - y1
        if width <= 0 or height <= 0:
            continue
        regions.append(
            PredictedRegion(
                label=label,
                # Clamped rather than refused: a model may answer 1.0000001, and
                # the domain's [0, 1] bound is about meaning rather than about
                # float arithmetic.
                confidence=min(1.0, max(0.0, score)),
                geometry=BboxGeometry(x=x1, y=y1, width=width, height=height),
            )
        )
    if iou_threshold is None:
        return tuple(sorted(regions, key=lambda region: -region.confidence))
    return suppressed(regions, iou_threshold=iou_threshold)


def prompt_text(prompt: TextPrompt) -> str:
    """The phrases as this family of detector wants them: lowercase, full stops.

    A model-specific spelling, so it lives at the model-specific end. The port
    carries a tuple of phrases because that is what a caller means; turning that
    into one string with the punctuation a tokenizer was trained on is the
    adapter's translation and nobody else's.
    """
    return " ".join(f"{phrase.strip().casefold()}." for phrase in prompt.phrases)


class LocalTransformersProvider:
    """Runs a zero-shot detector here, in this process, on this machine.

    Satisfies :class:`~visionset.kernel.ports.ModelProvider` structurally rather
    than by inheritance, which is what a ``Protocol`` is for — and what a test
    asserts with ``isinstance``, on the instance, for the reason
    ``formats/registry.py`` already documents.

    Not thread safe and not meant to be: the port says a provider is built by the
    code about to use it, and a worker process runs one task at a time.
    """

    def __init__(
        self,
        model_id: str,
        model_revision: str,
        *,
        device: str,
        precision: str | None,
        cache_dir: Path,
        connection_name: str = "",
        nms_iou_threshold: float | None = DEFAULT_IOU_THRESHOLD,
        text_threshold: float = DEFAULT_TEXT_THRESHOLD,
    ) -> None:
        self._model_id = model_id
        self._model_revision = model_revision
        self._device = device
        self._precision = precision
        self._cache_dir = cache_dir
        self._connection_name = connection_name
        self._nms_iou_threshold = nms_iou_threshold
        self._text_threshold = text_threshold
        self._loaded: tuple[Any, Any, str, bool] | None = None

    @property
    def model_ref(self) -> str:
        """What every answer is stamped with, and what an annotation will carry.

        ``id@revision``, the same spelling the CLI's listing prints, because the
        revision is half of the identity: "which model produced this label" is
        unanswerable if the answer names a moving pointer.
        """
        return f"{self._model_id}@{self._model_revision}"

    def predict(self, request: PredictionRequest) -> Iterator[AssetPrediction]:
        """One answer per target, yielded as each image finishes.

        Yielding rather than returning is the port's contract and is what lets a
        caller report progress between images with no channel of its own. It also
        means **nothing is loaded until the first item is pulled**, which is
        ordinary generator behaviour and worth stating: a caller that builds the
        iterator and never iterates has not started a model.

        Raises:
            UnsupportedPrompt: the request asks by pointing, and this is a
                detector. It answers words.
            LocalInferenceUnavailable: the optional runtime is not installed.
        """
        if not isinstance(request.prompt, TextPrompt):
            raise UnsupportedPrompt(
                f"{self.model_ref} answers text prompts; it was asked with "
                f"{request.prompt.kind!r} points, which it has no way to interpret"
            )
        text = prompt_text(request.prompt)
        processor, model, device, half = self._ready()
        torch = imported("torch")
        for target in request.targets:
            yield self._one(
                target,
                text=text,
                processor=processor,
                model=model,
                device=device,
                half=half,
                torch=torch,
                minimum_confidence=request.minimum_confidence,
            )

    def _one(
        self,
        target: PredictionTarget,
        *,
        text: str,
        processor: Any,
        model: Any,
        device: str,
        half: bool,
        torch: Any,
        minimum_confidence: float,
    ) -> AssetPrediction:
        """Everything that happens to one image, from bytes to domain regions.

        The whole body runs inside the allocation guard rather than only the
        forward: the processor's tensors and the post-processor's boxes are
        allocations too, and an image that dies on any of them died for the same
        reason and has the same remedy.
        """
        with _memory.translated(torch, device=device, model_ref=self.model_ref):
            image = self._decoded(target)
            inputs = processor(images=image, text=text, return_tensors="pt").to(device)
            with _fp16.forward_guard(torch, device_type=device.split(":")[0], half=half):
                outputs = model(**inputs)
            # ``target_sizes`` is (height, width) and PIL's ``size`` is (width,
            # height). Reversed here rather than remembered at the call site.
            raw = processor.post_process_grounded_object_detection(
                outputs,
                inputs.input_ids,
                threshold=minimum_confidence,
                text_threshold=self._text_threshold,
                target_sizes=[image.size[::-1]],
            )[0]
            return AssetPrediction(
                asset_id=target.asset_id,
                model_ref=self.model_ref,
                regions=regions_from(
                    [[float(value) for value in box] for box in raw["boxes"].tolist()],
                    [float(score) for score in raw["scores"].tolist()],
                    _labels_in(raw),
                    minimum_confidence=minimum_confidence,
                    iou_threshold=self._nms_iou_threshold,
                ),
            )

    def _decoded(self, target: PredictionTarget) -> Any:
        """The bytes as an RGB image.

        Pillow rather than anything the optional runtime brings: it is already a
        hard dependency for the media adapters, so decoding costs a base install
        nothing and is importable at the top of this module like an ordinary
        thing. ``RGB`` unconditionally — a greyscale or palette image would
        otherwise reach a three-channel model as the wrong shape, and a palette
        PNG is an ordinary thing to find in a dataset.
        """
        return Image.open(BytesIO(target.content)).convert("RGB")

    def _ready(self) -> tuple[Any, Any, str, bool]:
        """The processor, the model, the device it is on, and whether it is half.

        Loaded once and remembered. The device is re-derived here rather than
        taken from the connection because what the connection holds is a
        *request* — free text, written on a machine that may not be this one —
        and what a forward needs is somewhere that exists.
        """
        if self._loaded is None:
            self._loaded = self._load()
        return self._loaded

    def _load(self) -> tuple[Any, Any, str, bool]:
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
            # Weights only; nothing here executes code that arrived with them.
            "local_files_only": True,
        }
        with _memory.translated(torch, device=device, model_ref=self.model_ref):
            processor = transformers.AutoProcessor.from_pretrained(self._model_id, **common)
            model = transformers.AutoModelForZeroShotObjectDetection.from_pretrained(
                self._model_id,
                dtype=torch.float16 if half else torch.float32,
                **common,
            )
            return processor, model.to(device).eval(), device, half


def _labels_in(raw: dict[str, Any]) -> list[str]:
    """The text each box decoded to — not necessarily a phrase anybody asked for.

    The post-processor turns a token span back into text over the prompt
    string; a span crossing the boundary between two phrases decodes as both of
    them joined, so this can return text that names no phrase in the prompt.
    Mapping an answer back onto a class, and discarding what cannot be mapped,
    is the caller's job.

    Two keys because the post-processor renamed one: ``text_labels`` is the
    current spelling and ``labels`` is what older releases wrote. Read both, in
    that order, rather than pinning a floor — the alternative is a hard
    dependency bound on a rename that costs one line to tolerate.
    """
    found = raw.get("text_labels", raw.get("labels", []))
    return [str(label) for label in found]


DINO_FAMILIES: Final[Mapping[str, ModelCapability]] = {
    "grounding-dino": ModelCapability.TEXT_DETECT,
    "mm-grounding-dino": ModelCapability.TEXT_DETECT,
}
"""``model_type`` values this driver serves, and what each can be asked.

Narrower than "everything the zero-shot detector auto-class accepts", and measured
rather than assumed. This adapter post-processes with a signature taking
``input_ids`` and a ``text_threshold``; the other zero-shot detectors the locked
runtime registers take a different one, so listing them would claim a support that
fails inside a post-processor instead of in a refusal a reader can act on.
"""

CURATED: Final[tuple[CuratedModel, ...]] = (
    CuratedModel(
        model_id="IDEA-Research/grounding-dino-tiny",
        model_revision="a2bb814dd30d776dcf7e30523b00659f4f141c71",
        family="grounding-dino",
        hint="tiny — fastest, comfortable on a CPU",
    ),
    CuratedModel(
        model_id="IDEA-Research/grounding-dino-base",
        model_revision="12bdfa3120f3e7ec7b434d90674b3396eccf88eb",
        family="grounding-dino",
        hint="base — more accurate, wants a GPU",
    ),
)


class GroundingDinoProvider:
    """The driver for text-prompted detectors that run on this machine."""

    provider_id: Final = "grounding-dino"
    families: Final = DINO_FAMILIES
    curated: Final = CURATED

    def __init__(self) -> None:
        self._weights = HuggingFaceWeights()

    def build(
        self, connection: InferenceConnection, *, family: str, workspace_root: Path
    ) -> LocalTransformersProvider:
        assert connection.device is not None
        return LocalTransformersProvider(
            connection.model_id,
            connection.model_revision,
            device=connection.device,
            precision=connection.precision,
            cache_dir=cache_root(workspace_root),
            connection_name=connection.name,
        )

    def price(self, model_id: str, model_revision: str) -> DownloadSize:
        return self._weights.price(model_id, model_revision)

    def family_of(self, connection: InferenceConnection, *, cache_dir: Path) -> str:
        return self._weights.family_of(connection, cache_dir=cache_dir)

    def fetch(
        self,
        connection: InferenceConnection,
        *,
        into: Path,
        on_bytes: Callable[[int], None] | None = None,
    ) -> Path:
        return self._weights.fetch(connection, into=into, on_bytes=on_bytes)
