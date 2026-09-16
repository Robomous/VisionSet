"""Both halves of the parity chain must be the same ONNX Runtime release.

Phase C measures the exported graphs three times: eager PyTorch, Python ONNX Runtime, and
ONNX Runtime Web in a real browser. The browser is not compared against PyTorch -- it is
compared against the Python ONNX Runtime run, whose per-case masks and confidences are
written to `reference.json`. That makes the Python runtime's version load-bearing: if it is
a different release from the one the browser loads, the reference describes a different
implementation of the same graph, and a genuine browser regression arrives looking exactly
like a version difference.

So the two pins are checked rather than merely written down. `export.py` makes the same
assertion at export time, which is what catches a bump to the browser package; this module
is the cheap always-on half, stdlib-only and needing neither `torch` nor the exported
artifacts, so it runs in the ordinary Python job and catches a bump to `pyproject.toml`.
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

import pytest
from scripts.browser_models.efficientsam import export as export_module

REPO_ROOT = Path(__file__).resolve().parents[2]


def _python_onnxruntime_specifier() -> str:
    pyproject = tomllib.loads((REPO_ROOT / "pyproject.toml").read_bytes().decode())
    group = pyproject["dependency-groups"]["browser-models"]
    declared = [entry for entry in group if entry.replace("_", "-").startswith("onnxruntime=")]
    assert len(declared) == 1, f"expected exactly one onnxruntime pin, found {declared!r}"
    return declared[0]


def test_python_onnxruntime_is_pinned_exactly() -> None:
    """A floor would let the reference be produced by a runtime nobody chose."""
    specifier = _python_onnxruntime_specifier()
    assert specifier.startswith("onnxruntime=="), (
        f"the browser-models group declares {specifier!r}; it must be an exact `==` pin, "
        "because this version is half of a parity claim rather than a compatibility floor."
    )


def test_the_two_onnx_runtimes_are_the_same_release() -> None:
    python_version = _python_onnxruntime_specifier().removeprefix("onnxruntime==")
    assert python_version == export_module.onnxruntime_web_pin(), (
        "pyproject.toml's `browser-models` group and frontend/browser-inference/package.json "
        "must name the same ONNX Runtime release -- move them together."
    )


def test_alignment_check_rejects_a_mismatch() -> None:
    """The assertion `export.py` relies on must actually fire."""
    with pytest.raises(AssertionError, match="disagree"):
        export_module.assert_runtime_alignment("1.29.0", "1.30.0")


def test_alignment_check_accepts_a_match() -> None:
    export_module.assert_runtime_alignment("1.29.0", "1.29.0")


def test_a_ranged_browser_pin_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A caret would move the browser runtime at install time, defeating the pin."""
    manifest = tmp_path / "package.json"
    manifest.write_text(json.dumps({"dependencies": {"onnxruntime-web": "^1.29.0"}}))
    monkeypatch.setattr(export_module, "BROWSER_PACKAGE_JSON", manifest)
    with pytest.raises(AssertionError, match="which is a range"):
        export_module.onnxruntime_web_pin()


def test_a_missing_browser_pin_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manifest = tmp_path / "package.json"
    manifest.write_text(json.dumps({"dependencies": {"vitest": "5.0.0"}}))
    monkeypatch.setattr(export_module, "BROWSER_PACKAGE_JSON", manifest)
    with pytest.raises(AssertionError, match="declares no onnxruntime-web"):
        export_module.onnxruntime_web_pin()
