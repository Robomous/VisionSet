# usage: from visionset.inference._device import resolved
"""Where a local model actually runs, and whether half precision survives the trip.

**One module because it was two identical methods.** Both local adapters carried
a private ``_resolved_device`` and a ``CPU_FALLBACK_WARNING`` that were the same
text, and adding a third device to two copies is how two copies become two
answers. The rule is promoted here rather than duplicated a third time, which is
the same move ``require_move`` and ``require_draft`` made in the kernel.

**A run-time question, not a configuration one.** What the connection holds is a
*request*, written on a machine that may not be this one; the vocabulary it is
drawn from lives in the kernel, and whether a named device is present right now
lives here. The two are deliberately separate: a device nothing could ever
address is refused when it is written down, and a device this particular machine
does not have is answered at the moment of the call.

**Falling back is the answer, not refusing.** A connection asking for a device
this machine does not offer runs on the CPU and says so at WARNING. Refusing
would make a workspace configured on a workstation unusable on a laptop, which is
worse than being slow; staying silent would make it fifty times slower for no
visible reason, which is worse than being loud. The same rule covers every
device, so ``mps`` on a machine without Metal behaves exactly as ``cuda`` on a
machine without an NVIDIA GPU.

**``torch`` is passed in rather than imported**, for the reason the whole package
defers its heavy imports — and with the side benefit that a stub proves every
branch of this on a machine that has neither GPU.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Any, Final

from visionset.inference import _fp16
from visionset.kernel.domain import CPU, CUDA, MPS

_logger: Final = logging.getLogger(__name__)

CPU_FALLBACK_WARNING: Final = (
    "inference connection %r asks for device %r, which this machine does not offer; "
    "running on the CPU in full precision instead"
)
"""Said out loud, once, at WARNING. A fallback that happens silently is a
fifty-times-slower run somebody spends an afternoon not understanding — the
~115 ms an image the detector is measured at is a GPU figure."""

MPS_FALLBACK_VARIABLE: Final = "PYTORCH_ENABLE_MPS_FALLBACK"
"""What lets an operator Metal has not implemented run on the CPU instead of raising.

Set to ``1`` in :mod:`visionset.inference`'s own module body, because the array
library reads it while it initialises rather than when an operator is reached, so
by the time a device has been resolved it is already too late to set. It is set
here as well for a caller that reached an adapter without importing the package
around it, and both are :func:`os.environ.setdefault`, so an operator who set it
to ``0`` deliberately keeps that answer.
"""


def enable_mps_fallback() -> None:
    """Ask for unimplemented operators to run on the CPU rather than raise.

    Free on every machine that has no Metal at all, which is why it is set
    unconditionally at import and needs no availability check of its own.
    """
    os.environ.setdefault(MPS_FALLBACK_VARIABLE, "1")


def resolved(
    torch: Any, *, device: str, precision: str | None, connection_name: str
) -> tuple[str, bool]:
    """The device this will really run on, and whether it runs in half precision.

    Half precision is CUDA-only, and the test is on the device that *survived*
    rather than on the one that was asked for. fp16 outside CUDA is not the
    conservative choice it looks like: the shims in :mod:`._fp16` exist for
    CUDA's autocast, Metal has no float64 and an inconsistent bfloat16, and
    ``float16`` arithmetic on a CPU is slower than the float32 it was avoiding.
    The kernel's ``precisions_for`` refuses the pairing before it is ever stored;
    this is the same rule holding for a row written before it did.
    """
    wanted = device.strip()
    if not _present(torch, wanted):
        _logger.warning(CPU_FALLBACK_WARNING, connection_name, wanted)
        return CPU, False
    if wanted == MPS:
        enable_mps_fallback()
    return wanted, wanted.startswith(CUDA) and _fp16.wants_half(precision)


def _present(torch: Any, device: str) -> bool:
    """Whether this machine offers that device, right now.

    ``mps`` is asked twice, and the second question is the one that matters.
    ``is_available`` answers *is there a Metal device*, which is not the same as
    *can I put a tensor on it*: on an Intel Mac with a discrete GPU it answers
    true and every allocation then raises ``MPS backend is only supported on
    devices with unified memory``. Measured on an i9 MacBook Pro, macOS 26.6,
    torch 2.13 — ``is_built`` and ``is_available`` both true, ``torch.zeros(1,
    device="mps")`` fatal. Asking ``is_built`` as well would not have helped; it
    is true there too.

    So the second question is asked by *doing it*, which is the only form that
    cannot be wrong, and it is the shape this module already argues for: a
    run-time question answered at the moment of the call.
    """
    if device.startswith(CUDA):
        return bool(torch.cuda.is_available())
    if device == MPS:
        return bool(torch.backends.mps.is_available()) and _mps_serves(torch)
    return True


@lru_cache(maxsize=None)
def _mps_serves(torch: Any) -> bool:
    """Whether Metal will really take a tensor, asked by handing it one.

    **Cached on the array library itself**, so the cost is one allocation of one
    element per process rather than per suggestion — and so that a test handing
    in a different stub gets a different answer without having to clear
    anything, which is what keeps this probe as injectable as the two
    availability flags beside it.

    Only ``RuntimeError`` is caught, because that is what an unusable backend
    raises. Anything else — a stub missing ``zeros``, an import that half
    happened — is a surprise this function has no business converting into a
    quiet "no GPU here", which is the most expensive kind of wrong answer a
    fallback can give.
    """
    try:
        torch.zeros(1, device=MPS)
    except RuntimeError:
        return False
    return True
