"""Export EfficientSAM-Ti to the two ONNX graphs the browser worker loads.

Reproduces `frontend/browser-inference/model-artifacts/efficientsam-ti/{encoder,decoder}.onnx`
from the pinned upstream checkpoint (yformer/EfficientSAM @ d525f622e6f6). Every step below
fails the build rather than warning:

  1. fetch (or reuse) the pinned upstream source, sparse, and verify the checked-out revision
  2. fetch (or reuse) the checkpoint, and verify its size and SHA-256 BEFORE `torch.load` touches it
  3. build the model and confirm it is really the Ti variant (`decoder_max_num_input_points == 6`)
  4. export encoder.onnx and decoder.onnx through wrapper.py, via the TorchScript tracer
     (`dynamo=False`) -- the path upstream itself used, and the only one that accepts a point
     count that is a traced constant rather than a declared dynamic axis
  5. assert the full graph contract (every input/output name, dtype, rank and dynamic axis) and
     run each graph once to assert its concrete shapes
  6. hash both artifacts and record their sizes
  7. copy upstream's LICENSE and write PROVENANCE.md beside the artifacts
  8. write build-report.json

Run with `uv run python scripts/browser_models/efficientsam/export.py`, after
`uv sync --locked --group browser-models`. `--artifacts-dir` lets CI point it elsewhere.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import sys
import time
import urllib.request
import warnings
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ARTIFACTS_DIR = REPO_ROOT / "frontend/browser-inference/model-artifacts"

UPSTREAM_REPOSITORY = "https://github.com/yformer/EfficientSAM.git"
UPSTREAM_REVISION = "d525f622e6f640acf5a0fc37c7ca1f243da5bde0"
UPSTREAM_REVISION_DATE = "2024-12-24"
CHECKPOINT_RELATIVE_PATH = "weights/efficient_sam_vitt.pt"
CHECKPOINT_URL = (
    f"https://raw.githubusercontent.com/yformer/EfficientSAM/{UPSTREAM_REVISION}/"
    f"{CHECKPOINT_RELATIVE_PATH}"
)
CHECKPOINT_SIZE_BYTES = 40_982_470
CHECKPOINT_SHA256 = "dff858b19600a46461cbb7de98f796b23a7a888d9f5e34c0b033f7d6eb9e4e6a"

OPSET_VERSION = 17
DECODER_MAX_POINTS = 6
MODEL_ID = "efficientsam-ti"

CODE_LICENSE_EVIDENCE = (
    "Apache-2.0, LICENSE at the upstream tree root, "
    '"Copyright (c) Meta Platforms, Inc. and affiliates." Every source file header points at it.'
)
WEIGHTS_LICENSE_EVIDENCE = (
    "No separate weights license or model card. The checkpoint is committed inside the same "
    'Apache-2.0 tree, under weights/, and the README calls it "available under the weights '
    'folder of this github repository." Phase C redistributes nothing -- the checkpoint is '
    "fetched at build time into an ignored cache and the exported graphs are never packaged --"
    " so this ambiguity is recorded rather than resolved here."
)

# --- graph contract (design section 5) --------------------------------------------------

DYNAMIC = "dynamic"  # sentinel: this axis must be a symbolic (dim_param) dimension


@dataclass(frozen=True)
class TensorSpec:
    name: str
    dtype: int  # onnx.TensorProto element type
    dims: tuple[Any, ...]  # int (must match exactly, static) or DYNAMIC


def _contract(
    onnx_module: Any,
) -> tuple[list[TensorSpec], list[TensorSpec], list[TensorSpec], list[TensorSpec]]:
    float32 = onnx_module.TensorProto.FLOAT
    int64 = onnx_module.TensorProto.INT64
    encoder_inputs = [TensorSpec("batched_images", float32, (DYNAMIC, 3, DYNAMIC, DYNAMIC))]
    encoder_outputs = [TensorSpec("image_embeddings", float32, (DYNAMIC, 256, DYNAMIC, DYNAMIC))]
    decoder_inputs = [
        TensorSpec("image_embeddings", float32, (DYNAMIC, 256, 64, 64)),
        TensorSpec("batched_point_coords", float32, (1, 1, DECODER_MAX_POINTS, 2)),
        TensorSpec("batched_point_labels", float32, (1, 1, DECODER_MAX_POINTS)),
        TensorSpec("orig_im_size", int64, (2,)),
    ]
    decoder_outputs = [
        TensorSpec("output_masks", float32, (1, 1, 3, DYNAMIC, DYNAMIC)),
        TensorSpec("iou_predictions", float32, (1, 1, 3)),
    ]
    return encoder_inputs, encoder_outputs, decoder_inputs, decoder_outputs


# --- upstream checkout and checkpoint ----------------------------------------------------


def _run(cmd: list[str], cwd: Path | None = None) -> None:
    subprocess.run(cmd, cwd=cwd, check=True)


def ensure_upstream_checkout(cache_dir: Path) -> Path:
    """Sparse-clone yformer/EfficientSAM and check out the pinned revision.

    A plain clone downloads all 269 MB of `weights/`; this fetches only `efficient_sam/`
    and the root files, and only once -- re-running reuses the existing checkout.
    """
    upstream_dir = cache_dir / "upstream"
    if not (upstream_dir / ".git").exists():
        upstream_dir.parent.mkdir(parents=True, exist_ok=True)
        _run(
            [
                "git",
                "clone",
                "--filter=blob:none",
                "--no-checkout",
                UPSTREAM_REPOSITORY,
                str(upstream_dir),
            ]
        )
        _run(["git", "sparse-checkout", "init", "--cone"], cwd=upstream_dir)
        _run(["git", "sparse-checkout", "set", "efficient_sam"], cwd=upstream_dir)
        _run(["git", "checkout", UPSTREAM_REVISION], cwd=upstream_dir)
    else:
        _run(["git", "checkout", UPSTREAM_REVISION], cwd=upstream_dir)

    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=upstream_dir, check=True, capture_output=True, text=True
    ).stdout.strip()
    if head != UPSTREAM_REVISION:
        raise RuntimeError(f"upstream checkout is at {head!r}, expected {UPSTREAM_REVISION!r}")
    return upstream_dir


def verify_checkpoint(checkpoint_path: Path) -> None:
    size = checkpoint_path.stat().st_size
    if size != CHECKPOINT_SIZE_BYTES:
        raise RuntimeError(
            f"checkpoint size mismatch: got {size}, expected {CHECKPOINT_SIZE_BYTES}"
        )
    digest = hashlib.sha256(checkpoint_path.read_bytes()).hexdigest()
    if digest != CHECKPOINT_SHA256:
        raise RuntimeError(
            f"checkpoint sha256 mismatch: got {digest}, expected {CHECKPOINT_SHA256}"
        )


def ensure_checkpoint(cache_dir: Path) -> Path:
    checkpoint_path = cache_dir / "checkpoints" / "efficient_sam_vitt.pt"
    if not checkpoint_path.exists():
        checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        # Pinned https URL; verify_checkpoint below checks size and SHA-256 before anything
        # else reads this file.
        urllib.request.urlretrieve(CHECKPOINT_URL, checkpoint_path)
    verify_checkpoint(checkpoint_path)
    return checkpoint_path


def load_wrapper_module(upstream_dir: Path):
    """Import wrapper.py, after putting upstream's tree root on `sys.path`.

    wrapper.py subclasses upstream's own top-level `onnx_models.py`, which is not a
    packaged module -- it only imports once the upstream checkout root is importable.
    """
    for path in (str(upstream_dir), str(SCRIPT_DIR)):
        if path not in sys.path:
            sys.path.insert(0, path)
    import wrapper  # local sibling module; see the docstring above for the import order

    return wrapper


# --- contract assertions -------------------------------------------------------------------


def _dim_repr(dim) -> Any:
    return dim.dim_param if dim.dim_param else dim.dim_value


def _assert_tensor(value_info, spec: TensorSpec, *, graph_name: str, role: str) -> None:
    if value_info.name != spec.name:
        raise AssertionError(
            f"{graph_name} {role} name: got {value_info.name!r}, expected {spec.name!r}"
        )
    tensor_type = value_info.type.tensor_type
    if tensor_type.elem_type != spec.dtype:
        raise AssertionError(
            f"{graph_name} {spec.name!r} dtype: got {tensor_type.elem_type}, expected {spec.dtype}"
        )
    dims = tensor_type.shape.dim
    if len(dims) != len(spec.dims):
        raise AssertionError(
            f"{graph_name} {spec.name!r} rank: got {len(dims)}, expected {len(spec.dims)}"
        )
    for axis, (dim, expected) in enumerate(zip(dims, spec.dims, strict=True)):
        is_dynamic = bool(dim.dim_param)
        if expected is DYNAMIC:
            if not is_dynamic:
                raise AssertionError(
                    f"{graph_name} {spec.name!r} axis {axis}: "
                    f"expected dynamic, got static {dim.dim_value}"
                )
        else:
            if is_dynamic or dim.dim_value != expected:
                raise AssertionError(
                    f"{graph_name} {spec.name!r} axis {axis}: "
                    f"got {_dim_repr(dim)!r}, expected {expected!r}"
                )


def assert_graph_contract(
    onnx_module: Any,
    path: Path,
    graph_name: str,
    inputs: list[TensorSpec],
    outputs: list[TensorSpec],
) -> None:
    graph = onnx_module.load(str(path), load_external_data=False).graph

    actual_input_names = [v.name for v in graph.input]
    expected_input_names = [spec.name for spec in inputs]
    if actual_input_names != expected_input_names:
        raise AssertionError(
            f"{graph_name} input names: got {actual_input_names}, expected {expected_input_names}"
        )
    actual_output_names = [v.name for v in graph.output]
    expected_output_names = [spec.name for spec in outputs]
    if actual_output_names != expected_output_names:
        raise AssertionError(
            f"{graph_name} output names: "
            f"got {actual_output_names}, expected {expected_output_names}"
        )

    for value_info, spec in zip(graph.input, inputs, strict=True):
        _assert_tensor(value_info, spec, graph_name=graph_name, role="input")
    for value_info, spec in zip(graph.output, outputs, strict=True):
        _assert_tensor(value_info, spec, graph_name=graph_name, role="output")


def assert_runtime_shapes(onnxruntime_module: Any, encoder_path: Path, decoder_path: Path) -> None:
    """Run each graph once and assert the concrete shapes the design's section 5 names."""
    import numpy as np

    height, width = 384, 512
    images = np.zeros((1, 3, height, width), dtype=np.float32)

    encoder_session = onnxruntime_module.InferenceSession(
        str(encoder_path), providers=["CPUExecutionProvider"]
    )
    (embeddings,) = encoder_session.run(None, {"batched_images": images})
    if embeddings.shape != (1, 256, 64, 64):
        raise AssertionError(
            f"image_embeddings shape: got {embeddings.shape}, expected (1, 256, 64, 64)"
        )

    coords = np.full((1, 1, DECODER_MAX_POINTS, 2), -1.0, dtype=np.float32)
    labels = np.full((1, 1, DECODER_MAX_POINTS), -1.0, dtype=np.float32)
    coords[0, 0, 0] = (170, 192)
    labels[0, 0, 0] = 1.0

    decoder_session = onnxruntime_module.InferenceSession(
        str(decoder_path), providers=["CPUExecutionProvider"]
    )
    output_masks, iou_predictions = decoder_session.run(
        None,
        {
            "image_embeddings": embeddings,
            "batched_point_coords": coords,
            "batched_point_labels": labels,
            "orig_im_size": np.array([height, width], dtype=np.int64),
        },
    )
    if output_masks.shape != (1, 1, 3, height, width):
        raise AssertionError(
            f"output_masks shape: got {output_masks.shape}, expected (1, 1, 3, {height}, {width})"
        )
    if iou_predictions.shape != (1, 1, 3):
        raise AssertionError(
            f"iou_predictions shape: got {iou_predictions.shape}, expected (1, 1, 3)"
        )


# --- export ----------------------------------------------------------------------------------


def export_graphs(model, wrapper_module, output_dir: Path) -> dict[str, float]:
    import torch

    output_dir.mkdir(parents=True, exist_ok=True)
    encoder_path = output_dir / "encoder.onnx"
    decoder_path = output_dir / "decoder.onnx"

    encoder = wrapper_module.EfficientSamEncoder(model)
    decoder = wrapper_module.EfficientSamDecoder(model)

    warnings.filterwarnings("ignore")  # upstream's own export triggers several TracerWarnings

    start = time.time()
    torch.onnx.export(
        encoder,
        (torch.randn(1, 3, 384, 512),),
        str(encoder_path),
        export_params=True,
        opset_version=OPSET_VERSION,
        do_constant_folding=True,
        dynamo=False,
        input_names=["batched_images"],
        output_names=["image_embeddings"],
        dynamic_axes={"batched_images": {0: "batch", 2: "height", 3: "width"}},
    )
    encoder_seconds = time.time() - start

    start = time.time()
    torch.onnx.export(
        decoder,
        (
            torch.randn(1, 256, 64, 64),
            torch.randint(0, 512, (1, 1, DECODER_MAX_POINTS, 2)).float(),
            torch.randint(0, 2, (1, 1, DECODER_MAX_POINTS)).float(),
            torch.tensor([384, 512], dtype=torch.long),
        ),
        str(decoder_path),
        export_params=True,
        opset_version=OPSET_VERSION,
        do_constant_folding=True,
        dynamo=False,
        input_names=[
            "image_embeddings",
            "batched_point_coords",
            "batched_point_labels",
            "orig_im_size",
        ],
        output_names=["output_masks", "iou_predictions"],
        dynamic_axes={"image_embeddings": {0: "batch"}},
    )
    decoder_seconds = time.time() - start

    return {"encoder_export_seconds": encoder_seconds, "decoder_export_seconds": decoder_seconds}


def _sha256_and_size(path: Path) -> tuple[str, int]:
    data = path.read_bytes()
    return hashlib.sha256(data).hexdigest(), len(data)


def _git_head(repo_root: Path) -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo_root, check=True, capture_output=True, text=True
        ).stdout.strip()
    except (subprocess.CalledProcessError, OSError):
        return "unknown"


def _serialize_spec(spec: TensorSpec) -> dict[str, Any]:
    dtype_name = {1: "float32", 7: "int64"}.get(spec.dtype, str(spec.dtype))
    return {"name": spec.name, "dtype": dtype_name, "dims": list(spec.dims)}


def write_provenance(output_dir: Path) -> None:
    exporter_commit = _git_head(REPO_ROOT)
    provenance = f"""# Provenance

- Repository: {UPSTREAM_REPOSITORY}
- Revision: {UPSTREAM_REVISION} ({UPSTREAM_REVISION_DATE})
- Checkpoint: {CHECKPOINT_RELATIVE_PATH}
- Checkpoint SHA-256: {CHECKPOINT_SHA256}
- Checkpoint size: {CHECKPOINT_SIZE_BYTES} bytes
- Code license: {CODE_LICENSE_EVIDENCE}
- Weights license: {WEIGHTS_LICENSE_EVIDENCE}

Exported by scripts/browser_models/efficientsam/export.py at VisionSet commit {exporter_commit}.
"""
    (output_dir / "PROVENANCE.md").write_text(provenance)


def write_build_report(
    output_dir: Path,
    timings: dict[str, float],
    versions: dict[str, str],
    contracts: dict[str, list[TensorSpec]],
) -> None:
    encoder_sha256, encoder_size = _sha256_and_size(output_dir / "encoder.onnx")
    decoder_sha256, decoder_size = _sha256_and_size(output_dir / "decoder.onnx")

    report = {
        "model_id": MODEL_ID,
        "generated_at": datetime.now(UTC).isoformat(),
        "upstream": {
            "repository": UPSTREAM_REPOSITORY,
            "revision": UPSTREAM_REVISION,
            "revision_date": UPSTREAM_REVISION_DATE,
        },
        "checkpoint": {
            "path": CHECKPOINT_RELATIVE_PATH,
            "sha256": CHECKPOINT_SHA256,
            "size_bytes": CHECKPOINT_SIZE_BYTES,
        },
        "license": {
            "code": CODE_LICENSE_EVIDENCE,
            "weights": WEIGHTS_LICENSE_EVIDENCE,
        },
        "exporter": {
            "visionset_commit": _git_head(REPO_ROOT),
            "opset": OPSET_VERSION,
        },
        "environment": versions,
        "artifacts": {
            "encoder.onnx": {"size_bytes": encoder_size, "sha256": encoder_sha256},
            "decoder.onnx": {"size_bytes": decoder_size, "sha256": decoder_sha256},
        },
        "graph_contract": {
            graph_name: {
                "inputs": [_serialize_spec(spec) for spec in specs[0]],
                "outputs": [_serialize_spec(spec) for spec in specs[1]],
            }
            for graph_name, specs in contracts.items()
        },
        "timing_seconds": timings,
        "parity": {
            "status": "not_run",
            "note": (
                "Parity comparisons (design section 11) run in a separate task; this build "
                "only exports the graphs and asserts their contract and concrete shapes."
            ),
        },
    }
    (output_dir / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")


# --- entry point -------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--artifacts-dir",
        type=Path,
        default=DEFAULT_ARTIFACTS_DIR,
        help="Directory to write model-artifacts into (default: frontend/browser-inference/"
        "model-artifacts)",
    )
    args = parser.parse_args()

    artifacts_dir: Path = args.artifacts_dir
    cache_dir = artifacts_dir / ".cache"
    output_dir = artifacts_dir / MODEL_ID

    wall_clock_start = time.time()

    print("Checking out pinned upstream source...")
    upstream_dir = ensure_upstream_checkout(cache_dir)

    print("Fetching and verifying checkpoint...")
    checkpoint_path = ensure_checkpoint(cache_dir)

    import onnx
    import onnxruntime
    import torch

    wrapper_module = load_wrapper_module(upstream_dir)
    # Importable only now that load_wrapper_module has put the upstream checkout on sys.path.
    from efficient_sam.efficient_sam import build_efficient_sam

    print("Building EfficientSAM-Ti...")
    model = build_efficient_sam(
        encoder_patch_embed_dim=192, encoder_num_heads=3, checkpoint=str(checkpoint_path)
    ).eval()
    if model.decoder_max_num_input_points != DECODER_MAX_POINTS:
        raise AssertionError(
            f"decoder_max_num_input_points: got {model.decoder_max_num_input_points}, "
            f"expected {DECODER_MAX_POINTS} -- this checkpoint is not the Ti variant"
        )

    print("Exporting encoder.onnx and decoder.onnx...")
    timings = export_graphs(model, wrapper_module, output_dir)
    print(
        f"  encoder: {timings['encoder_export_seconds']:.1f}s"
        f"  decoder: {timings['decoder_export_seconds']:.1f}s"
    )

    print("Asserting the graph contract...")
    encoder_inputs, encoder_outputs, decoder_inputs, decoder_outputs = _contract(onnx)
    assert_graph_contract(
        onnx, output_dir / "encoder.onnx", "encoder", encoder_inputs, encoder_outputs
    )
    assert_graph_contract(
        onnx, output_dir / "decoder.onnx", "decoder", decoder_inputs, decoder_outputs
    )
    assert_runtime_shapes(onnxruntime, output_dir / "encoder.onnx", output_dir / "decoder.onnx")

    print("Writing LICENSE, PROVENANCE.md and build-report.json...")
    (output_dir / "LICENSE").write_bytes((upstream_dir / "LICENSE").read_bytes())
    write_provenance(output_dir)
    versions = {
        "python": platform.python_version(),
        "torch": torch.__version__,
        "onnx": onnx.__version__,
        "onnxruntime": onnxruntime.__version__,
    }
    write_build_report(
        output_dir,
        timings,
        versions,
        {
            "encoder": (encoder_inputs, encoder_outputs),
            "decoder": (decoder_inputs, decoder_outputs),
        },
    )

    wall_clock = time.time() - wall_clock_start
    encoder_sha256, encoder_size = _sha256_and_size(output_dir / "encoder.onnx")
    decoder_sha256, decoder_size = _sha256_and_size(output_dir / "decoder.onnx")
    print(f"Done in {wall_clock:.1f}s wall clock.")
    print(f"  encoder.onnx  {encoder_size:,} bytes  sha256={encoder_sha256}")
    print(f"  decoder.onnx  {decoder_size:,} bytes  sha256={decoder_sha256}")


if __name__ == "__main__":
    main()
