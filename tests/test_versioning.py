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


def test_version_file_is_the_beta(declared_version: str) -> None:
    """The published artifact. Pinned, so a bump is a deliberate edit in two places.

    It was `0.0.1.dev0` through all five alpha tags, because those are git tags and
    nothing was being distributed. This is the version that goes to PyPI, where
    PEP 440 hides a pre-release from a plain `pip install` — which is what makes
    publishing it safe rather than premature. See `docs/content/releasing.md`.

    `0.0.1b2` is the beta corrected: `0.0.1b1` shipped with three defects a manual
    pass over the **wheel** found and a green suite could not, and a
    published version is never edited in place.
    """
    assert declared_version == "0.0.1b2"


def test_installed_distribution_reports_the_declared_version(declared_version: str) -> None:
    assert __version__ == declared_version


def test_cli_version_flag_prints_the_declared_version(declared_version: str) -> None:
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0
    assert result.stdout.strip() == declared_version
