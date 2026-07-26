import shutil
from collections.abc import Callable
from pathlib import Path

import pytest
from sqlalchemy import text

from visionset.kernel import (
    ConstraintViolated,
    InvalidName,
    NotAWorkspace,
    ProjectNameTaken,
    VisionSetError,
    WorkspaceAlreadyExists,
    WorkspaceCorrupt,
    WorkspaceFormatTooNew,
    WorkspaceNotEmpty,
)
from visionset.kernel.adapters import SqliteMetadataStore
from visionset.kernel.adapters.migrations import FORMAT_VERSION
from visionset.kernel.domain import Project, Workspace
from visionset.kernel.ports import BlobStore, MetadataStore, UnitOfWork
from visionset.kernel.services import BLOBS_DIRNAME, DB_FILENAME, WorkspaceService


def _init(tmp_path: Path, name: str = "ws") -> WorkspaceService:
    return WorkspaceService.init(tmp_path / name)


def _explode(db_path: Path) -> MetadataStore:
    """A metadata-store factory that fails, to exercise ``init``'s cleanup."""
    raise RuntimeError("boom")


class _ClosingSpy(SqliteMetadataStore):
    """A real store that counts how often it was closed."""

    def __init__(self, db_path: Path) -> None:
        super().__init__(db_path)
        self.close_count = 0

    def close(self) -> None:
        self.close_count += 1
        super().close()


def _sql(root: Path, statement: str) -> None:
    store = SqliteMetadataStore(root / DB_FILENAME)
    with store.engine.begin() as connection:
        connection.execute(text(statement))
    store.close()


# --- init: layout and contents ------------------------------------------------


def test_init_creates_the_database_and_the_blob_directory(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    assert (workspace.root / DB_FILENAME).is_file()
    assert (workspace.root / BLOBS_DIRNAME).is_dir()
    workspace.close()


def test_init_creates_missing_parent_directories(tmp_path: Path) -> None:
    workspace = WorkspaceService.init(tmp_path / "a" / "b" / "ws")
    assert (workspace.root / DB_FILENAME).is_file()
    workspace.close()


def test_init_stamps_the_current_format_version(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    assert workspace.format_version == FORMAT_VERSION
    workspace.close()


def test_init_stores_exactly_one_workspace_row(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    with workspace.unit_of_work() as uow:
        assert [row.id for row in uow.workspaces.list()] == [workspace.workspace_id]
    workspace.close()


def test_init_names_the_workspace_after_its_directory_by_default(tmp_path: Path) -> None:
    workspace = _init(tmp_path, "road-signs")
    assert workspace.workspace.name == "road-signs"
    workspace.close()


def test_init_accepts_an_explicit_workspace_name(tmp_path: Path) -> None:
    workspace = WorkspaceService.init(tmp_path / "ws", name="Road Signs")
    assert workspace.workspace.name == "Road Signs"
    workspace.close()


def test_init_records_an_absolute_root_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    workspace = WorkspaceService.init(Path("relative-ws"))
    assert workspace.root.is_absolute()
    assert workspace.workspace.root_dir == str(workspace.root)
    workspace.close()


def test_init_into_an_existing_empty_directory_succeeds(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    root.mkdir()
    workspace = WorkspaceService.init(root)
    assert workspace.format_version == FORMAT_VERSION
    workspace.close()


def test_init_works_in_a_directory_whose_name_contains_url_punctuation(tmp_path: Path) -> None:
    """A ``#`` or ``?`` in the path used to send the database to a sibling file."""
    root = tmp_path / "we#ird?ws"
    workspace = WorkspaceService.init(root)
    assert (root / DB_FILENAME).is_file()
    assert workspace.format_version == FORMAT_VERSION
    assert sorted(p.name for p in tmp_path.iterdir()) == ["we#ird?ws"]
    workspace.close()


# --- init: refusals and safety ------------------------------------------------


def test_init_on_a_directory_that_is_already_a_workspace_is_refused(tmp_path: Path) -> None:
    _init(tmp_path).close()
    with pytest.raises(WorkspaceAlreadyExists, match="open it instead"):
        _init(tmp_path)


def test_init_on_a_non_empty_directory_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    root.mkdir()
    (root / "notes.txt").write_text("mine")
    with pytest.raises(WorkspaceNotEmpty, match="notes.txt"):
        WorkspaceService.init(root)


def test_init_on_a_non_empty_directory_leaves_it_exactly_as_it_was(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    root.mkdir()
    (root / "notes.txt").write_text("mine")
    with pytest.raises(WorkspaceNotEmpty):
        WorkspaceService.init(root)
    assert sorted(entry.name for entry in root.iterdir()) == ["notes.txt"]
    assert (root / "notes.txt").read_text() == "mine"


def test_init_on_a_path_that_is_a_file_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "not-a-dir"
    path.write_text("")
    with pytest.raises(WorkspaceNotEmpty, match="not a directory"):
        WorkspaceService.init(path)


def test_a_failed_init_removes_the_directory_it_created(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    with pytest.raises(RuntimeError, match="boom"):
        WorkspaceService.init(root, metadata_store_factory=_explode)
    assert not root.exists()


def test_a_failed_init_leaves_a_pre_existing_directory_empty(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    root.mkdir()
    with pytest.raises(RuntimeError, match="boom"):
        WorkspaceService.init(root, metadata_store_factory=_explode)
    assert root.is_dir()
    assert list(root.iterdir()) == []


# --- open: happy paths --------------------------------------------------------


def test_open_reads_back_the_workspace_that_init_created(tmp_path: Path) -> None:
    created = _init(tmp_path, "road-signs")
    created.close()

    reopened = WorkspaceService.open(tmp_path / "road-signs")
    assert reopened.workspace_id == created.workspace_id
    assert reopened.workspace.name == "road-signs"
    reopened.close()


def test_a_reopened_workspace_still_holds_the_projects_written_before_it_closed(
    tmp_path: Path,
) -> None:
    created = _init(tmp_path)
    created.create_project("signs", description="street furniture")
    created.close()

    reopened = WorkspaceService.open(tmp_path / "ws")
    projects = reopened.list_projects()
    assert [(p.name, p.description) for p in projects] == [("signs", "street furniture")]
    reopened.close()


def test_open_resolves_a_relative_path_to_an_absolute_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init(tmp_path).close()
    monkeypatch.chdir(tmp_path)
    workspace = WorkspaceService.open(Path("ws"))
    assert workspace.root.is_absolute()
    workspace.close()


def test_open_expands_a_home_relative_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    _init(tmp_path).close()
    workspace = WorkspaceService.open("~/ws")
    assert workspace.root == (tmp_path / "ws").resolve()
    workspace.close()


def test_open_recreates_a_blob_directory_lost_in_a_copy(tmp_path: Path) -> None:
    """Zip archives and git both drop empty directories; that is not corruption."""
    _init(tmp_path).close()
    shutil.rmtree(tmp_path / "ws" / BLOBS_DIRNAME)

    workspace = WorkspaceService.open(tmp_path / "ws")
    assert (workspace.root / BLOBS_DIRNAME).is_dir()
    workspace.close()


def test_open_uses_the_path_it_was_opened_from_after_the_workspace_moved(tmp_path: Path) -> None:
    created = _init(tmp_path, "before")
    created.close()
    moved = tmp_path / "after"
    shutil.move(tmp_path / "before", moved)

    workspace = WorkspaceService.open(moved)
    assert workspace.root == moved.resolve()
    # root_dir records where it last was, and open does not rewrite it: a
    # workspace on a read-only mount must still open.
    assert workspace.workspace.root_dir == str((tmp_path / "before").resolve())
    workspace.close()


def test_open_migrates_a_workspace_written_by_an_older_build(tmp_path: Path) -> None:
    _init(tmp_path).close()
    root = tmp_path / "ws"
    _sql(root, "drop index if exists uq_project_workspace_name")
    _sql(root, "update _visionset_meta set format_version = 1")

    workspace = WorkspaceService.open(root)
    assert workspace.format_version == FORMAT_VERSION
    workspace.close()


def test_reopening_an_up_to_date_workspace_changes_nothing(tmp_path: Path) -> None:
    _init(tmp_path).close()
    for _ in range(3):
        workspace = WorkspaceService.open(tmp_path / "ws")
        assert workspace.format_version == FORMAT_VERSION
        workspace.close()


# --- open: refusals -----------------------------------------------------------


def test_open_on_a_missing_directory_is_refused(tmp_path: Path) -> None:
    with pytest.raises(NotAWorkspace, match="does not exist"):
        WorkspaceService.open(tmp_path / "nope")


def test_open_on_a_file_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "a-file"
    path.write_text("")
    with pytest.raises(NotAWorkspace, match="not a directory"):
        WorkspaceService.open(path)


def test_open_on_an_empty_directory_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "empty"
    root.mkdir()
    with pytest.raises(NotAWorkspace, match=DB_FILENAME):
        WorkspaceService.open(root)


def test_open_creates_nothing_when_it_refuses(tmp_path: Path) -> None:
    root = tmp_path / "empty"
    root.mkdir()
    with pytest.raises(NotAWorkspace):
        WorkspaceService.open(root)
    assert list(root.iterdir()) == []


def test_open_on_a_database_that_was_never_initialized_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    root.mkdir()
    (root / DB_FILENAME).touch()
    with pytest.raises(WorkspaceCorrupt, match="no VisionSet schema"):
        WorkspaceService.open(root)


def test_open_never_creates_a_schema_in_a_stray_database(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    root.mkdir()
    stray = root / DB_FILENAME
    stray.touch()
    with pytest.raises(WorkspaceCorrupt):
        WorkspaceService.open(root)
    assert stray.stat().st_size == 0


def test_open_on_a_file_that_is_not_a_database_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    root.mkdir()
    (root / DB_FILENAME).write_bytes(b"not a SQLite file at all")
    with pytest.raises(WorkspaceCorrupt, match="not a readable"):
        WorkspaceService.open(root)


def test_open_on_a_database_without_a_workspace_row_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    store = SqliteMetadataStore(root / DB_FILENAME)
    store.initialize()
    store.close()
    with pytest.raises(WorkspaceCorrupt, match="0 workspace rows"):
        WorkspaceService.open(root)


def test_open_on_a_database_with_two_workspace_rows_is_refused(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    with workspace.unit_of_work() as uow:
        uow.workspaces.add(Workspace(name="stowaway"))
    workspace.close()
    with pytest.raises(WorkspaceCorrupt, match="2 workspace rows"):
        WorkspaceService.open(tmp_path / "ws")


def test_open_refuses_a_workspace_from_the_future(tmp_path: Path) -> None:
    _init(tmp_path).close()
    _sql(tmp_path / "ws", "update _visionset_meta set format_version = 99")
    with pytest.raises(WorkspaceFormatTooNew, match="99"):
        WorkspaceService.open(tmp_path / "ws")


def test_open_rejects_a_blob_root_that_is_not_a_directory(tmp_path: Path) -> None:
    _init(tmp_path).close()
    blobs = tmp_path / "ws" / BLOBS_DIRNAME
    shutil.rmtree(blobs)
    blobs.write_text("")
    with pytest.raises(WorkspaceCorrupt, match="not a directory"):
        WorkspaceService.open(tmp_path / "ws")


def _garbage_database(root: Path) -> None:
    root.mkdir()
    (root / DB_FILENAME).write_bytes(b"nope")


def _empty_database(root: Path) -> None:
    root.mkdir()
    (root / DB_FILENAME).touch()


def _no_workspace_row(root: Path) -> None:
    store = SqliteMetadataStore(root / DB_FILENAME)
    store.initialize()
    store.close()


def _from_the_future(root: Path) -> None:
    WorkspaceService.init(root).close()
    _sql(root, "update _visionset_meta set format_version = 99")


@pytest.mark.parametrize(
    "corrupt",
    [_garbage_database, _empty_database, _no_workspace_row, _from_the_future],
    ids=["garbage", "empty-file", "no-workspace-row", "from-the-future"],
)
def test_no_sqlalchemy_exception_escapes_open(
    tmp_path: Path, corrupt: Callable[[Path], None]
) -> None:
    root = tmp_path / "ws"
    corrupt(root)
    with pytest.raises(VisionSetError) as caught:
        WorkspaceService.open(root)
    assert "sqlalchemy" not in type(caught.value).__module__


# --- the handle ---------------------------------------------------------------


def test_the_workspace_exposes_ports_not_adapters(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    assert isinstance(workspace.metadata_store, MetadataStore)
    assert isinstance(workspace.blob_store, BlobStore)
    workspace.close()


def test_a_unit_of_work_from_the_handle_commits_on_clean_exit(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    with workspace.unit_of_work() as uow:
        assert isinstance(uow, UnitOfWork)
        uow.projects.add(Project(workspace_id=workspace.workspace_id, name="signs"))
    assert [p.name for p in workspace.list_projects()] == ["signs"]
    workspace.close()


def test_closing_the_workspace_closes_its_metadata_store(tmp_path: Path) -> None:
    workspace = WorkspaceService.init(tmp_path / "ws", metadata_store_factory=_ClosingSpy)
    spy = workspace.metadata_store
    assert isinstance(spy, _ClosingSpy)
    assert spy.close_count == 0
    workspace.close()
    assert spy.close_count == 1


def test_the_workspace_works_as_a_context_manager(tmp_path: Path) -> None:
    with WorkspaceService.init(tmp_path / "ws", metadata_store_factory=_ClosingSpy) as workspace:
        spy = workspace.metadata_store
        assert isinstance(spy, _ClosingSpy)
    assert spy.close_count == 1


def test_alternative_adapters_can_be_injected(tmp_path: Path) -> None:
    workspace = WorkspaceService.init(tmp_path / "ws", metadata_store_factory=_ClosingSpy)
    assert isinstance(workspace.metadata_store, _ClosingSpy)
    workspace.close()


# --- project names ------------------------------------------------------------


def test_a_project_name_is_stripped_before_it_is_stored(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    assert workspace.create_project("  road signs  ").name == "road signs"
    workspace.close()


#: "cafe" + a combining acute accent: what macOS filesystems hand out.
CAFE_DECOMPOSED = "caf\u0065\u0301"
#: The same text as one pre-composed codepoint, which is the form we store.
CAFE_COMPOSED = "caf\u00e9"


def test_a_project_name_is_stored_in_composed_unicode_form(tmp_path: Path) -> None:
    assert CAFE_DECOMPOSED != CAFE_COMPOSED
    workspace = _init(tmp_path)
    assert workspace.create_project(CAFE_DECOMPOSED).name == CAFE_COMPOSED
    workspace.close()


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_a_blank_project_name_is_rejected(tmp_path: Path, blank: str) -> None:
    workspace = _init(tmp_path)
    with pytest.raises(InvalidName, match="non-blank"):
        workspace.create_project(blank)
    workspace.close()


def test_a_duplicate_project_name_is_rejected(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    workspace.create_project("signs")
    with pytest.raises(ProjectNameTaken, match="signs"):
        workspace.create_project("signs")
    assert len(workspace.list_projects()) == 1
    workspace.close()


def test_project_names_collide_regardless_of_case(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    workspace.create_project("Road Signs")
    with pytest.raises(ProjectNameTaken):
        workspace.create_project("road signs")
    workspace.close()


def test_project_names_collide_regardless_of_surrounding_whitespace(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    workspace.create_project("signs")
    with pytest.raises(ProjectNameTaken):
        workspace.create_project("  signs\n")
    workspace.close()


def test_project_names_collide_across_unicode_normalization_forms(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    workspace.create_project(CAFE_COMPOSED)
    with pytest.raises(ProjectNameTaken):
        workspace.create_project(CAFE_DECOMPOSED)
    workspace.close()


def test_names_differing_in_internal_whitespace_are_different_projects(tmp_path: Path) -> None:
    """Collapsing runs of spaces would rewrite the user's input for no invariant."""
    workspace = _init(tmp_path)
    workspace.create_project("road signs")
    workspace.create_project("road  signs")
    assert len(workspace.list_projects()) == 2
    workspace.close()


def test_a_project_may_keep_its_own_name_when_excluded(tmp_path: Path) -> None:
    """What ``ProjectService.rename`` needs: a no-op rename is not a collision."""
    workspace = _init(tmp_path)
    project = workspace.create_project("signs")
    with workspace.unit_of_work() as uow:
        assert workspace.require_project_name(uow, "Signs", exclude=project.id) == "Signs"
        with pytest.raises(ProjectNameTaken):
            workspace.require_project_name(uow, "Signs")
    workspace.close()


def test_the_same_project_name_is_free_in_a_different_workspace(tmp_path: Path) -> None:
    first = _init(tmp_path, "one")
    second = _init(tmp_path, "two")
    first.create_project("signs")
    second.create_project("signs")
    assert [p.name for p in first.list_projects()] == ["signs"]
    assert [p.name for p in second.list_projects()] == ["signs"]
    first.close()
    second.close()


def test_duplicate_project_names_are_refused_even_when_the_service_is_bypassed(
    tmp_path: Path,
) -> None:
    """The index is the guarantee; the service pre-check is only the message."""
    workspace = _init(tmp_path)
    workspace.create_project("signs")
    with pytest.raises(ConstraintViolated, match="UNIQUE"), workspace.unit_of_work() as uow:
        uow.projects.add(Project(workspace_id=workspace.workspace_id, name="SIGNS"))
    assert len(workspace.list_projects()) == 1
    workspace.close()


def test_projects_are_listed_in_the_order_they_were_created(tmp_path: Path) -> None:
    workspace = _init(tmp_path)
    for name in ("first", "second", "third"):
        workspace.create_project(name)
    assert [p.name for p in workspace.list_projects()] == ["first", "second", "third"]
    workspace.close()
