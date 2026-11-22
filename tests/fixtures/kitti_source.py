"""A tiny KITTI 3D object detection split, written by the test that needs it."""

from __future__ import annotations

import struct
from collections.abc import Sequence
from pathlib import Path

Point = tuple[float, float, float, float]

#: A car-sized cluster ten metres ahead, and a little ground.
SCAN: tuple[Point, ...] = (
    (10.0, 0.0, -0.8, 0.3),
    (10.5, 0.4, -0.2, 0.5),
    (9.6, -0.5, 0.1, 0.2),
    (4.0, 3.0, -1.7, 0.1),
)

#: A car in front of the camera: location (x, y, z) = (0, 1.5, 10), h w l = 1.5 1.6 4.0.
CAR = "Car 0.00 0 -1.57 600.0 170.0 650.0 210.0 1.50 1.60 4.00 0.00 1.50 10.00 0.00"
DONT_CARE = "DontCare -1 -1 -10 503.89 169.71 590.61 190.13 -1 -1 -1 -1000 -1000 -1000 -10"

#: Nominal axes (x_velo = z_cam, y_velo = -x_cam, z_velo = -y_cam), a small offset.
CALIB = (
    "P0: 7.07e+02 0 6.04e+02 0 0 7.07e+02 1.80e+02 0 0 0 1 0\n"
    "P1: 7.07e+02 0 6.04e+02 -3.79e+02 0 7.07e+02 1.80e+02 0 0 0 1 0\n"
    "P2: 7.07e+02 0 6.04e+02 4.57e+01 0 7.07e+02 1.80e+02 -3.45e-01 0 0 1 4.98e-03\n"
    "P3: 7.07e+02 0 6.04e+02 -3.34e+02 0 7.07e+02 1.80e+02 2.33e+00 0 0 1 3.20e-03\n"
    "R0_rect: 1 0 0 0 1 0 0 0 1\n"
    "Tr_velo_to_cam: 0 -1 0 0 0 0 -1 -0.08 1 0 0 -0.27\n"
    "Tr_imu_to_velo: 1 0 0 -0.81 0 1 0 0.32 0 0 1 -0.80\n"
)


def scan_bytes(points: Sequence[Point] = SCAN) -> bytes:
    return b"".join(struct.pack("<ffff", *point) for point in points)


def write_frame(
    split: Path,
    frame_id: str,
    *,
    points: Sequence[Point] | None = SCAN,
    labels: Sequence[str] | None = (CAR,),
    calib: str | None = CALIB,
) -> None:
    """One frame of a split; ``None`` leaves that file out."""
    for name, content in (
        ("velodyne", None if points is None else scan_bytes(points)),
        ("label_2", None if labels is None else "".join(f"{line}\n" for line in labels).encode()),
        ("calib", None if calib is None else calib.encode()),
    ):
        directory = split / name
        directory.mkdir(parents=True, exist_ok=True)
        if content is not None:
            suffix = ".bin" if name == "velodyne" else ".txt"
            (directory / f"{frame_id}{suffix}").write_bytes(content)


def write_kitti_source(root: Path) -> Path:
    """A split of two labelled frames, one with a DontCare region as well."""
    write_frame(root, "000000", labels=(CAR, DONT_CARE))
    write_frame(
        root,
        "000001",
        points=tuple((x + 1, y, z, i) for x, y, z, i in SCAN),
        labels=(CAR.replace("Car", "Pedestrian").replace("1.60 4.00", "0.60 0.80"),),
    )
    return root
