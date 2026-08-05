"""SchemaService: monotonic immutable versions, and the two gates on narrowing.

The tests that need existing labels write assets and annotations straight
through the unit of work, and keep doing so now that `AnnotationService` exists.
That is deliberate rather than left over: those labels have to sit under classes
the *next* version is about to remove, and the service would first demand an
approved batch pinned at the very schema the test is trying to narrow. Setting
up the precondition is not the same as exercising the door — every schema in
here still comes through `SchemaService`.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import text

from visionset.kernel import (
    ConstraintViolated,
    DestructiveSchemaChange,
    InvalidSchema,
    ProjectNotFound,
    SchemaChangeWouldOrphan,
    SchemaNotFound,
    SchemaVersionConflict,
    UnsupportedGeometry,
)
from visionset.kernel.adapters import SqliteMetadataStore
from visionset.kernel.domain import (
    IMPLEMENTED_GEOMETRIES,
    Annotation,
    AnnotationSchema,
    Asset,
    Attribute,
    BboxGeometry,
    GeometryType,
    LabelClass,
    SchemaProvenance,
)
from visionset.kernel.services import ProjectService, SchemaService, WorkspaceService

SIGN = LabelClass(name="sign", geometry=GeometryType.BBOX)
LANE = LabelClass(name="lane", geometry=GeometryType.POLYGON)

#: One class using every attribute kind, so the round-trip test covers them all.
RICH = LabelClass(
    name="vehicle",
    geometry=GeometryType.BBOX,
    color="#3355ff",
    attributes=(
        Attribute(name="note", kind="string", default="none"),
        Attribute(name="wheels", kind="number", required=True, default=4),
        Attribute(name="occluded", kind="boolean", default=False),
        Attribute(name="weather", kind="select", options=("dry", "wet"), default="dry"),
    ),
)


def _services(
    tmp_path: Path, name: str = "ws"
) -> tuple[WorkspaceService, ProjectService, SchemaService]:
    workspace = WorkspaceService.init(tmp_path / name)
    return workspace, ProjectService(workspace), SchemaService(workspace)


def _annotate(workspace: WorkspaceService, project_id: UUID, label_class: str) -> None:
    """Give the project one annotation under ``label_class``, schema aside."""
    content_hash = workspace.blob_store.put(BytesIO(label_class.encode()))
    with workspace.unit_of_work() as uow:
        asset = uow.assets.add(
            Asset(project_id=project_id, content_hash=content_hash, uri=f"/tmp/{label_class}.png")
        )
        uow.annotations.add(
            Annotation(
                asset_id=asset.id,
                label_class=label_class,
                schema_version=1,
                geometry=BboxGeometry(x=0, y=0, width=4, height=4),
                provenance="human",
            )
        )


# --- versions are 1..N, monotonic, immutable ---------------------------------


def test_the_first_version_of_a_schema_is_one(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    assert schemas.create_version(project.id, [SIGN]).version == 1
    workspace.close()


def test_versions_are_numbered_one_past_the_highest_stored(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    for expected in (1, 2, 3):
        assert schemas.create_version(project.id, [SIGN, LANE]).version == expected
    assert [s.version for s in schemas.list_versions(project.id)] == [1, 2, 3]
    workspace.close()


def test_the_active_version_is_the_highest_one(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN])
    latest = schemas.create_version(project.id, [SIGN, LANE])
    assert schemas.get_active(project.id) == latest
    workspace.close()


def test_a_new_project_has_no_schema(tmp_path: Path) -> None:
    """A project starts without an ontology; version 1 is a decision somebody makes."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    assert schemas.list_versions(project.id) == []
    with pytest.raises(SchemaNotFound, match="no schema yet"):
        schemas.get_active(project.id)
    workspace.close()


def test_creating_a_version_never_rewrites_an_earlier_one(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    first = schemas.create_version(project.id, [SIGN])
    second = schemas.create_version(project.id, [SIGN, LANE])

    assert first.id != second.id
    assert schemas.get(project.id, 1) == first
    workspace.close()


def test_an_identical_version_is_still_a_new_version(tmp_path: Path) -> None:
    """Versions are cheap, and refusing a no-op would need an equality rule we
    would then have to defend against reordering and colors."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    first = schemas.create_version(project.id, [SIGN])
    again = schemas.create_version(project.id, [SIGN])

    assert (again.version, again.classes) == (2, first.classes)
    assert again.id != first.id
    workspace.close()


def test_a_stored_version_cannot_be_edited_in_place(tmp_path: Path) -> None:
    """The models are frozen, so immutability does not depend on nobody trying."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schema = schemas.create_version(project.id, [RICH])

    with pytest.raises(ValidationError):
        schema.version = 9  # type: ignore[misc]
    with pytest.raises(ValidationError):
        schema.classes[0].name = "other"  # type: ignore[misc]
    with pytest.raises(ValidationError):
        schema.classes[0].attributes[0].required = True  # type: ignore[misc]
    workspace.close()


def test_a_version_rehydrates_identically_after_a_reopen(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    stored = schemas.create_version(project.id, [RICH, LANE])
    workspace.close()

    reopened = WorkspaceService.open(tmp_path / "ws")
    reloaded = SchemaService(reopened).get(project.id, 1)

    assert reloaded == stored
    assert [c.model_dump(mode="json") for c in reloaded.classes] == [
        c.model_dump(mode="json") for c in (RICH, LANE)
    ]
    reopened.close()


# --- reading ------------------------------------------------------------------


def test_versions_are_listed_oldest_first(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    for classes in ([SIGN], [SIGN, LANE], [SIGN]):
        schemas.create_version(project.id, classes, allow_destructive=True)
    assert [s.version for s in schemas.list_versions(project.id)] == [1, 2, 3]
    workspace.close()


def test_asking_for_a_version_that_was_never_created_is_refused(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN])
    with pytest.raises(SchemaNotFound, match="version 2"):
        schemas.get(project.id, 2)
    workspace.close()


@pytest.mark.parametrize(
    "read",
    [
        lambda s, p: s.get(p, 1),
        lambda s, p: s.get_active(p),
        lambda s, p: s.list_versions(p),
        lambda s, p: s.allowed_geometries(p),
        lambda s, p: s.preview(p, []),
        lambda s, p: s.compare(p, 1, 2),
        lambda s, p: s.create_version(p, []),
    ],
    ids=[
        "get",
        "get_active",
        "list_versions",
        "allowed_geometries",
        "preview",
        "compare",
        "create",
    ],
)
def test_every_operation_refuses_an_unknown_project(
    tmp_path: Path, read: Callable[[SchemaService, UUID], object]
) -> None:
    workspace, _projects, schemas = _services(tmp_path)
    with pytest.raises(ProjectNotFound, match="no project"):
        read(schemas, uuid4())
    workspace.close()


def test_a_project_from_another_workspace_reads_as_missing(tmp_path: Path) -> None:
    first_workspace, _first, first_schemas = _services(tmp_path, "one")
    second_workspace, second, second_schemas = _services(tmp_path, "two")
    stranger = second.create("signs")
    second_schemas.create_version(stranger.id, [SIGN])

    with pytest.raises(ProjectNotFound):
        first_schemas.get_active(stranger.id)
    first_workspace.close()
    second_workspace.close()


def test_allowed_geometries_are_read_off_the_classes(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN])
    schemas.create_version(project.id, [SIGN, LANE])

    assert schemas.allowed_geometries(project.id, 1) == frozenset({GeometryType.BBOX})
    assert schemas.allowed_geometries(project.id) == frozenset(
        {GeometryType.BBOX, GeometryType.POLYGON}
    )
    workspace.close()


# --- validation ---------------------------------------------------------------


@pytest.mark.parametrize(
    "duplicate", ["sign", "SIGN", " sign "], ids=["identical", "other-case", "padded"]
)
def test_two_classes_cannot_share_a_name(tmp_path: Path, duplicate: str) -> None:
    """``Annotation.label_class`` matches exactly, so near-duplicates read as one
    class to everybody except the code."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    with pytest.raises(InvalidSchema, match="unique within a version"):
        schemas.create_version(
            project.id, [SIGN, LabelClass(name=duplicate, geometry=GeometryType.POLYGON)]
        )
    assert schemas.list_versions(project.id) == []
    workspace.close()


@pytest.mark.parametrize(
    "geometry",
    sorted(set(GeometryType) - IMPLEMENTED_GEOMETRIES),
    ids=lambda g: str(g.value),
)
def test_a_class_bound_to_an_unimplemented_geometry_is_refused(
    tmp_path: Path, geometry: GeometryType
) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    with pytest.raises(UnsupportedGeometry, match="no geometry implementation"):
        schemas.create_version(project.id, [LabelClass(name="thing", geometry=geometry)])
    assert schemas.list_versions(project.id) == []
    workspace.close()


@pytest.mark.parametrize("geometry", sorted(IMPLEMENTED_GEOMETRIES), ids=lambda g: str(g.value))
def test_every_implemented_geometry_is_accepted(tmp_path: Path, geometry: GeometryType) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schema = schemas.create_version(project.id, [LabelClass(name="thing", geometry=geometry)])
    assert schema.classes[0].geometry is geometry
    workspace.close()


def test_an_unsupported_geometry_is_reported_as_an_invalid_schema(tmp_path: Path) -> None:
    """One ``except InvalidSchema`` covers every way a version can be malformed."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    with pytest.raises(InvalidSchema):
        schemas.create_version(project.id, [LabelClass(name="road", geometry=GeometryType.MASK)])
    workspace.close()


def test_a_version_with_no_classes_is_a_legitimate_starting_point(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    assert schemas.create_version(project.id, []).classes == ()
    workspace.close()


@pytest.mark.parametrize(
    "malformed",
    [
        {"name": "  ", "kind": "string"},
        {"name": "weather", "kind": "select"},
        {"name": "note", "kind": "string", "options": ("a",)},
        {"name": "wheels", "kind": "number", "default": True},
        {"name": "weather", "kind": "select", "options": ("dry",), "default": "wet"},
    ],
    ids=[
        "blank-name",
        "select-without-options",
        "options-on-a-string",
        "wrong-default-kind",
        "default-outside-options",
    ],
)
def test_a_malformed_attribute_cannot_be_built_at_all(malformed: dict[str, object]) -> None:
    """Per-value validity is the model's, so it fails before a service sees it."""
    with pytest.raises(ValidationError):
        Attribute(**malformed)  # type: ignore[arg-type]


def test_one_class_cannot_carry_two_attributes_with_the_same_name() -> None:
    with pytest.raises(ValidationError, match="same name"):
        LabelClass(
            name="sign",
            geometry=GeometryType.BBOX,
            attributes=(
                Attribute(name="weather", kind="string"),
                Attribute(name="WEATHER", kind="boolean"),
            ),
        )


# --- the destructive gate -----------------------------------------------------


def test_an_additive_change_needs_no_flag(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN])
    assert schemas.create_version(project.id, [SIGN, LANE]).version == 2
    workspace.close()


def test_a_narrowing_change_without_the_flag_is_refused(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN, LANE])

    with pytest.raises(DestructiveSchemaChange, match="class 'lane' removed"):
        schemas.create_version(project.id, [SIGN])
    assert [s.version for s in schemas.list_versions(project.id)] == [1]
    workspace.close()


def test_a_narrowing_change_with_the_flag_and_no_labels_is_allowed(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN, LANE])

    second = schemas.create_version(project.id, [SIGN], allow_destructive=True)
    assert (second.version, [c.name for c in second.classes]) == (2, ["sign"])
    workspace.close()


def test_the_first_version_is_never_destructive(tmp_path: Path) -> None:
    """There are no annotations under a version that never existed."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    assert schemas.create_version(project.id, [SIGN]).version == 1
    workspace.close()


# --- the orphan refusal, which no flag overrides ------------------------------


def test_a_narrowing_change_is_refused_once_labels_exist_under_the_class(
    tmp_path: Path,
) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN, LANE])
    _annotate(workspace, project.id, "lane")

    with pytest.raises(SchemaChangeWouldOrphan, match="'lane' \\(1\\)"):
        schemas.create_version(project.id, [SIGN], allow_destructive=True)
    assert [s.version for s in schemas.list_versions(project.id)] == [1]
    workspace.close()


def test_labels_under_an_untouched_class_do_not_block_the_change(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN, LANE])
    _annotate(workspace, project.id, "sign")

    assert schemas.create_version(project.id, [SIGN], allow_destructive=True).version == 2
    workspace.close()


def test_labels_in_another_project_do_not_block_the_change(tmp_path: Path) -> None:
    """The orphan check is scoped to the project the version belongs to."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    neighbour = projects.create("other")
    schemas.create_version(project.id, [SIGN, LANE])
    _annotate(workspace, neighbour.id, "lane")

    assert schemas.create_version(project.id, [SIGN], allow_destructive=True).version == 2
    workspace.close()


def test_the_missing_flag_is_reported_before_the_labels_are_counted(tmp_path: Path) -> None:
    """Intent first, facts on disk second — the two refusals have different fixes."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN, LANE])
    _annotate(workspace, project.id, "lane")

    with pytest.raises(DestructiveSchemaChange):
        schemas.create_version(project.id, [SIGN])
    workspace.close()


def test_a_renamed_class_is_refused_like_a_removed_one(tmp_path: Path) -> None:
    """The kernel cannot see intent, and a rename really does orphan labels."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN])
    _annotate(workspace, project.id, "sign")

    with pytest.raises(SchemaChangeWouldOrphan, match="'sign'"):
        schemas.create_version(
            project.id,
            [LabelClass(name="signal", geometry=GeometryType.BBOX)],
            allow_destructive=True,
        )
    workspace.close()


# --- comparing ----------------------------------------------------------------


def test_two_stored_versions_can_be_compared(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN])
    schemas.create_version(project.id, [SIGN, LANE])

    forward = schemas.compare(project.id, 1, 2)
    backward = schemas.compare(project.id, 2, 1)

    assert forward.is_destructive is False
    assert backward.destructive_classes == frozenset({"lane"})
    workspace.close()


def test_comparing_against_a_missing_version_is_refused(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN])
    with pytest.raises(SchemaNotFound, match="version 2"):
        schemas.compare(project.id, 1, 2)
    workspace.close()


def test_preview_reports_what_create_version_would_gate_on_without_writing(
    tmp_path: Path,
) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN, LANE])

    diff = schemas.preview(project.id, [SIGN])

    assert diff.destructive_classes == frozenset({"lane"})
    assert [s.version for s in schemas.list_versions(project.id)] == [1]
    with pytest.raises(DestructiveSchemaChange, match=diff.describe(diff.changes[0].kind)):
        schemas.create_version(project.id, [SIGN])
    workspace.close()


def test_preview_on_a_project_with_no_schema_is_all_additive(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    assert schemas.preview(project.id, [SIGN, LANE]).is_destructive is False
    workspace.close()


# --- the version race ---------------------------------------------------------


def test_a_lost_version_race_is_reported_as_a_conflict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both writers read the same highest version; the unique index refuses the
    loser, one layer below where the maximum was read."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("signs")
    schemas.create_version(project.id, [SIGN])

    def _stale(self: SchemaService, uow: object, project_id: UUID) -> AnnotationSchema | None:
        return None  # as if nothing were stored yet, so the next version is 1 again

    # `active` rather than `_active` since #207 promoted it: `ProjectService.stats`
    # needs the "no schema yet" answer without an exception, and the seam a race
    # is simulated through is the same one.
    monkeypatch.setattr(SchemaService, "active", _stale)
    with pytest.raises(SchemaVersionConflict, match="retry"):
        schemas.create_version(project.id, [SIGN])
    workspace.close()


def test_any_other_constraint_travels_on_unchanged(tmp_path: Path) -> None:
    """Only the version index's complaint is this service's to reinterpret."""
    workspace, projects, schemas = _services(tmp_path)
    schemas.create_version(projects.create("signs").id, [SIGN])

    with pytest.raises(ConstraintViolated), workspace.unit_of_work() as uow:
        uow.schemas.add(AnnotationSchema(project_id=uuid4(), version=1, classes=(SIGN,)))
    workspace.close()


# --- the commit message, and when it was written ------------------------------


def test_a_version_records_why_it_exists_and_when(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")
    before = datetime.now(UTC)

    created = schemas.create_version(project.id, [SIGN], description="the first contract")

    assert created.description == "the first contract"
    assert created.created_at is not None
    assert before <= created.created_at <= datetime.now(UTC)
    assert created.created_at.tzinfo is not None
    workspace.close()


def test_the_moment_survives_a_round_trip_through_the_store(tmp_path: Path) -> None:
    """Byte-identically: the store keeps ISO-8601 text, and a naive read would be
    wrong by the writer's offset from UTC."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")
    created = schemas.create_version(project.id, [SIGN], description="v1")

    read = schemas.get(project.id, 1)

    assert read.created_at == created.created_at
    assert read.created_at is not None
    assert read.created_at.isoformat() == created.created_at.isoformat()  # type: ignore[union-attr]
    assert read.description == "v1"
    workspace.close()


def test_a_version_published_without_a_description_has_none(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")

    created = schemas.create_version(project.id, [SIGN])

    assert created.description is None
    assert schemas.get(project.id, 1).description is None
    workspace.close()


@pytest.mark.parametrize("blank", ["", "   ", "\n\t "])
def test_a_blank_description_is_none_rather_than_a_refusal(tmp_path: Path, blank: str) -> None:
    """An empty commit message is legal — this is not ``normalize_name``."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")

    created = schemas.create_version(project.id, [SIGN], description=blank)

    assert created.description is None
    workspace.close()


def test_a_description_is_stripped_and_nfc_normalized(tmp_path: Path) -> None:
    """``normalize_name``'s temperament with the refusal removed: two spellings
    that render identically must not be two different strings."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")

    # Spelled out with escapes rather than pasted: a literal that is already
    # composed would make this test assert only the strip, and pass whether or
    # not anything normalizes at all.
    decomposed = "  cafe\u0301 pass  "
    composed = "caf\u00e9 pass"
    assert decomposed.strip() != composed

    created = schemas.create_version(project.id, [SIGN], description=decomposed)

    assert created.description == composed
    workspace.close()


def test_the_description_cannot_be_edited_because_the_model_is_frozen(tmp_path: Path) -> None:
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")
    created = schemas.create_version(project.id, [SIGN], description="as published")

    with pytest.raises(ValidationError):
        created.description = "second thoughts"  # type: ignore[misc]
    workspace.close()


def test_a_naive_moment_is_refused_rather_than_assumed_to_be_utc(tmp_path: Path) -> None:
    workspace, projects, _ = _services(tmp_path)
    project = projects.create("roads")

    with pytest.raises(ValidationError, match="timezone-aware"):
        AnnotationSchema(
            project_id=project.id, version=1, created_at=datetime(2026, 8, 2, 12, 0, 0)
        )
    workspace.close()


def test_each_version_carries_its_own_description(tmp_path: Path) -> None:
    """A version history is only worth showing if the entries differ."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")
    schemas.create_version(project.id, [SIGN], description="first")
    schemas.create_version(project.id, [SIGN, LANE], description="lanes too")

    versions = schemas.list_versions(project.id)

    assert [v.description for v in versions] == ["first", "lanes too"]
    assert all(v.created_at is not None for v in versions)
    workspace.close()


# --- provenance: which kind of work published a version (#368) ---------------
#
# It is recorded, never derived. Nothing in the service reads it back, no gate
# consults it and no diff sees it — so what these tests are for is that the value
# a caller stated survives the round trip through JSON and SQLite unchanged, and
# that a caller who stated nothing is not given an opinion.


@pytest.mark.parametrize("stated", list(SchemaProvenance))
def test_the_provenance_a_caller_stated_survives_the_round_trip(
    tmp_path: Path, stated: SchemaProvenance
) -> None:
    """Parametrized over the enum itself, so a third member cannot go uncovered."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")

    created = schemas.create_version(project.id, [SIGN], provenance=stated)

    assert created.provenance is stated
    read = schemas.get(project.id, 1)
    assert read.provenance is stated
    # A ``StrEnum`` compares equal to its own text, so the member assertions above
    # would also pass against the bare string. This is what pins that rehydration
    # produces the enum rather than whatever SQLite handed back.
    assert isinstance(read.provenance, SchemaProvenance)
    workspace.close()


def test_a_version_published_without_a_provenance_has_none(tmp_path: Path) -> None:
    """ "Nobody said" is a legal answer, and the service does not fill it in.

    The SDK is the caller this is for: a script composing a schema in Python is
    neither surface, and making it choose would put a decision where there is no
    decision to make.
    """
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")

    created = schemas.create_version(project.id, [SIGN])

    assert created.provenance is None
    assert schemas.get(project.id, 1).provenance is None
    workspace.close()


def test_a_stored_version_predating_provenance_rehydrates_as_none(tmp_path: Path) -> None:
    """The migrated case, from the domain's side rather than the column's.

    ``test_schema_provenance_starts_null_because_nothing_recorded_who_published``
    proves the *column* stays NULL. This proves a NULL comes back as ``None`` and
    not as some default the model invented on the way out — which is the half a
    reader of the version history actually depends on.
    """
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")
    schemas.create_version(project.id, [SIGN], provenance=SchemaProvenance.CURATED)
    workspace.close()

    # Emptied through the store rather than through a service, because no service
    # can produce this state — which is the point: the only writer that leaves a
    # NULL here is a build that predates the column.
    store = SqliteMetadataStore(tmp_path / "ws" / "visionset.db")
    with store.engine.begin() as connection:
        connection.execute(text("update annotation_schema set provenance = null"))
    store.close()

    reopened = WorkspaceService.open(tmp_path / "ws")
    assert SchemaService(reopened).get(project.id, 1).provenance is None
    reopened.close()


def test_provenance_is_not_part_of_what_a_version_declares(tmp_path: Path) -> None:
    """Two versions differing only in provenance are the same contract.

    Stated as a test because the opposite is a plausible thing to build later: a
    diff that reported "provenance changed" would make an incidental version look
    like a contract change in every surface that renders one.
    """
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")
    schemas.create_version(project.id, [SIGN], provenance=SchemaProvenance.CURATED)
    schemas.create_version(project.id, [SIGN], provenance=SchemaProvenance.ANNOTATION)

    assert schemas.compare(project.id, 1, 2).changes == ()
    assert not schemas.compare(project.id, 1, 2).is_destructive
    workspace.close()


def test_each_version_carries_its_own_provenance(tmp_path: Path) -> None:
    """The run-versus-milestone shape a version history has to be able to read."""
    workspace, projects, schemas = _services(tmp_path)
    project = projects.create("roads")
    schemas.create_version(project.id, [SIGN], provenance=SchemaProvenance.CURATED)
    schemas.create_version(project.id, [SIGN, LANE], provenance=SchemaProvenance.ANNOTATION)
    schemas.create_version(project.id, [SIGN, LANE])

    assert [v.provenance for v in schemas.list_versions(project.id)] == [
        SchemaProvenance.CURATED,
        SchemaProvenance.ANNOTATION,
        None,
    ]
    workspace.close()
