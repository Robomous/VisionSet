"""Does the exported ONNX graph compute what the wrapper it came from computes?

Two different PyTorch implementations of `predict_masks` exist at the pinned upstream
revision, and they differ in exactly one place: `efficient_sam/efficient_sam.py` (the
model class) upsamples the final mask with `mode="bicubic"`, while `onnx_models.py`
(upstream's own export wrapper, which `wrapper.py` subclasses without changing this)
upsamples with `mode="bilinear"`. A single "PyTorch vs exported ONNX" comparison would
therefore measure an interpolation choice, not export fidelity, and either fail for the
wrong reason or get loosened until it proved nothing.

So this measures two separate things:

1. **Export fidelity** -- `wrapper.py`'s classes run eagerly, in PyTorch, vs the graphs
   `export.py` produced from those same classes, run under Python ONNX Runtime. Same
   maths on both sides; this isolates the export step and earns a tight bar.
2. **Wrapper deviation** -- upstream's `EfficientSam.predict_masks` (bicubic) vs
   `wrapper.py`'s decoder (bilinear), both run eagerly. This quantifies the cost of the
   bilinear choice. It is measured and reported, never gated: it is a known, deliberate
   difference, not a defect.

Masks are thresholded with `> 0`, matching `binaryMask` in
`frontend/browser-inference/src/models/efficientSam.ts` -- upstream's own example uses
`>= 0`, and the two disagree only on an exactly-zero logit, which is a tie-break, not an
export question.

Run with `uv run python scripts/browser_models/efficientsam/parity.py`, after
`uv sync --locked --group browser-models` and after
`uv run python scripts/browser_models/efficientsam/export.py` has produced the artifacts
this reads. Writes `reference.json` beside the artifacts and updates their
`build-report.json`'s `parity` field in place -- but only writes the reference when the
gates pass. A failing run removes it instead, because a run that could not vouch for the
graphs must not be the thing the browser suite measures itself against.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import export as export_module  # noqa: E402  local sibling; see export.py's import-order note
from fixture import HEIGHT, REFERENCE_IMAGE_SHA256, WIDTH, reference_image  # noqa: E402

MAX_POINTS = 6

# Gates for export fidelity (comparison 1 in the module docstring). Measured on the
# reference probe that preceded this script: selected index equal on every case, IoU
# absolute error 1.8e-07 .. 8.0e-07, binary mask IoU exactly 1.0 on every case. The
# bars below sit an order of magnitude above the noise floor a correct export produces
# (float32 accumulation differences between eager PyTorch and ONNX Runtime), while
# staying far below what an actual export bug -- a wrong interpolation mode, a
# transposed axis, a mis-rescaled point -- would produce: those move whole mask
# boundaries and land IoU error in the 1e-2..1e-1 range with mask IoU well under 1.0.
IOU_SCORE_ABS_TOL = 1e-5
MASK_IOU_EXACT = 1.0


@dataclass(frozen=True)
class Case:
    name: str
    positive: tuple[tuple[int, int], ...]


# Coordinates tuned against the real model in the pre-Task-8 spike. Case 1 recovers the
# circle at 25,068 px against its true area of 25,447; case 2 recovers the rectangle at
# 33,575 against 33,600. Positive-only: this model defines no negative point -- see
# `frontend/browser-inference/src/models/efficientSam.ts`'s module docstring.
CASES: tuple[Case, ...] = (
    Case("one positive, circle", ((170, 192),)),
    Case("one positive, rectangle", ((380, 195),)),
    Case("two positives, rectangle refined", ((380, 195), (320, 110))),
)


def encode_prompt(points: tuple[tuple[int, int], ...]) -> tuple[np.ndarray, np.ndarray]:
    """Pad `points` to `MAX_POINTS`, all labelled positive -- `decoderPrompt` in TypeScript."""
    coords = np.full((1, 1, MAX_POINTS, 2), -1.0, dtype=np.float32)
    labels = np.full((1, 1, MAX_POINTS), -1.0, dtype=np.float32)
    for slot, (x, y) in enumerate(points):
        coords[0, 0, slot] = (x, y)
        labels[0, 0, slot] = 1.0
    return coords, labels


def best_candidate(iou: np.ndarray) -> tuple[int, float]:
    """`bestCandidate` in TypeScript: argmax, confidence clamped to [0, 1]."""
    index = int(np.argmax(iou))
    return index, float(min(1.0, max(0.0, iou[index])))


def binary_mask(logits: np.ndarray) -> np.ndarray:
    """`binaryMask` in TypeScript: `> 0`, not `>= 0`."""
    return (logits > 0).astype(np.uint8)


def mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    a_bool, b_bool = a.astype(bool), b.astype(bool)
    union = np.logical_or(a_bool, b_bool).sum()
    if union == 0:
        # No lit pixels on either side is not agreement, it is two empty masks -- do not let
        # that trivially satisfy the strictest gate.
        return 0.0
    return float(np.logical_and(a_bool, b_bool).sum() / union)


def mask_sha256(mask: np.ndarray) -> str:
    """Hashes the same bytes a browser's `Uint8Array` mask would hash: one 0/1 byte per pixel."""
    return hashlib.sha256(mask.tobytes()).hexdigest()


def build_eager_model() -> tuple[Any, Any]:
    """Build the upstream model and its wrapper module, exactly as `export.py` does."""
    import torch

    cache_dir = export_module.DEFAULT_ARTIFACTS_DIR / ".cache"
    upstream_dir = export_module.ensure_upstream_checkout(cache_dir)
    checkpoint_path = export_module.ensure_checkpoint(cache_dir)
    wrapper_module = export_module.load_wrapper_module(upstream_dir)
    model = export_module.build_ti_model(checkpoint_path)
    torch.manual_seed(0)  # the model is deterministic in eval mode; belt and suspenders
    return model, wrapper_module


def run_parity(artifacts_dir: Path) -> dict[str, Any]:
    import onnxruntime
    import torch

    model, wrapper_module = build_eager_model()
    encoder_eager = wrapper_module.EfficientSamEncoder(model)
    decoder_eager = wrapper_module.EfficientSamDecoder(model)

    image = reference_image()
    image_sha256 = hashlib.sha256(image.tobytes()).hexdigest()
    if image_sha256 != REFERENCE_IMAGE_SHA256:
        raise AssertionError(
            f"reference image sha256 mismatch: got {image_sha256}, expected "
            f"{REFERENCE_IMAGE_SHA256} -- fixture.py has drifted from what it asserts"
        )
    x_np = (image.transpose(2, 0, 1)[None].astype(np.float32)) / 255.0

    encoder_session = onnxruntime.InferenceSession(
        str(artifacts_dir / "encoder.onnx"), providers=["CPUExecutionProvider"]
    )
    decoder_session = onnxruntime.InferenceSession(
        str(artifacts_dir / "decoder.onnx"), providers=["CPUExecutionProvider"]
    )

    with torch.no_grad():
        emb_eager = encoder_eager(torch.from_numpy(x_np))
    (emb_ort,) = encoder_session.run(None, {"batched_images": x_np})
    encoder_max_abs_diff = float(np.abs(emb_eager.numpy() - emb_ort).max())
    print(
        f"encoder: eager vs ORT embedding max|diff| = {encoder_max_abs_diff:.3e} "
        f"(diagnostic, not gated -- comparisons below carry each side's own embedding through)"
    )

    orig_im_size = torch.tensor([HEIGHT, WIDTH], dtype=torch.long)
    orig_im_size_np = np.array([HEIGHT, WIDTH], dtype=np.int64)

    case_reports: list[dict[str, Any]] = []
    reference_cases: list[dict[str, Any]] = []
    gate_failures: list[str] = []

    for case in CASES:
        coords, labels = encode_prompt(case.positive)

        with torch.no_grad():
            masks_we_t, iou_we_t = decoder_eager(
                emb_eager, torch.from_numpy(coords), torch.from_numpy(labels), orig_im_size
            )
        masks_we, iou_we = masks_we_t.numpy(), iou_we_t.numpy()

        masks_ort, iou_ort = decoder_session.run(
            None,
            {
                "image_embeddings": emb_ort,
                "batched_point_coords": coords,
                "batched_point_labels": labels,
                "orig_im_size": orig_im_size_np,
            },
        )

        idx_we, conf_we = best_candidate(iou_we[0, 0])
        idx_ort, conf_ort = best_candidate(iou_ort[0, 0])
        iou_score_abs_error = float(np.abs(iou_we - iou_ort).max())

        mask_we = binary_mask(masks_we[0, 0, idx_we])
        mask_ort = binary_mask(masks_ort[0, 0, idx_ort])
        if mask_we.sum() == 0 or mask_ort.sum() == 0:
            raise AssertionError(
                f"{case.name}: an empty mask would trivially pass the mask-IoU gate -- "
                f"lit pixels eager={int(mask_we.sum())}, ort={int(mask_ort.sum())}"
            )
        export_mask_iou = mask_iou(mask_we, mask_ort)

        index_equal = idx_we == idx_ort
        iou_gate_ok = iou_score_abs_error <= IOU_SCORE_ABS_TOL
        mask_gate_ok = export_mask_iou >= MASK_IOU_EXACT

        # Comparison 2: upstream's own (bicubic) model class vs our (bilinear) wrapper,
        # both eager, both fed the same embedding and prompt. Not gated -- see module docstring.
        with torch.no_grad():
            masks_bicubic_t, iou_bicubic_t = model.predict_masks(
                emb_eager,
                torch.from_numpy(coords),
                torch.from_numpy(labels),
                True,
                HEIGHT,
                WIDTH,
                HEIGHT,
                WIDTH,
            )
        masks_bicubic, iou_bicubic = masks_bicubic_t.numpy(), iou_bicubic_t.numpy()
        idx_bicubic, conf_bicubic = best_candidate(iou_bicubic[0, 0])
        mask_bicubic = binary_mask(masks_bicubic[0, 0, idx_bicubic])
        wrapper_deviation_iou = mask_iou(mask_bicubic, mask_we)
        bicubic_bool, bilinear_bool = mask_bicubic.astype(bool), mask_we.astype(bool)
        differing_pixels = int(np.logical_xor(bicubic_bool, bilinear_bool).sum())

        lit_ort = int(mask_ort.sum())
        total_pixels = int(mask_ort.size)

        print(
            f"[{case.name}] idx eager={idx_we} ort={idx_ort} | "
            f"iou_score_abs_error={iou_score_abs_error:.3e} (gate <= {IOU_SCORE_ABS_TOL:.0e}) | "
            f"export_mask_iou={export_mask_iou:.6f} (gate >= {MASK_IOU_EXACT}) | "
            f"confidence eager={conf_we:.6f} ort={conf_ort:.6f} | "
            f"lit={lit_ort}/{total_pixels}"
        )
        print(
            f"           bicubic(upstream) vs bilinear(ours): idx {idx_bicubic} vs {idx_we}, "
            f"maskIoU={wrapper_deviation_iou:.6f}, differing px={differing_pixels}, "
            f"confidence bicubic={conf_bicubic:.6f}"
        )

        if not index_equal:
            gate_failures.append(
                f"{case.name}: selected index differs (eager={idx_we}, ort={idx_ort})"
            )
        if not iou_gate_ok:
            gate_failures.append(
                f"{case.name}: iou_score_abs_error {iou_score_abs_error:.3e} "
                f"> {IOU_SCORE_ABS_TOL:.0e}"
            )
        if not mask_gate_ok:
            gate_failures.append(
                f"{case.name}: export_mask_iou {export_mask_iou:.6f} < {MASK_IOU_EXACT}"
            )

        case_reports.append(
            {
                "name": case.name,
                "positive_points": [list(p) for p in case.positive],
                "export_fidelity": {
                    "selected_index_equal": index_equal,
                    "selected_index_eager": idx_we,
                    "selected_index_ort": idx_ort,
                    "iou_score_abs_error": iou_score_abs_error,
                    "confidence_eager": conf_we,
                    "confidence_ort": conf_ort,
                    "mask_iou": export_mask_iou,
                },
                "wrapper_deviation": {
                    "selected_index_bicubic": idx_bicubic,
                    "selected_index_bilinear": idx_we,
                    "confidence_bicubic": conf_bicubic,
                    "confidence_bilinear": conf_we,
                    "mask_iou": wrapper_deviation_iou,
                    "differing_pixels": differing_pixels,
                    "total_pixels": total_pixels,
                },
            }
        )
        reference_cases.append(
            {
                "name": case.name,
                "positive_points": [list(p) for p in case.positive],
                "selected_index": idx_ort,
                "confidence": conf_ort,
                "mask_sha256": mask_sha256(mask_ort),
                "lit_pixels": lit_ort,
                "total_pixels": total_pixels,
            }
        )

    return {
        "image_sha256": image_sha256,
        "encoder_max_abs_diff": encoder_max_abs_diff,
        "cases": case_reports,
        "reference_cases": reference_cases,
        "gate_failures": gate_failures,
    }


def write_reference_json(artifacts_dir: Path, result: dict[str, Any]) -> None:
    reference = {
        "model_id": export_module.MODEL_ID,
        "generated_at": datetime.now(UTC).isoformat(),
        "image": {"width": WIDTH, "height": HEIGHT, "sha256": result["image_sha256"]},
        "mask_threshold": 0,
        "note": (
            "Per-case values are the Python-ONNX-Runtime side of the export-fidelity "
            "comparison in parity.py -- the same graphs a browser loads. A browser test "
            "compares its own onnxruntime-web run against this file."
        ),
        "cases": result["reference_cases"],
    }
    (artifacts_dir / "reference.json").write_text(json.dumps(reference, indent=2) + "\n")


def update_build_report(artifacts_dir: Path, result: dict[str, Any], status: str) -> None:
    build_report_path = artifacts_dir / "build-report.json"
    report = json.loads(build_report_path.read_text())
    report["parity"] = {
        "status": status,
        "measured_at": datetime.now(UTC).isoformat(),
        "reference_image_sha256": result["image_sha256"],
        "encoder_max_abs_diff": result["encoder_max_abs_diff"],
        "gates": {
            "selected_index_equal": True,
            "iou_score_abs_error_tolerance": IOU_SCORE_ABS_TOL,
            "mask_iou_minimum": MASK_IOU_EXACT,
        },
        "gate_failures": result["gate_failures"],
        "cases": result["cases"],
        "note": (
            "export_fidelity compares wrapper.py's classes eager vs the graphs export.py "
            "produced from them, under Python ONNX Runtime -- same maths both sides. "
            "wrapper_deviation compares upstream's own EfficientSam.predict_masks "
            "(bicubic upsample) against wrapper.py's decoder (bilinear upsample), both "
            "eager; it is measured and reported, never gated, because it is a deliberate "
            "difference from upstream's model class, not an export defect."
        ),
    }
    build_report_path.write_text(json.dumps(report, indent=2) + "\n")


def main() -> None:
    artifacts_dir = export_module.DEFAULT_ARTIFACTS_DIR / export_module.MODEL_ID
    for name in ("encoder.onnx", "decoder.onnx", "build-report.json"):
        if not (artifacts_dir / name).exists():
            raise SystemExit(
                f"{artifacts_dir / name} is missing -- run "
                "`uv run python scripts/browser_models/efficientsam/export.py` first"
            )

    start = time.time()
    result = run_parity(artifacts_dir)
    elapsed = time.time() - start

    status = "fail" if result["gate_failures"] else "pass"

    # `reference.json` is what the browser suite measures itself against, and a run that
    # failed its own gates has not earned the right to say what correct looks like. Writing
    # it anyway -- which this did until a deliberately broken run proved it -- leaves a
    # reference describing graphs nobody vouched for, and every consumer downstream then
    # agrees with it: the browser suite compares against the wrong numbers and passes, or
    # fails for a reason that has nothing to do with the browser.
    #
    # So a failing run writes no reference and removes any earlier one. A missing
    # reference.json is a state both consumers already handle correctly -- they skip
    # locally and fail under VISIONSET_REQUIRE_BROWSER_MODELS -- which is the right answer
    # here. The build report is still updated either way, because the record of a failure
    # is exactly what should survive it.
    if result["gate_failures"]:
        (artifacts_dir / "reference.json").unlink(missing_ok=True)
    else:
        write_reference_json(artifacts_dir, result)
    update_build_report(artifacts_dir, result, status)

    print(f"\nparity status: {status}  ({elapsed:.1f}s)")
    if result["gate_failures"]:
        for failure in result["gate_failures"]:
            print(f"  GATE FAILURE: {failure}")
        print(
            "\nreference.json was not written (and any earlier one was removed): a run that "
            "failed its gates does not get to define what the browser is measured against."
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
