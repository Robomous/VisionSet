"""A tiny nuScenes data root, written by the test that needs it.

Boxes are stated in the LIDAR_TOP frame (x right, y forward, z up) and pushed
out to the global frame here, with quaternion algebra written independently of
the importer's matrices: ``q_global = q_ego ⊗ q_sensor ⊗ q_box`` and
``p_global = q_ego · (q_sensor · p + t_sensor) + t_ego``.
"""

from __future__ import annotations

import json
import math
import struct
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

Quaternion = tuple[float, float, float, float]
Vector = tuple[float, float, float]
Point = tuple[float, float, float, float, float]

VERSION = "v1.0-mini"
LIDAR_DIR = "samples/LIDAR_TOP"


def axis_angle(axis: Vector, angle: float) -> Quaternion:
    norm = math.sqrt(sum(a * a for a in axis))
    s = math.sin(angle / 2) / norm
    return (math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s)


def multiply(a: Quaternion, b: Quaternion) -> Quaternion:
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    )


def rotate(q: Quaternion, v: Vector) -> Vector:
    _, x, y, z = multiply(multiply(q, (0.0, *v)), (q[0], -q[1], -q[2], -q[3]))
    return (x, y, z)


def add(a: Vector, b: Vector) -> Vector:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


#: LIDAR_TOP sits about -90 degrees of yaw from the ego frame, a little tilted.
LIDAR_ROTATION: Quaternion = multiply(
    axis_angle((0.0, 0.0, 1.0), -math.pi / 2 + 0.004),
    multiply(axis_angle((1.0, 0.0, 0.0), 0.009), axis_angle((0.0, 1.0, 0.0), -0.012)),
)
LIDAR_TRANSLATION: Vector = (0.943, 0.0, 1.841)

#: The car heading north-west across the map, on a slight grade.
EGO_ROTATION: Quaternion = multiply(
    axis_angle((0.0, 0.0, 1.0), 2.31), axis_angle((0.0, 1.0, 0.0), 0.02)
)
EGO_TRANSLATION: Vector = (411.3, 1180.9, 0.6)


@dataclass(frozen=True)
class SensorBox:
    """A box in the LIDAR_TOP frame: centre, ``(l, w, h)``, yaw, and any lean."""

    category: str
    center: Vector
    size_lwh: Vector
    yaw: float
    lean: Quaternion = (1.0, 0.0, 0.0, 0.0)
    attributes: tuple[str, ...] = ("attr-moving",)

    def box_rotation(self) -> Quaternion:
        # The box's own +x is its heading, cos(yaw)·(0, 1, 0) + sin(yaw)·(-1, 0, 0).
        return multiply(self.lean, axis_angle((0.0, 0.0, 1.0), self.yaw + math.pi / 2))


CAR = SensorBox("vehicle.car", (2.4, 11.5, -0.9), (4.6, 1.9, 1.7), 0.35)
PEDESTRIAN = SensorBox("human.pedestrian.adult", (-3.2, 6.0, -1.0), (0.7, 0.6, 1.8), -2.9)

SCAN: tuple[Point, ...] = (
    (2.4, 11.5, -0.9, 12.0, 3.0),
    (2.0, 10.0, -0.5, 30.0, 7.0),
    (-3.2, 6.0, -1.0, 5.0, 11.0),
    (8.0, -4.0, -1.8, 1.0, 0.0),
)


def scan_bytes(points: Sequence[Point] = SCAN) -> bytes:
    return b"".join(struct.pack("<fffff", *point) for point in points)


@dataclass
class Keyframe:
    name: str
    boxes: Sequence[SensorBox] = ()
    ego_rotation: Quaternion = EGO_ROTATION
    ego_translation: Vector = EGO_TRANSLATION
    points: Sequence[Point] | None = SCAN
    scene: str = "scene-0001"


@dataclass
class Root:
    """Every table as rows, editable by a test before :meth:`write`."""

    tables: dict[str, list[dict[str, Any]]] = field(default_factory=dict)

    def write(self, root: Path) -> Path:
        version = root / VERSION
        version.mkdir(parents=True, exist_ok=True)
        for name, rows in self.tables.items():
            (version / f"{name}.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
        return root


def to_global(box: SensorBox, keyframe: Keyframe) -> tuple[Vector, Quaternion]:
    in_ego = add(rotate(LIDAR_ROTATION, box.center), LIDAR_TRANSLATION)
    center = add(rotate(keyframe.ego_rotation, in_ego), keyframe.ego_translation)
    rotation = multiply(keyframe.ego_rotation, multiply(LIDAR_ROTATION, box.box_rotation()))
    return center, rotation


def build(root: Path, keyframes: Sequence[Keyframe], *, sweeps: int = 1) -> Root:
    """The tables of ``keyframes`` (files written now), plus a sweep and a camera frame each."""
    tables: dict[str, list[dict[str, Any]]] = {
        "category": [],
        "instance": [],
        "attribute": [{"token": "attr-moving", "name": "vehicle.moving"}],
        "visibility": [{"token": "4", "level": "v80-100"}],
        "sensor": [
            {"token": "sensor-lidar", "channel": "LIDAR_TOP", "modality": "lidar"},
            {"token": "sensor-cam", "channel": "CAM_FRONT", "modality": "camera"},
        ],
        "calibrated_sensor": [
            {
                "token": "cs-lidar",
                "sensor_token": "sensor-lidar",
                "translation": list(LIDAR_TRANSLATION),
                "rotation": list(LIDAR_ROTATION),
                "camera_intrinsic": [],
            },
            {
                "token": "cs-cam",
                "sensor_token": "sensor-cam",
                "translation": [1.7, 0.0, 1.5],
                "rotation": [0.5, -0.5, 0.5, -0.5],
                "camera_intrinsic": [[1266.4, 0, 816.3], [0, 1266.4, 491.5], [0, 0, 1]],
            },
        ],
        "ego_pose": [],
        "scene": [],
        "sample": [],
        "sample_data": [],
        "sample_annotation": [],
    }
    categories: dict[str, str] = {}
    (root / LIDAR_DIR).mkdir(parents=True, exist_ok=True)
    for index, keyframe in enumerate(keyframes):
        sample = f"sample-{keyframe.name}"
        scene = f"scene-token-{keyframe.scene}"
        if not any(row["token"] == scene for row in tables["scene"]):
            tables["scene"].append(
                {"token": scene, "name": keyframe.scene, "log_token": "log-1", "description": ""}
            )
        tables["sample"].append(
            {"token": sample, "timestamp": 1_000_000 * index, "scene_token": scene}
        )
        tables["ego_pose"].append(
            {
                "token": f"ego-{keyframe.name}",
                "translation": list(keyframe.ego_translation),
                "rotation": list(keyframe.ego_rotation),
            }
        )
        filename = f"{LIDAR_DIR}/{keyframe.name}.pcd.bin"
        if keyframe.points is not None:
            (root / filename).write_bytes(scan_bytes(keyframe.points))
        rows = [("sd", "cs-lidar", True, filename)]
        rows += [
            (f"sweep{n}", "cs-lidar", False, f"sweeps/LIDAR_TOP/{keyframe.name}-{n}.pcd.bin")
            for n in range(sweeps)
        ]
        rows.append(("cam", "cs-cam", True, f"samples/CAM_FRONT/{keyframe.name}.jpg"))
        for prefix, calibrated, key, name in rows:
            tables["sample_data"].append(
                {
                    "token": f"{prefix}-{keyframe.name}",
                    "sample_token": sample,
                    "ego_pose_token": f"ego-{keyframe.name}",
                    "calibrated_sensor_token": calibrated,
                    "filename": name,
                    "fileformat": "pcd",
                    "is_key_frame": key,
                }
            )
        for number, box in enumerate(keyframe.boxes):
            category = categories.setdefault(box.category, f"cat-{len(categories)}")
            instance = f"inst-{keyframe.name}-{number}"
            tables["instance"].append({"token": instance, "category_token": category})
            center, rotation = to_global(box, keyframe)
            length, width, height = box.size_lwh
            tables["sample_annotation"].append(
                {
                    "token": f"ann-{keyframe.name}-{number}",
                    "sample_token": sample,
                    "instance_token": instance,
                    "visibility_token": "4",
                    "attribute_tokens": list(box.attributes),
                    "translation": list(center),
                    "size": [width, length, height],
                    "rotation": list(rotation),
                    "num_lidar_pts": 12,
                    "num_radar_pts": 0,
                }
            )
    tables["category"] = [{"token": token, "name": name} for name, token in categories.items()]
    return Root(tables)


def write_nuscenes_source(root: Path) -> Path:
    """Two keyframes: one with a car and a pedestrian, one with nothing annotated."""
    return build(
        root,
        [
            Keyframe("n015-0001", (CAR, PEDESTRIAN)),
            Keyframe(
                "n015-0002",
                ego_rotation=axis_angle((0.0, 0.0, 1.0), -0.7),
                ego_translation=(420.0, 1170.0, 0.4),
                points=tuple((x + 1, y, z, i, r) for x, y, z, i, r in SCAN),
            ),
        ],
    ).write(root)
