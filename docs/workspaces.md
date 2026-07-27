# Workspaces

A workspace is a directory on disk plus the stores inside it. Every kernel operation
happens in the context of exactly one, so `WorkspaceService` is both the way in and the
**single composition point** for the default adapters.

```
<root>/
  visionset.db      the metadata store — its presence is what makes a directory a workspace
  blobs/            FilesystemBlobStore root, sharded <hh>/<hh>/<hash>
```

Nothing else is written. WAL is deliberately **not** enabled in M1, so those two entries
are the whole format — if WAL is ever adopted, `visionset.db-wal` and `-shm` become part
of it and this page has to say so, because a user who copies only `visionset.db` under WAL
loses committed data.

Two of the four ports have no line in that layout, and that is the point: the [event
bus](events.md) is in-process and the [image processor](media.md) is a decoder, so neither
leaves anything behind. They are composed here anyway, because a workspace is what services
are handed and every port has to arrive with it. One of each per open workspace, built by
`event_bus_factory` and `image_processor_factory` — never a module-level singleton, which two
workspaces open at once must not share.

`WorkspaceService` is the only place in the kernel that names `SqliteMetadataStore`,
`FilesystemBlobStore`, `InProcessEventBus` or `PillowImageProcessor`. Everything above it — later
surface, the CLI, MCP — gets an open service and reaches the ports through it, so swapping
an adapter is a change to two functions and to nowhere else.

## Creating and opening

```python
from visionset.kernel.services import ProjectService, WorkspaceService

with WorkspaceService.init("./road-signs") as workspace:  # name defaults to "road-signs"
    ProjectService(workspace).create("Speed limits")

with WorkspaceService.open("./road-signs") as workspace:
    print(ProjectService(workspace).list())
```

`WorkspaceService` holds the workspace-level rules but creates nothing inside it: projects
come from [`ProjectService`](projects.md), so that a project can never exist without the
dataset it is supposed to be created with.

`init` and `open` are classmethods rather than work done in `__init__` for a concrete
reason: **both default adapters `mkdir` in their constructor**, so "this directory must be
empty" and "this must already be a workspace" can only be decided *before* a store object
exists. `__init__` stays the injection seam — hand it ports and it touches no filesystem.
The keyword-only `metadata_store_factory` / `blob_store_factory` arguments carry the
defaults, because the default depends on the path and so cannot be an ordinary constructor
default.

Paths are normalized once, with `expanduser().resolve()`. `workspace.root` is therefore
always absolute, and a workspace reached through a symlink is not mistaken for a different
place.

### `init` — checks in order, first match wins

| Condition | Result |
| --- | --- |
| path exists and is not a directory | `WorkspaceNotEmpty` |
| `visionset.db` present | `WorkspaceAlreadyExists` |
| directory is not empty | `WorkspaceNotEmpty`, naming up to three entries it found |
| path missing | created, with parents |
| all clear | `blobs/` → database → `initialize()` → one `workspace` row |

The already-a-workspace check runs *before* the emptiness check on purpose: a workspace
directory is also non-empty, and "open it instead" is the useful message.

Emptiness is strict — a stray `.DS_Store` is enough to refuse. That matches the contract
literally and keeps `init` from ever writing into, say, a git repository root. Worth
revisiting when the `visionset init` CLI command lands, where a friendlier rule may earn
its keep.

If anything fails midway, `init` removes what it created and nothing else: the whole
directory if `init` made it, otherwise just the database and `blobs/`. "Fails safely" means
a directory that already held something is never touched.

### `open` — the decision table

| Condition | Result |
| --- | --- |
| does not exist / is not a directory | `NotAWorkspace` (the message distinguishes the two) |
| no `visionset.db` — empty directory, unrelated directory, or `visionset.db` is itself a directory | `NotAWorkspace` |
| `blobs` exists but is not a directory | `WorkspaceCorrupt` |
| the database is not readable as SQLite | `WorkspaceCorrupt` |
| `format_version` is `UNINITIALIZED` | `WorkspaceCorrupt` — "carries no VisionSet schema" |
| stored version > `FORMAT_VERSION` | `WorkspaceFormatTooNew` |
| stored version < `FORMAT_VERSION` | migrated forward in place, restamped, then opened |
| `workspace` rows ≠ 1 | `WorkspaceCorrupt` — "expected exactly one" |
| `blobs/` missing | recreated; not an error |

Two orderings in that table are load-bearing:

- **The `UNINITIALIZED` check precedes `initialize()`.** SQLite treats a zero-length file as
  a valid empty database, so without this check `open` would happily create a VisionSet
  schema inside any unrelated file that happens to be named `visionset.db`. `open` creates,
  migrates, and repairs — but it never *initializes*.
- **`open` creates nothing when it refuses.** Every check that decides "is this a workspace"
  runs before an adapter exists, because constructing one would `mkdir`.

A missing `blobs/` is repaired rather than rejected: zip archives and git both drop empty
directories, so its absence says nothing about the workspace's health.

**Older workspaces are migrated, not refused** — that is what the migration list is for.
The honest cost is that an in-place upgrade makes the workspace unopenable by the older
build, with no backup. A `migrate=False` flag is keyword-only and source-compatible to add
later; backup-before-migrate belongs with the CLI.

### `root` is authoritative, `root_dir` is advisory

`workspace.root` is the path you opened. `Workspace.root_dir` records where the workspace
*last* was, and `open` deliberately does not rewrite it when a directory has moved: writing
on open would break opening a workspace on a read-only mount — a shared dataset over NFS, a
read-only bind mount in a container — and would make `open` non-idempotent for no invariant
gain. Read `root`; treat `root_dir` as a possibly-stale hint.

## `format_version` lives in one place

The database stamp in `_visionset_meta` is the sole authority. There is no sidecar marker
file, and the reason is the same one that rules out alembic (see
[persistence.md](persistence.md)): a second copy of one fact is a second thing to keep in
sync by hand, and a migration interrupted between the two would leave `open` guessing which
to believe. The database file *is* the marker; the version lives inside the thing it
describes.

If a marker is ever wanted for ergonomics — say, for a `visionset` command that walks up
parent directories the way `git` does — the constraint to preserve is that it must be
**content-free** (existence only, no version inside) and **tolerated when absent**, or the
drift problem comes straight back.

## Project names

Unique per workspace, ignoring case and surrounding whitespace. Enforced twice, and both
halves are necessary:

- **The unique index** `uq_project_workspace_name` on `project (workspace_id, name COLLATE
  NOCASE)` is the *guarantee*. It holds across processes, across service bugs, and across
  any future code path that forgets to ask.
- **`WorkspaceService.require_project_name`** is the *error message*. It runs inside the
  caller's unit of work, before the insert.

The pre-check is not redundancy. A constraint violation ends the transaction it happened in
— SQLAlchemy refuses further work on it — so a service cannot insert first and translate the
failure into a friendly domain error afterwards. Any caller that needs `ProjectNameTaken`
*and* an atomic multi-row write (creating a project together with its dataset, for example)
must check first. That is why `require_project_name` takes the caller's `uow` instead of
opening its own.

Normalization, and where each layer applies:

| Rule | Where |
| --- | --- |
| NFC normalization, outer whitespace stripped | service, on the way in — this is the stored form |
| case-insensitive comparison (Unicode `casefold`) | service |
| case-insensitive comparison (ASCII, `COLLATE NOCASE`) | the index |
| blank name rejected (`InvalidName`) | service |

NFC matters concretely: macOS filesystems hand out decomposed strings, so `café` typed in
Finder and `café` typed in a terminal are different byte sequences that must not become two
projects. Internal whitespace is left alone — `road signs` and `road  signs` are distinct,
because collapsing runs of spaces would rewrite the user's input for no invariant. There is
no length limit in M1.

The two comparison rules differ in reach (Unicode vs ASCII), and that split is deliberate:
the index catches the collision users actually make at the storage layer, while the service
has the full normalized string in hand and can be stricter. The service is never *looser*
than the index, so nothing slips through.

`require_project_name(uow, name, exclude=project_id)` lets a rename keep its own name.

## Concurrency, plainly

One SQLite file, rollback-journal mode, no cross-process lock, one engine per open
`WorkspaceService`.

**Guaranteed, under any number of processes:** a workspace can never contain two `project`
rows whose names are equal under ASCII case folding. That holds because the guarantee is an
index evaluated inside SQLite's write transaction, not the service's `SELECT`. Every write
is a transaction, so no half-finished operation can be observed.

**Not guaranteed:** which error the loser of a race sees. Two processes can both pass the
pre-check; then either the second insert hits the index and raises `ConstraintViolated` — a
caller re-raises that as `ProjectNameTaken`, so user-visible behavior stays correct — or the
writes interleave and the loser eventually gets `database is locked` as an untranslated
SQLAlchemy `OperationalError`. That leak is a known M1 gap: mapping it to `WorkspaceCorrupt`
would be a lie, and inventing an error for transient failure with no caller would be
speculative.

Opening the same path twice yields two independent engines with no shared cache and no
in-process lock: **VisionSet is single-writer by convention, not by enforcement.** Hardenings
in the order they would be taken: `PRAGMA busy_timeout`, `BEGIN IMMEDIATE` for write
transactions (which removes the race entirely), WAL (changes the on-disk format), an advisory
lock file.

## How later services are composed

`WorkspaceService` is the handle every other service depends on. `ProjectService` is the
first of them, and the shape it takes is the shape the rest take:

```python
class ProjectService:
    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace

    def create(self, name: str, description: str | None = None) -> Project:
        with self._workspace.unit_of_work() as uow:  # one transaction per operation
            resolved = self._workspace.require_project_name(uow, name)
            project = uow.projects.add(
                Project(
                    workspace_id=self._workspace.workspace_id,
                    name=resolved,
                    description=description,
                )
            )
            uow.datasets.add(Dataset(project_id=project.id, name=resolved))
            return project
```

Four habits that keep the boundary honest:

- Take a `WorkspaceService`, not a store and a path. One dependency, and it carries the
  workspace-level rules with it.
- One `unit_of_work()` per operation, and do the whole operation inside it.
- Reach the ports through the handle — `workspace.metadata_store`, `workspace.blob_store`,
  `workspace.event_bus`, `workspace.image_processor`. No service other than `workspace_service`
  should name `SqliteMetadataStore`, `FilesystemBlobStore`, `InProcessEventBus` or
  `PillowImageProcessor` — if a second one does, the composition point has stopped being single.
- Publish [events](events.md) *after* the `unit_of_work()` block, never inside it. An
  announcement is about work that committed, and a subscriber that raises must have nothing
  left to roll back.
