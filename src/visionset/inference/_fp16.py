# usage: from visionset.inference._fp16 import forward_guard
"""The two shims half precision needs, and the measurement that found them.

**Finding 1 on #418's spike-findings comment, as code.** Grounding DINO in fp16
on transformers 5.14.1 does not simply work: several internals are built in
float32 regardless of the weights' dtype, and the forward dies on a dtype
mismatch rather than on anything a caller did. Two are enough to reproduce it —
the deformable-attention sampling grid reaching ``grid_sample`` as float32 beside
half-precision values, and the decoder's reference-point head — and both are
answered here:

1. ``torch.autocast`` around the forward, which is what reconciles the ordinary
   float32 layers with half-precision weights.
2. A ``grid_sample`` that casts its sampling grid to whatever dtype the input
   holds. Autocast does not cover it: ``grid_sample`` is not on the autocast
   list, so it sees exactly the two dtypes it was handed.

Weights stay fp16-resident either way — the spike measured VRAM unchanged — so
this buys correctness rather than costing memory.

**Patched for the duration of a forward and restored afterwards.** The spike
replaced ``torch.nn.functional.grid_sample`` permanently at import, which is
fine for a script and wrong for a library: a process that also runs somebody
else's model would inherit a wrapper it never asked for. The scope of the fix is
the scope of the problem.

**The wrapper is a factory over a plain callable**, which is the whole reason
this module is separable from the provider. It can be handed a stand-in with a
``dtype`` and a ``to``, so the rule is proved by a test that runs anywhere
instead of only on a machine holding a GPU.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

HALF_PRECISION_NAMES = frozenset({"fp16", "float16", "half"})
"""What a connection's ``precision`` may say to mean half.

A set rather than one spelling because the field is free text by design —
``InferenceConnection.precision`` documents that — and refusing ``float16`` from
somebody who wrote what torch calls it would be a trap rather than a rule.
"""


def wants_half(precision: str | None) -> bool:
    """Whether that precision setting asks for fp16. Case- and space-insensitive."""
    return precision is not None and precision.strip().casefold() in HALF_PRECISION_NAMES


def grid_sample_with_matching_dtype(original: Callable[..., Any]) -> Callable[..., Any]:
    """``grid_sample``, but the sampling grid is cast to the input's dtype first.

    The cast goes one way on purpose: the *grid* follows the *input*, never the
    other way round. Casting the input to the grid's float32 would undo the half
    precision the caller asked for at the one layer that reads the most values,
    which is the opposite of the point.

    A no-op when the dtypes already agree, so the wrapper is safe to leave in
    place across a whole forward including the layers that never had the problem.
    """

    def sampling_with_matching_dtype(input: Any, grid: Any, *args: Any, **kwargs: Any) -> Any:
        if grid.dtype is not input.dtype:
            grid = grid.to(input.dtype)
        return original(input, grid, *args, **kwargs)

    return sampling_with_matching_dtype


@contextmanager
def forward_guard(torch: Any, *, device_type: str, half: bool) -> Iterator[None]:
    """Everything a forward pass should run inside, and nothing it should not.

    ``torch`` is passed in rather than imported, for the reason the whole package
    defers its heavy imports — and with the side benefit that a stub proves the
    patching and the restore.

    ``no_grad`` always: nothing here trains, and gradients on a batch of images
    are the difference between fitting in 16 GB and not. Autocast **only** when
    half precision was asked for, because a caller that fell back to CPU asked
    for the ordinary path and ``float16`` autocast on CPU is not it.

    The ``finally`` is the point of the whole context manager: a forward that
    raises must still leave ``torch.nn.functional`` as it found it, or the next
    exception in the process is a mystery about somebody else's model.
    """
    functional = torch.nn.functional
    original = functional.grid_sample
    functional.grid_sample = grid_sample_with_matching_dtype(original)
    try:
        if half:
            with torch.no_grad(), torch.autocast(device_type, dtype=torch.float16):
                yield
        else:
            with torch.no_grad():
                yield
    finally:
        functional.grid_sample = original
