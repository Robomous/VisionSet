"""The two ONNX-exportable wrappers around upstream's `EfficientSam`.

Two differences from yformer/EfficientSAM's own onnx_models.py at d525f622, and no others:

1. The decoder returns (output_masks, iou_predictions) rather than
   (output_masks, iou_predictions, low_res_masks). Upstream declares two
   output_names for three return values, so its third output ships under a name
   PyTorch invents — 'onnx::Shape_1830' in the copy published at this revision.
   A name a tracer chose is not a contract, and this runtime looks outputs up by
   name. low_res_masks is still computed; it is simply not an output.

2. Nothing else. The bilinear upsample, the padding sentinel, the point
   rescaling and the opset are upstream's: both classes below call straight
   through to `OnnxEfficientSam.predict_masks` / `get_image_embeddings`, which
   this module does not touch.

Importing this module requires upstream's checkout root to already be on `sys.path`,
because it subclasses `onnx_models.OnnxEfficientSam` from upstream's own (un-packaged,
top-level) `onnx_models.py`. `export.py` inserts that path before importing this module.
"""

from __future__ import annotations

import onnx_models  # upstream's module; see the sys.path note above.
import torch


class EfficientSamEncoder(onnx_models.OnnxEfficientSam):
    """Identical to upstream's `OnnxEfficientSamEncoder`: one input, one output."""

    def forward(self, batched_images: torch.Tensor) -> torch.Tensor:
        return self.get_image_embeddings(batched_images)


class EfficientSamDecoder(onnx_models.OnnxEfficientSam):
    """Upstream's decoder, with its third, tracer-named output dropped."""

    def forward(
        self,
        image_embeddings: torch.Tensor,
        batched_point_coords: torch.Tensor,
        batched_point_labels: torch.Tensor,
        orig_im_size: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        output_masks, iou_predictions, _low_res_masks = self.predict_masks(
            image_embeddings=image_embeddings,
            batched_points=batched_point_coords,
            batched_point_labels=batched_point_labels,
            multimask_output=True,
            input_h=orig_im_size[0],
            input_w=orig_im_size[1],
            output_h=orig_im_size[0],
            output_w=orig_im_size[1],
        )
        return output_masks, iou_predictions
