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
    LabelClass,
    Project,
    SchemaDraft,
    SchemaProvenance,
    SchemaPublication,
)
from visionset.kernel.errors import InvalidSchema, ProjectNotFound, SchemaDraftNotFound, StaleWrite
from visionset.kernel.services import SchemaDraftService, SchemaService, WorkspaceService

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


def test_the_format_version_is_twelve() -> None:
    assert FORMAT_VERSION == 12


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
    """A writer that never read must not be able to clobber one that did.

    The message says a draft already exists and names its revision — not that
    the write is stale against ``None``, which is what "expired" would say to a
    caller who never named a revision in the first place.
    """
    workspace, drafts, project = _drafts(tmp_path)
    drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="car")])
    with pytest.raises(StaleWrite, match="already has a curated schema draft at revision 1") as exc:
        drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="lane")])
    assert "None" not in str(exc.value)
    workspace.close()


def test_omitting_based_on_on_a_second_save_preserves_the_stored_value(tmp_path: Path) -> None:
    """A read-modify-write through a surface with no ``based_on`` parameter at all
    — the CLI's ``schema draft set``, ``set_schema_draft`` — must not silently null
    out a value it never had the means to carry.
    """
    workspace, drafts, project = _drafts(tmp_path)
    first = drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="car")], based_on=3)
    second = drafts.save(
        project.id,
        CURATED,
        classes=[DraftLabelClass(name="car"), DraftLabelClass(name="lane")],
        expected_revision=first.revision,
    )
    assert second.based_on == 3
    workspace.close()


def test_based_on_explicitly_passed_as_none_still_clears_it(tmp_path: Path) -> None:
    """Omitted and explicit-``None`` are different requests, and only the first preserves."""
    workspace, drafts, project = _drafts(tmp_path)
    first = drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="car")], based_on=3)
    second = drafts.save(
        project.id,
        CURATED,
        classes=[DraftLabelClass(name="car")],
        based_on=None,
        expected_revision=first.revision,
    )
    assert second.based_on is None
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


# --- SchemaDraftService.publish ------------------------------------------------


def test_publishing_a_draft_creates_a_version_and_clears_the_draft(tmp_path: Path) -> None:
    workspace, drafts, project = _drafts(tmp_path)
    saved = drafts.save(
        project.id,
        CURATED,
        classes=[DraftLabelClass(name="car", geometries=(GeometryType.BBOX,))],
        note="first pass",
    )
    published = drafts.publish(project.id, CURATED, expected_revision=saved.revision)
    assert published.published.version == 1
    assert [c.name for c in published.published.classes] == ["car"]
    assert published.published.description == "first pass"
    assert published.published.provenance is CURATED
    assert drafts.get(project.id, CURATED) is None
    workspace.close()


def test_publishing_a_blank_note_leaves_the_version_undescribed(tmp_path: Path) -> None:
    """An empty box is not a decision: `note=""` publishes `description=None`, not `""`.

    The property this guards used to be a wire-level omission — a client that sent
    no `description` key at all. `SchemaDraftBody.note` is a required field, so that
    omission is no longer possible on the client; the same guarantee now lives here,
    in `publish`'s own `draft.note or None`.
    """
    workspace, drafts, project = _drafts(tmp_path)
    saved = drafts.save(
        project.id,
        CURATED,
        classes=[DraftLabelClass(name="car", geometries=(GeometryType.BBOX,))],
        note="",
    )
    published = drafts.publish(project.id, CURATED, expected_revision=saved.revision)
    assert published.published.description is None
    workspace.close()


def test_the_kind_becomes_the_versions_provenance(tmp_path: Path) -> None:
    workspace, drafts, project = _drafts(tmp_path)
    saved = drafts.save(
        project.id,
        SchemaProvenance.ANNOTATION,
        classes=[DraftLabelClass(name="lane", geometries=(GeometryType.BBOX,))],
    )
    published = drafts.publish(
        project.id, SchemaProvenance.ANNOTATION, expected_revision=saved.revision
    )
    assert published.published.provenance is SchemaProvenance.ANNOTATION
    workspace.close()


def test_publishing_one_kind_leaves_the_other_alone(tmp_path: Path) -> None:
    """A dialog session publishes its own classes only, never the editor's draft."""
    workspace, drafts, project = _drafts(tmp_path)
    curated = drafts.save(project.id, CURATED, classes=[DraftLabelClass(name="unfinished")])
    session = drafts.save(
        project.id,
        SchemaProvenance.ANNOTATION,
        classes=[DraftLabelClass(name="lane", geometries=(GeometryType.BBOX,))],
    )
    published = drafts.publish(
        project.id, SchemaProvenance.ANNOTATION, expected_revision=session.revision
    )
    assert [c.name for c in published.published.classes] == ["lane"]
    assert drafts.get(project.id, CURATED).revision == curated.revision
    workspace.close()


def test_publishing_an_expired_revision_is_refused_and_writes_nothing(tmp_path: Path) -> None:
    workspace, drafts, project = _drafts(tmp_path)
    schemas = SchemaService(workspace)
    saved = drafts.save(
        project.id,
        CURATED,
        classes=[DraftLabelClass(name="car", geometries=(GeometryType.BBOX,))],
    )
    drafts.save(project.id, CURATED, classes=[], expected_revision=saved.revision)
    with pytest.raises(StaleWrite):
        drafts.publish(project.id, CURATED, expected_revision=saved.revision)
    assert schemas.list_versions(project.id) == []
    assert drafts.get(project.id, CURATED) is not None
    workspace.close()


def test_publishing_a_draft_that_is_not_there_is_a_refusal_of_its_own(tmp_path: Path) -> None:
    workspace, drafts, project = _drafts(tmp_path)
    with pytest.raises(SchemaDraftNotFound):
        drafts.publish(project.id, CURATED, expected_revision=1)
    workspace.close()


def test_an_unfinished_class_is_refused_at_publish_and_named(tmp_path: Path) -> None:
    """Validation is not weakened by the permissive store — it moves to here."""
    workspace, drafts, project = _drafts(tmp_path)
    saved = drafts.save(
        project.id,
        CURATED,
        classes=[
            DraftLabelClass(name="car", geometries=(GeometryType.BBOX,)),
            DraftLabelClass(name="", geometries=(GeometryType.BBOX,)),
        ],
    )
    with pytest.raises(InvalidSchema) as refused:
        drafts.publish(project.id, CURATED, expected_revision=saved.revision)
    assert "classes.1" in str(refused.value)
    workspace.close()


def test_an_attribute_with_no_kind_is_refused_at_publish_and_named(tmp_path: Path) -> None:
    """The bare ``ValueError`` path: ``to_attribute`` raises it directly, never through
    pydantic's ``ValidationError``, because it fires before ``Attribute`` is constructed.
    """
    workspace, drafts, project = _drafts(tmp_path)
    saved = drafts.save(
        project.id,
        CURATED,
        classes=[
            DraftLabelClass(name="ok", geometries=(GeometryType.BBOX,)),
            DraftLabelClass(
                name="car",
                geometries=(GeometryType.BBOX,),
                attributes=(DraftAttribute(name="occlusion"),),
            ),
        ],
    )
    with pytest.raises(InvalidSchema) as refused:
        drafts.publish(project.id, CURATED, expected_revision=saved.revision)
    assert "classes.1" in str(refused.value)
    workspace.close()


def test_a_write_landing_between_publish_and_its_discard_survives(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The gap ``publish``'s own docstring names — not one transaction, and it
    cannot be — is exactly where a second writer's commit must not be destroyed.
    A ``discard`` with no revision check would delete it as collateral of a
    publish that never asked to touch it.
    """
    workspace, drafts, project = _drafts(tmp_path)
    saved = drafts.save(
        project.id, CURATED, classes=[DraftLabelClass(name="car", geometries=(GeometryType.BBOX,))]
    )
    original_create_version = SchemaService.create_version

    def racing_create_version(
        self: SchemaService, *args: object, **kwargs: object
    ) -> SchemaPublication:
        published = original_create_version(self, *args, **kwargs)  # type: ignore[arg-type]
        # A second writer's save, committed in its own unit of work, in the
        # window between `create_version` returning and `publish`'s discard.
        drafts.save(
            project.id,
            CURATED,
            classes=[
                DraftLabelClass(name="car", geometries=(GeometryType.BBOX,)),
                DraftLabelClass(name="lane"),
            ],
            expected_revision=saved.revision,
        )
        return published

    monkeypatch.setattr(SchemaService, "create_version", racing_create_version)
    drafts.publish(project.id, CURATED, expected_revision=saved.revision)

    survivor = drafts.get(project.id, CURATED)
    assert survivor is not None
    assert [c.name for c in survivor.classes] == ["car", "lane"]
    workspace.close()


def test_a_draft_that_publishes_nothing_new_still_clears(tmp_path: Path) -> None:
    """`create_version` answers a no-op with the active version; the draft is spent either way."""
    workspace, drafts, project = _drafts(tmp_path)
    schemas = SchemaService(workspace)
    schemas.create_version(project.id, [LabelClass(name="car", geometries=(GeometryType.BBOX,))])
    saved = drafts.save(
        project.id,
        CURATED,
        classes=[DraftLabelClass(name="car", geometries=(GeometryType.BBOX,))],
    )
    published = drafts.publish(project.id, CURATED, expected_revision=saved.revision)
    assert published.published.version == 1
    assert drafts.get(project.id, CURATED) is None
    workspace.close()
