"""The half-precision shims, and the measurement that found they were needed.

Finding 1 on #418's spike-findings comment: Grounding DINO in fp16 on
transformers 5.14.1 does not simply work. Several internals are built in float32
regardless of the weights' dtype, and the forward dies on a dtype mismatch rather
than on anything a caller did — the deformable-attention sampling grid reaching
`grid_sample` as float32 beside half-precision values being the first one hit.

Two levels of test, because there are two things worth proving and only one of
them needs hardware:

- **The rule**, driven with stand-ins that carry a `dtype` and a `to`. It runs
  everywhere, including on a base install with no torch at all, and it is what
  catches the shim being dropped.
- **The reproduction**, driven with real half-precision CUDA tensors through the
  real `torch.nn.functional.grid_sample`. It is skipped without a GPU — so it is
  skipped in CI — and it is the one that would have caught the finding in the
  first place.
"""

from __future__ import annotations

import importlib.util
from typing import Any

import pytest

from visionset.inference._fp16 import (
    forward_guard,
    grid_sample_with_matching_dtype,
    wants_half,
)


class Tensor:
    """The two things the shim touches: a dtype, and the ability to change it."""

    def __init__(self, dtype: str) -> None:
        self.dtype = dtype

    def to(self, dtype: str) -> Tensor:
        return Tensor(dtype)


class Functional:
    """A stand-in for `torch.nn.functional`, holding the one attribute patched."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.grid_sample = self._grid_sample

    def _grid_sample(self, input: Any, grid: Any, *args: Any, **kwargs: Any) -> str:
        self.calls.append((input.dtype, grid.dtype))
        return "sampled"


class Autocast:
    def __init__(self, recorder: list[tuple[str, str]], device_type: str, dtype: str) -> None:
        self._recorder = recorder
        self._entry = (device_type, dtype)

    def __enter__(self) -> Autocast:
        self._recorder.append(self._entry)
        return self

    def __exit__(self, *_: object) -> None:
        return None


class NoGrad:
    def __init__(self, recorder: list[str]) -> None:
        self._recorder = recorder

    def __enter__(self) -> NoGrad:
        self._recorder.append("no_grad")
        return self

    def __exit__(self, *_: object) -> None:
        return None


class StubTorch:
    """Enough of torch to prove the guard, and nothing else.

    A stub rather than a mock: every attribute here is one the guard genuinely
    reaches for, so the shape of this class is a readable statement of what the
    shim depends on. If it grows, the coupling grew.
    """

    float16 = "float16"

    def __init__(self) -> None:
        self.nn = type("nn", (), {"functional": Functional()})()
        self.autocasts: list[tuple[str, str]] = []
        self.no_grads: list[str] = []

    def autocast(self, device_type: str, dtype: str) -> Autocast:
        return Autocast(self.autocasts, device_type, dtype)

    def no_grad(self) -> NoGrad:
        return NoGrad(self.no_grads)


# --- the grid-sample cast -----------------------------------------------------


def test_a_float32_grid_is_cast_to_the_inputs_half_dtype() -> None:
    """The finding itself: the grid follows the input, and the call goes through."""
    calls: list[tuple[str, str]] = []

    def original(input: Any, grid: Any, *args: Any, **kwargs: Any) -> str:
        calls.append((input.dtype, grid.dtype))
        return "sampled"

    wrapped = grid_sample_with_matching_dtype(original)
    assert wrapped(Tensor("float16"), Tensor("float32")) == "sampled"
    assert calls == [("float16", "float16")]


def test_the_cast_goes_one_way_only() -> None:
    """The input is never demoted to the grid's dtype.

    Casting the other way would undo the half precision at the one layer that
    reads the most values, which is the opposite of the point.
    """
    calls: list[tuple[str, str]] = []

    def original(input: Any, grid: Any, *args: Any, **kwargs: Any) -> str:
        calls.append((input.dtype, grid.dtype))
        return "sampled"

    grid_sample_with_matching_dtype(original)(Tensor("float32"), Tensor("float16"))
    assert calls == [("float32", "float32")]


def test_matching_dtypes_are_left_alone() -> None:
    """A no-op when there is nothing to fix, so the wrapper is safe to leave in
    place across a whole forward including the layers that never had the problem."""
    seen: list[Any] = []
    grid = Tensor("float16")
    grid_sample_with_matching_dtype(lambda i, g, *a, **k: seen.append(g))(Tensor("float16"), grid)
    assert seen == [grid]


def test_extra_arguments_reach_the_original_untouched() -> None:
    """`grid_sample` takes a mode, a padding mode and an alignment flag, and the
    wrapper is transparent to all of them."""
    seen: list[tuple[tuple, dict]] = []
    wrapped = grid_sample_with_matching_dtype(
        lambda i, g, *args, **kwargs: seen.append((args, kwargs))
    )
    wrapped(Tensor("float16"), Tensor("float32"), "bilinear", align_corners=False)
    assert seen == [(("bilinear",), {"align_corners": False})]


# --- the guard ----------------------------------------------------------------


def test_half_precision_runs_under_autocast_and_no_grad() -> None:
    torch = StubTorch()
    with forward_guard(torch, device_type="cuda", half=True):
        pass
    assert torch.autocasts == [("cuda", "float16")]
    assert torch.no_grads == ["no_grad"]


def test_full_precision_runs_under_no_grad_alone() -> None:
    """A CPU fallback asked for the ordinary path, and float16 autocast is not it."""
    torch = StubTorch()
    with forward_guard(torch, device_type="cpu", half=False):
        pass
    assert torch.autocasts == []
    assert torch.no_grads == ["no_grad"]


def test_the_patch_is_in_place_inside_and_gone_afterwards() -> None:
    """Scoped to the forward, unlike the spike's permanent module-level swap.

    A process that also runs somebody else's model must not inherit a wrapper it
    never asked for.
    """
    torch = StubTorch()
    before = torch.nn.functional.grid_sample
    with forward_guard(torch, device_type="cuda", half=True):
        assert torch.nn.functional.grid_sample is not before
        torch.nn.functional.grid_sample(Tensor("float16"), Tensor("float32"))
    assert torch.nn.functional.grid_sample is before
    assert torch.nn.functional.calls == [("float16", "float16")]


def test_a_forward_that_raises_still_restores_grid_sample() -> None:
    """The `finally` earning its place: otherwise the next exception in the
    process is a mystery about somebody else's model."""
    torch = StubTorch()
    before = torch.nn.functional.grid_sample
    with pytest.raises(RuntimeError), forward_guard(torch, device_type="cuda", half=True):
        raise RuntimeError("CUDA out of memory")
    assert torch.nn.functional.grid_sample is before


# --- which precisions mean half ----------------------------------------------


@pytest.mark.parametrize("spelling", ["fp16", "FP16", " float16 ", "half"])
def test_the_spellings_a_person_might_write_all_mean_half(spelling: str) -> None:
    """`precision` is free text by design, and refusing `float16` from somebody
    who wrote what torch calls it would be a trap rather than a rule."""
    assert wants_half(spelling)


@pytest.mark.parametrize("spelling", [None, "fp32", "float32", "bf16", ""])
def test_everything_else_is_full_precision(spelling: str | None) -> None:
    assert not wants_half(spelling)


# --- the reproduction, on real hardware ---------------------------------------


def _cuda_is_available() -> bool:
    if importlib.util.find_spec("torch") is None:
        return False
    import torch as real_torch

    return bool(real_torch.cuda.is_available())


@pytest.mark.skipif(
    not _cuda_is_available(), reason="needs the local-inference extra and a CUDA device"
)
def test_a_half_precision_grid_sample_survives_a_float32_grid_on_cuda() -> None:
    """The measured failure, reproduced and then fixed, with real tensors.

    This is finding 1 in its smallest honest form: half-precision values and a
    float32 sampling grid through the real `torch.nn.functional.grid_sample` on a
    real device. Unguarded it raises `RuntimeError: expected scalar type Half but
    found Float`, which is exactly what the spike hit inside deformable attention;
    inside `forward_guard` it returns.

    Skipped without a GPU, so it does not run in CI. It is here because the
    stubbed tests above prove the *rule* and only this one proves the rule was
    the right one — and because the next person to touch the shim will want a way
    to check it on a machine that has the hardware.
    """
    import torch as real_torch

    values = real_torch.randn(1, 1, 8, 8, device="cuda", dtype=real_torch.float16)
    grid = real_torch.zeros(1, 4, 4, 2, device="cuda", dtype=real_torch.float32)

    with pytest.raises(RuntimeError):
        real_torch.nn.functional.grid_sample(values, grid, align_corners=False)

    with forward_guard(real_torch, device_type="cuda", half=True):
        sampled = real_torch.nn.functional.grid_sample(values, grid, align_corners=False)
    assert sampled.shape == (1, 1, 4, 4)
