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

    ``mps`` is asked with ``is_available`` alone. ``is_built`` answers a
    different question — whether this build of the array library carries the
    backend — and ``is_available`` is already false when it does not, so asking
    both is asking one question twice.
    """
    if device.startswith(CUDA):
        return bool(torch.cuda.is_available())
    if device == MPS:
        return bool(torch.backends.mps.is_available())
    return True
