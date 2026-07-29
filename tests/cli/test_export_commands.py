"""``visionset export`` and ``visionset format list``.

The only installed exporter is ``dummy``, and it **writes nothing** — so
``file_count: 0`` here is the honest report of an export that ran, not evidence
of one that failed. The counts are taken by walking the destination afterwards,
which is what makes them checkable at all.

The lossy gate is exercised against an exporter registered for the test through
``importlib.metadata``, because no installed one declares itself lossy — and a
gate nothing ever trips is a gate nobody has tested.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from tests.cli._flow import payload, published_release, run, workspace
from typer.testing import CliRunner

from visionset.cli.main import app
from visionset.formats import registry
from visionset.kernel.domain import Manifest, Release
from visionset.kernel.services import WORKSPACE_ENV_VAR


class LossyExporter:
    """A format that cannot carry everything a release holds. Writes one file."""

    format_name = "lossy-sample"
    lossy = True

    def export(self, release: Release, manifest: Manifest, dest: Path) -> None:
        (dest / "labels.txt").write_text(f"{len(manifest.assets)}\n", encoding="utf-8")


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return workspace(tmp_path)


@pytest.fixture()
def lossy(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Add a lossy exporter to what the registry finds, for one test.

    The registry itself is not stubbed — ``exporters()`` still scans the entry
    point group — so what is being tested is the command's use of it.
    """
    real = registry.exporters

    def with_lossy() -> dict[str, object]:
        return {**real(), LossyExporter.format_name: LossyExporter()}

    monkeypatch.setattr(registry, "exporters", with_lossy)
    yield


# --- format list -------------------------------------------------------------


def test_format_list_names_the_installed_exporters() -> None:
    # No ``--workspace``: this command opens nothing, so ``_flow.ok`` (which
    # always appends the flag) cannot be used and the runner is called directly.
    result = CliRunner().invoke(app, ["format", "list"])
    assert result.exit_code == 0, result.output
    rows = result.stdout.splitlines()
    assert rows[0].split() == ["NAME", "LOSSY"]
    assert rows[1].split() == ["dummy", "no"]


def test_format_list_needs_no_workspace_at_all(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Plugins are a fact about the process, not about any dataset — and you ask
    # what is available *before* choosing a ``--format``.
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(app, ["format", "list"])
    assert result.exit_code == 0, result.output
    assert "dummy" in result.stdout


def test_format_list_json_is_the_envelope() -> None:
    result = CliRunner().invoke(app, ["format", "list", "--json"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["items"] == [{"name": "dummy", "lossy": False}]


# --- export ------------------------------------------------------------------


def test_export_writes_into_the_directory_it_was_given(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    out = tmp_path / "out"
    document = payload(
        root, "export", "-p", name, "--release", "v1.0", "--format", "dummy", "--out", str(out)
    )
    assert document["directory"] == str(out)
    assert out.is_dir()


def test_the_dummy_exporter_reports_zero_files_and_that_is_correct(
    root: Path, tmp_path: Path
) -> None:
    name = published_release(root, tmp_path)
    document = payload(
        root,
        "export",
        "-p",
        name,
        "--release",
        "v1.0",
        "--format",
        "dummy",
        "--out",
        str(tmp_path / "out"),
    )
    assert document == {
        "release_id": document["release_id"],
        "format": "dummy",
        "directory": str(tmp_path / "out"),
        "file_count": 0,
        "total_bytes": 0,
    }


def test_an_unknown_format_exits_one_naming_what_is_installed(root: Path, tmp_path: Path) -> None:
    # ``registry.pick`` refuses with a ``VisionSetError`` listing the installed
    # set; a dict lookup would raise ``KeyError`` and print a traceback.
    name = published_release(root, tmp_path)
    result = run(
        root, "export", "-p", name, "--release", "v1.0", "--format", "yolo", "--out", str(tmp_path)
    )
    assert result.exit_code == 1, result.output
    assert "dummy" in result.stderr


def test_an_unknown_release_tag_exits_one(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    result = run(
        root, "export", "-p", name, "--release", "v9.9", "--format", "dummy", "--out", str(tmp_path)
    )
    assert result.exit_code == 1, result.output


def test_out_pointing_at_a_file_exits_two(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    occupied = tmp_path / "already-a-file"
    occupied.write_text("mine", encoding="utf-8")
    result = run(
        root,
        "export",
        "-p",
        name,
        "--release",
        "v1.0",
        "--format",
        "dummy",
        "--out",
        str(occupied),
    )
    assert result.exit_code == 2, result.output


# --- the lossy gate ----------------------------------------------------------


def test_a_lossy_format_exits_one_until_the_flag(root: Path, tmp_path: Path, lossy: None) -> None:
    # A third gate word, never folded into ``--yes``: this guards emitting an
    # incomplete *copy* of something that stays intact.
    name = published_release(root, tmp_path)
    out = tmp_path / "out"
    argv = [
        "export",
        "-p",
        name,
        "--release",
        "v1.0",
        "--format",
        "lossy-sample",
        "--out",
        str(out),
    ]
    refused = run(root, *argv)
    assert refused.exit_code == 1, refused.output
    assert not out.exists()

    document = payload(root, *argv, "--allow-lossy")
    assert document["file_count"] == 1
    assert (out / "labels.txt").is_file()
