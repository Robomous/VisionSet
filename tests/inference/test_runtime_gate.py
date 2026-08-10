"""The gate that decides which half of the inference matrix runs, tested itself.

`require_local_inference` is the only reason CI's `inference-smoke` job means
anything: it is what turns a broken install of the optional runtime from a
quietly shrinking suite into a red build. A rule nothing exercises is a comment,
and this one is invisible when it works — the whole job passes either way — so it
gets a test that drives all three of its answers directly.

Nothing here needs the runtime installed, or absent: the predicate is patched, so
the same three assertions run identically in both CI jobs and on any developer
machine.
"""

from __future__ import annotations

import pytest
from tests.fixtures import local_inference
from tests.fixtures.local_inference import EXTRA_REQUIRED_ENV, require_local_inference


def test_a_missing_runtime_is_a_skip_where_nothing_asked_for_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A base install is a working install, and its test run says so by skipping.

    The default has to be the quiet one: most machines that run this suite have
    no reason to carry two gigabytes of CUDA wheels, and a red suite for not
    having them would be a demand rather than a check.
    """
    monkeypatch.setattr(local_inference, "EXTRA_INSTALLED", False)
    monkeypatch.delenv(EXTRA_REQUIRED_ENV, raising=False)

    with pytest.raises(pytest.skip.Exception) as raised:
        require_local_inference()
    assert "local-inference" in str(raised.value)


def test_a_missing_runtime_is_an_error_where_the_job_installed_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The flip, and the whole point of the variable.

    Reverting the skip-to-error branch in `require_local_inference` turns this
    test red — which is the only thing standing between `inference-smoke` and the
    failure it exists to prevent: an install that broke, a suite that skipped
    every test needing the runtime, and a green tick reporting it.

    **Written as a `try` rather than as `pytest.raises(RuntimeError)`, and that is
    the whole reason it works.** A skip is raised as a `BaseException`, which
    sails straight through a `raises` looking for `RuntimeError` and skips *this*
    test — so against a build where the flip had been reverted, the guard's own
    test reported "skipped", not "failed", and a skip is not red. Catching the
    skip by name is what turns the regression into a failure somebody sees.
    """
    monkeypatch.setattr(local_inference, "EXTRA_INSTALLED", False)
    monkeypatch.setenv(EXTRA_REQUIRED_ENV, "1")

    try:
        require_local_inference()
    except RuntimeError as error:
        assert EXTRA_REQUIRED_ENV in str(error)
    except pytest.skip.Exception as skipped:
        pytest.fail(f"a missing runtime skipped under {EXTRA_REQUIRED_ENV}=1: {skipped}")
    else:
        pytest.fail(f"a missing runtime did nothing under {EXTRA_REQUIRED_ENV}=1")


def test_a_present_runtime_asks_nothing_of_either(monkeypatch: pytest.MonkeyPatch) -> None:
    """With the runtime there, the variable changes nothing — it only ever
    describes what to do about its absence."""
    monkeypatch.setattr(local_inference, "EXTRA_INSTALLED", True)
    monkeypatch.setenv(EXTRA_REQUIRED_ENV, "1")

    assert require_local_inference() is None
