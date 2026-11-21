# usage: from visionset.kernel.domain import Calibration, effective_calibration
"""Camera calibration and scan frames: what a 3D label is read against.

A calibration belongs to a source, with an optional per-asset override — see
``docs/content/architecture/decisions/three-dimensional-labels-are-calibrated-image-labels.md``.

**The sensor frame is OpenCV's**: x to the right, y down, z forward along the
optical axis, in metres. A pixel ``(u, v)`` of a point ``(x, y, z)`` is
``u = fx * x / z + skew * y / z + cx`` and ``v = fy * y / z + cy`` before
distortion.

**Intrinsics carry the resolution they were measured at.** Without it, a frame
stored at a smaller size silently inherits full-resolution focal lengths; with
it, a calibration that does not match the asset it would apply to is refused.

**Extrinsics are required**, and map the sensor frame into the rig frame:
``p_rig = rotation @ p_sensor + translation``. The rotation is a row-major 3x3
matrix and must be a proper rotation (orthonormal, determinant +1).

**A point cloud is read against a declared frame instead.** A scan has no
intrinsics; its source declares which axis convention its coordinates use
(:class:`ScanFrame`), and nothing is re-expressed on ingest.
"""

from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING, Final, Literal, assert_never
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from visionset.kernel.domain.geometry import (
    BboxGeometry,
    ClassificationGeometry,
    Cuboid3DGeometry,
    Geometry,
    PolygonGeometry,
    Polyline3DGeometry,
    PolylineGeometry,
)
from visionset.kernel.errors import (
    CalibrationMissing,
    CalibrationNotApplicable,
    CalibrationResolutionMismatch,
)

if TYPE_CHECKING:
    from visionset.kernel.domain.asset import Asset
    from visionset.kernel.domain.source import Source

ROTATION_TOLERANCE: Final = 1e-4
"""How far ``R @ R.T`` may stray from identity, and ``det(R)`` from 1, per entry.

Loose enough for a matrix printed to six decimals, which is how most published
calibrations ship, and tight enough to refuse a scaled or reflected one.
"""

Vector3 = tuple[float, float, float]
Matrix3 = tuple[Vector3, Vector3, Vector3]

_FROZEN = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)


class CameraIntrinsics(BaseModel):
    """A pinhole camera's projection, and the image size it was measured at."""

    model_config = _FROZEN

    fx: float = Field(gt=0)
    fy: float = Field(gt=0)
    cx: float
    cy: float
    skew: float = 0.0
    width: int = Field(ge=1)
    height: int = Field(ge=1)


class SensorExtrinsics(BaseModel):
    """Where the sensor sits on the rig: rotation and translation, in metres."""

    model_config = _FROZEN

    rotation: Matrix3
    translation: Vector3

    @model_validator(mode="after")
    def _rotation_is_proper(self) -> SensorExtrinsics:
        r = self.rotation
        for i in range(3):
            for j in range(3):
                dot = sum(r[i][k] * r[j][k] for k in range(3))
                if abs(dot - (1.0 if i == j else 0.0)) > ROTATION_TOLERANCE:
                    raise ValueError("rotation must be orthonormal")
        det = (
            r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
            - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
            + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0])
        )
        if abs(det - 1.0) > ROTATION_TOLERANCE:
            raise ValueError("rotation must have determinant +1, not be a reflection")
        return self


class PlumbBobDistortion(BaseModel):
    """OpenCV's radial-tangential lens distortion: k1, k2, p1, p2, k3."""

    model_config = _FROZEN

    model: Literal["plumb_bob"] = "plumb_bob"
    k1: float
    k2: float
    p1: float
    p2: float
    k3: float = 0.0


class Calibration(BaseModel):
    """One camera's intrinsics, its extrinsics, and an optional distortion."""

    model_config = _FROZEN

    intrinsics: CameraIntrinsics
    extrinsics: SensorExtrinsics
    distortion: PlumbBobDistortion | None = None

    def fits(self, width: int | None, height: int | None) -> bool:
        """Whether an image of that size is the one these intrinsics describe.

        An unknown size fits: there is nothing to disagree with.
        """
        if width is None or height is None:
            return True
        return (self.intrinsics.width, self.intrinsics.height) == (width, height)


class AssetCalibration(BaseModel):
    """An asset's own override, and the calibration that applies to it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    asset_id: UUID
    override: Calibration | None
    effective: Calibration | None


def effective_calibration(asset: Asset, source: Source | None) -> Calibration | None:
    """The asset's override when it has one, else its source's, else none."""
    if asset.calibration is not None:
        return asset.calibration
    return None if source is None else source.calibration


def require_calibration(asset: Asset, source: Source | None) -> Calibration:
    """The calibration a 3D label on ``asset`` is read against, or a refusal.

    The size check is repeated here, not only where a calibration is set,
    because an asset can join a calibrated source later at another size.

    Raises:
        CalibrationMissing: neither the asset nor its source has one.
        CalibrationResolutionMismatch: the one that applies was measured at a
            size other than the asset's.
    """
    calibration = effective_calibration(asset, source)
    if calibration is None:
        raise CalibrationMissing(
            f"asset {asset.id} has no calibration of its own and "
            + ("no source" if source is None else f"its source {source.id} has none")
            + "; a 3D label is read against one, so set it on the asset or its source first"
        )
    if not calibration.fits(asset.width, asset.height):
        intrinsics = calibration.intrinsics
        raise CalibrationResolutionMismatch(
            f"asset {asset.id} is {asset.width}x{asset.height} and the calibration that "
            f"applies to it was measured at {intrinsics.width}x{intrinsics.height}"
        )
    return calibration


Modality = Literal["image", "point_cloud"]
"""What an asset holds: a still image, or a single point-cloud scan."""

GeometryReference = Literal["calibration", "scan_frame"]


class ScanFrame(StrEnum):
    """The axis convention a point-cloud source's coordinates are written in.

    Declared by the source, never inferred, and never normalised away: a label
    on a scan is stored in exactly these axes, and a ``cuboid_3d`` yaw is a
    rotation about :attr:`up`, counter-clockwise seen from above.
    """

    #: A lidar's usual frame: x forward, y left, z up.
    LIDAR_FLU = "lidar_flu"
    #: A depth camera's optical frame: x right, y down, z forward (OpenCV's).
    CAMERA_RDF = "camera_rdf"

    @property
    def forward(self) -> tuple[int, int]:
        """The forward axis as ``(index, sign)`` over ``(x, y, z)``."""
        return _FRAME_AXES[self][0]

    @property
    def left(self) -> tuple[int, int]:
        return _FRAME_AXES[self][1]

    @property
    def up(self) -> tuple[int, int]:
        return _FRAME_AXES[self][2]


_FRAME_AXES: Final[dict[ScanFrame, tuple[tuple[int, int], tuple[int, int], tuple[int, int]]]] = {
    ScanFrame.LIDAR_FLU: ((0, 1), (1, 1), (2, 1)),
    ScanFrame.CAMERA_RDF: ((2, 1), (0, -1), (1, -1)),
}


def require_scan_frame(asset: Asset, source: Source | None) -> ScanFrame:
    """The frame a 3D label on a point-cloud ``asset`` is read against, or a refusal.

    Raises:
        CalibrationMissing: the asset has no source declaring a frame.
    """
    frame = None if source is None else source.frame
    if frame is None:
        raise CalibrationMissing(
            f"point-cloud asset {asset.id} has "
            + ("no source" if source is None else f"a source {source.id} declaring no frame")
            + "; a 3D label on a scan is read against the frame its source declares"
        )
    return frame


def require_calibratable(asset: Asset) -> None:
    """Refuse a calibration for an asset that cannot have one.

    Raises:
        CalibrationNotApplicable: the asset is a point cloud, which has no intrinsics.
    """
    if asset.modality != "image":
        raise CalibrationNotApplicable(
            f"asset {asset.id} is a {asset.modality}, which has no camera intrinsics; "
            "its 3D labels are read against the frame its source declares"
        )


def geometry_reference(geometry: Geometry, *, modality: Modality) -> GeometryReference | None:
    """What a stored label on an asset of that modality is read against, if anything.

    Every 3D label is read against something: an image's calibration, or a
    scan's declared frame. A 2D label is read against nothing but its pixels.
    """
    match geometry:
        case Polyline3DGeometry() | Cuboid3DGeometry():
            match modality:
                case "image":
                    return "calibration"
                case "point_cloud":
                    return "scan_frame"
                case _:
                    assert_never(modality)
        case BboxGeometry() | PolygonGeometry() | PolylineGeometry() | ClassificationGeometry():
            return None
        case _:
            assert_never(geometry)


def geometry_needs_calibration(geometry: Geometry, *, modality: Modality) -> bool:
    """Whether a stored label is read against its asset's camera calibration.

    Every 3D label on an image is; a 3D label on a point cloud is read against
    its source's declared frame instead (:func:`geometry_needs_scan_frame`).
    """
    return geometry_reference(geometry, modality=modality) == "calibration"


def geometry_needs_scan_frame(geometry: Geometry, *, modality: Modality) -> bool:
    """Whether a stored label is read against its point-cloud source's declared frame."""
    return geometry_reference(geometry, modality=modality) == "scan_frame"


def geometry_fits_modality(geometry: Geometry, *, modality: Modality) -> bool:
    """Whether a label of that shape means anything on an asset of that modality.

    A pixel-space shape on a scan has no pixels to be measured in; a tag and a
    3D label fit both.
    """
    match geometry:
        case BboxGeometry() | PolygonGeometry() | PolylineGeometry():
            return modality == "image"
        case Polyline3DGeometry() | Cuboid3DGeometry() | ClassificationGeometry():
            return True
        case _:
            assert_never(geometry)
