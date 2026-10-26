"""Recipes as a project resource: named, editable, and unique per project."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from tests.fixtures.media import write_image
from tests.fixtures.samples import SOURCE
from tests.kernel.test_release_service import SIGN, Fixture

from visionset.kernel.domain import (
    EXPORT_JOB_TYPE,
    Asset,
    AugmentOp,
    AugmentStep,
    BackgroundJob,
    BackgroundJobOutcome,
    BackgroundJobSpec,
    BackgroundJobState,
    RecipeSpec,
    RecipeUsage,
    Release,
    ResizeStep,
    ResizeStrategy,
    SplitRecipe,
    export_job_payload,
    recipe_usage,
)
from visionset.kernel.errors import (
    InvalidName,
    PreprocessingRecipeNameTaken,
    PreprocessingRecipeNotFound,
    ProjectNotFound,
    ReleaseNotFound,
)
from visionset.kernel.services import (
    PreprocessingRecipeService,
    ProjectService,
    ReleaseService,
    WorkspaceService,
)
from visionset.preprocessing.registry import drivers

LETTERBOX = RecipeSpec(
    target="yolo11",
    steps=(ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=640, height=640),),
)
AUGMENTED = RecipeSpec(
    target=None,
    steps=(AugmentStep(op=AugmentOp.HFLIP),),
    variants_per_asset=2,
)


@pytest.fixture
def workspace(tmp_path: Path) -> WorkspaceService:
    service = WorkspaceService.init(tmp_path / "ws")
    yield service
    service.close()


def test_a_recipe_is_stored_under_its_name_and_read_back_whole(
    workspace: WorkspaceService,
) -> None:
    project = ProjectService(workspace).create("p")
    recipes = PreprocessingRecipeService(workspace)

    created = recipes.create(project.id, "letterbox-640", LETTERBOX)

    assert created.name == "letterbox-640"
    assert created.spec == LETTERBOX
    assert created.created_at == created.updated_at
    assert recipes.get(project.id, "letterbox-640") == created
    assert recipes.list(project.id) == [created]


def test_a_name_is_normalized_and_must_be_a_slug(workspace: WorkspaceService) -> None:
    project = ProjectService(workspace).create("p")
    recipes = PreprocessingRecipeService(workspace)

    assert recipes.create(project.id, "  flips.v2 ", AUGMENTED).name == "flips.v2"
    for bad in ("", "Letterbox", "has space", "-leading", "x" * 65):
        with pytest.raises(InvalidName):
            recipes.create(project.id, bad, LETTERBOX)


def test_a_name_is_unique_per_project_and_free_across_projects(
    workspace: WorkspaceService,
) -> None:
    projects = ProjectService(workspace)
    first, second = projects.create("one"), projects.create("two")
    recipes = PreprocessingRecipeService(workspace)
    recipes.create(first.id, "same", LETTERBOX)

    with pytest.raises(PreprocessingRecipeNameTaken):
        recipes.create(first.id, "same", AUGMENTED)
    assert recipes.create(second.id, "same", AUGMENTED).spec == AUGMENTED


def test_update_replaces_the_spec_and_moves_updated_at(workspace: WorkspaceService) -> None:
    project = ProjectService(workspace).create("p")
    recipes = PreprocessingRecipeService(workspace)
    created = recipes.create(project.id, "r", LETTERBOX)

    updated = recipes.update(project.id, "r", spec=AUGMENTED)

    assert updated.id == created.id
    assert updated.spec == AUGMENTED
    assert updated.created_at == created.created_at
    assert updated.updated_at >= created.updated_at
    assert recipes.get(project.id, "r") == updated


def test_update_can_rename_and_a_rename_onto_a_taken_name_is_refused(
    workspace: WorkspaceService,
) -> None:
    project = ProjectService(workspace).create("p")
    recipes = PreprocessingRecipeService(workspace)
    recipes.create(project.id, "a", LETTERBOX)
    recipes.create(project.id, "b", AUGMENTED)

    renamed = recipes.update(project.id, "a", spec=LETTERBOX, new_name="c")
    assert renamed.name == "c"
    with pytest.raises(PreprocessingRecipeNotFound):
        recipes.get(project.id, "a")
    with pytest.raises(PreprocessingRecipeNameTaken):
        recipes.update(project.id, "c", spec=LETTERBOX, new_name="b")
    # Renaming onto its own name is not a collision.
    assert recipes.update(project.id, "c", spec=LETTERBOX, new_name="c").name == "c"


def test_delete_answers_what_went_and_a_second_delete_is_refused(
    workspace: WorkspaceService,
) -> None:
    project = ProjectService(workspace).create("p")
    recipes = PreprocessingRecipeService(workspace)
    created = recipes.create(project.id, "r", LETTERBOX)

    assert recipes.delete(project.id, "r") == created
    assert recipes.list(project.id) == []
    with pytest.raises(PreprocessingRecipeNotFound):
        recipes.delete(project.id, "r")


def test_an_unknown_project_is_refused_on_every_operation(workspace: WorkspaceService) -> None:
    from uuid import uuid4

    recipes = PreprocessingRecipeService(workspace)
    missing = uuid4()
    with pytest.raises(ProjectNotFound):
        recipes.create(missing, "r", LETTERBOX)
    with pytest.raises(ProjectNotFound):
        recipes.list(missing)
    with pytest.raises(ProjectNotFound):
        recipes.get(missing, "r")
    with pytest.raises(ProjectNotFound):
        recipes.delete(missing, "r")


def test_deleting_the_project_takes_its_recipes_with_it(workspace: WorkspaceService) -> None:
    projects = ProjectService(workspace)
    project = projects.create("p")
    PreprocessingRecipeService(workspace).create(project.id, "r", LETTERBOX)

    projects.delete(project.id, confirm=True)

    with workspace.unit_of_work() as uow:
        assert uow.preprocessing_recipes.list(project.id) == []


def test_a_recipe_is_resolved_for_a_release_through_its_project(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(fixture.project.id, [SIGN])
    fixture.promote()
    release = fixture.releases.publish(
        fixture.dataset_id, "v1", split=SplitRecipe(train=0.6, val=0.2, test=0.2, seed=1)
    )
    recipes = PreprocessingRecipeService(fixture.workspace)
    created = recipes.create(fixture.project.id, "r", LETTERBOX)

    assert recipes.for_release(release.id, "r") == created
    with pytest.raises(PreprocessingRecipeNotFound):
        recipes.for_release(release.id, "other")
    from uuid import uuid4

    with pytest.raises(ReleaseNotFound):
        recipes.for_release(uuid4(), "r")
    fixture.close()


def test_migration_seventeen_adds_the_table_to_an_older_file(tmp_path: Path) -> None:
    """A file stamped 16 without the table gains it on open, and the stamp moves."""
    from sqlalchemy import inspect, text

    from visionset.kernel.adapters._tables import META_TABLE
    from visionset.kernel.adapters.migrations import FORMAT_VERSION
    from visionset.kernel.adapters.sqlite_metadata_store import SqliteMetadataStore

    path = tmp_path / "old.db"
    store = SqliteMetadataStore(path)
    store.initialize()
    with store.engine.begin() as connection:
        connection.execute(text("DROP TABLE preprocessing_recipes"))
        connection.execute(text(f"UPDATE {META_TABLE} SET format_version = 16"))
    store.close()

    reopened = SqliteMetadataStore(path)
    reopened.initialize()
    with reopened.engine.connect() as connection:
        assert "preprocessing_recipes" in inspect(connection).get_table_names()
    assert reopened.format_version == FORMAT_VERSION
    reopened.close()


def test_release_service_is_untouched_by_recipes(tmp_path: Path) -> None:
    """A recipe changes nothing about publication: the manifest is the same bytes."""
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    before = ReleaseService(fixture.workspace).publish(dataset_id, "v1").manifest_hash
    PreprocessingRecipeService(fixture.workspace).create(fixture.project.id, "r", AUGMENTED)
    after = ReleaseService(fixture.workspace).publish(dataset_id, "v2").manifest_hash
    assert before == after
    fixture.close()


# --- the preview's provenance -------------------------------------------------------


def _stored_asset(
    workspace: WorkspaceService, project_id: UUID, tmp_path: Path, **fields: Any
) -> UUID:
    image = write_image(tmp_path / f"{uuid4()}.png", size=(96, 48))
    content_hash = workspace.blob_store.put(BytesIO(image.read_bytes()))
    with workspace.unit_of_work() as uow:
        return uow.assets.add(
            Asset(
                project_id=project_id,
                content_hash=content_hash,
                uri=str(image),
                width=96,
                height=48,
                **fields,
            )
        ).id


def test_the_preview_names_its_frame_its_source_and_its_recorded_size(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("p")
    source = SOURCE.model_copy(
        update={"id": uuid4(), "project_id": project.id, "display_name": "Highway — August"}
    )
    with workspace.unit_of_work() as uow:
        uow.sources.add(source)
    asset_id = _stored_asset(
        workspace,
        project.id,
        tmp_path,
        source_id=source.id,
        frame_index=1188,
        frame_timestamp=118.8,
    )

    preview = PreprocessingRecipeService(workspace).preview(
        project.id, LETTERBOX, asset_id, variant=0, drivers=drivers()
    )

    assert (preview.width, preview.height) == (512, 512)
    assert (preview.original_width, preview.original_height) == (96, 48)
    assert (preview.frame_index, preview.source_name) == (1188, "Highway — August")


def test_a_still_with_no_recorded_source_previews_with_null_provenance(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("p")
    asset_id = _stored_asset(workspace, project.id, tmp_path)

    preview = PreprocessingRecipeService(workspace).preview(
        project.id, LETTERBOX, asset_id, variant=0, drivers=drivers()
    )

    assert (preview.original_width, preview.original_height) == (96, 48)
    assert (preview.frame_index, preview.source_name) == (None, None)


# --- usage ------------------------------------------------------------------------


def _ran(
    workspace: WorkspaceService,
    release_id: UUID,
    recipe: str | None,
    *,
    state: BackgroundJobState = BackgroundJobState.SUCCEEDED,
    target: str | None = None,
) -> None:
    spec = None if recipe is None else (recipe, LETTERBOX)
    queue = workspace.job_queue
    queue.enqueue(
        BackgroundJobSpec(
            type=EXPORT_JOB_TYPE,
            payload=export_job_payload(
                release_id, "yolov8", target=target, allow_lossy=False, recipe=spec
            ),
        )
    )
    claimed = queue.claim("test")
    assert claimed is not None
    queue.finish(
        claimed.id,
        BackgroundJobOutcome(
            state=state, error=None if state is BackgroundJobState.SUCCEEDED else "boom"
        ),
    )


def test_usage_counts_the_projects_succeeded_exports_by_recipe_name(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    first = fixture.releases.publish(dataset_id, "v1")
    second = fixture.releases.publish(dataset_id, "v2")
    recipes = PreprocessingRecipeService(fixture.workspace)
    assert recipes.usage(fixture.project.id) == {}

    _ran(fixture.workspace, first.id, "lb")
    _ran(fixture.workspace, second.id, "lb", target="ultralytics-yolo11")
    _ran(fixture.workspace, second.id, "lb", state=BackgroundJobState.FAILED)
    _ran(fixture.workspace, second.id, None)
    _ran(fixture.workspace, uuid4(), "lb")

    usage = recipes.usage(fixture.project.id)

    assert usage == {
        "lb": RecipeUsage(
            export_count=2,
            release_id=second.id,
            release_tag="v2",
            target="ultralytics-yolo11",
            format="yolov8",
        )
    }
    with pytest.raises(ProjectNotFound):
        recipes.usage(uuid4())
    fixture.close()


def test_recipe_usage_reads_only_succeeded_exports_newest_first() -> None:
    release = Release(
        dataset_id=uuid4(),
        tag="v1",
        manifest_hash="0" * 64,
        schema_version=1,
        asset_count=0,
        annotation_count=0,
    )

    def job(
        state: BackgroundJobState, *, kind: str = EXPORT_JOB_TYPE, fmt: str = "coco"
    ) -> BackgroundJob:
        payload = export_job_payload(
            release.id, fmt, target=None, allow_lossy=False, recipe=("lb", LETTERBOX)
        )
        return BackgroundJob(type=kind, payload=payload, state=state)

    usage = recipe_usage(
        [
            job(BackgroundJobState.FAILED, fmt="newest-but-failed"),
            job(BackgroundJobState.SUCCEEDED, kind="annotation.pre_label", fmt="not-an-export"),
            BackgroundJob(
                type=EXPORT_JOB_TYPE,
                state=BackgroundJobState.SUCCEEDED,
                payload={"release_id": "not-a-uuid", "format": "x", "recipe": {"name": "lb"}},
            ),
            job(BackgroundJobState.SUCCEEDED, fmt="yolov8"),
            job(BackgroundJobState.SUCCEEDED),
        ],
        {release.id: release},
    )

    assert usage == {
        "lb": RecipeUsage(
            export_count=2, release_id=release.id, release_tag="v1", target=None, format="yolov8"
        )
    }
