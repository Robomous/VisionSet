"""Recipes as a project resource: named, editable, and unique per project."""

from __future__ import annotations

from pathlib import Path

import pytest
from tests.kernel.test_release_service import SIGN, Fixture

from visionset.kernel.domain import (
    AugmentOp,
    AugmentStep,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    SplitRecipe,
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
