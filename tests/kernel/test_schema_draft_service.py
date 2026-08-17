"""The draft, from the store up. Service behaviour arrives in the next tasks."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from visionset.kernel.adapters.migrations import FORMAT_VERSION
from visionset.kernel.domain import (
    DraftAttribute,
    DraftLabelClass,
    GeometryType,
    Project,
    SchemaDraft,
    SchemaProvenance,
)
from visionset.kernel.services import WorkspaceService


def _store(tmp_path: Path, name: str = "ws") -> tuple[WorkspaceService, Project]:
    """Open a workspace with one project, the way every test here needs it."""
    workspace = WorkspaceService.init(tmp_path / name)
    with workspace.unit_of_work() as uow:
        project = uow.projects.add(Project(workspace_id=uow.workspaces.list()[0].id, name="p"))
    return workspace, project


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
