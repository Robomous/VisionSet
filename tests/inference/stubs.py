"""Stand-ins for the parts of the optional runtime the SAM adapter reaches for.

Stubs rather than mocks, on ``test_fp16``'s terms: every attribute here is one
the adapter genuinely touches, so the shape of this file is a readable statement
of what the adapter depends on. If it grows, the coupling grew — and the point of
the adapter being written the way it is, is that this file stays small enough to
read.

Nothing here imports torch, which is what lets the whole point-prompt path be
exercised on a machine with no GPU and no ``local-inference`` extra installed.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

Mask = list[list[bool]]


class Values:
    """A tensor-shaped thing holding one list of numbers."""

    def __init__(self, values: list[float]) -> None:
        self._values = values

    def flatten(self) -> Values:
        return self

    def tolist(self) -> list[float]:
        return self._values


class Grid:
    """One mask, and the only thing the adapter asks of it."""

    def __init__(self, mask: Mask) -> None:
        self._mask = mask

    def tolist(self) -> Mask:
        return self._mask


class Stack:
    """Several masks, addressed the way ``post_process_masks`` output is.

    The adapter reshapes away the batch and object dimensions and then indexes,
    which is exactly the two operations reproduced here — deliberately no more,
    so that a change in how the adapter reads its output shows up as an
    ``AttributeError`` here rather than as a silently different answer.
    """

    def __init__(self, masks: list[Mask]) -> None:
        self._masks = masks

    @property
    def shape(self) -> tuple[int, int, int, int]:
        return (1, len(self._masks), len(self._masks[0]), len(self._masks[0][0]))

    def reshape(self, *_: Any) -> Stack:
        return self

    def __getitem__(self, index: int) -> Grid:
        return Grid(self._masks[index])


class Inputs(dict[str, Any]):
    """What a processor hands back: a mapping that also knows how to move device."""

    def to(self, device: str) -> Inputs:
        self.device = device
        return self


class StubProcessor:
    """Both halves of the encode/decode split, and a record of which was asked for.

    ``encodes`` counts calls carrying an image and ``decodes`` counts calls
    carrying points — the two the adapter deliberately keeps apart, and the only
    externally visible difference between a working embedding cache and a
    bypassed one.
    """

    def __init__(self, masks: list[Mask], scores: list[float]) -> None:
        self._masks = masks
        self._scores = scores
        self.encodes = 0
        self.decodes = 0
        self.post_processed: list[list[list[int]]] = []

    def __call__(self, **kwargs: Any) -> Inputs:
        if kwargs.get("images") is not None:
            self.encodes += 1
            return Inputs(pixel_values="pixels")
        self.decodes += 1
        return Inputs(
            input_points=kwargs["input_points"],
            input_labels=kwargs["input_labels"],
            original_sizes=kwargs["original_sizes"],
        )

    def post_process_masks(
        self, masks: Any, original_sizes: list[list[int]], binarize: bool = True
    ) -> list[Stack]:
        self.post_processed.append(original_sizes)
        return [Stack(self._masks)]


class StubModel:
    """A segmenter that answers from a fixed script, and counts its encodes."""

    def __init__(self, masks: list[Mask], scores: list[float]) -> None:
        self._masks = masks
        self._scores = scores
        self.encodes = 0
        self.prompts: list[tuple[Any, Any]] = []
        self.embeddings_seen: list[Any] = []

    def get_image_embeddings(self, pixel_values: Any) -> str:
        self.encodes += 1
        return f"embedding-{self.encodes}"

    def __call__(
        self,
        *,
        input_points: Any,
        input_labels: Any,
        image_embeddings: Any,
        multimask_output: bool,
    ) -> SimpleNamespace:
        self.prompts.append((input_points, input_labels))
        self.embeddings_seen.append(image_embeddings)
        return SimpleNamespace(pred_masks=Stack(self._masks), iou_scores=Values(self._scores))


class Functional:
    """The one torch function the fp16 guard swaps out and puts back."""

    @staticmethod
    def grid_sample(input: Any, grid: Any, *args: Any, **kwargs: Any) -> str:
        return "sampled"


class _Scope:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *_: Any) -> None:
        return None


class StubTorch:
    """Enough of torch for ``forward_guard`` and ``_device.resolved`` to work.

    The two availability answers are constructor arguments rather than fixed
    values, because device resolution is a *branch* on them and a stub that can
    only say "no GPU here" can only ever exercise the fallback. Both default to
    absent, which is what every machine running this suite actually is and what
    every caller predating the arguments expects.
    """

    float16 = "float16"

    def __init__(self, *, cuda: bool = False, mps: bool = False) -> None:
        self.nn = SimpleNamespace(functional=Functional())
        self.cuda = SimpleNamespace(is_available=lambda: cuda)
        self.backends = SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps))

    def no_grad(self) -> _Scope:
        return _Scope()

    def autocast(self, device_type: str, dtype: str) -> _Scope:
        return _Scope()


def disc(radius: int, *, size: int = 64) -> Mask:
    """A filled circle — a mask with an outline worth simplifying."""
    centre = size // 2
    return [
        [(x - centre) ** 2 + (y - centre) ** 2 <= radius * radius for x in range(size)]
        for y in range(size)
    ]


def blank(size: int = 64) -> Mask:
    return [[False] * size for _ in range(size)]
