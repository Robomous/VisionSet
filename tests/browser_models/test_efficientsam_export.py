"""Does the exported EfficientSAM-Ti graph still pass the parity gates it shipped with?

Skips unless both halves are present: the `browser-models` dependency group (`numpy`, `onnx`,
`onnxruntime`, `torch` -- `parity.py` re-runs the eager PyTorch side, not only the ONNX side)
and the artifacts `export.py`/`parity.py` produce. Neither is there by default -- the group is
deliberately not in `dev` because it brings torch, and
`frontend/browser-inference/model-artifacts/` is gitignored (a 41 MB checkpoint and two
~20 MB graphs, reproducible on demand, never committed). Checking the group by `find_spec`
rather than importing it matters here specifically: the artifact *files* survive a later
`uv sync --locked` that removes the group, so a stale checkout with old artifacts but no torch
must still skip cleanly rather than erroring on an import this module makes at collection time.
`VISIONSET_REQUIRE_BROWSER_MODELS=1` turns that skip into a failure, the `require_local_inference`
rule one subsystem over: a job whose whole point is exercising this export must not quietly pass
by skipping it.

Build the artifacts first:

    uv sync --locked --group browser-models
    uv run python scripts/browser_models/efficientsam/export.py
    uv run python scripts/browser_models/efficientsam/parity.py
"""

from __future__ import annotations

import importlib.util
import json
import os
from typing import Any

import pytest
from scripts.browser_models.efficientsam import export as export_module

REQUIRED_ENV = "VISIONSET_REQUIRE_BROWSER_MODELS"

ARTIFACTS_DIR = export_module.DEFAULT_ARTIFACTS_DIR / export_module.MODEL_ID

BROWSER_MODELS_MODULES = ("numpy", "onnx", "onnxruntime", "torch")

GROUP_INSTALLED = all(importlib.util.find_spec(name) is not None for name in BROWSER_MODELS_MODULES)

MISSING_HINT = (
    "the browser-models dependency group and/or its exported artifacts are not present here. "
    "Build them: `uv sync --locked --group browser-models`, then "
    "`uv run python scripts/browser_models/efficientsam/export.py` and "
    "`uv run python scripts/browser_models/efficientsam/parity.py`."
)


def _artifacts_present() -> bool:
    return all(
        (ARTIFACTS_DIR / name).exists()
        for name in ("encoder.onnx", "decoder.onnx", "build-report.json", "reference.json")
    )


def require_browser_models() -> None:
    """Skip locally, fail where the artifacts were supposed to be built.

    The `require_local_inference` bargain, one subsystem over: this module holds both the
    always-runnable parts (none, here -- the whole suite needs the exported graphs) and the
    with-artifacts parts, so a module-level skip is the right shape, and it must not fire
    silently in the job that exists to build and check these artifacts.
    """
    if GROUP_INSTALLED and _artifacts_present():
        return
    if os.environ.get(REQUIRED_ENV) == "1":
        raise RuntimeError(
            f"{MISSING_HINT} ({REQUIRED_ENV}=1 is set, so a missing group or artifacts are "
            "an error, not a skip.)"
        )
    pytest.skip(MISSING_HINT, allow_module_level=True)


require_browser_models()

from scripts.browser_models.efficientsam import parity  # noqa: E402


def _build_report() -> dict[str, Any]:
    return json.loads((ARTIFACTS_DIR / "build-report.json").read_text())


def _reference_json() -> dict[str, Any]:
    return json.loads((ARTIFACTS_DIR / "reference.json").read_text())


def test_graph_contract_matches_the_build_report() -> None:
    contract = _build_report()["graph_contract"]

    assert contract["encoder"]["inputs"] == [
        {"name": "batched_images", "dtype": "float32", "dims": ["dynamic", 3, "dynamic", "dynamic"]}
    ]
    assert contract["encoder"]["outputs"] == [
        {
            "name": "image_embeddings",
            "dtype": "float32",
            "dims": ["dynamic", 256, "dynamic", "dynamic"],
        }
    ]
    assert contract["decoder"]["inputs"] == [
        {"name": "image_embeddings", "dtype": "float32", "dims": ["dynamic", 256, 64, 64]},
        {"name": "batched_point_coords", "dtype": "float32", "dims": [1, 1, 6, 2]},
        {"name": "batched_point_labels", "dtype": "float32", "dims": [1, 1, 6]},
        {"name": "orig_im_size", "dtype": "int64", "dims": [2]},
    ]
    assert contract["decoder"]["outputs"] == [
        {"name": "output_masks", "dtype": "float32", "dims": [1, 1, 3, "dynamic", "dynamic"]},
        {"name": "iou_predictions", "dtype": "float32", "dims": [1, 1, 3]},
    ]


def test_parity_gates_pass_and_reference_json_is_current() -> None:
    """Re-runs the gated comparisons (design section 11 / task-9 brief) for real.

    Deliberately re-asserts each threshold here rather than trusting `run_parity`'s own
    `gate_failures` list: a bug in that bookkeeping should not make this suite green by
    agreeing with itself. `reference.json` is also compared against a fresh run, so a graph
    rebuilt without re-running `parity.py` is caught rather than shipping a stale reference
    for the browser suite to compare against.
    """
    result = parity.run_parity(ARTIFACTS_DIR)
    assert result["gate_failures"] == []

    for case in result["cases"]:
        fidelity = case["export_fidelity"]
        assert fidelity["selected_index_equal"], case["name"]
        assert fidelity["iou_score_abs_error"] <= parity.IOU_SCORE_ABS_TOL, case["name"]
        assert fidelity["mask_iou"] >= parity.MASK_IOU_EXACT, case["name"]

    reference_by_name = {case["name"]: case for case in _reference_json()["cases"]}
    assert set(reference_by_name) == {case["name"] for case in result["reference_cases"]}
    for fresh in result["reference_cases"]:
        stored = reference_by_name[fresh["name"]]
        assert stored["selected_index"] == fresh["selected_index"], fresh["name"]
        assert stored["mask_sha256"] == fresh["mask_sha256"], fresh["name"]
        assert stored["lit_pixels"] == fresh["lit_pixels"], fresh["name"]
        assert stored["confidence"] == pytest.approx(fresh["confidence"], abs=1e-6), fresh["name"]
