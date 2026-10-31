"""Where ``visionset export`` may write, and what it refuses before writing."""

from __future__ import annotations

from pathlib import Path

import pytest
from click.testing import Result
from tests.cli._flow import published_release, run, workspace

from visionset.kernel.services import (
    WORKSPACE_ENV_VAR,
    ProjectService,
    ReleaseService,
    WorkspaceService,
)


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


def _export(root: Path, name: str, out: Path | str, *extra: str) -> Result:
    return run(
        root,
        "export",
        "--project",
        name,
        "--release",
        "v1.0",
        "--format",
        "coco",
        "--allow-lossy",
        "--out",
        str(out),
        *extra,
    )


def _refused(result: Result, needle: str) -> None:
    assert result.exit_code == 1, result.output
    assert needle in result.stderr
    assert "Traceback" not in result.output


def test_a_relative_out_is_resolved_against_the_working_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = workspace(tmp_path)
    name = published_release(root, tmp_path)
    monkeypatch.chdir(tmp_path)

    result = _export(root, name, "relative-out")

    assert result.exit_code == 0, result.output
    assert any((tmp_path / "relative-out").iterdir())


def test_a_non_empty_out_is_refused_until_the_flag_is_given(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = published_release(root, tmp_path)
    out = tmp_path / "out"
    assert _export(root, name, out).exit_code == 0

    second = _export(root, name, out)
    _refused(second, "is not empty")
    assert "--allow-non-empty" in second.stderr

    assert _export(root, name, out, "--allow-non-empty").exit_code == 0


def test_an_out_inside_the_workspace_is_refused(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = published_release(root, tmp_path)

    _refused(_export(root, name, root / "out"), "inside the workspace")
    assert not (root / "out").exists()


def test_an_uncreatable_out_is_a_sentence_not_a_traceback(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = published_release(root, tmp_path)
    in_the_way = tmp_path / "a-file"
    in_the_way.write_text("x")

    _refused(_export(root, name, in_the_way / "below"), "cannot create")


def test_a_corrupted_blob_refuses_the_export_before_anything_is_written(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = published_release(root, tmp_path)
    with WorkspaceService.open(root) as service:
        project = ProjectService(service).get_by_name(name)
        dataset = ProjectService(service).get_dataset(project.id)
        release = ReleaseService(service).get_by_tag(dataset.id, "v1.0")
        digest = ReleaseService(service).manifest(release.id).assets[0].content_hash
    with (root / "blobs" / digest[:2] / digest[2:4] / digest).open("ab") as blob:
        blob.write(b"\0")
    out = tmp_path / "out"

    _refused(_export(root, name, out), "no longer matches its content hash")
    assert not out.exists()
