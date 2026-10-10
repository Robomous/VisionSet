"""The thumbnail-backfill handler, driven directly against a workspace root."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from uuid import UUID, uuid4

from tests.fixtures.media import write_images

from visionset.jobs import REGISTRY
from visionset.jobs.thumbnails import JOB_TYPE, payload_for, run
from visionset.kernel.domain import Asset, ImageFormat, ItemFailure
from visionset.kernel.services import ProjectService, WorkspaceService


class Reporter:
    def __init__(self, *, cancelled: bool = False) -> None:
        self._cancelled = cancelled

    def report(
        self,
        *,
        processed: int,
        total: int | None = None,
        failures: Sequence[ItemFailure] = (),
    ) -> None:
        pass

    def is_cancelled(self) -> bool:
        return self._cancelled


def _project_with_unrendered_assets(
    root: Path, stills: Path, *, count: int
) -> tuple[str, list[str]]:
    paths = write_images(stills, count=count, first_seed=11)
    with WorkspaceService.init(root, name="thumbs") as workspace:
        project = ProjectService(workspace).create("thumbs")
        ids: list[str] = []
        for path in paths:
            with workspace.unit_of_work() as uow, path.open("rb") as handle:
                asset = uow.assets.add(
                    Asset(
                        project_id=project.id,
                        content_hash=workspace.blob_store.put(handle),
                        uri=str(path),
                        format=ImageFormat.PNG,
                    )
                )
            ids.append(str(asset.id))
        return str(project.id), ids


def _thumbnail_hashes(root: Path, project_id: str) -> list[str | None]:
    with WorkspaceService.open(root) as workspace, workspace.unit_of_work() as uow:
        return [asset.thumbnail_hash for asset in uow.assets.list(UUID(project_id))]


def test_the_handler_is_registered_idempotent() -> None:
    assert REGISTRY[JOB_TYPE].idempotent is True


def test_the_handler_fills_every_missing_preview_and_reports_it(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    project_id, ids = _project_with_unrendered_assets(root, tmp_path / "stills", count=2)
    assert _thumbnail_hashes(root, project_id) == [None, None]

    result = run(root, payload_for(UUID(project_id)), Reporter())

    assert result["project_id"] == project_id
    assert result["examined"] == 2
    assert sorted(result["filled"]) == sorted(ids)
    assert result["missing"] == [] and result["unreadable"] == []
    assert None not in _thumbnail_hashes(root, project_id)


def test_an_asset_whose_blob_is_gone_is_reported_as_missing(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    project_id, ids = _project_with_unrendered_assets(root, tmp_path / "stills", count=2)
    with WorkspaceService.open(root) as workspace, workspace.unit_of_work() as uow:
        gone = uow.assets.get(UUID(ids[0]))
    digest = gone.content_hash
    (root / "blobs" / digest[:2] / digest[2:4] / digest).unlink()

    result = run(root, payload_for(UUID(project_id)), Reporter())

    assert result["missing"] == [ids[0]]
    assert result["filled"] == [ids[1]]


def test_an_asset_that_will_not_render_is_reported_as_unreadable(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    project_id, ids = _project_with_unrendered_assets(root, tmp_path / "stills", count=1)
    with WorkspaceService.open(root) as workspace, workspace.unit_of_work() as uow:
        digest = uow.assets.get(UUID(ids[0])).content_hash
    (root / "blobs" / digest[:2] / digest[2:4] / digest).write_bytes(b"not an image")

    result = run(root, payload_for(UUID(project_id)), Reporter())

    assert result["filled"] == []
    assert len(result["unreadable"]) == 1
    assert result["unreadable"][0]["reason"]
    assert _thumbnail_hashes(root, project_id) == [None]


def test_a_run_already_cancelled_touches_nothing(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    project_id, _ = _project_with_unrendered_assets(root, tmp_path / "stills", count=1)

    result = run(root, payload_for(UUID(project_id)), Reporter(cancelled=True))

    assert result == {}
    assert _thumbnail_hashes(root, project_id) == [None]


def test_payload_names_the_project() -> None:
    project_id = uuid4()

    assert payload_for(project_id) == {"project_id": str(project_id)}
