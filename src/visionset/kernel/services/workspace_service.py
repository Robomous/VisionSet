# usage: from visionset.kernel.services import WorkspaceService
"""The workspace: a directory on disk plus the stores that live inside it.

Every kernel operation happens in the context of exactly one workspace, so this
module is also the **single composition point** for the default adapters. It is
the only place in the kernel that names ``SqliteMetadataStore``,
``FilesystemBlobStore``, ``InProcessEventBus``, ``PillowImageProcessor``,
``FfmpegVideoProcessor`` or ``StoredTokenAuthProvider``; everything above it — later
services, the REST surface, the CLI, MCP — receives an open ``WorkspaceService``
and reaches the ports through it. Swapping an adapter is therefore a change to
two functions here and to nowhere else.

The layout is flat, and the database is the marker::

    <root>/visionset.db     the metadata store; holds format_version
    <root>/visionset.db-wal SQLite's write-ahead log, only while open
    <root>/visionset.db-shm its shared-memory index, only while open
    <root>/blobs/           the content-addressed blob store

The store runs in WAL mode, so those two sidecars exist for as long as the
workspace is open and are checkpointed away by ``close()``. They still belong to
the workspace while they are there: a copy taken mid-run that includes only
``visionset.db`` is missing whatever has not been checkpointed yet.

Five of the seven ports have no line in that layout, and that is the point: the
event bus is in-process, the two media processors are decoders, and the auth
provider and the job queue both read tables inside the database above, so none of
them leaves anything behind. They are composed here anyway, because a workspace is what
services are handed and every port has to arrive with it.

There is no sidecar file carrying the format version. It lives inside the
database it describes, for the same reason there is no alembic ledger: a second
copy of one fact is a second thing to keep in sync by hand.

Two invariants shape the code:

- **``init`` creates, ``open`` never does.** Both default adapters ``mkdir`` in
  their constructor, and ``initialize()`` on an empty file would happily stamp a
  stranger's ``visionset.db`` into a workspace. So every path check happens
  *before* an adapter is constructed, and ``open`` refuses a database that was
  never initialized rather than initializing it.
- **A project name is unique per workspace, and the database enforces it.** The
  service pre-check exists for the error message; the unique index is the
  guarantee. See :meth:`WorkspaceService.require_project_name`.

The name rules live here because they are workspace-wide, but nothing here
creates a project: ``ProjectService`` is the only door, so that a project can
never exist without the dataset it is supposed to be created with.
"""

from __future__ import annotations

import os
import shutil
from collections.abc import Callable
from contextlib import AbstractContextManager
from pathlib import Path
from types import TracebackType
from uuid import UUID

from visionset.kernel.adapters import (
    FfmpegVideoProcessor,
    FilesystemBlobStore,
    InProcessEventBus,
    PillowImageProcessor,
    SqliteJobQueue,
    SqliteMetadataStore,
    StoredTokenAuthProvider,
)
from visionset.kernel.domain import Workspace, normalize_name
from visionset.kernel.errors import (
    NotAWorkspace,
    ProjectNameTaken,
    WorkspaceAlreadyExists,
    WorkspaceCorrupt,
    WorkspaceNotEmpty,
)
from visionset.kernel.ports import (
    UNINITIALIZED,
    AuthProvider,
    BlobStore,
    EventBus,
    ImageProcessor,
    JobQueue,
    MetadataStore,
    UnitOfWork,
    VideoProcessor,
)

#: The metadata store. Its presence is what makes a directory a workspace.
DB_FILENAME = "visionset.db"

#: SQLite's WAL sidecars, named after the database file. A clean ``close()``
#: checkpoints and removes them, so they are only ever found beside a workspace
#: that is open right now or was killed while open — but they are part of the
#: workspace either way, which is why everything that enumerates its contents
#: has to know about them.
DB_SIDECAR_FILENAMES = (f"{DB_FILENAME}-wal", f"{DB_FILENAME}-shm")

#: Root of the content-addressed blob store, relative to the workspace directory.
BLOBS_DIRNAME = "blobs"

#: Which workspace a surface operates on when its command line says nothing.
#:
#: Deliberately not a server- or CLI-specific name: the CLI writes the tokens the
#: server reads, so the two have to agree on one spelling of "the workspace", and
#: ``docker/compose.yaml`` already sets this one.
WORKSPACE_ENV_VAR = "VISIONSET_WORKSPACE"

#: How many entries a "this directory is not empty" message names.
_PREVIEW = 3

type MetadataStoreFactory = Callable[[Path], MetadataStore]
type BlobStoreFactory = Callable[[Path], BlobStore]
#: Zero-argument, unlike the two store factories: a bus is not derived from the
#: workspace path, because it has nothing on disk to be derived from.
type EventBusFactory = Callable[[], EventBus]
#: Zero-argument for the same reason, and with even less to say for itself: a
#: decoder has no state at all. It is composed here anyway, because this module is
#: the only one allowed to name an adapter.
type ImageProcessorFactory = Callable[[], ImageProcessor]
#: Zero-argument, like its image sibling. The video decoder needs an external
#: program rather than a library, but that is the adapter's problem and not the
#: workspace's: a missing ffmpeg is discovered by the call that needs it, so a
#: machine without one still opens workspaces and still ingests images.
type VideoProcessorFactory = Callable[[], VideoProcessor]
#: Two arguments, unlike every factory above, and the first port that is derived
#: from another one: verifying a token means reading the workspace's own ``token``
#: table, scoped to the workspace that owns it. ``StoredTokenAuthProvider`` binds
#: both positionally, so the bare class reference still satisfies this type.
type AuthProviderFactory = Callable[[MetadataStore, UUID], AuthProvider]
#: One argument, and the second port derived from the store rather than the path.
#: A queue is rows, and the rows live in the workspace's own database — see
#: ``SqliteJobQueue`` for why they are not in a file of their own. It takes no
#: workspace id because a job is not scoped to one: a server serves exactly one
#: workspace, so the queue in this handle is that workspace's queue by
#: construction.
type JobQueueFactory = Callable[[MetadataStore], JobQueue]


def _resolved(path: Path | str) -> Path:
    """Absolute, ``~``-expanded, symlink-free — the one form we store and compare.

    A relative ``root_dir`` in the database stops meaning anything the moment the
    process changes directory, and two paths to one workspace (one through a
    symlink) must not look like two different places.
    """
    return Path(path).expanduser().resolve()


def resolve_workspace_root(explicit: Path | str | None = None) -> Path:
    """Which workspace a surface was pointed at. Never checks that one is there.

    One rule, shared by every surface. It lives beside ``DB_FILENAME`` because it
    is the same fact read from the other end — the database file is what marks a
    directory as a workspace, and this is what goes looking for the mark. It
    cannot live in either caller: import-linter forbids ``visionset.server``
    importing ``visionset.cli``, so the resolver the two share belongs above both.

    Precedence, first match wins:

    1. ``explicit`` — the CLI's ``--workspace``. Somebody named a directory.
    2. ``VISIONSET_WORKSPACE``, when it is set to something non-empty. An unset
       variable and one set to ``""`` are the same thing to a shell, so both fall
       through rather than resolving to the filesystem root's idea of ``Path("")``.
    3. The working directory, or the nearest directory **above** it holding a
       ``visionset.db`` — so ``cd assets/raw && visionset token list`` works.
    4. The working directory, when the walk finds nothing.

    **Only case 3 walks, and that asymmetry is the whole rule.** A flag and an
    environment variable are somebody *stating* which workspace; if the stated
    directory holds none, walking to its parent and quietly minting a credential
    into whatever workspace lives up there is the worst thing this function could
    do. Git draws the line in the same place — discovery walks up, ``--git-dir``
    and ``GIT_DIR`` do not — and for the same reason.

    **Finding nothing is not an error here.** This names a directory;
    :meth:`WorkspaceService.open` owns "is this a workspace?" and already raises
    ``NotAWorkspace`` naming the path it was given. A refusal here would be two
    errors for one condition, and would make this function non-total for the
    server, which calls it inside a lazily opened handle that expects exactly one
    failure mode.

    **Nothing is normalized.** :func:`_resolved` is the one place a path becomes
    canonical, and it runs inside ``init``/``open``; expanding ``~`` twice is how
    two spellings of one workspace start looking like two workspaces.
    """
    if explicit is not None:
        return Path(explicit)
    named = os.environ.get(WORKSPACE_ENV_VAR)
    if named:
        return Path(named)
    cwd = Path.cwd()
    return _workspace_above(cwd) or cwd


def _workspace_above(start: Path) -> Path | None:
    """The nearest directory at or above ``start`` holding a ``DB_FILENAME``.

    Walks to the filesystem root. Private because
    :func:`resolve_workspace_root` is its only caller and "how far does discovery
    reach?" is that function's rule to state, not a second public knob.
    """
    for candidate in (start, *start.parents):
        if (candidate / DB_FILENAME).is_file():
            return candidate
    return None


class WorkspaceService:
    """One open workspace: its identity, its directory, and its seven ports.

    Instances come from :meth:`init` and :meth:`open`. Constructing one directly
    is the injection seam — hand it ports and nothing here touches a disk.

    The two stores cannot be ordinary constructor defaults because their default
    is derived from the path, which the constructor does not own. The keyword-only
    *factories* on ``init``/``open`` carry them instead: no module-level
    singleton, no import from a delivery module, and each default named once.

    The event bus and the two media processors have no path to be derived from
    and could have been plain defaults, but they take the same shape anyway — one
    place naming each default, one of each per open workspace. A module-level
    default would be a singleton shared by every workspace in the process, which
    is precisely the thing two workspaces open at once must not have.

    A new port is appended **last** to this signature, never inserted. Both
    classmethods below bind these arguments positionally, so a parameter added in
    the middle silently re-binds every one after it.
    """

    def __init__(
        self,
        root: Path,
        workspace: Workspace,
        metadata_store: MetadataStore,
        blob_store: BlobStore,
        event_bus: EventBus,
        image_processor: ImageProcessor,
        video_processor: VideoProcessor,
        auth_provider: AuthProvider,
        job_queue: JobQueue,
    ) -> None:
        self._root = root
        self._workspace = workspace
        self._metadata_store = metadata_store
        self._blob_store = blob_store
        self._event_bus = event_bus
        self._image_processor = image_processor
        self._video_processor = video_processor
        self._auth_provider = auth_provider
        self._job_queue = job_queue

    # --- composition: the only two ways to get one ------------------------

    @classmethod
    def init(
        cls,
        path: Path | str,
        *,
        name: str | None = None,
        metadata_store_factory: MetadataStoreFactory = SqliteMetadataStore,
        blob_store_factory: BlobStoreFactory = FilesystemBlobStore,
        event_bus_factory: EventBusFactory = InProcessEventBus,
        image_processor_factory: ImageProcessorFactory = PillowImageProcessor,
        video_processor_factory: VideoProcessorFactory = FfmpegVideoProcessor,
        auth_provider_factory: AuthProviderFactory = StoredTokenAuthProvider,
        job_queue_factory: JobQueueFactory = SqliteJobQueue,
    ) -> WorkspaceService:
        """Create a workspace at ``path`` and return it open.

        The directory may be missing (parents are created) or empty; anything
        else is refused before a single byte is written. ``name`` defaults to the
        directory's own name, so ``init("./road-signs")`` needs no second
        argument.

        Raises:
            WorkspaceAlreadyExists: ``path`` already holds a workspace.
            WorkspaceNotEmpty: ``path`` holds something else, or is not a
                directory.
        """
        root = _resolved(path)
        db_path = root / DB_FILENAME
        blobs_dir = root / BLOBS_DIRNAME

        if root.exists() and not root.is_dir():
            raise WorkspaceNotEmpty(f"cannot create a workspace at {root}: it is not a directory")
        if db_path.exists():
            raise WorkspaceAlreadyExists(
                f"{root} is already a VisionSet workspace ({DB_FILENAME} exists); open it instead"
            )
        if root.is_dir():
            entries = sorted(entry.name for entry in root.iterdir())
            if entries:
                shown = ", ".join(entries[:_PREVIEW])
                more = " and more" if len(entries) > _PREVIEW else ""
                raise WorkspaceNotEmpty(
                    f"cannot create a workspace in {root}: it already contains {shown}{more}"
                )

        created_root = not root.exists()
        root.mkdir(parents=True, exist_ok=True)
        metadata_store: MetadataStore | None = None
        try:
            blob_store = blob_store_factory(blobs_dir)
            metadata_store = metadata_store_factory(db_path)
            metadata_store.initialize()
            workspace = Workspace(name=name or root.name, root_dir=str(root))
            with metadata_store.unit_of_work() as uow:
                uow.workspaces.add(workspace)
        except BaseException:
            if metadata_store is not None:
                metadata_store.close()
            _undo_init(root, created_root=created_root)
            raise
        # The four remaining factories cannot touch the disk — three take no
        # arguments at all, and the auth provider only stores the two references
        # it is handed — so they run outside the block that would undo a
        # half-made workspace. A future port whose construction can fail moves
        # inside it.
        return cls(
            root,
            workspace,
            metadata_store,
            blob_store,
            event_bus_factory(),
            image_processor_factory(),
            video_processor_factory(),
            auth_provider_factory(metadata_store, workspace.id),
            job_queue_factory(metadata_store),
        )

    @classmethod
    def open(
        cls,
        path: Path | str,
        *,
        metadata_store_factory: MetadataStoreFactory = SqliteMetadataStore,
        blob_store_factory: BlobStoreFactory = FilesystemBlobStore,
        event_bus_factory: EventBusFactory = InProcessEventBus,
        image_processor_factory: ImageProcessorFactory = PillowImageProcessor,
        video_processor_factory: VideoProcessorFactory = FfmpegVideoProcessor,
        auth_provider_factory: AuthProviderFactory = StoredTokenAuthProvider,
        job_queue_factory: JobQueueFactory = SqliteJobQueue,
    ) -> WorkspaceService:
        """Open the workspace at ``path``, migrating it forward if it is behind.

        Creates nothing when it refuses: the checks that decide whether this is a
        workspace all run before an adapter — which would ``mkdir`` — exists.

        Raises:
            NotAWorkspace: nothing there, or no ``visionset.db`` in it.
            WorkspaceCorrupt: the layout is there but unusable.
            WorkspaceFormatTooNew: written by a later VisionSet.
        """
        root = _resolved(path)
        db_path = root / DB_FILENAME
        blobs_dir = root / BLOBS_DIRNAME

        if not root.exists():
            raise NotAWorkspace(f"{root} does not exist")
        if not root.is_dir():
            raise NotAWorkspace(f"{root} is not a directory")
        if not db_path.is_file():
            raise NotAWorkspace(
                f"{root} is not a VisionSet workspace (no {DB_FILENAME}); "
                f"use WorkspaceService.init to create one"
            )
        if blobs_dir.exists() and not blobs_dir.is_dir():
            raise WorkspaceCorrupt(f"{blobs_dir} is not a directory")

        metadata_store = metadata_store_factory(db_path)
        try:
            # Before initialize(), which would otherwise create a schema inside
            # any unrelated file that happens to be named visionset.db.
            if metadata_store.format_version == UNINITIALIZED:
                raise WorkspaceCorrupt(
                    f"{db_path} exists but carries no VisionSet schema; open never creates one"
                )
            metadata_store.initialize()
            with metadata_store.unit_of_work() as uow:
                rows = uow.workspaces.list()
            if len(rows) != 1:
                raise WorkspaceCorrupt(
                    f"{db_path} holds {len(rows)} workspace rows; expected exactly one"
                )
            # Recreated by the adapter if a zip or a clone dropped it empty.
            blob_store = blob_store_factory(blobs_dir)
        except BaseException:
            metadata_store.close()
            raise
        return cls(
            root,
            rows[0],
            metadata_store,
            blob_store,
            event_bus_factory(),
            image_processor_factory(),
            video_processor_factory(),
            auth_provider_factory(metadata_store, rows[0].id),
            job_queue_factory(metadata_store),
        )

    # --- what the surfaces and the later services read --------------------

    @property
    def root(self) -> Path:
        """The directory this workspace was opened from. Always absolute.

        Authoritative, unlike ``workspace.root_dir``, which records where the
        workspace last was and is never rewritten on open.
        """
        return self._root

    @property
    def workspace(self) -> Workspace:
        return self._workspace

    @property
    def workspace_id(self) -> UUID:
        return self._workspace.id

    @property
    def metadata_store(self) -> MetadataStore:
        return self._metadata_store

    @property
    def blob_store(self) -> BlobStore:
        return self._blob_store

    @property
    def event_bus(self) -> EventBus:
        """Where the services announce what they did, once it has committed.

        Reached through the handle like every other port, so a service takes a
        ``WorkspaceService`` and still needs no second dependency to emit.
        """
        return self._event_bus

    @property
    def image_processor(self) -> ImageProcessor:
        """Decoding, dimensions and thumbnails for still images.

        Reached through the handle like the other four ports, which is what lets
        an ingest service take a ``WorkspaceService`` and still name no adapter —
        the rule this module exists to keep, and the reason a decoder is composed
        here rather than defaulted in the service that uses it.

        Nothing in the workspace layout corresponds to it. Like the event bus it
        leaves nothing on disk, and unlike the event bus it holds no state at all,
        so one per workspace is uniformity rather than isolation: two workspaces
        sharing a decoder would be harmless, and giving each its own costs nothing
        and means every port arrives the same way.
        """
        return self._image_processor

    @property
    def video_processor(self) -> VideoProcessor:
        """Probing and frame extraction for video.

        Composed on exactly the terms the image processor is, including the part
        that looks like it should be an exception: the default adapter needs
        ffmpeg on the machine, and building one still cannot fail. That is
        deliberate. Checking for the binary here would mean a workspace full of
        JPEGs refuses to open on a laptop with no ffmpeg installed, so the check
        belongs to the call that actually needs to decode something.

        The one way this port differs in use: what it returns owns a running
        program. A workspace has no say in that lifetime — the iterator does — so
        :meth:`close` has nothing to do here either.
        """
        return self._video_processor

    @property
    def auth_provider(self) -> AuthProvider:
        """Whether a presented token may operate this workspace.

        The narrow seam all three delivery surfaces authenticate through, and the
        one port here that no kernel service uses: it exists for the layers above.
        It is composed here anyway, and has to be, because the alternative is a
        surface constructing ``StoredTokenAuthProvider`` itself — a delivery module
        naming a kernel adapter, which is exactly what this module exists to
        prevent.

        The first port derived from another rather than from the path: the default
        adapter reads the ``token`` table through the metadata store above, scoped
        to this workspace's id. It holds those two references and nothing else, so
        :meth:`close` has nothing to do here — closing the store closes what this
        reads through.

        Credentials are minted and revoked by ``TokenService``, never here.
        """
        return self._auth_provider

    @property
    def job_queue(self) -> JobQueue:
        """Where background work waits, and where a poller reads its state.

        The **seventh** port, appended last to both classmethods rather than
        inserted, which is the rule this class states about itself: the two
        constructors bind positionally, so a parameter added in the middle
        silently re-binds every one after it.

        The second port with no kernel-service caller, after the auth provider,
        and composed here for that port's reason rather than in spite of it: the
        alternative is a delivery module constructing ``SqliteJobQueue``, which is
        a surface naming a kernel adapter. Nothing in ``kernel/services`` enqueues
        anything — a service does its work, and *deciding* that some work should
        happen later is a question about the deployment, which is the surface's to
        answer.

        It has no line in the workspace layout above because its rows are in the
        database that does. :meth:`close` has nothing to do here either: closing
        the store closes what this writes through.
        """
        return self._job_queue

    @property
    def format_version(self) -> int:
        return self._metadata_store.format_version

    def unit_of_work(self) -> AbstractContextManager[UnitOfWork]:
        """One transaction, so that later services never reach for the store."""
        return self._metadata_store.unit_of_work()

    # --- workspace-level rules --------------------------------------------

    def normalize_project_name(self, name: str) -> str:
        """The canonical stored form: NFC, outer whitespace stripped, else as typed.

        NFC matters concretely: macOS filesystems hand out decomposed strings, so
        a name typed in Finder and the same name typed in a terminal are
        different byte sequences that must not become two projects. Internal
        whitespace is left alone — collapsing it would rewrite the user's input
        for no invariant.

        The rule itself is shared (:func:`normalize_name`) because every named
        entity answers "is this the same name?" the same way; what is specific to
        a project is the *uniqueness* below, not the normalization.

        Raises:
            InvalidName: the name is blank once stripped.
        """
        return normalize_name(name, what="project")

    def require_project_name(
        self, uow: UnitOfWork, name: str, *, exclude: UUID | None = None
    ) -> str:
        """The normalized name, or refuse it because this workspace already has it.

        The caller passes its own ``uow`` so that this check and the write that
        follows commit as one transaction. That matters more than it looks: a
        constraint violation ends its transaction, so a caller cannot insert
        first and translate the failure afterwards — see ``ConstraintViolated``.
        Hence two layers, and do not delete either. The index in ``_tables`` is
        the guarantee; this pre-check is the error message.

        ``exclude`` is the project being renamed, which may keep its own name.

        Raises:
            InvalidName: the name is blank.
            ProjectNameTaken: another project in this workspace holds it.
        """
        normalized = self.normalize_project_name(name)
        wanted = normalized.casefold()
        for project in uow.projects.list(self._workspace.id):
            if project.id != exclude and project.name.casefold() == wanted:
                raise ProjectNameTaken(f"a project named {project.name!r} already exists")
        return normalized

    # --- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        """Release the metadata store's connections. Safe to call twice.

        The other six ports are not closed and have nothing to close: the blob
        store addresses files by hash and opens them per call, the event bus holds
        a list of callables, the two media processors hold nothing whatsoever, and
        the auth provider and the job queue each hold a reference to the store this
        line closes. Only the database keeps a connection. A frame iterator does own a running
        decoder, but it belongs to whoever asked for it, not to the workspace.
        """
        self._metadata_store.close()

    def __enter__(self) -> WorkspaceService:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()


def _undo_init(root: Path, *, created_root: bool) -> None:
    """Remove what a failed ``init`` created, and nothing else.

    ``init`` only ever runs against a directory it made or found empty, so there
    is nothing of the user's to lose here. Best-effort: the original failure is
    the interesting one and must not be masked by a cleanup error.
    """
    try:
        if created_root:
            shutil.rmtree(root, ignore_errors=True)
            return
        (root / DB_FILENAME).unlink(missing_ok=True)
        for sidecar in DB_SIDECAR_FILENAMES:
            (root / sidecar).unlink(missing_ok=True)
        shutil.rmtree(root / BLOBS_DIRNAME, ignore_errors=True)
    except OSError:
        pass
