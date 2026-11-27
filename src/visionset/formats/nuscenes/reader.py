"""nuScenes in: LIDAR_TOP keyframes with their boxes, moved into the sensor frame.

The source is a nuScenes data root: one or more version folders (``v1.0-mini``,
``v1.0-trainval``, ...) of JSON tables beside ``samples/``, which holds each
keyframe's ``LIDAR_TOP/*.pcd.bin`` (headerless float32 ``x, y, z, intensity,
ring``). Tables from several version folders are merged by token. Nothing here
touches a workspace; it returns an ``ImportedDataset`` of scans in the
``lidar_rfu`` frame, LIDAR_TOP's own axes.

A ``sample_annotation`` is in the global frame, so each box is moved into the
scan's frame through that keyframe's ego pose and calibrated sensor (see
:mod:`.poses`), an explicit conversion the loss report names. What the domain
cannot hold is counted into ``losses``: attributes and visibility, the instance
token that tracks an object across samples, the lidar and radar point counts,
the poses themselves, a box leaning too far for a cuboid, the sweeps between
keyframes and every other sensor's data. A keyframe with no annotations is
imported unlabelled.

Each keyframe carries its scene's name as its ``group_label``, read through
``sample.scene_token``, so a release split can keep a scene in one fold. The
scene's other fields are counted as lost.
"""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Final

from pydantic import ValidationError

from visionset.formats._reading import contained, inside, relative
from visionset.formats._tilt import TILT_TOLERANCE
from visionset.formats.nuscenes.poses import (
    GlobalToSensor,
    Pose,
    Quaternion,
    TiltedBox,
    Vector,
    global_box_to_sensor,
)
from visionset.kernel.domain import (
    Cuboid3DGeometry,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedLabel,
    ImportedScan,
    ImportLoss,
    ImportLossKind,
    ScanFrame,
    ScanLayout,
)
from visionset.kernel.errors import ImportSourceUnreadable

CHANNEL: Final = "LIDAR_TOP"

LAYOUT: Final = ScanLayout(fields=("x", "y", "z", "intensity", "_"))

TABLES: Final = (
    "scene",
    "sample",
    "category",
    "instance",
    "sensor",
    "calibrated_sensor",
    "ego_pose",
    "sample_data",
    "sample_annotation",
)

_Losses = Counter[tuple[ImportLossKind, str, str]]
_Table = dict[str, Mapping[str, Any]]


class NuScenesImporter:
    """Reads a nuScenes data root's LIDAR_TOP keyframes into an ``ImportedDataset`` of scans."""

    format_name = "nuscenes"

    def read(self, src: Path) -> ImportedDataset:
        tables = _tables(src)
        losses: _Losses = Counter()
        lidar = _lidar_calibrations(tables, losses)
        keyframes = _keyframes(tables, lidar, losses)
        if not keyframes:
            raise ImportSourceUnreadable(
                f"the nuScenes tables name no {CHANNEL} keyframe; a nuScenes import reads "
                f"samples/{CHANNEL}/*.pcd.bin keyframes and their annotations"
            )
        by_sample: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
        for row in tables["sample_annotation"].values():
            by_sample[_text(row, "sample_token", "sample_annotation")].append(row)

        root = src.resolve()
        used: set[str] = set()
        scans: list[ImportedScan] = []
        sampled: set[str] = set()
        scenes: set[str] = set()
        for row in sorted(keyframes, key=lambda row: str(row["filename"])):
            sample = _text(row, "sample_token", "sample_data")
            sampled.add(sample)
            scene = _scene_of(tables, row, sample)
            scenes.add(scene)
            path = inside(_text(row, "filename", "sample_data"), "sample_data.json")
            file = src / path
            if file.is_file():
                _require_whole_points(src, contained(src, root, file))
            transform = _transform(tables, lidar, row)
            losses[
                (
                    ImportLossKind.ATTRIBUTE,
                    "ego_pose",
                    f"the ego pose and the {CHANNEL} calibration are not stored; each box is "
                    "moved from the global frame into the sensor frame with them",
                )
            ] += 1
            labels: list[ImportedLabel] = []
            for annotation in sorted(by_sample.get(sample, ()), key=_token):
                label = _label(tables, annotation, transform, losses)
                if label is not None:
                    labels.append(label)
                    used.add(label.class_name)
            scans.append(
                ImportedScan(path=path, layout=LAYOUT, labels=tuple(labels), group_label=scene)
            )
        losses[
            (
                ImportLossKind.ATTRIBUTE,
                "scene",
                "a scene's name is carried as the group label of each of its keyframes; its "
                "description, log and map are not",
            )
        ] += len(scenes)
        for sample, rows in by_sample.items():
            if sample in sampled:
                continue
            for annotation in rows:
                losses[
                    (
                        ImportLossKind.LABEL,
                        _class_of(tables, annotation),
                        f"its sample has no {CHANNEL} keyframe",
                    )
                ] += 1

        classes = tuple(
            ImportedClass(name=name, geometries=(GeometryType.CUBOID_3D,)) for name in sorted(used)
        )
        try:
            return ImportedDataset(
                classes=classes,
                scans=tuple(scans),
                frame=ScanFrame.LIDAR_RFU,
                losses=tuple(
                    ImportLoss(kind=kind, subject=subject, count=count, reason=reason)
                    for (kind, subject, reason), count in losses.items()
                ),
            )
        except ValidationError as exc:
            raise ImportSourceUnreadable(f"the nuScenes dataset is inconsistent: {exc}") from None


def _versions(src: Path) -> list[Path]:
    if not src.is_dir():
        raise ImportSourceUnreadable(f"the nuScenes source {src.name!r} is not a directory")
    if (src / "sample_data.json").is_file():
        raise ImportSourceUnreadable(
            f"{src.name!r} is a nuScenes version folder; import its parent, the data root "
            "that holds it beside samples/, since the tables name files relative to that root"
        )
    found = sorted(
        child
        for child in src.iterdir()
        if child.is_dir() and not child.is_symlink() and (child / "sample_data.json").is_file()
    )
    if not found:
        raise ImportSourceUnreadable(
            "no nuScenes version folder (such as v1.0-mini/) holding sample_data.json at the "
            "top of the source; a nuScenes data root holds one beside samples/"
        )
    return found


def _tables(src: Path) -> dict[str, _Table]:
    merged: dict[str, _Table] = {name: {} for name in TABLES}
    for version in _versions(src):
        for name in TABLES:
            path = version / f"{name}.json"
            where = relative(src, path)
            if not path.is_file():
                raise ImportSourceUnreadable(
                    f"{where} is missing; a nuScenes import reads {', '.join(TABLES)}"
                )
            for row in _rows(path, where):
                merged[name][_text(row, "token", where)] = row
    return merged


def _refuse_constant(name: str) -> float:
    raise ImportSourceUnreadable(f"a nuScenes table holds the non-finite number {name}")


def _rows(path: Path, where: str) -> list[Mapping[str, Any]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"), parse_constant=_refuse_constant)
    except ImportSourceUnreadable:
        raise
    except (OSError, ValueError, RecursionError) as exc:
        raise ImportSourceUnreadable(f"{where} is not readable JSON: {exc}") from None
    if not isinstance(document, list) or not all(isinstance(row, dict) for row in document):
        raise ImportSourceUnreadable(f"{where} is not a nuScenes table: a JSON list of objects")
    return document


def _text(row: Mapping[str, Any], key: str, where: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value:
        raise ImportSourceUnreadable(f"{where}: a row has no {key}")
    return value


def _token(row: Mapping[str, Any]) -> str:
    return str(row.get("token", ""))


def _numbers(value: object, count: int) -> tuple[float, ...] | None:
    if not isinstance(value, list) or len(value) != count:
        return None
    if not all(isinstance(item, int | float) and not isinstance(item, bool) for item in value):
        return None
    numbers = tuple(float(item) for item in value)
    return numbers if all(math.isfinite(item) for item in numbers) else None


def _lidar_calibrations(tables: Mapping[str, _Table], losses: _Losses) -> dict[str, Pose]:
    """Every ``calibrated_sensor`` of a LIDAR_TOP sensor, as a pose in the ego frame."""
    channels = {token: row.get("channel") for token, row in tables["sensor"].items()}
    modalities = {token: row.get("modality") for token, row in tables["sensor"].items()}
    other: Counter[tuple[str, str]] = Counter()
    lidar: dict[str, Pose] = {}
    sensor_of: dict[str, str] = {}
    for token, row in tables["calibrated_sensor"].items():
        sensor = _text(row, "sensor_token", "calibrated_sensor")
        if sensor not in channels:
            raise ImportSourceUnreadable(
                f"calibrated_sensor {token} names sensor {sensor}, which sensor.json does not hold"
            )
        sensor_of[token] = sensor
        if channels[sensor] == CHANNEL:
            lidar[token] = _pose(row, f"calibrated_sensor {token}")
    for row in tables["sample_data"].values():
        calibrated = _text(row, "calibrated_sensor_token", "sample_data")
        owner = sensor_of.get(calibrated)
        if owner is None:
            raise ImportSourceUnreadable(
                f"sample_data {_token(row)} names calibrated_sensor {calibrated}, which "
                "calibrated_sensor.json does not hold"
            )
        if channels[owner] != CHANNEL:
            other[(str(channels[owner]), str(modalities[owner]))] += 1
    for (channel, modality), count in other.items():
        kind = ImportLossKind.IMAGE if modality == "camera" else ImportLossKind.SCAN
        losses[
            (kind, channel, f"{modality} data is not imported; only {CHANNEL} keyframes are")
        ] += count
    return lidar


def _scene_of(tables: Mapping[str, _Table], row: Mapping[str, Any], sample: str) -> str:
    """The name of the scene a keyframe's sample belongs to."""
    owner = tables["sample"].get(sample)
    if owner is None:
        raise ImportSourceUnreadable(
            f"sample_data {_token(row)} names sample {sample}, which sample.json does not hold"
        )
    token = _text(owner, "scene_token", "sample")
    scene = tables["scene"].get(token)
    if scene is None:
        raise ImportSourceUnreadable(
            f"sample {sample} names scene {token}, which scene.json does not hold"
        )
    name = _text(scene, "name", "scene").strip()
    if not name:
        raise ImportSourceUnreadable(f"scene {token} has a blank name")
    return name


def _keyframes(
    tables: Mapping[str, _Table], lidar: Mapping[str, Pose], losses: _Losses
) -> list[Mapping[str, Any]]:
    keyframes: list[Mapping[str, Any]] = []
    for row in tables["sample_data"].values():
        if row.get("calibrated_sensor_token") not in lidar:
            continue
        if row.get("is_key_frame") is True:
            keyframes.append(row)
        else:
            losses[
                (
                    ImportLossKind.SCAN,
                    CHANNEL,
                    "a sweep between keyframes has no annotations and is not imported",
                )
            ] += 1
    return keyframes


def _pose(row: Mapping[str, Any], where: str) -> Pose:
    rotation = _numbers(row.get("rotation"), 4)
    translation = _numbers(row.get("translation"), 3)
    if rotation is None or translation is None:
        raise ImportSourceUnreadable(
            f"{where} has no rotation of four numbers and translation of three"
        )
    try:
        return Pose.of(_quaternion(rotation), _vector(translation))
    except ValueError:
        raise ImportSourceUnreadable(
            f"{where} has a rotation that is not a unit quaternion"
        ) from None


def _transform(
    tables: Mapping[str, _Table], lidar: Mapping[str, Pose], row: Mapping[str, Any]
) -> GlobalToSensor:
    token = _text(row, "ego_pose_token", "sample_data")
    ego = tables["ego_pose"].get(token)
    if ego is None:
        raise ImportSourceUnreadable(
            f"sample_data {_token(row)} names ego_pose {token}, which ego_pose.json does not hold"
        )
    return GlobalToSensor(
        ego=_pose(ego, f"ego_pose {token}"),
        sensor=lidar[str(row["calibrated_sensor_token"])],
    )


def _class_of(tables: Mapping[str, _Table], annotation: Mapping[str, Any]) -> str:
    instance = tables["instance"].get(str(annotation.get("instance_token")))
    category = (
        None if instance is None else tables["category"].get(str(instance.get("category_token")))
    )
    name = None if category is None else category.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ImportSourceUnreadable(
            f"sample_annotation {_token(annotation)} has no instance whose category is named"
        )
    return name


def _label(
    tables: Mapping[str, _Table],
    annotation: Mapping[str, Any],
    transform: GlobalToSensor,
    losses: _Losses,
) -> ImportedLabel | None:
    name = _class_of(tables, annotation)
    translation = _numbers(annotation.get("translation"), 3)
    size = _numbers(annotation.get("size"), 3)
    rotation = _numbers(annotation.get("rotation"), 4)
    if translation is None or size is None or rotation is None:
        losses[(ImportLossKind.LABEL, name, "a malformed box")] += 1
        return None
    if min(size) <= 0:
        losses[(ImportLossKind.LABEL, name, "a box dimension that is not positive")] += 1
        return None
    try:
        box = global_box_to_sensor(
            _vector(translation), _vector(size), _quaternion(rotation), transform
        )
    except TiltedBox:
        losses[
            (
                ImportLossKind.LABEL,
                name,
                f"a box leaning more than {math.degrees(TILT_TOLERANCE):g} degrees from the "
                "sensor's up axis; a cuboid has no pitch or roll, so it is not flattened",
            )
        ] += 1
        return None
    except ValueError:
        losses[
            (
                ImportLossKind.LABEL,
                name,
                "a rotation that is not a unit quaternion, so the box cannot be placed",
            )
        ] += 1
        return None
    if min(box.size) <= 0:
        losses[(ImportLossKind.LABEL, name, "a box under a micrometre across")] += 1
        return None
    if annotation.get("attribute_tokens") or annotation.get("visibility_token"):
        losses[
            (ImportLossKind.ATTRIBUTE, name, "nuScenes attributes and visibility are not carried")
        ] += 1
    if annotation.get("instance_token"):
        losses[
            (
                ImportLossKind.ATTRIBUTE,
                name,
                (
                    "the instance token that tracks an object across samples is not carried; "
                    "a track follows 2D labels only, and these are 3D boxes in lidar scans"
                ),
            )
        ] += 1
    if "num_lidar_pts" in annotation or "num_radar_pts" in annotation:
        losses[
            (ImportLossKind.ATTRIBUTE, name, "num_lidar_pts and num_radar_pts are not carried")
        ] += 1
    return ImportedLabel(
        class_name=name,
        geometry=Cuboid3DGeometry(center=box.center, size=box.size, yaw=box.yaw),
    )


def _require_whole_points(src: Path, path: Path) -> None:
    size = path.stat().st_size
    if size == 0 or size % LAYOUT.record_size:
        raise ImportSourceUnreadable(
            f"{relative(src, path)} is {size} bytes, which is not a whole number of "
            f"{LAYOUT.record_size}-byte points"
        )


def _quaternion(values: tuple[float, ...]) -> Quaternion:
    return (values[0], values[1], values[2], values[3])


def _vector(values: tuple[float, ...]) -> Vector:
    return (values[0], values[1], values[2])
