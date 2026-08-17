"""The draft, from the store up. Service behaviour arrives in the next tasks."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest

from visionset.kernel.adapters.migrations import FORMAT_VERSION
from visionset.kernel.domain import (
    DraftAttribute,
    DraftLabelClass,
    GeometryType,
    Project,
    SchemaDraft,
    SchemaProvenance,
)
from visionset.kernel.errors import ProjectNotFound, StaleWrite
from visionset.kernel.services import SchemaDraftService, WorkspaceService

CURATED = SchemaProvenance.CURATED


def _store(tmp_path: Path, name: str = "ws") -> tuple[WorkspaceService, Project]:
    """Open a workspace with one project, the way every test here needs it."""
    workspace = WorkspaceService.init(tmp_path / name)
    with workspace.unit_of_work() as uow:
        project = uow.projects.add(Project(workspace_id=uow.workspaces.list()[0].id, name="p"))
    return workspace, project


def _drafts(
    tmp_path: Path, name: str = "ws"
) -> tuple[WorkspaceService, SchemaDraftService, Project]:
    """Open a workspace with one project and its draft service, the way every test here needs it."""
    workspace, project = _store(tmp_path, name)
    return workspace, SchemaDraftService(workspace), project


def test_the_format_version_is_ten() -> None:
    assert FORMAT_VERSION == 10


def test_a_draft_round_trips_with_its_half_typed_classes_intact(tmp_path: Path) -> None:
    """The store must not quietly tidy what the domain deliberately permits."""
    store, project = _store(tmp_path)
    with store.unit_of_work() as uow:
        uow.schema_drafts.add(
            SchemaDraft(
                project_id=project.id,
                kind=SchemaProvenance.CURATED,
                classes=(
                    DraftLabelClass(name="", geometries=()),
                    DraftLabelClass(
                        name="car",
                        geometries=(GeometryType.BBOX,),
                        attributes=(DraftAttribute(name="occlusion"),),
                    ),
                ),
                note="halfway",
                based_on=None,
                updated_at=datetime.now(UTC),
            )
        )
    with store.unit_of_work() as uow:
        [read] = uow.schema_drafts.list(project.id)
    assert read.kind is SchemaProvenance.CURATED
    assert read.classes[0].name == ""
    assert read.classes[0].geometries == ()
    assert read.classes[1].attributes[0].kind is None
    assert read.note == "halfway"
    assert read.updated_at.tzinfo is not None
    store.close()


def test_the_two_kinds_are_two_rows(tmp_path: Path) -> None:
    store, project = _store(tmp_path)
    with store.unit_of_work() as uow:
        for kind in (SchemaProvenance.CURATED, SchemaProvenance.ANNOTATION):
            uow.schema_drafts.add(
                SchemaDraft(project_id=project.id, kind=kind, updated_at=datetime.now(UTC))
            )
    with store.unit_of_work() as uow:
        assert len(uow.schema_drafts.list(project.id)) == 2
    store.close()


def test_deleting_a_project_takes_its_drafts(tmp_path: Path) -> None:
    store, project = _store(tmp_path)
    with store.unit_of_work() as uow:
        uow.schema_drafts.add(
            SchemaDraft(
                project_id=project.id,
                kind=SchemaProvenance.CURATED,
                updated_at=datetime.now(UTC),
            )
        )
    with store.unit_of_work() as uow:
        uow.projects.delete(project.id)
    with store.unit_of_work() as uow:
        assert uow.schema_drafts.list(project.id) == []
    store.close()


# --- SchemaDraftService: read, upsert, discard --------------------------------


def test_a_project_with_no_draft_reads_none(tmp_path: Path) -> None:
    workspace, drafts, project = _drafts(tmp_path)
    assert drafts.get(project.id, CURATED) is None
    workspace.close()


def test_the_first_save_creates_revision_one(tmp_path: Path) -> None:
    workspace, drafts, project = _drafts(tmp_path)
    saved = drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="car")])
    assert saved.revision == 1
    assert saved.based_on is None
    assert drafts.get(project.id, CURATED) == saved
    workspace.close()


def test_a_second_save_naming_the_stored_revision_advances_it(tmp_path: Path) -> None:
    workspace, drafts, project = _drafts(tmp_path)
    first = drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="car")])
    second = drafts.save(
        project.id,
        CURATED,
        classes=[DraftLabelClass(name="car"), DraftLabelClass(name="lane")],
        expected_revision=first.revision,
    )
    assert second.revision == 2
    assert len(second.classes) == 2
    assert second.id == first.id
    workspace.close()


def test_a_save_naming_an_expired_revision_is_refused(tmp_path: Path) -> None:
    """Two people on one draft: the second write was decided against a stale answer."""
    workspace, drafts, project = _drafts(tmp_path)
    first = drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="car")])
    drafts.save(project.id, CURATED, classes=[], expected_revision=first.revision)
    with pytest.raises(StaleWrite):
        drafts.save(
            project.id,
            CURATED,
            classes=[DraftLabelClass(name="lane")],
            expected_revision=first.revision,
        )
    workspace.close()


def test_creating_over_an_existing_draft_is_refused(tmp_path: Path) -> None:
    """A writer that never read must not be able to clobber one that did."""
    workspace, drafts, project = _drafts(tmp_path)
    drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="car")])
    with pytest.raises(StaleWrite):
        drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="lane")])
    workspace.close()


def test_the_two_kinds_do_not_see_each_other(tmp_path: Path) -> None:
    workspace, drafts, project = _drafts(tmp_path)
    drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="car")])
    drafts.save(project.id, SchemaProvenance.ANNOTATION, classes=[DraftLabelClass(name="lane")])
    assert [c.name for c in drafts.get(project.id, CURATED).classes] == ["car"]
    assert [c.name for c in drafts.get(project.id, SchemaProvenance.ANNOTATION).classes] == ["lane"]
    workspace.close()


def test_discard_removes_it_and_says_so(tmp_path: Path) -> None:
    workspace, drafts, project = _drafts(tmp_path)
    drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="car")])
    assert drafts.discard(project.id, CURATED) is True
    assert drafts.get(project.id, CURATED) is None
    workspace.close()


def test_discarding_a_draft_that_is_not_there_is_false_and_not_an_error(tmp_path: Path) -> None:
    workspace, drafts, project = _drafts(tmp_path)
    assert drafts.discard(project.id, CURATED) is False
    workspace.close()


def test_a_project_in_another_workspace_reads_as_missing(tmp_path: Path) -> None:
    workspace, drafts, _project = _drafts(tmp_path)
    with pytest.raises(ProjectNotFound):
        drafts.get(uuid4(), CURATED)
    workspace.close()
