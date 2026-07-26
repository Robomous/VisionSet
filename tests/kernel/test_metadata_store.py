from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from visionset.kernel import EntityAlreadyExists, EntityNotFound, WorkspaceFormatTooNew
from visionset.kernel.adapters import SqliteMetadataStore
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
    IngestJob,
    LabelClass,
    Manifest,
    PolygonGeometry,
    Project,
    Release,
    Source,
    TaskGroup,
    Workspace,
)
from visionset.kernel.ports import MetadataStore, UnitOfWork


def _store(tmp_path: Path, name: str = "visionset.db") -> SqliteMetadataStore:
    store = SqliteMetadataStore(tmp_path / name)
    store.initialize()
    return store


def _seed(uow: UnitOfWork) -> list[tuple[str, UUID]]:
    """Persist one of every entity, wired into a valid parent chain."""
    workspace = uow.workspaces.add(Workspace(name="w", root_dir="/tmp/w"))
    project = uow.projects.add(Project(workspace_id=workspace.id, name="p", description="d"))
    source = uow.sources.add(Source(project_id=project.id, uri="file:///images"))
    ingest = uow.ingest_jobs.add(IngestJob(source_id=source.id))
    first = uow.assets.add(
        Asset(project_id=project.id, content_hash="a" * 64, uri="file:///1.png", width=8, height=6)
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
            manifest=Manifest(schema_version=1, asset_count=1, content_hashes=["a" * 64]),
        )
    )
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


def test_satisfies_metadata_store_port(tmp_path: Path) -> None:
    assert isinstance(SqliteMetadataStore(tmp_path / "visionset.db"), MetadataStore)


def test_unit_of_work_satisfies_the_port(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        assert isinstance(uow, UnitOfWork)
    store.close()


def test_format_version_is_zero_until_initialized(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    assert store.format_version == 0
    store.initialize()
    assert store.format_version == 1
    store.close()


def test_a_reopened_workspace_reports_the_same_format_version(tmp_path: Path) -> None:
    _store(tmp_path).close()
    reopened = SqliteMetadataStore(tmp_path / "visionset.db")
    reopened.initialize()
    assert reopened.format_version == 1
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


def test_release_manifest_round_trips(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with store.unit_of_work() as uow:
        release = uow.releases.get(_seed(uow)[14][1])
        assert release is not None
        assert release.manifest == Manifest(
            schema_version=1, asset_count=1, content_hashes=["a" * 64]
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
    with pytest.raises(IntegrityError, match="FOREIGN KEY"), store.unit_of_work() as uow:
        uow.projects.add(Project(workspace_id=uuid4(), name="orphan"))
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
