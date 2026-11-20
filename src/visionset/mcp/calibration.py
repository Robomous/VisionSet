# usage: from visionset.mcp import calibration
"""Calibration tools: read, state and clear the camera behind a source or an asset.

Three tools rather than six: each names its target with exactly one of
``source_id`` and ``asset_id``, which is the choice an agent already made when it
picked the id out of ``list_sources`` or ``list_project_assets``.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import Field

from visionset import wire
from visionset.kernel.domain import Calibration
from visionset.kernel.services import CalibrationService, ProjectService
from visionset.mcp._errors import Refusal, refused
from visionset.mcp._resolve import ProjectRef, identifier
from visionset.mcp._workspace import opened_workspace
from visionset.wire import shapes

SourceIdRef = Annotated[
    str | None,
    Field(description="The source whose calibration this is, by id. Give this or `asset_id`."),
]
AssetIdRef = Annotated[
    str | None,
    Field(
        description=(
            "The asset whose own calibration (its override) this is, by id. Give this or "
            "`source_id`."
        )
    ),
]
Answer = shapes.SourceCalibration | shapes.AssetCalibration | Refusal

_ONE_TARGET = "give exactly one of `source_id` and `asset_id`"


def get_calibration(
    project: ProjectRef, source_id: SourceIdRef = None, asset_id: AssetIdRef = None
) -> Answer:
    """Read the camera calibration of a source, or of one asset.

    For a source, `calibration` is null when none is stated. For an asset,
    `override` is its own calibration (null when it inherits) and `effective` is
    the one that applies: the override, else its source's, else null.
    """
    if (source_id is None) == (asset_id is None):
        return refused(_ONE_TARGET)
    with opened_workspace() as workspace:
        resolved = ProjectService(workspace).resolve(project)
        calibrations = CalibrationService(workspace)
        if source_id is not None:
            sid = identifier(source_id, what="source_id")
            found = calibrations.source_calibration(sid, project_id=resolved.id)
            return wire.source_calibration(sid, found)
        aid = identifier(str(asset_id), what="asset_id")
        return wire.asset_calibration(calibrations.asset_calibration(resolved.id, aid))


def set_calibration(
    project: ProjectRef,
    calibration: Annotated[
        Calibration,
        Field(
            description=(
                "The whole calibration, replacing any already stated. `intrinsics` is "
                "`{fx, fy, cx, cy, skew?, width, height}` in pixels, where `width` and "
                "`height` are the image size it was measured at; `extrinsics` is "
                "`{rotation, translation}`, a row-major 3x3 rotation and a translation in "
                "metres taking the sensor frame (OpenCV: x right, y down, z forward) into "
                "the rig's; `distortion` is null or `{model: 'plumb_bob', k1, k2, p1, p2, k3?}`."
            )
        ),
    ],
    source_id: SourceIdRef = None,
    asset_id: AssetIdRef = None,
) -> Answer:
    """State the camera calibration of a source, or override it for one asset.

    A source's calibration reaches every asset of it that has none of its own;
    an imported asset has no source, so its override is the only way one reaches
    it. Registering the same directory again keeps the source and its
    calibration as they are.

    Refuses a calibration measured at a size other than the asset it would apply
    to, and a rotation that is not a proper rotation.
    """
    if (source_id is None) == (asset_id is None):
        return refused(_ONE_TARGET)
    with opened_workspace() as workspace:
        resolved = ProjectService(workspace).resolve(project)
        calibrations = CalibrationService(workspace)
        if source_id is not None:
            sid = identifier(source_id, what="source_id")
            stored = calibrations.set_source_calibration(sid, calibration, project_id=resolved.id)
            return wire.source_calibration(stored.id, stored.calibration)
        aid = identifier(str(asset_id), what="asset_id")
        return wire.asset_calibration(
            calibrations.set_asset_calibration(resolved.id, aid, calibration)
        )


def clear_calibration(
    project: ProjectRef, source_id: SourceIdRef = None, asset_id: AssetIdRef = None
) -> Answer:
    """Remove the calibration of a source, or one asset's override. None is not an error.

    Clearing an asset's override makes it inherit its source's again, and is
    refused when that calibration was measured at a size other than the
    asset's. Refused too while 3D labels would be left with no calibration to
    resolve to; replacing with `set_calibration` stays allowed.
    """
    if (source_id is None) == (asset_id is None):
        return refused(_ONE_TARGET)
    with opened_workspace() as workspace:
        resolved = ProjectService(workspace).resolve(project)
        calibrations = CalibrationService(workspace)
        if source_id is not None:
            sid = identifier(source_id, what="source_id")
            cleared = calibrations.clear_source_calibration(sid, project_id=resolved.id)
            return wire.source_calibration(cleared.id, cleared.calibration)
        aid = identifier(str(asset_id), what="asset_id")
        return wire.asset_calibration(calibrations.clear_asset_calibration(resolved.id, aid))
