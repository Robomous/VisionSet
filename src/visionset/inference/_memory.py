# usage: from visionset.inference._memory import translated
"""An allocation failure during a run, answered as a refusal rather than as a defect.

**A run-time question about this machine, like ``_device``'s.** That module
answers whether a device is *there*; this one answers what happens when it is
there and does not have the memory for the model somebody chose. Both are facts
about the machine rather than about the connection, and both are decided at the
moment of the call rather than when a row was written.

**One helper rather than a ``try`` at each site**, which is the move ``_device``
itself was created by: both local adapters route their load and their per-image
work through this, so a third adapter inherits the rule instead of respelling it.

**What counts as an allocation failure is measured rather than reasoned about.**
On the locked runtime ``torch.OutOfMemoryError`` exists, subclasses
``RuntimeError``, and ``torch.cuda.OutOfMemoryError`` *is* that same class rather
than a sibling — so CUDA is answered by a type test. Nothing else is. Exhausting
a CPU raises a plain ``RuntimeError`` reading ``DefaultCPUAllocator: can't
allocate memory: you tried to allocate N bytes``, measured on torch 2.13 on
Linux, and Metal raises one reading ``MPS backend out of memory``, which is
upstream's text and the one spelling here not reproduced on the machine this was
written on. Those two are matched on their message, which is unlovely and is the
only thing that reaches them.

**Catching wider would be worse than catching nothing.** ``_device`` already
records that ``RuntimeError`` is what an unusable backend raises, and a dtype
mismatch, a bad checkpoint and a shape error are all that same class — so a rule
that took every ``RuntimeError`` would rename every genuine defect as a soothing
"out of memory", which is worse than the opaque answer it replaced. Anything
unrecognised leaves here exactly as it arrived.

**``torch`` is passed in rather than imported**, for the reason the whole package
defers its heavy imports — and with the side benefit that a stub proves every
branch of this on a machine with no GPU to exhaust.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Final

from visionset.kernel.domain import CPU
from visionset.kernel.errors import InferenceOutOfMemory

ALLOCATION_MARKERS: Final[tuple[str, ...]] = ("out of memory", "can't allocate memory")
"""The two ways a device with no class of its own says it is full.

Compared against a case-folded message. ``out of memory`` is Metal's, and is also
what CUDA says in the text it writes beside its dedicated class — which is what
covers a runtime old enough not to have that class. ``can't allocate memory`` is
the CPU allocator's, quoted from a real failure rather than from the source.
"""


@contextmanager
def translated(torch: Any, *, device: str, model_ref: str) -> Iterator[None]:
    """Run a load or a forward, and answer an allocation failure with a remedy.

    Safe to nest: the refusal is a ``VisionSetError`` rather than a
    ``RuntimeError``, so an inner translation passes straight through an outer
    one instead of being described twice.
    """
    try:
        yield
    except RuntimeError as exc:
        if not exhausted(torch, exc):
            raise
        raise InferenceOutOfMemory(remedy(device=device, model_ref=model_ref)) from exc


def exhausted(torch: Any, exc: RuntimeError) -> bool:
    """Whether that error is a device having run out of memory.

    The dedicated class is read off the module rather than imported, because the
    floor is ``torch>=2.4`` and only ``torch.cuda``'s spelling is that old. A
    runtime without the top-level name is answered by the markers alone, which
    reach the same failure through the text its allocator writes.
    """
    dedicated = getattr(torch, "OutOfMemoryError", None)
    if isinstance(dedicated, type) and isinstance(exc, dedicated):
        return True
    text = str(exc).casefold()
    return any(marker in text for marker in ALLOCATION_MARKERS)


def remedy(*, device: str, model_ref: str) -> str:
    """What happened and what to do about it, on the device it happened on.

    The middle clause is dropped on the CPU: "use another device", said to
    somebody already on the last one there is, is the advice that costs an
    afternoon.
    """
    if device.split(":")[0] == CPU:
        return (
            f"running {model_ref} on the CPU ran out of memory. Choose a smaller model, "
            "or free memory on this machine and try again."
        )
    return (
        f"running {model_ref} on {device} ran out of memory. Choose a smaller model, set "
        f"this connection's device to {CPU!r}, or free {device} and try again."
    )
