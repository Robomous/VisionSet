"""The metadata store: one row of every entity, written and read back.

The seed writes a `Release` straight through the unit of work rather than through
`ReleaseService`, and that is the point of this file: what is under test is the
adapter's round trip, not publication. A real release would also need a manifest
in the blob store, which this file has no business owning — its `manifest_hash`
here names nothing, deliberately.
"""

from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import text

from visionset.kernel import (
    ConstraintViolated,
    EntityAlreadyExists,
    EntityNotFound,
    WorkspaceCorrupt,
    WorkspaceFormatTooNew,
)
from visionset.kernel.adapters import SqliteMetadataStore
from visionset.kernel.adapters.migrations import FORMAT_VERSION
from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationSchema,
    Asset,
    AssetProgress,
    Attribute,
    Batch,
    BboxGeometry,
    ClassificationGeometry,
    Dataset,
    DatasetChange,
    DatasetMember,
    GeometryType,
    IngestFailure,
    IngestFailureKind,
    IngestJob,
    IngestState,
    LabelClass,
    PolygonGeometry,
    Project,
    Release,
    Source,
    SourceKind,
    SplitRecipe,
    TaskGroup,
    Token,
    VideoMetadata,
    VideoProvenance,
    Workspace,
    hash_secret,
)
from visionset.kernel.ports import UNINITIALIZED, UnitOfWork


def _store(tmp_path: Path, name: str = "visionset.db") -> SqliteMetadataStore:
    store = SqliteMetadataStore(tmp_path / name)
    store.initialize()
    return store


def _seed(uow: UnitOfWork) -> list[tuple[str, UUID]]:
    """Persist one of every entity, wired into a valid parent chain."""
    workspace = uow.workspaces.add(Workspace(name="w", root_dir="/tmp/w"))
    project = uow.projects.add(Project(workspace_id=workspace.id, name="p", description="d"))
    # A *video* source, and an explicit timestamp, for the reason the release
    # below carries a real ``SplitRecipe`` and a fixed ``created_at``: seeding
    # the simple shape would leave the ``video`` JSON column NULL in every store
    # test, and nothing here would ever exercise the nested round trip.
    source = uow.sources.add(
        Source(
            project_id=project.id,
            kind=SourceKind.VIDEO,
            path="/data/clip.mp4",
            registered_at=datetime(2026, 7, 27, 8, 0, tzinfo=UTC),
            capture_params={"lens": "24mm"},
            video=VideoProvenance(
                metadata=VideoMetadata(
                    width=64, height=48, fps=29.97, duration_seconds=2.0, codec="h264"
                ),
                extraction_fps=5.0,
            ),
        )
    )
    # Counters set and a *populated* report, for the same reason the source
    # above is a video one: leaving `failures` at its default would leave the
    # JSON column empty in every store test and the nested round trip untested.
    ingest = uow.ingest_jobs.add(
        IngestJob(
            source_id=source.id,
            state=IngestState.COMPLETED,
            batch_name="monday",
            processed=3,
            total=4,
            failures=(
                IngestFailure(
                    name="/data/notes.txt",
                    kind=IngestFailureKind.UNSUPPORTED,
                    reason="not an image",
                ),
            ),
        )
    )
    # `thumbnail_hash` on one and not the other: the flat mapper has to carry a
    # cached preview and an absent one through the same round trip.
    first = uow.assets.add(
        Asset(
            project_id=project.id,
            content_hash="a" * 64,
            uri="file:///1.png",
            width=8,
            height=6,
            thumbnail_hash="c" * 64,
        )
    )
    second = uow.assets.add(
        Asset(project_id=project.id, content_hash="b" * 64, uri="file:///2.png")
    )
    schema = uow.schemas.add(
        AnnotationSchema(
            project_id=project.id,
            version=1,
            classes=[
                LabelClass(
                    name="car",
                    geometry=GeometryType.BBOX,
                    color="#ff0000",
                    attributes=[Attribute(name="occluded", kind="boolean", required=True)],
                )
            ],
        )
    )
    batch = uow.batches.add(Batch(project_id=project.id, name="b", asset_ids=[second.id, first.id]))
    group = uow.task_groups.add(TaskGroup(batch_id=batch.id, name="tg"))
    job = uow.annotation_jobs.add(
        AnnotationJob(
            task_group_id=group.id,
            progress={first.id: AssetProgress.ANNOTATED, second.id: AssetProgress.SKIPPED},
        )
    )
    annotation = uow.annotations.add(
        Annotation(
            asset_id=first.id,
            label_class="car",
            schema_version=1,
            geometry=BboxGeometry(x=1.0, y=2.0, width=10.0, height=20.0),
            provenance="model",
            model_ref="yolo:v8",
            confidence=0.5,
        )
    )
    dataset = uow.datasets.add(Dataset(project_id=project.id, name="ds"))
    member = uow.dataset_members.add(DatasetMember(dataset_id=dataset.id, asset_id=first.id))
    change = uow.dataset_changes.add(
        DatasetChange(dataset_id=dataset.id, operation="promote", subject_ids=[first.id])
    )
    release = uow.releases.add(
        Release(
            dataset_id=dataset.id,
            tag="v1",
            manifest_hash="a" * 64,
            schema_version=1,
            asset_count=1,
            annotation_count=1,
            split=SplitRecipe(train=0.8, val=0.1, test=0.1, seed=7),
            created_at=datetime(2026, 7, 27, 9, 0, tzinfo=UTC),
            visionset_version="0.0.1.dev0",
        )
    )
    # Revoked, and with an explicit ``created_at``, for the reason the source
    # above is a video one: leaving ``revoked_at`` at its default would leave
    # that column NULL in every store test and the nullable timestamp untested.
    token = uow.tokens.add(
        Token(
            workspace_id=workspace.id,
            name="ci",
            secret_hash=hash_secret("vst_seed"),
            created_at=datetime(2026, 7, 27, 8, 30, tzinfo=UTC),
            revoked_at=datetime(2026, 7, 27, 9, 30, tzinfo=UTC),
        )
    )
    # Appended LAST, and it has to be: the tests below index into this list by
    # position, so inserting anywhere else renames every entity after it.
    return [
        ("workspaces", workspace.id),
        ("projects", project.id),
        ("sources", source.id),
        ("ingest_jobs", ingest.id),
        ("assets", first.id),
        ("assets", second.id),
        ("schemas", schema.id),
        ("batches", batch.id),
        ("task_groups", group.id),
        ("annotation_jobs", job.id),
        ("annotations", annotation.id),
        ("datasets", dataset.id),
        ("dataset_members", member.id),
        ("dataset_changes", change.id),
        ("releases", release.id),
        ("tokens", token.id),
    ]


def test_initialize_creates_database_file(tmp_path: Path) -> None:
    db_path = tmp_path / "meta" / "visionset.db"
    store = SqliteMetadataStore(db_path)
    store.initialize()
    with store.engine.connect() as conn:
        assert conn.execute(text("select 1")).scalar() == 1
    store.close()
    assert db_path.is_file()


def test_initialize_is_idempotent(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    store.initialize()
    store.close()


def test_format_version_is_zero_until_initialized(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    assert store.format_version == UNINITIALIZED
    store.initialize()
    assert store.format_version == FORMAT_VERSION
    store.close()


def test_a_reopened_workspace_reports_the_same_format_version(tmp_path: Path) -> None:
    _store(tmp_path).close()
    reopened = SqliteMetadataStore(tmp_path / "visionset.db")
    reopened.initialize()
    assert reopened.format_version == FORMAT_VERSION
    reopened.close()


def test_a_workspace_from_the_future_is_refused(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.engine.begin() as conn:
        conn.execute(text("update _visionset_meta set format_version = 99"))
    store.close()

    reopened = SqliteMetadataStore(tmp_path / "visionset.db")
    with pytest.raises(WorkspaceFormatTooNew, match="99"):
        reopened.initialize()
    reopened.close()


def test_every_entity_round_trips_through_a_reopened_store(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        seeded = _seed(uow)
        written = {key: getattr(uow, name).get(key) for name, key in seeded}
    store.close()

    reopened = SqliteMetadataStore(tmp_path / "visionset.db")
    reopened.initialize()
    with reopened.unit_of_work() as uow:
        for name, key in seeded:
            assert getattr(uow, name).get(key) == written[key]
    reopened.close()


def test_annotation_round_trips_every_geometry_variant(tmp_path: Path) -> None:
    store = _store(tmp_path)
    geometries = [
        BboxGeometry(x=1.0, y=2.0, width=10.0, height=20.0),
        PolygonGeometry(points=[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]),
        ClassificationGeometry(),
    ]
    with store.unit_of_work() as uow:
        asset_id = _seed(uow)[4][1]
        for geometry in geometries:
            written = uow.annotations.add(
                Annotation(
                    asset_id=asset_id,
                    label_class="car",
                    schema_version=1,
                    geometry=geometry,
                    provenance="human",
                )
            )
            read = uow.annotations.get(written.id)
            assert read is not None
            assert read == written
            assert type(read.geometry) is type(geometry)
            assert isinstance(read.geometry.type, GeometryType)
    store.close()


def test_batch_membership_keeps_the_order_it_was_written_in(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        seeded = _seed(uow)
        first, second, batch_id = seeded[4][1], seeded[5][1], seeded[7][1]
        stored = uow.batches.get(batch_id)
        assert stored is not None
        assert stored.asset_ids == [second, first]

        stored.asset_ids = [first, second]
        uow.batches.update(stored)
        reread = uow.batches.get(batch_id)
        assert reread is not None
        assert reread.asset_ids == [first, second]
    store.close()


def test_annotation_job_progress_round_trips_keyed_by_asset(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        seeded = _seed(uow)
        first, second = seeded[4][1], seeded[5][1]
        job = uow.annotation_jobs.get(seeded[9][1])
        assert job is not None
        assert job.progress == {first: AssetProgress.ANNOTATED, second: AssetProgress.SKIPPED}
        assert all(isinstance(key, UUID) for key in job.progress)
    store.close()


def test_schema_classes_and_attributes_round_trip(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        schema = uow.schemas.get(_seed(uow)[6][1])
        assert schema is not None
        label_class = schema.classes[0]
        assert label_class.geometry is GeometryType.BBOX
        assert label_class.attributes[0] == Attribute(
            name="occluded", kind="boolean", required=True
        )
    store.close()


def test_a_source_video_provenance_and_timestamp_round_trip(tmp_path: Path) -> None:
    """The nested probe result survives the JSON column, offset and all."""
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        source = uow.sources.get(_seed(uow)[2][1])
        assert source is not None
        assert source.kind is SourceKind.VIDEO
        assert source.path == "/data/clip.mp4"
        assert source.capture_params == {"lens": "24mm"}
        assert source.require_video() == VideoProvenance(
            metadata=VideoMetadata(
                width=64, height=48, fps=29.97, duration_seconds=2.0, codec="h264"
            ),
            extraction_fps=5.0,
        )
        assert source.registered_at == datetime(2026, 7, 27, 8, 0, tzinfo=UTC)
        assert source.registered_at.tzinfo is not None
    store.close()


def test_a_source_without_video_provenance_round_trips_as_none(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        project_id = _seed(uow)[1][1]
        stored = uow.sources.add(
            Source(
                project_id=project_id,
                kind=SourceKind.IMAGE_DIRECTORY,
                path="/data/stills",
            )
        )
        read_back = uow.sources.get(stored.id)
        assert read_back is not None
        assert read_back.video is None
        assert read_back.capture_params == {}
    store.close()


def test_a_release_points_at_its_manifest_rather_than_carrying_it(tmp_path: Path) -> None:
    """The document is in the blob store; the row keeps its hash and a read cache."""
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        release = uow.releases.get(_seed(uow)[14][1])
        assert release is not None
        assert release.manifest_hash == "a" * 64
        assert (release.schema_version, release.asset_count, release.annotation_count) == (1, 1, 1)
        assert release.visionset_version == "0.0.1.dev0"
    store.close()


def test_a_release_split_recipe_and_timestamp_round_trip(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        release = uow.releases.get(_seed(uow)[14][1])
        assert release is not None
        assert release.split == SplitRecipe(train=0.8, val=0.1, test=0.1, seed=7)
        assert release.created_at == datetime(2026, 7, 27, 9, 0, tzinfo=UTC)
        assert release.created_at.tzinfo is not None
    store.close()


def test_a_release_published_without_a_split_recipe_round_trips_as_none(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        dataset_id = _seed(uow)[11][1]
        stored = uow.releases.add(
            Release(
                dataset_id=dataset_id,
                tag="v2",
                manifest_hash="b" * 64,
                schema_version=1,
                asset_count=0,
                annotation_count=0,
            )
        )
        assert uow.releases.get(stored.id) is not None
        assert uow.releases.get(stored.id).split is None  # type: ignore[union-attr]
    store.close()


def test_two_releases_of_one_dataset_cannot_share_a_tag(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with (
        pytest.raises(ConstraintViolated, match="release.dataset_id, release.tag"),
        store.unit_of_work() as uow,
    ):
        dataset_id = _seed(uow)[11][1]
        uow.releases.add(
            Release(
                dataset_id=dataset_id,
                tag="v1",
                manifest_hash="c" * 64,
                schema_version=1,
                asset_count=0,
                annotation_count=0,
            )
        )
    store.close()


def test_dataset_change_timestamp_stays_utc_aware(tmp_path: Path) -> None:
    store = _store(tmp_path)
    written_at = datetime(2026, 7, 26, 12, 30, tzinfo=UTC)
    with store.unit_of_work() as uow:
        change = uow.dataset_changes.add(
            DatasetChange(
                dataset_id=_seed(uow)[11][1],
                operation="remove_asset",
                actor="anaya",
                occurred_at=written_at,
            )
        )
    store.close()

    reopened = SqliteMetadataStore(tmp_path / "visionset.db")
    reopened.initialize()
    with reopened.unit_of_work() as uow:
        stored = uow.dataset_changes.get(change.id)
        assert stored is not None
        assert stored.occurred_at == written_at
        assert stored.occurred_at.tzinfo is not None
    reopened.close()


def test_a_naive_timestamp_is_rejected() -> None:
    with pytest.raises(ValidationError, match="timezone-aware"):
        DatasetChange(dataset_id=uuid4(), operation="promote", occurred_at=datetime(2026, 7, 26))


def test_unit_of_work_rolls_back_on_error(tmp_path: Path) -> None:
    store = _store(tmp_path)
    workspace = Workspace(name="doomed")
    with pytest.raises(RuntimeError, match="boom"), store.unit_of_work() as uow:
        uow.workspaces.add(workspace)
        raise RuntimeError("boom")

    with store.unit_of_work() as uow:
        assert uow.workspaces.get(workspace.id) is None
    store.close()


def test_unit_of_work_commits_on_clean_exit(tmp_path: Path) -> None:
    store = _store(tmp_path)
    workspace = Workspace(name="kept")
    with store.unit_of_work() as uow:
        uow.workspaces.add(workspace)
    store.close()

    reopened = SqliteMetadataStore(tmp_path / "visionset.db")
    reopened.initialize()
    with reopened.unit_of_work() as uow:
        assert uow.workspaces.get(workspace.id) == workspace
    reopened.close()


def test_add_rejects_a_duplicate_id(tmp_path: Path) -> None:
    store = _store(tmp_path)
    workspace = Workspace(name="w")
    with store.unit_of_work() as uow:
        uow.workspaces.add(workspace)
        with pytest.raises(EntityAlreadyExists, match=str(workspace.id)):
            uow.workspaces.add(workspace)
    store.close()


def test_update_requires_an_existing_entity(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow, pytest.raises(EntityNotFound, match="workspace"):
        uow.workspaces.update(Workspace(name="ghost"))
    store.close()


def test_update_replaces_the_stored_fields(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        workspace = uow.workspaces.add(Workspace(name="before"))
        workspace.name = "after"
        uow.workspaces.update(workspace)
        stored = uow.workspaces.get(workspace.id)
        assert stored is not None
        assert stored.name == "after"
    store.close()


def test_delete_reports_whether_anything_was_removed(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        workspace = uow.workspaces.add(Workspace(name="w"))
        assert uow.workspaces.delete(workspace.id) is True
        assert uow.workspaces.get(workspace.id) is None
        assert uow.workspaces.delete(workspace.id) is False
        assert uow.workspaces.delete(uuid4()) is False
    store.close()


def test_list_is_scoped_to_the_parent(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        workspace = uow.workspaces.add(Workspace(name="w"))
        other = uow.workspaces.add(Workspace(name="other"))
        mine = uow.projects.add(Project(workspace_id=workspace.id, name="mine"))
        uow.projects.add(Project(workspace_id=other.id, name="theirs"))

        assert [project.id for project in uow.projects.list(workspace.id)] == [mine.id]
        assert len(uow.projects.list()) == 2
    store.close()


def test_list_rejects_a_parent_id_for_a_root_entity(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        uow.workspaces.list()
        with pytest.raises(ValueError, match="root entity"):
            uow.workspaces.list(uuid4())
    store.close()


def test_foreign_keys_are_enforced(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with pytest.raises(ConstraintViolated, match="FOREIGN KEY"), store.unit_of_work() as uow:
        uow.projects.add(Project(workspace_id=uuid4(), name="orphan"))
    store.close()


def test_a_constraint_violation_is_not_a_sqlalchemy_exception(tmp_path: Path) -> None:
    """The kernel translates its adapter's exceptions; SQLAlchemy stays inside."""
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        workspace_id = uow.workspaces.add(Workspace(name="w")).id
    try:
        with store.unit_of_work() as uow:
            uow.projects.add(Project(workspace_id=workspace_id, name="signs"))
            uow.projects.add(Project(workspace_id=workspace_id, name="Signs"))
    except ConstraintViolated as exc:
        assert "sqlalchemy" not in type(exc).__module__
        assert "UNIQUE" in str(exc)
    else:
        pytest.fail("a duplicate project name should have been refused")
    store.close()


def test_duplicate_project_names_in_one_workspace_are_refused(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        workspace_id = uow.workspaces.add(Workspace(name="w")).id
    with pytest.raises(ConstraintViolated, match="UNIQUE"), store.unit_of_work() as uow:
        uow.projects.add(Project(workspace_id=workspace_id, name="road signs"))
        uow.projects.add(Project(workspace_id=workspace_id, name="Road Signs"))
    store.close()


def test_the_same_project_name_is_allowed_in_another_workspace(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        first = uow.workspaces.add(Workspace(name="one")).id
        second = uow.workspaces.add(Workspace(name="two")).id
        uow.projects.add(Project(workspace_id=first, name="signs"))
        uow.projects.add(Project(workspace_id=second, name="signs"))
        assert len(uow.projects.list(first)) == 1
        assert len(uow.projects.list(second)) == 1
    store.close()


def test_a_file_that_is_not_a_database_is_reported_as_corrupt(tmp_path: Path) -> None:
    db_path = tmp_path / "visionset.db"
    db_path.write_bytes(b"this is not a SQLite file, it is a poem about one")

    store = SqliteMetadataStore(db_path)
    with pytest.raises(WorkspaceCorrupt, match="not a readable"):
        _ = store.format_version
    with pytest.raises(WorkspaceCorrupt, match="not a readable"):
        store.initialize()
    store.close()


def test_a_database_that_cannot_be_opened_is_corrupt_rather_than_busy(tmp_path: Path) -> None:
    """The other half of the `OperationalError` split.

    SQLite answers a directory where a database was wanted with `SQLITE_CANTOPEN`
    — an `OperationalError`, same class as the lock, told apart only by its
    result code. It is not contention and retrying will not help, so it belongs
    with the damage rather than with `WorkspaceBusy`.
    """
    db_path = tmp_path / "visionset.db"
    db_path.mkdir()

    store = SqliteMetadataStore(db_path)
    with pytest.raises(WorkspaceCorrupt) as caught:
        _ = store.format_version
    assert "sqlalchemy" not in type(caught.value).__module__
    assert "unable to open database file" in str(caught.value)
    store.close()


def test_deleting_a_parent_cascades_to_its_children(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        project_id = _seed(uow)[1][1]
        uow.projects.delete(project_id)
        assert uow.assets.list(project_id) == []
        assert uow.batches.list(project_id) == []
        assert uow.datasets.list(project_id) == []
    store.close()
