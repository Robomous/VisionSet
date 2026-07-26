"""The repo-root VERSION file is the single source of truth; these tests keep it that way."""

from pathlib import Path

import pytest
from typer.testing import CliRunner

from visionset import __version__
from visionset.cli.main import app

VERSION_FILE = Path(__file__).resolve().parents[1] / "VERSION"

runner = CliRunner()


@pytest.fixture(scope="module")
def declared_version() -> str:
    return VERSION_FILE.read_text(encoding="utf-8").strip()


def test_version_file_targets_the_beta_release_line(declared_version: str) -> None:
    """`0.0.1-beta` is the release target, so VERSION must stay below it in PEP 440 order."""
    assert declared_version == "0.0.1.dev0"


def test_installed_distribution_reports_the_declared_version(declared_version: str) -> None:
    assert __version__ == declared_version


def test_cli_version_flag_prints_the_declared_version(declared_version: str) -> None:
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0
    assert result.stdout.strip() == declared_version
