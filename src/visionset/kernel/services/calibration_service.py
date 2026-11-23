# usage: from visionset.kernel.services import CalibrationService
"""Calibration: the one writer of a source's camera and an asset's override.

Registration never touches a calibration — ``SourceService.register_images``
takes none and carries the stored one forward — so a re-registration cannot
re-interpret labels already drawn against it. Setting replaces whole, but
replacing a calibration with a different one, like clearing it, is refused
while 3D labels resolve to it, since those labels were drawn against it.

Composition follows ``SourceService``: an open ``WorkspaceService`` and nothing
else.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import overload
from uuid import UUID

from visionset.kernel.domain import (
    Asset,
    AssetCalibration,
    Calibration,
    Source,
    SourceKind,
    effective_calibration,
    geometry_needs_calibration,
    require_calibratable,
)
from visionset.kernel.errors import (
    AssetNotFound,
    CalibrationInUse,
    CalibrationNotApplicable,
    CalibrationResolutionMismatch,
    ProjectNotFound,
    SourceNotFound,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.source_service import SourceService
from visionset.kernel.services.workspace_service import WorkspaceService


class CalibrationService:
    """Read, set and clear calibration on a source or an asset."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._sources = SourceService(workspace)

    # --- sources -----------------------------------------------------------

    def source_calibration(
        self, source_id: UUID, *, project_id: UUID | None = None
    ) -> Calibration | None:
        """The source's calibration, or ``None`` when nobody stated one.

        Raises:
            SourceNotFound: no such source in this workspace, or in ``project_id``.
        """
        with self._workspace.unit_of_work() as uow:
            return self._require_source(uow, source_id, project_id).calibration

    def set_source_calibration(
        self, source_id: UUID, calibration: Calibration, *, project_id: UUID | None = None
    ) -> Source:
        """Store the source's calibration. Storing the one already there is a no-op.

        Raises:
            SourceNotFound: no such source in this workspace, or in ``project_id``.
            CalibrationResolutionMismatch: a clip's stored frame size, or an asset
                that would inherit it, is not the size it was measured at.
            CalibrationNotApplicable: the source is a point-cloud directory.
            CalibrationInUse: it replaces a different calibration that an asset
                inheriting it holds 3D labels against.
        """
        with self._workspace.unit_of_work() as uow:
            source = self._require_source(uow, source_id, project_id)
            if source.kind is SourceKind.POINT_CLOUD_DIRECTORY:
                raise CalibrationNotApplicable(
                    f"source {source.id} is a point-cloud directory, which has no camera "
                    f"intrinsics; its scans are read against its declared {source.frame} frame"
                )
            if source.video is not None and not calibration.fits(
                source.video.stored_width, source.video.stored_height
            ):
                raise CalibrationResolutionMismatch(
                    f"source {source.id} stores frames at {source.video.stored_width}x"
                    f"{source.video.stored_height}; {_measured(calibration)}"
                )
            for asset in _inheriting(uow, source):
                if not calibration.fits(asset.width, asset.height):
                    raise CalibrationResolutionMismatch(
                        f"asset {asset.id} of source {source.id} is {asset.width}x"
                        f"{asset.height}; {_measured(calibration)}"
                    )
            if source.calibration is not None:
                source = _held(uow, source)
                if source.calibration == calibration:
                    return source
                dependent = _dependent(uow, _inheriting(uow, source))
                if source.calibration is not None and dependent:
                    raise CalibrationInUse(
                        f"{len(dependent)} asset(s) of source {source.id} hold 3D labels drawn "
                        f"against its current calibration, among them {dependent[0].id}"
                    )
            return uow.sources.update(source.model_copy(update={"calibration": calibration}))

    def clear_source_calibration(
        self, source_id: UUID, *, project_id: UUID | None = None
    ) -> Source:
        """Remove the source's calibration. Clearing none is not an error.

        Raises:
            SourceNotFound: no such source in this workspace, or in ``project_id``.
            CalibrationInUse: an asset inheriting it holds a label that needs one.
        """
        with self._workspace.unit_of_work() as uow:
            source = self._require_source(uow, source_id, project_id)
            if source.calibration is None:
                return source
            source = _held(uow, source)
            dependent = _dependent(uow, _inheriting(uow, source))
            if dependent:
                raise CalibrationInUse(
                    f"{len(dependent)} asset(s) of source {source.id} hold 3D labels that "
                    f"resolve to this calibration, among them {dependent[0].id}"
                )
            return uow.sources.update(source.model_copy(update={"calibration": None}))

    # --- assets ------------------------------------------------------------

    def asset_calibration(self, project_id: UUID, asset_id: UUID) -> AssetCalibration:
        """The asset's own override and the calibration that applies to it.

        Raises:
            ProjectNotFound: no such project in this workspace.
            AssetNotFound: no such asset in that project.
        """
        with self._workspace.unit_of_work() as uow:
            asset = self._require_asset(uow, project_id, asset_id)
            return _resolved(uow, asset)

    def set_asset_calibration(
        self, project_id: UUID, asset_id: UUID, calibration: Calibration
    ) -> AssetCalibration:
        """Store the asset's own calibration. Storing the override already there is a no-op.

        Raises:
            ProjectNotFound: no such project in this workspace.
            AssetNotFound: no such asset in that project.
            CalibrationResolutionMismatch: the asset is not the size it was measured at.
            CalibrationNotApplicable: the asset is a point cloud.
            CalibrationInUse: it replaces a different override that the asset
                holds 3D labels against.
        """
        with self._workspace.unit_of_work() as uow:
            asset = self._require_asset(uow, project_id, asset_id)
            require_calibratable(asset)
            if not calibration.fits(asset.width, asset.height):
                raise CalibrationResolutionMismatch(
                    f"asset {asset.id} is {asset.width}x{asset.height}; {_measured(calibration)}"
                )
            if asset.calibration is not None:
                asset = _held(uow, asset)
                if asset.calibration == calibration:
                    return _resolved(uow, asset)
                if asset.calibration is not None and _dependent(uow, [asset]):
                    raise CalibrationInUse(
                        f"asset {asset.id} holds 3D labels drawn against its current calibration"
                    )
            stored = uow.assets.update(asset.model_copy(update={"calibration": calibration}))
            return _resolved(uow, stored)

    def clear_asset_calibration(self, project_id: UUID, asset_id: UUID) -> AssetCalibration:
        """Remove the asset's override, falling back to its source's. None is not an error.

        Raises:
            ProjectNotFound: no such project in this workspace.
            AssetNotFound: no such asset in that project.
            CalibrationResolutionMismatch: the source's calibration it would fall
                back to was measured at a size other than the asset's.
            CalibrationInUse: the asset holds a label that needs one, and its
                source has none to fall back to.
        """
        with self._workspace.unit_of_work() as uow:
            asset = self._require_asset(uow, project_id, asset_id)
            if asset.calibration is None:
                return _resolved(uow, asset)
            asset = _held(uow, asset)
            cleared = asset.model_copy(update={"calibration": None})
            fallback = effective_calibration(cleared, _source_of(uow, asset))
            if fallback is not None and not fallback.fits(asset.width, asset.height):
                raise CalibrationResolutionMismatch(
                    f"asset {asset.id} is {asset.width}x{asset.height} and would fall back to "
                    f"its source's calibration; {_measured(fallback)}"
                )
            if fallback is None and _dependent(uow, [asset]):
                raise CalibrationInUse(
                    f"asset {asset.id} holds 3D labels and its source has no calibration "
                    f"to fall back to"
                )
            return _resolved(uow, uow.assets.update(cleared))

    # --- lookups -----------------------------------------------------------

    def _require_source(self, uow: UnitOfWork, source_id: UUID, project_id: UUID | None) -> Source:
        source = self._sources.require_source(uow, source_id)
        if project_id is not None and source.project_id != project_id:
            raise SourceNotFound(f"no source {source_id} in project {project_id}")
        return source

    def _require_asset(self, uow: UnitOfWork, project_id: UUID, asset_id: UUID) -> Asset:
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )
        asset = uow.assets.get(asset_id)
        if asset is None or asset.project_id != project.id:
            raise AssetNotFound(f"no asset {asset_id} in project {project.name!r}")
        return asset


@overload
def _held(uow: UnitOfWork, row: Source) -> Source: ...
@overload
def _held(uow: UnitOfWork, row: Asset) -> Asset: ...
def _held(uow: UnitOfWork, row: Source | Asset) -> Source | Asset:
    """The row re-read under the store's write lock.

    A read before a unit of work's first write can see a state another writer
    is about to change, so a clear or replace that checked for 3D labels and then wrote
    could interleave with a label write that checked for a calibration and then
    wrote, and both would land. Every label write already takes the lock before
    its calibration check (``hold_open_job``, ``hold_draft``); taking it here
    before the dependency check serializes the two, so the second one sees the
    first one's commit.
    """
    uow.hold_writes()
    fresh = uow.sources.get(row.id) if isinstance(row, Source) else uow.assets.get(row.id)
    assert fresh is not None
    return fresh


def _measured(calibration: Calibration) -> str:
    intrinsics = calibration.intrinsics
    return f"the calibration was measured at {intrinsics.width}x{intrinsics.height}"


def _inheriting(uow: UnitOfWork, source: Source) -> list[Asset]:
    """The assets whose effective calibration is this source's."""
    return [
        asset
        for asset in uow.assets.list(source.project_id)
        if asset.source_id == source.id and asset.calibration is None
    ]


def _dependent(uow: UnitOfWork, assets: Iterable[Asset]) -> list[Asset]:
    """The assets holding a label that is read against a calibration."""
    return [
        asset
        for asset in assets
        if any(
            geometry_needs_calibration(a.geometry, modality=asset.modality)
            for a in uow.annotations.list(asset.id)
        )
    ]


def _source_of(uow: UnitOfWork, asset: Asset) -> Source | None:
    return None if asset.source_id is None else uow.sources.get(asset.source_id)


def _resolved(uow: UnitOfWork, asset: Asset) -> AssetCalibration:
    return AssetCalibration(
        asset_id=asset.id,
        override=asset.calibration,
        effective=effective_calibration(asset, _source_of(uow, asset)),
    )
