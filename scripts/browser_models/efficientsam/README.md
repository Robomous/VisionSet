# EfficientSAM-Ti exporter

Exports `yformer/EfficientSAM`'s Ti checkpoint to the two ONNX graphs
`@visionset/browser-inference`'s worker loads: `encoder.onnx` (image -> embedding) and
`decoder.onnx` (embedding + up to 6 points -> masks). Nothing here is imported by the
Python distribution; it is a build-time tool, run by a developer or CI, whose output is a
gitignored directory.

## Usage

```bash
uv sync --locked --group browser-models
uv run python scripts/browser_models/efficientsam/export.py
```

`--artifacts-dir <path>` writes elsewhere (CI uses this to control caching layout). The
default is `frontend/browser-inference/model-artifacts/`, which is gitignored — see
`.gitignore` and `tests/architecture/test_tracked_file_sizes.py`, which refuses a tracked
file over 200 KB and would fail if the 41 MB checkpoint or either ~20 MB graph were
accidentally added to the index.

Re-running reuses the cached upstream checkout and checkpoint under
`<artifacts-dir>/.cache/`; neither is re-fetched once present, though both are still
re-verified (revision pin, file size, SHA-256) on every run.

## What it produces

`<artifacts-dir>/efficientsam-ti/`:

- `encoder.onnx`, `decoder.onnx` — the exported graphs, opset 17
- `LICENSE` — copied from the upstream checkout
- `PROVENANCE.md` — upstream repository, revision, checkpoint path and hash
- `build-report.json` — machine-readable: versions, both artifacts' sizes and hashes, the
  full graph contract, export timing, and license evidence. An engineering artifact, not a
  registry manifest.

## Why a wrapper at all

Upstream's own `onnx_models.py` declares two `output_names` for the decoder while its
`forward` returns three tensors, so the published decoder ships a third output under a
name PyTorch invented (`onnx::Shape_1830` in the copy at the pinned revision) rather than
one anybody chose. `wrapper.py` subclasses upstream's `OnnxEfficientSam` and overrides
`forward` to return exactly the two tensors this runtime looks up by name. That is the
only deviation from upstream; see `wrapper.py`'s module docstring for the complete,
verbatim statement of it.

## Facts this script asserts rather than assumes

- Upstream pin: `d525f622e6f640acf5a0fc37c7ca1f243da5bde0` (`github.com/yformer/EfficientSAM`).
- Checkpoint: `weights/efficient_sam_vitt.pt`, 40,982,470 bytes,
  SHA-256 `dff858b19600a46461cbb7de98f796b23a7a888d9f5e34c0b033f7d6eb9e4e6a`, verified
  before `torch.load` ever touches it.
- The point count is static at 6, not a dynamic axis: `batched_point_coords` is
  `[1, 1, 6, 2]` and `batched_point_labels` is `[1, 1, 6]`. The runtime always pads to six
  points, so a dynamic axis here would be a claim the caller never exercises — and torch's
  dynamo exporter refuses it outright once the padding specialises the dimension to a
  constant. `export.py` therefore calls `torch.onnx.export(..., dynamo=False)`, the
  TorchScript tracer upstream itself used.
- Every input/output name, dtype, rank and dynamic axis is asserted against `onnx.load`,
  and the concrete runtime shapes (including `image_embeddings == [1, 256, 64, 64]`) are
  asserted from one real run of each graph — see `export.py`'s contract tables.
