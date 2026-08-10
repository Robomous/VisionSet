"""ProjectService: CRUD, the atomic 1:1 dataset, and what deletion does not destroy.

`_populate` writes one row of everything a project owns straight through the unit
of work, `Release` included. Going through `ReleaseService` for that would mean
running a whole batch to completion first — a precondition, not the door under
test — and the release here exists only to be cascaded away and to name a blob
that must survive it.
"""

from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from visionset.kernel import (
    ConfirmationRequired,
    InvalidName,
    ProjectNameTaken,
    ProjectNotFound,
    WorkspaceCorrupt,
)
from visionset.kernel.domain import (
    Annotation,
    AnnotationSchema,
    Asset,
    Batch,
    BboxGeometry,
    Dataset,
    DatasetChange,
    DatasetMember,
    GeometryType,
    LabelClass,
    Release,
    Source,
    SourceKind,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services import ProjectService, WorkspaceService

#: "cafe" + a combining acute accent: what macOS filesystems hand out.
CAFE_DECOMPOSED = "caf\u0065\u0301"
#: The same text as one pre-composed codepoint, which is the form we store.
CAFE_COMPOSED = "caf\u00e9"


def _service(tmp_path: Path, name: str = "ws") -> tuple[WorkspaceService, ProjectService]:
    workspace = WorkspaceService.init(tmp_path / name)
    return workspace, ProjectService(workspace)


def _datasets_of(workspace: WorkspaceService, project_id: UUID) -> list[Dataset]:
    """The dataset rows a project owns, read past the service's 1:1 assertion."""
    with workspace.unit_of_work() as uow:
        return uow.datasets.list(project_id)


def _populate(workspace: WorkspaceService, project_id: UUID, dataset_id: UUID) -> str:
    """Give a project one of everything that hangs off it. Returns the blob hash."""
    content_hash = workspace.blob_store.put(BytesIO(b"pixels"))
    with workspace.unit_of_work() as uow:
        schema = uow.schemas.add(
            AnnotationSchema(
                project_id=project_id,
                version=1,
                classes=[LabelClass(name="sign", geometry=GeometryType.BBOX)],
            )
        )
        uow.sources.add(
            Source(project_id=project_id, kind=SourceKind.IMAGE_DIRECTORY, path="/tmp/in")
        )
        asset = uow.assets.add(
            Asset(project_id=project_id, content_hash=content_hash, uri="/tmp/in/a.png")
        )
        uow.annotations.add(
            Annotation(
                asset_id=asset.id,
                label_class="sign",
                schema_version=schema.version,
                geometry=BboxGeometry(x=0, y=0, width=4, height=4),
                provenance="human",
            )
        )
        uow.batches.add(Batch(project_id=project_id, name="first", asset_ids=[asset.id]))
        uow.dataset_members.add(DatasetMember(dataset_id=dataset_id, asset_id=asset.id))
        uow.dataset_changes.add(DatasetChange(dataset_id=dataset_id, operation="promote"))
        uow.releases.add(
            Release(
                dataset_id=dataset_id,
                tag="v1",
                manifest_hash=content_hash,
                schema_version=1,
                asset_count=1,
                annotation_count=1,
            )
        )
    return content_hash


# --- create: the project and its dataset, or neither --------------------------


def test_creating_a_project_creates_its_dataset(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    assert projects.get_dataset(project.id).project_id == project.id
    workspace.close()


def test_a_new_project_has_exactly_one_dataset(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    assert len(_datasets_of(workspace, project.id)) == 1
    workspace.close()


def test_a_new_dataset_takes_the_name_of_its_project(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("  road signs  ")
    assert (project.name, projects.get_dataset(project.id).name) == ("road signs", "road signs")
    workspace.close()


def test_a_new_dataset_starts_empty(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    dataset = projects.get_dataset(projects.create("signs").id)
    with workspace.unit_of_work() as uow:
        assert uow.dataset_members.list(dataset.id) == []
        assert uow.releases.list(dataset.id) == []
    assert dataset.description is None
    workspace.close()


def test_a_description_is_stored_on_the_project(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs", "street furniture")
    assert projects.get(project.id).description == "street furniture"
    workspace.close()


def test_a_project_name_is_stored_in_composed_unicode_form(tmp_path: Path) -> None:
    assert CAFE_DECOMPOSED != CAFE_COMPOSED
    workspace, projects = _service(tmp_path)
    project = projects.create(CAFE_DECOMPOSED)
    assert (project.name, projects.get_dataset(project.id).name) == (
        CAFE_COMPOSED,
        CAFE_COMPOSED,
    )
    with pytest.raises(ProjectNameTaken):
        projects.create(CAFE_COMPOSED)
    workspace.close()


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_creating_a_project_with_a_blank_name_is_rejected(tmp_path: Path, blank: str) -> None:
    workspace, projects = _service(tmp_path)
    with pytest.raises(InvalidName, match="non-blank"):
        projects.create(blank)
    assert projects.list() == []
    workspace.close()


@pytest.mark.parametrize(
    "duplicate",
    ["signs", "SIGNS", "  signs\n"],
    ids=["identical", "other-case", "padded"],
)
def test_creating_a_project_under_a_taken_name_is_rejected(tmp_path: Path, duplicate: str) -> None:
    workspace, projects = _service(tmp_path)
    projects.create("signs")
    with pytest.raises(ProjectNameTaken, match="signs"):
        projects.create(duplicate)
    assert len(projects.list()) == 1
    workspace.close()


def test_a_refused_project_leaves_no_orphan_dataset(tmp_path: Path) -> None:
    """The two rows are one transaction: if the project does not land, nothing does."""
    workspace, projects = _service(tmp_path)
    first = projects.create("signs")
    with pytest.raises(ProjectNameTaken):
        projects.create("SIGNS")
    with workspace.unit_of_work() as uow:
        assert [d.project_id for d in uow.datasets.list()] == [first.id]
    workspace.close()


def test_a_lost_name_race_is_reported_as_a_taken_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both processes pass the pre-check; the index refuses the loser, not the service."""

    def _no_check(self: WorkspaceService, uow: UnitOfWork, name: str, **_: object) -> str:
        return self.normalize_project_name(name)

    workspace, projects = _service(tmp_path)
    projects.create("signs")
    monkeypatch.setattr(WorkspaceService, "require_project_name", _no_check)
    with pytest.raises(ProjectNameTaken, match="SIGNS"):
        projects.create("SIGNS")
    workspace.close()


# --- get, list ----------------------------------------------------------------


def test_a_project_reads_back_by_id(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    assert projects.get(project.id) == project
    workspace.close()


def test_getting_an_unknown_project_is_refused(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    with pytest.raises(ProjectNotFound, match="no project"):
        projects.get(uuid4())
    workspace.close()


def test_a_project_from_another_workspace_reads_as_missing(tmp_path: Path) -> None:
    first_workspace, first = _service(tmp_path, "one")
    second_workspace, second = _service(tmp_path, "two")
    stranger = second.create("signs")
    with pytest.raises(ProjectNotFound):
        first.get(stranger.id)
    first_workspace.close()
    second_workspace.close()


def test_a_project_reads_back_by_name(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    assert projects.get_by_name("signs") == project
    workspace.close()


@pytest.mark.parametrize("spelling", ["SIGNS", "Signs", "sIgNs"])
def test_a_name_resolves_ignoring_case(tmp_path: Path, spelling: str) -> None:
    # The comparison the unique index makes. It lives here rather than in a
    # surface because it is not obvious and it is not the only one: a release tag
    # is unique per dataset and case-*sensitive*, so a caller re-deriving either
    # rule from prose would eventually get one of them wrong.
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    assert projects.get_by_name(spelling) == project
    workspace.close()


def test_a_name_resolves_after_normalization(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    assert projects.get_by_name("  signs  ") == project
    workspace.close()


def test_getting_an_unknown_name_is_refused(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    with pytest.raises(ProjectNotFound, match="no project named"):
        projects.get_by_name("signs")
    workspace.close()


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_getting_a_blank_name_is_refused_as_a_name(tmp_path: Path, blank: str) -> None:
    # ``InvalidName`` rather than ``ProjectNotFound``: a blank string never named
    # anything, which is a different answer from naming something absent.
    workspace, projects = _service(tmp_path)
    with pytest.raises(InvalidName):
        projects.get_by_name(blank)
    workspace.close()


def test_a_project_from_another_workspace_does_not_resolve_by_name(tmp_path: Path) -> None:
    first_workspace, first = _service(tmp_path, "one")
    second_workspace, second = _service(tmp_path, "two")
    second.create("signs")
    with pytest.raises(ProjectNotFound):
        first.get_by_name("signs")
    first_workspace.close()
    second_workspace.close()


def test_a_fresh_workspace_has_no_projects(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    assert projects.list() == []
    workspace.close()


def test_projects_are_listed_in_the_order_they_were_created(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    for name in ("first", "second", "third"):
        projects.create(name)
    assert [p.name for p in projects.list()] == ["first", "second", "third"]
    workspace.close()


def test_a_project_without_a_dataset_is_reported_as_corruption(tmp_path: Path) -> None:
    """Picking the first of none — or of two — would hide a broken 1:1 relation."""
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    with workspace.unit_of_work() as uow:
        uow.datasets.delete(uow.datasets.list(project.id)[0].id)
    with pytest.raises(WorkspaceCorrupt, match="0 datasets"):
        projects.get_dataset(project.id)
    workspace.close()


# --- rename -------------------------------------------------------------------


def test_renaming_a_project_renames_its_dataset(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    renamed = projects.rename(project.id, "traffic signs")
    assert (renamed.name, projects.get_dataset(project.id).name) == (
        "traffic signs",
        "traffic signs",
    )
    workspace.close()


def test_a_rename_is_stored_not_merely_returned(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    projects.rename(project.id, "traffic signs")
    assert [p.name for p in projects.list()] == ["traffic signs"]
    workspace.close()


def test_a_rename_keeps_the_description(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs", "street furniture")
    assert projects.rename(project.id, "traffic signs").description == "street furniture"
    workspace.close()


def test_a_project_may_be_renamed_to_a_different_case_of_its_own_name(tmp_path: Path) -> None:
    """A no-op rename is not a collision — correcting capitalization has to work."""
    workspace, projects = _service(tmp_path)
    project = projects.create("road signs")
    assert projects.rename(project.id, "Road Signs").name == "Road Signs"
    workspace.close()


def test_renaming_onto_another_projects_name_is_rejected(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    projects.create("signs")
    other = projects.create("lanes")
    with pytest.raises(ProjectNameTaken, match="signs"):
        projects.rename(other.id, "SIGNS")
    assert [p.name for p in projects.list()] == ["signs", "lanes"]
    assert projects.get_dataset(other.id).name == "lanes"
    workspace.close()


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_renaming_a_project_to_a_blank_name_is_rejected(tmp_path: Path, blank: str) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    with pytest.raises(InvalidName, match="non-blank"):
        projects.rename(project.id, blank)
    assert projects.get(project.id).name == "signs"
    workspace.close()


def test_renaming_an_unknown_project_is_refused(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    with pytest.raises(ProjectNotFound):
        projects.rename(uuid4(), "signs")
    workspace.close()


# --- delete: confirmation -----------------------------------------------------


def test_deleting_without_confirmation_is_refused(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    with pytest.raises(ConfirmationRequired, match="confirm=True"):
        projects.delete(project.id)
    assert [p.name for p in projects.list()] == ["signs"]
    assert len(_datasets_of(workspace, project.id)) == 1
    workspace.close()


def test_deleting_with_confirmation_removes_the_project_and_its_dataset(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    projects.delete(project.id, confirm=True)
    assert projects.list() == []
    assert _datasets_of(workspace, project.id) == []
    workspace.close()


def test_deleting_a_project_leaves_its_siblings_alone(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    doomed = projects.create("signs")
    keeper = projects.create("lanes")
    projects.delete(doomed.id, confirm=True)
    assert [p.name for p in projects.list()] == ["lanes"]
    assert projects.get_dataset(keeper.id).name == "lanes"
    workspace.close()


def test_a_deleted_name_becomes_free_again(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    projects.delete(projects.create("signs").id, confirm=True)
    assert projects.create("signs").name == "signs"
    workspace.close()


@pytest.mark.parametrize("confirm", [False, True], ids=["unconfirmed", "confirmed"])
def test_deleting_an_unknown_project_is_refused(tmp_path: Path, confirm: bool) -> None:
    """Nothing destructive is being guarded when the target does not exist."""
    workspace, projects = _service(tmp_path)
    with pytest.raises(ProjectNotFound):
        projects.delete(uuid4(), confirm=confirm)
    workspace.close()


def test_deleting_a_project_takes_everything_below_it(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    dataset = projects.get_dataset(project.id)
    _populate(workspace, project.id, dataset.id)

    projects.delete(project.id, confirm=True)

    with workspace.unit_of_work() as uow:
        assert uow.schemas.list(project.id) == []
        assert uow.sources.list(project.id) == []
        assert uow.assets.list(project.id) == []
        assert uow.batches.list(project.id) == []
        assert uow.datasets.list(project.id) == []
        assert uow.annotations.list() == []
        assert uow.dataset_members.list(dataset.id) == []
        assert uow.dataset_changes.list(dataset.id) == []
        assert uow.releases.list(dataset.id) == []
    workspace.close()


# --- delete: what it must not touch -------------------------------------------


def test_a_blob_named_by_a_release_survives_the_project_that_owned_it(tmp_path: Path) -> None:
    """Content is shared by hash, so no project can know it is the last owner."""
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    content_hash = _populate(workspace, project.id, projects.get_dataset(project.id).id)
    assert workspace.blob_store.exists(content_hash)

    projects.delete(project.id, confirm=True)

    assert workspace.blob_store.exists(content_hash)
    assert workspace.blob_store.get(content_hash).read() == b"pixels"
    workspace.close()


def test_a_refused_delete_destroys_nothing(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    dataset = projects.get_dataset(project.id)
    content_hash = _populate(workspace, project.id, dataset.id)

    with pytest.raises(ConfirmationRequired):
        projects.delete(project.id)

    with workspace.unit_of_work() as uow:
        assert len(uow.assets.list(project.id)) == 1
        assert len(uow.releases.list(dataset.id)) == 1
    assert workspace.blob_store.exists(content_hash)
    workspace.close()


# --- persistence --------------------------------------------------------------


def test_a_project_and_its_dataset_survive_a_reopen(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs", "street furniture")
    workspace.close()

    reopened = WorkspaceService.open(tmp_path / "ws")
    reread = ProjectService(reopened)
    assert [(p.name, p.description) for p in reread.list()] == [("signs", "street furniture")]
    assert reread.get_dataset(project.id).name == "signs"
    reopened.close()


# --- stats: what the project holds, not what the trunk holds -------------------


def _labeled(
    workspace: WorkspaceService,
    project_id: UUID,
    *,
    assets: int,
    classes: dict[str, int] | None = None,
) -> list[UUID]:
    """``assets`` assets, the first of them carrying ``classes`` annotations each.

    Everything is written straight through the unit of work, `_populate`'s reason:
    reaching the same state through `IngestService` and `AnnotationService` would
    make every assertion below depend on two doors that are not under test.
    """
    made: list[UUID] = []
    with workspace.unit_of_work() as uow:
        for index in range(assets):
            content_hash = f"{index:064x}"
            asset = uow.assets.add(
                Asset(
                    project_id=project_id,
                    content_hash=content_hash,
                    uri=f"/tmp/in/{index}.png",
                )
            )
            made.append(asset.id)
        for label_class, count in (classes or {}).items():
            for _ in range(count):
                uow.annotations.add(
                    Annotation(
                        asset_id=made[0],
                        label_class=label_class,
                        schema_version=1,
                        geometry=BboxGeometry(x=0, y=0, width=4, height=4),
                        provenance="human",
                    )
                )
    return made


def _schema(workspace: WorkspaceService, project_id: UUID, *names: str) -> None:
    with workspace.unit_of_work() as uow:
        uow.schemas.add(
            AnnotationSchema(
                project_id=project_id,
                version=1,
                classes=[LabelClass(name=name, geometry=GeometryType.BBOX) for name in names],
            )
        )


def test_a_project_with_nothing_in_it_counts_zero_rather_than_refusing(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")

    stats = projects.stats(project.id)

    assert (stats.asset_count, stats.annotation_count, stats.class_count) == (0, 0, 0)
    assert stats.per_class == ()
    workspace.close()


def test_an_empty_project_is_zero_percent_annotated_rather_than_a_division_by_zero(
    tmp_path: Path,
) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")

    assert projects.stats(project.id).annotated_fraction == 0.0
    workspace.close()


def test_every_ingested_asset_is_counted_however_far_it_got(tmp_path: Path) -> None:
    """The whole reason this is not `DatasetService.stats`.

    Nothing here is promoted — there is no dataset member at all — and the count
    is still four. Read through the trunk the same project reads as empty.
    """
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    _labeled(workspace, project.id, assets=4)

    assert projects.stats(project.id).asset_count == 4
    workspace.close()


def test_only_assets_carrying_a_label_count_as_annotated(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    _labeled(workspace, project.id, assets=4, classes={"sign": 3})

    stats = projects.stats(project.id)

    # Three annotations, all on the first asset: one asset annotated out of four.
    assert (stats.annotated_asset_count, stats.annotation_count) == (1, 3)
    assert stats.annotated_fraction == 0.25
    workspace.close()


def test_a_class_is_counted_once_per_asset_and_once_per_annotation(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    _labeled(workspace, project.id, assets=2, classes={"sign": 5})

    (sign,) = projects.stats(project.id).per_class

    assert (sign.label_class, sign.annotations, sign.assets) == ("sign", 5, 1)
    workspace.close()


def test_classes_are_counted_from_the_schema_not_from_what_anybody_labeled(
    tmp_path: Path,
) -> None:
    """A declared class nobody has used is still a class the project has."""
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    _schema(workspace, project.id, "sign", "lane", "pole")
    _labeled(workspace, project.id, assets=1, classes={"sign": 2})

    stats = projects.stats(project.id)

    assert stats.class_count == 3
    assert [count.label_class for count in stats.per_class] == ["sign"]
    workspace.close()


def test_a_project_with_no_schema_reports_no_classes_rather_than_raising(tmp_path: Path) -> None:
    """Schema-less is the state every project starts in, not a failure."""
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    _labeled(workspace, project.id, assets=1, classes={"sign": 1})

    assert projects.stats(project.id).class_count == 0
    workspace.close()


def test_per_class_is_ordered_by_name_whatever_order_the_walk_found_them(
    tmp_path: Path,
) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("signs")
    _labeled(workspace, project.id, assets=1, classes={"zebra": 1, "ant": 1, "moose": 1})

    found = [count.label_class for count in projects.stats(project.id).per_class]

    assert found == ["ant", "moose", "zebra"]
    workspace.close()


def test_stats_count_one_project_and_never_its_neighbour(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    mine = projects.create("mine")
    theirs = projects.create("theirs")
    _labeled(workspace, mine.id, assets=2, classes={"sign": 1})
    _labeled(workspace, theirs.id, assets=7, classes={"lane": 4})

    assert projects.stats(mine.id).asset_count == 2
    assert projects.stats(theirs.id).asset_count == 7
    workspace.close()


def test_stats_for_an_unknown_project_is_project_not_found(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    with pytest.raises(ProjectNotFound):
        projects.stats(uuid4())
    workspace.close()


# --- stats: when data last arrived --------------------------------------------


def _arrived(workspace: WorkspaceService, project_id: UUID, *when: datetime | None) -> None:
    """One asset per argument, each carrying that arrival — ``None`` for unknown.

    Written straight through the unit of work for ``_labeled``'s reason, and for
    one more: a row with no arrival is what migration 13 leaves behind, and no
    operation can produce one.
    """
    with workspace.unit_of_work() as uow:
        for index, moment in enumerate(when):
            uow.assets.add(
                Asset(
                    project_id=project_id,
                    content_hash=f"{index:064x}",
                    uri=f"/tmp/in/{index}.png",
                    ingested_at=moment,
                )
            )


def test_last_ingest_at_is_the_newest_arrival(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("dated")
    newest = datetime(2026, 3, 2, 9, 30, tzinfo=UTC)
    _arrived(
        workspace,
        project.id,
        datetime(2026, 1, 4, 12, 0, tzinfo=UTC),
        newest,
        datetime(2026, 2, 9, 8, 15, tzinfo=UTC),
    )

    assert projects.stats(project.id).last_ingest_at == newest
    workspace.close()


def test_an_asset_with_no_arrival_does_not_hide_one_that_has_it(tmp_path: Path) -> None:
    """Mixed is the state every upgraded workspace lands in, and the answer is the known one.

    The failure this rules out is a `max` over the raw column: `None` is not
    comparable with a `datetime`, so an unfiltered walk raises rather than
    answering — and any sentinel that makes it comparable is a date nobody chose.
    """
    workspace, projects = _service(tmp_path)
    project = projects.create("mixed")
    known = datetime(2026, 5, 6, 7, 8, tzinfo=UTC)
    _arrived(workspace, project.id, None, known, None)

    assert projects.stats(project.id).last_ingest_at == known
    workspace.close()


def test_last_ingest_at_is_null_when_no_asset_records_one(tmp_path: Path) -> None:
    """Unknown, not never — and the two are deliberately not distinguished."""
    workspace, projects = _service(tmp_path)
    project = projects.create("legacy")
    _arrived(workspace, project.id, None, None)

    assert projects.stats(project.id).last_ingest_at is None
    workspace.close()


def test_last_ingest_at_is_null_for_a_project_holding_nothing(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    project = projects.create("empty")

    assert projects.stats(project.id).last_ingest_at is None
    workspace.close()


def test_last_ingest_at_belongs_to_its_own_project(tmp_path: Path) -> None:
    workspace, projects = _service(tmp_path)
    mine = projects.create("mine")
    theirs = projects.create("theirs")
    _arrived(workspace, mine.id, datetime(2026, 1, 1, tzinfo=UTC))
    _arrived(workspace, theirs.id, datetime(2026, 9, 9, tzinfo=UTC))

    assert projects.stats(mine.id).last_ingest_at == datetime(2026, 1, 1, tzinfo=UTC)
    workspace.close()
