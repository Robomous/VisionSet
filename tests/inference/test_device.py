"""Where a local model runs, and whether half precision survives the trip.

The rule these cover shipped inside both adapters, twice, and untested in either:
nothing reached the fallback branch, the warning, or the half-precision decision.
It is one function now, and this is its first coverage.

**Every case runs on a stub**, which is the point rather than a compromise. No
runner in continuous integration has an NVIDIA GPU and none is an Apple Silicon
Mac, so a test asking for real hardware would skip everywhere and prove nothing;
availability is an *input* to this function, and injecting it is how both answers
get exercised on a machine that has neither.
"""

from __future__ import annotations

import logging
import os

import pytest
from tests.inference.stubs import StubTorch

from visionset.inference import _device


def resolve(
    *,
    device: str,
    precision: str | None = "fp32",
    cuda: bool = False,
    mps: bool = False,
    mps_usable: bool = True,
) -> tuple[str, bool]:
    """``resolved`` with a stub torch and a name, so a case reads as its question.

    A fresh ``StubTorch`` per call is what keeps ``_mps_serves``'s cache out of
    the way: it is keyed on the array library it was handed, so two cases asking
    opposite questions never see each other's answer.
    """
    return _device.resolved(
        StubTorch(cuda=cuda, mps=mps, mps_usable=mps_usable),
        device=device,
        precision=precision,
        connection_name="detector",
    )


def test_the_cpu_is_always_present_and_never_runs_in_half_precision() -> None:
    assert resolve(device="cpu") == ("cpu", False)


def test_a_cuda_machine_keeps_cuda_and_the_half_precision_it_asked_for() -> None:
    assert resolve(device="cuda", precision="fp16", cuda=True) == ("cuda", True)


def test_a_cuda_connection_asking_for_full_precision_keeps_full_precision() -> None:
    assert resolve(device="cuda", precision="fp32", cuda=True) == ("cuda", False)


def test_a_second_gpu_is_still_a_cuda_device() -> None:
    assert resolve(device="cuda:1", precision="fp16", cuda=True) == ("cuda:1", True)


def test_cuda_on_a_machine_with_no_gpu_falls_back_to_the_cpu(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING):
        assert resolve(device="cuda", precision="fp16", cuda=False) == ("cpu", False)
    assert "detector" in caplog.text
    assert "cuda" in caplog.text


def test_mps_on_an_apple_silicon_machine_is_kept() -> None:
    assert resolve(device="mps", mps=True) == ("mps", False)


def test_mps_never_runs_in_half_precision_even_when_the_connection_asks_for_it() -> None:
    """The CUDA-only dtype rule must not leak to Metal.

    A row written before the kernel conditioned precision on the device could
    carry ``mps`` beside ``fp16``, and the answer has to be the same one the
    kernel gives at creation rather than an autocast Metal cannot honour.
    """
    assert resolve(device="mps", precision="fp16", mps=True) == ("mps", False)


def test_a_cpu_connection_asking_for_half_precision_does_not_get_it() -> None:
    assert resolve(device="cpu", precision="fp16") == ("cpu", False)


def test_metal_that_cannot_take_a_tensor_falls_back_to_the_cpu(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The case ``is_available`` alone gets wrong, and it is a real machine.

    An Intel Mac with a discrete GPU answers ``is_built`` **and**
    ``is_available`` true, then raises on every allocation — so the check that
    shipped waved ``mps`` through, no warning was logged, and the failure landed
    as a 500 out of the first suggestion instead of a slow run on the CPU.
    Reproduced on an i9 MacBook Pro, macOS 26.6, torch 2.13.
    """
    with caplog.at_level(logging.WARNING):
        assert resolve(device="mps", mps=True, mps_usable=False) == ("cpu", False)
    assert "detector" in caplog.text
    assert "mps" in caplog.text


def test_the_probe_is_not_paid_for_on_a_machine_with_no_metal_at_all() -> None:
    """``is_available`` is asked first, so the common case allocates nothing.

    A stub whose ``zeros`` raises ``AssertionError`` — which the production code
    deliberately does *not* catch — is how "never reached" is asserted rather
    than described.
    """
    torch = StubTorch(mps=False)
    torch.zeros = _never  # type: ignore[method-assign]

    assert _device.resolved(torch, device="mps", precision="fp32", connection_name="detector") == (
        "cpu",
        False,
    )


def _never(*_: object, **__: object) -> object:
    raise AssertionError("the probe ran on a machine that reports no Metal")


def test_a_surprise_from_the_probe_is_not_read_as_absent_hardware() -> None:
    """The narrowing to ``RuntimeError``, which is the whole of what it buys.

    An unusable backend raises ``RuntimeError``; a half-installed array library
    raises other things. Turning the second into a silent CPU fallback would
    hide a broken installation behind a fifty-times-slower run, which is the
    most expensive way for this function to be wrong — so it propagates.
    """
    torch = StubTorch(mps=True)
    torch.zeros = _broken  # type: ignore[method-assign]

    with pytest.raises(ValueError, match="half an installation"):
        _device.resolved(torch, device="mps", precision="fp32", connection_name="detector")


def _broken(*_: object, **__: object) -> object:
    raise ValueError("half an installation")


def test_mps_on_a_machine_without_metal_falls_back_to_the_cpu(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING):
        assert resolve(device="mps", mps=False) == ("cpu", False)
    assert "detector" in caplog.text
    assert "mps" in caplog.text


def test_the_cpu_is_not_asked_whether_it_is_available(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A stub answering ``False`` to everything must still leave the CPU alone.

    Without this, a resolver that asked about every device would look correct in
    every other case here and warn on the one machine that cannot be wrong.
    """
    with caplog.at_level(logging.WARNING):
        assert resolve(device="cpu") == ("cpu", False)
    assert caplog.text == ""


def test_surrounding_whitespace_in_a_stored_device_is_ignored() -> None:
    assert resolve(device="  cuda  ", precision="fp16", cuda=True) == ("cuda", True)


def test_resolving_onto_metal_asks_for_the_cpu_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(_device.MPS_FALLBACK_VARIABLE, raising=False)
    resolve(device="mps", mps=True)
    assert os.environ[_device.MPS_FALLBACK_VARIABLE] == "1"


def test_an_operator_who_turned_the_fallback_off_keeps_that_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``setdefault``, not an assignment.

    Somebody debugging which operators Metal is missing turns this off on
    purpose, and a library that overwrites it makes that impossible.
    """
    monkeypatch.setenv(_device.MPS_FALLBACK_VARIABLE, "0")
    resolve(device="mps", mps=True)
    assert os.environ[_device.MPS_FALLBACK_VARIABLE] == "0"


def test_the_fallback_can_be_asked_for_without_resolving_anything(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The call the package makes as it is imported, which is the one that matters.

    By the time a device has been resolved the array library is already loaded,
    so the ``setdefault`` inside ``resolved`` is a second belt. That the *import*
    reaches this before anything heavy loads is asserted in a fresh interpreter,
    in ``tests/architecture/test_optional_runtime.py``, because this one has
    already imported both.
    """
    monkeypatch.delenv(_device.MPS_FALLBACK_VARIABLE, raising=False)
    _device.enable_mps_fallback()
    assert os.environ[_device.MPS_FALLBACK_VARIABLE] == "1"
