"""A calibration in the wire's own shape, for every surface's tests to send and compare."""

from __future__ import annotations

from typing import Any

from visionset.kernel.domain import Calibration


def calibration_document(
    *, width: int = 32, height: int = 24, fx: float = 30.0, distortion: bool = True
) -> dict[str, Any]:
    """A plausible camera measured at ``width`` x ``height``, as JSON."""
    return {
        "intrinsics": {
            "fx": fx,
            "fy": 29.5,
            "cx": width / 2,
            "cy": height / 2,
            "skew": 0.0,
            "width": width,
            "height": height,
        },
        "extrinsics": {
            "rotation": [[0.0, 0.0, 1.0], [-1.0, 0.0, 0.0], [0.0, -1.0, 0.0]],
            "translation": [1.5, 0.0, 1.2],
        },
        "distortion": (
            {"model": "plumb_bob", "k1": -0.1, "k2": 0.01, "p1": 0.001, "p2": -0.002, "k3": 0.0}
            if distortion
            else None
        ),
    }


def calibration(**kwargs: Any) -> Calibration:
    return Calibration.model_validate(calibration_document(**kwargs))
