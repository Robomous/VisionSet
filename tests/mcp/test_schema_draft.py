"""The draft as an agent meets it: compose over several calls, publish once."""

from __future__ import annotations

from pathlib import Path

import pytest
from tests.mcp import _flow

from visionset.kernel.errors import StaleWrite
from visionset.mcp import schemas


@pytest.fixture
def project(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> str:
    """A workspace with one project in it. Returns the project name."""
    return _flow.project(monkeypatch, tmp_path)


def test_a_project_with_no_draft_answers_none(project) -> None:
    assert schemas.get_schema_draft(project)["draft"] is None


def test_set_then_get_round_trips(project) -> None:
    saved = schemas.set_schema_draft(project, classes=[{"name": "car"}])
    assert saved["revision"] == 1
    read = schemas.get_schema_draft(project)["draft"]
    assert [c["name"] for c in read["classes"]] == ["car"]


def test_an_expired_revision_is_refused(project) -> None:
    schemas.set_schema_draft(project, classes=[{"name": "car"}])
    with pytest.raises(StaleWrite):
        schemas.set_schema_draft(project, classes=[{"name": "lane"}], revision=99)


def test_publish_creates_the_version_and_clears_the_draft(project) -> None:
    saved = schemas.set_schema_draft(
        project, classes=[{"name": "car", "geometries": ["bbox"]}], note="first"
    )
    published = schemas.publish_schema_draft(project, revision=saved["revision"])
    assert published["published"]["version"] == 1
    assert published["published"]["provenance"] == "curated"
    assert schemas.get_schema_draft(project)["draft"] is None


def test_clear_removes_it(project) -> None:
    schemas.set_schema_draft(project, classes=[{"name": "car"}])
    schemas.clear_schema_draft(project)
    assert schemas.get_schema_draft(project)["draft"] is None
