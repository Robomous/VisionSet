"""What counts as running out of memory, and what a person is told when it does.

Every case runs on a stand-in, which is the point rather than a compromise: no
runner in continuous integration has a GPU to exhaust, and the question this
module answers — is *that* exception an allocation failure — is a question about
an exception object rather than about hardware. ``test_device`` makes the same
argument for the same reason, and it is what lets both halves of the inference
matrix run this file.

The three messages below are quoted rather than invented. The CPU one is a real
failure, measured by asking torch 2.13 on Linux for 400 TB; the CUDA one is what
its allocator writes; the Metal one is upstream's, and is the only one of the
three this machine could not reproduce.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from visionset.inference._memory import exhausted, remedy, translated
from visionset.kernel.errors import InferenceOutOfMemory

CUDA_TEXT = "CUDA out of memory. Tried to allocate 2.44 GiB. GPU 0 has a total capacity of 8.00 GiB"
MPS_TEXT = "MPS backend out of memory (MPS allocated: 9.06 GB, other allocations: 384.00 KB)"
CPU_TEXT = (
    "[enforce fail at alloc_cpu.cpp:127] err == 0. DefaultCPUAllocator: can't allocate "
    "memory: you tried to allocate 400000000000000 bytes. Error code 12 (Cannot allocate memory)"
)
DTYPE_TEXT = "expected scalar type Half but found Float"
UNUSABLE_TEXT = "MPS backend is only supported on devices with unified memory"


class StubOutOfMemoryError(RuntimeError):
    """torch's dedicated class, with the one property the rule depends on.

    A subclass of ``RuntimeError``, because the real one is: on the locked
    runtime ``torch.OutOfMemoryError`` has ``RuntimeError`` in its bases and
    ``torch.cuda.OutOfMemoryError`` *is* that same object rather than a sibling.
    A stand-in inheriting from ``Exception`` instead would let a rule that never
    catches the real thing pass every test in this file.
    """


def with_the_class() -> SimpleNamespace:
    """A runtime new enough to spell it ``torch.OutOfMemoryError``."""
    return SimpleNamespace(OutOfMemoryError=StubOutOfMemoryError)


def without_the_class() -> SimpleNamespace:
    """One old enough to spell it only ``torch.cuda.OutOfMemoryError``.

    A supported installation rather than a hypothetical one: the floor is
    ``torch>=2.4`` and the top-level name is newer than that.
    """
    return SimpleNamespace()


# --- what counts ---------------------------------------------------------------


def test_the_dedicated_class_is_an_allocation_failure() -> None:
    assert exhausted(with_the_class(), StubOutOfMemoryError(CUDA_TEXT))


def test_a_runtime_without_the_class_still_recognises_cudas_own_message() -> None:
    """The type test is the fast path, not the only one — the floor predates it."""
    assert exhausted(without_the_class(), RuntimeError(CUDA_TEXT))


def test_metals_exhaustion_is_recognised_by_its_message() -> None:
    """Metal has no class of its own; ``torch.mps`` exposes accessors and nothing else."""
    assert exhausted(with_the_class(), RuntimeError(MPS_TEXT))


def test_the_cpu_allocators_own_words_are_recognised() -> None:
    """The commonest exhaustion of all, and the one with no dedicated class."""
    assert exhausted(with_the_class(), RuntimeError(CPU_TEXT))


# --- what does not ------------------------------------------------------------


def test_an_ordinary_defect_is_not_an_allocation_failure() -> None:
    """The discrimination the module exists for. A dtype mismatch is a bug."""
    assert not exhausted(with_the_class(), RuntimeError(DTYPE_TEXT))


def test_an_unusable_backend_is_not_an_allocation_failure() -> None:
    """Device resolution already answers this one by falling back, and must keep doing so."""
    assert not exhausted(with_the_class(), RuntimeError(UNUSABLE_TEXT))


# --- the translation ----------------------------------------------------------


def test_an_allocation_failure_becomes_a_refusal_naming_what_to_do() -> None:
    with (
        pytest.raises(InferenceOutOfMemory) as raised,
        translated(with_the_class(), device="cuda", model_ref="facebook/sam3@3c879f3"),
    ):
        raise StubOutOfMemoryError(CUDA_TEXT)
    said = str(raised.value)
    assert "facebook/sam3@3c879f3" in said
    assert "cuda" in said
    assert "smaller model" in said


def test_the_refusal_keeps_the_original_as_its_cause() -> None:
    """The traceback belongs in the log, and ``raise … from`` is what puts it there."""
    with (
        pytest.raises(InferenceOutOfMemory) as raised,
        translated(with_the_class(), device="cuda", model_ref="m@1"),
    ):
        raise StubOutOfMemoryError(CUDA_TEXT)
    assert isinstance(raised.value.__cause__, StubOutOfMemoryError)


def test_anything_else_leaves_exactly_as_it_arrived() -> None:
    """Identity, not type: a defect must reach the boundary as itself."""
    original = RuntimeError(DTYPE_TEXT)
    with (
        pytest.raises(RuntimeError) as raised,
        translated(with_the_class(), device="cuda", model_ref="m@1"),
    ):
        raise original
    assert raised.value is original


def test_a_refusal_passes_through_an_outer_translation_undescribed_twice() -> None:
    """Nesting is safe, which is what lets a load inside a run carry its own wrap."""
    with (
        pytest.raises(InferenceOutOfMemory) as raised,
        translated(with_the_class(), device="cuda", model_ref="outer@1"),
        translated(with_the_class(), device="cpu", model_ref="inner@1"),
    ):
        raise StubOutOfMemoryError(CUDA_TEXT)
    assert "inner@1" in str(raised.value)


def test_a_run_that_finishes_is_left_alone() -> None:
    with translated(with_the_class(), device="cpu", model_ref="m@1"):
        pass


# --- the sentence -------------------------------------------------------------


def test_a_gpu_is_told_it_can_move_the_connection_to_the_cpu() -> None:
    said = remedy(device="cuda:1", model_ref="m@1")
    assert "cuda:1" in said
    assert "'cpu'" in said


def test_the_cpu_is_not_told_to_move_to_the_cpu() -> None:
    """Advice to use another device, given to the last device there is, costs an afternoon."""
    said = remedy(device="cpu", model_ref="m@1")
    assert "smaller model" in said
    assert "device to" not in said
