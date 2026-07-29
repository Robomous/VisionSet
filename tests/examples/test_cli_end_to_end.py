"""``examples/cli_end_to_end.sh`` still runs, and still leaves what it claims.

By **subprocess**, not by importing anything — which is the whole point, and the
one thing its two sibling smoke tests cannot do. ``CliRunner`` calls the Typer
app in-process; only running the real ``visionset`` binary proves
``[project.scripts]`` still points somewhere and that the console script works
from a shell that knows nothing about Python.

Assertions are about **outcomes**, per the sibling modules: the exit code, then
the workspace reopened through the SDK. The narration is never grepped — it is
for a person reading the run, and pinning it would make every wording change a
test failure.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from visionset.kernel.services import (
    WORKSPACE_ENV_VAR,
    ProjectService,
    ReleaseService,
    WorkspaceService,
)

SCRIPT = Path(__file__).resolve().parents[2] / "examples" / "cli_end_to_end.sh"

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the example is a bash script")


@pytest.fixture(scope="module")
def destination(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("workspace") / "cli-e2e"


@pytest.fixture(scope="module")
def run(destination: Path) -> subprocess.CompletedProcess[str]:
    """One run of the script, shared by every assertion below."""
    # An *assert*, not a skip: a silently skipped CLI test looks exactly like a
    # passing one, which is the posture ``require_ffmpeg`` already takes.
    assert shutil.which("visionset") is not None, "the console script is not on PATH"
    # ``setenv``-style rather than deleting: the script exports the variable, and
    # a developer with it already exported must get CI's result. Empty is the
    # same as unset both to ``resolve_workspace_root`` and to a shell.
    environment = {**os.environ, WORKSPACE_ENV_VAR: ""}
    return subprocess.run(
        ["bash", str(SCRIPT), str(destination)],
        capture_output=True,
        text=True,
        env=environment,
        check=False,
    )


@pytest.fixture(scope="module")
def workspace(run: subprocess.CompletedProcess[str], destination: Path) -> Path:
    assert run.returncode == 0, run.stderr
    return destination / "ws"


def test_the_script_runs_to_the_end(run: subprocess.CompletedProcess[str]) -> None:
    assert run.returncode == 0, run.stderr


def test_it_leaves_one_project_with_a_schema(workspace: Path) -> None:
    with WorkspaceService.open(workspace) as service:
        projects = ProjectService(service).list()
    assert [p.name for p in projects] == ["road-signs"]


def test_it_leaves_a_release_of_every_still(workspace: Path) -> None:
    with WorkspaceService.open(workspace) as service:
        project = ProjectService(service).get_by_name("road-signs")
        dataset = ProjectService(service).get_dataset(project.id)
        releases = ReleaseService(service).list(dataset.id)
    assert [r.tag for r in releases] == ["v1.0"]
    assert releases[0].asset_count == 6
    # The stray ``notes.txt`` is reported per file and never becomes an asset.
    assert releases[0].schema_version == 1


def test_the_release_it_published_verifies(workspace: Path) -> None:
    with WorkspaceService.open(workspace) as service:
        project = ProjectService(service).get_by_name("road-signs")
        dataset = ProjectService(service).get_dataset(project.id)
        releases = ReleaseService(service)
        report = releases.verify(releases.list(dataset.id)[0].id)
    assert report.ok
    assert report.checked == 6


def test_it_carries_no_annotations_and_says_so(workspace: Path) -> None:
    # The honest consequence of driving the lifecycle from a terminal:
    # ``job mark --progress annotated`` records that somebody labeled an asset,
    # and the CLI writes no labels.
    with WorkspaceService.open(workspace) as service:
        project = ProjectService(service).get_by_name("road-signs")
        dataset = ProjectService(service).get_dataset(project.id)
        release = ReleaseService(service).list(dataset.id)[0]
    assert release.annotation_count == 0


def test_it_leaves_the_export_directory_it_was_given(destination: Path, workspace: Path) -> None:
    # ``dummy`` writes nothing, so the directory is empty — but it exists, which
    # is what proves the export ran rather than being skipped.
    assert (destination / "export").is_dir()
    assert workspace.is_dir()
