"""One scan directory registered through the CLI, REST and MCP is the same source."""

from __future__ import annotations

from pathlib import Path

import pytest
from tests.cli._flow import payload as cli_payload
from tests.cli._flow import project as cli_project
from tests.cli._flow import workspace as cli_workspace
from tests.fixtures.point_clouds import write_scans
from tests.mcp._flow import call
from tests.mcp._flow import payload as mcp_payload
from tests.mcp._flow import project as mcp_project
from tests.server._api import api_client
from tests.server._jobs import InlineDispatcher

from visionset.kernel.services import ProjectService, WorkspaceService

PROJECT = "road-signs"


def registered(root: Path) -> tuple[list[tuple[str, str | None]], list[str]]:
    """Every source of the project as ``(kind, frame)``, and every asset's modality."""
    with WorkspaceService.open(root) as service:
        project_id = ProjectService(service).get_by_name(PROJECT).id
        with service.unit_of_work() as uow:
            sources = [
                (s.kind.value, None if s.frame is None else s.frame.value)
                for s in uow.sources.list(project_id)
            ]
            modalities = sorted(asset.modality for asset in uow.assets.list(project_id))
    return sources, modalities


def through_cli(tmp_path: Path, scans: Path) -> Path:
    root = cli_workspace(tmp_path / "cli")
    cli_project(root, PROJECT)
    cli_payload(root, "ingest", str(scans), "-p", PROJECT, "--point-clouds", "camera_rdf")
    return root


def through_rest(tmp_path: Path, scans: Path) -> Path:
    root = tmp_path / "rest" / "ws"
    runner = InlineDispatcher()
    with api_client(root, dispatcher=runner) as client:
        project_id = client.post("/projects", json={"name": PROJECT}).json()["id"]
        parts = [
            ("files", (path.name, path.read_bytes(), "application/octet-stream"))
            for path in sorted(scans.iterdir())
        ]
        source = client.post(
            f"/projects/{project_id}/sources/point-clouds",
            files=parts,
            data={"frame": "camera_rdf"},
        )
        assert source.status_code == 201, source.text
        job = client.post(f"/sources/{source.json()['id']}/ingest-jobs")
        assert job.status_code == 202, job.text
        runner.wait()
    return root


def through_mcp(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, scans: Path) -> Path:
    home = tmp_path / "mcp"
    home.mkdir()
    mcp_project(monkeypatch, home, name=PROJECT)
    mcp_payload(call("ingest", project=PROJECT, path=str(scans), frame="camera_rdf"))
    return home / "ws"


def test_every_surface_registers_the_same_point_cloud_source(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    scans = write_scans(tmp_path / "scans")

    cli = registered(through_cli(tmp_path, scans))
    rest = registered(through_rest(tmp_path, scans))
    mcp = registered(through_mcp(monkeypatch, tmp_path, scans))

    assert cli == ([("point_cloud_directory", "camera_rdf")], ["point_cloud", "point_cloud"])
    assert rest == cli
    assert mcp == cli
