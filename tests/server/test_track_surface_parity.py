"""REST, ``visionset --json`` and MCP answer the same document for the same track."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.cli._flow import payload as cli_payload
from tests.fixtures.tracks import repeat_clip, track_world
from tests.mcp._flow import call
from tests.mcp._flow import payload as mcp_payload
from tests.server._api import api_workspace, served_app


def test_every_surface_publishes_the_same_tracks_and_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "ws"
    secret = api_workspace(root)
    world = track_world(root, tmp_path)
    repeat_clip(root, [1, 0])
    with TestClient(served_app(root), headers={"Authorization": f"Bearer {secret}"}) as client:
        rest_tracks = client.get(f"/sources/{world.source}/tracks").json()
        rest_track = client.get(f"/tracks/{world.track}").json()
        rest_status = client.get(
            f"/tracks/{world.track}/status", params={"batch_id": world.batch}
        ).json()
        rest_occurrences = client.get(f"/sources/{world.source}/occurrences").json()
        rest_asset_occurrences = client.get(
            f"/projects/{world.project_id}/assets/{world.assets[1]}/occurrences"
        ).json()

    monkeypatch.setenv("VISIONSET_WORKSPACE", str(root))
    assert rest_track["observations"]
    assert rest_tracks == {"items": [rest_track], "total": 1}

    assert cli_payload(root, "track", "list", "--source", world.source) == rest_tracks
    assert cli_payload(root, "track", "show", world.track) == rest_track
    assert cli_payload(root, "track", "status", world.track, "--batch", world.batch) == rest_status
    assert cli_payload(root, "track", "occurrences", "--source", world.source) == rest_occurrences
    assert rest_asset_occurrences["total"] == 2
    assert (
        cli_payload(root, "track", "occurrences", "--asset", world.assets[1])
        == rest_asset_occurrences
    )

    assert mcp_payload(call("list_tracks", source_id=world.source)) == rest_tracks
    assert (
        mcp_payload(call("get_track_status", track_id=world.track, batch_id=world.batch))
        == rest_status
    )
    assert mcp_payload(call("list_frame_occurrences", source_id=world.source)) == rest_occurrences
    assert (
        mcp_payload(call("list_asset_occurrences", asset_id=world.assets[1]))
        == rest_asset_occurrences
    )
