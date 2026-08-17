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

**Which memory ran out is a second question, and the wrong answer to it is
expensive.** A run on a GPU allocates on the host either side of the forward —
the processor builds its tensors before they move to the device, and the mask is
copied back afterwards — so a host shortage reaches this rule with a device run
in progress. Told apart from a device shortage it earns its own sentence; not
told apart, it inherits the one that offers to move the connection to the CPU,
which puts the weights in the memory that just ran out. The message is what
separates them: the CPU allocator names itself, and nothing else does.

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

HOST: Final = "host"
DEVICE: Final = "device"
"""Which memory ran out. The two answers, and the only two.

Plain strings rather than an enum, on ``_device``'s precedent for the vocabulary
beside them: nothing outside this module reads either, and a value that never
crosses a boundary does not need a type to cross it with.
"""

HOST_MARKER: Final = "can't allocate memory"
"""The CPU allocator's own words, and the one message that says *which* memory ran out.

Quoted from a real failure rather than from the source: ``[enforce fail at
alloc_cpu.cpp:127] … DefaultCPUAllocator: can't allocate memory: you tried to
allocate N bytes``. No device allocator writes this, which is what makes it a
classification rather than a guess — and it stays true of a host allocation made
part-way through a run that is otherwise on a GPU, which is the case the third
sentence exists for.
"""

DEVICE_MARKERS: Final[tuple[str, ...]] = ("out of memory",)
"""How a device with no class of its own says it is full.

Metal's spelling, and also what CUDA writes in the text beside its dedicated
class — which is what covers a runtime old enough not to have that class.
"""

ALLOCATION_MARKERS: Final[tuple[str, ...]] = (*DEVICE_MARKERS, HOST_MARKER)
"""Every marker, in one tuple, for a reader asking what this rule matches at all.

Derived rather than retyped, so the two halves above cannot drift from the whole.
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
        kind = exhaustion(torch, exc)
        if kind is None:
            raise
        raise InferenceOutOfMemory(remedy(device=device, model_ref=model_ref, kind=kind)) from exc


def exhaustion(torch: Any, exc: RuntimeError) -> str | None:
    """Which memory that error says ran out, or ``None`` if it says none did.

    The host is asked first, because its marker names an allocator and the other
    two tests name only a symptom: an error carrying the CPU allocator's own
    words came from host memory whatever else is true of the run.

    The dedicated class is read off the module rather than imported, because the
    floor is ``torch>=2.4`` and only ``torch.cuda``'s spelling is that old. A
    runtime without the top-level name is answered by the markers alone, which
    reach the same failure through the text its allocator writes.
    """
    text = str(exc).casefold()
    if HOST_MARKER in text:
        return HOST
    dedicated = getattr(torch, "OutOfMemoryError", None)
    if isinstance(dedicated, type) and isinstance(exc, dedicated):
        return DEVICE
    if any(marker in text for marker in DEVICE_MARKERS):
        return DEVICE
    return None


def remedy(*, device: str, model_ref: str, kind: str) -> str:
    """What happened and what to do about it, in terms that fit what ran out.

    Three sentences, because there are three situations and each has a remedy the
    other two must not be given.

    **A run already on the CPU keeps its own sentence whatever ``kind`` says.**
    "Use another device", said to somebody on the last device there is, is the
    advice that costs an afternoon, and that stays true however the failure was
    classified — so the check on the device comes first and is absolute rather
    than being one branch among three.
    """
    if device.split(":")[0] == CPU:
        return (
            f"running {model_ref} on the CPU ran out of memory. Choose a smaller model, "
            "or free memory on this machine and try again."
        )
    if kind == HOST:
        return (
            f"running {model_ref} on {device} ran out of system memory rather than "
            f"{device}'s own. Choose a smaller model, or free memory on this machine and "
            f"try again; moving the connection to {CPU!r} would only use more of it."
        )
    return (
        f"running {model_ref} on {device} ran out of memory. Choose a smaller model, set "
        f"this connection's device to {CPU!r}, or free {device} and try again."
    )
