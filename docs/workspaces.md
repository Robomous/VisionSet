# Workspaces

A workspace is a directory on disk plus the stores inside it. Every kernel operation
happens in the context of exactly one, so `WorkspaceService` is both the way in and the
**single composition point** for the default adapters.

```
<root>/
  visionset.db      the metadata store — its presence is what makes a directory a workspace
  visionset.db-wal  SQLite's write-ahead log — present only while the workspace is open
  visionset.db-shm  its shared-memory index — likewise
  blobs/            FilesystemBlobStore root, sharded <hh>/<hh>/<hash>
  uploads/          written only by the REST server — see below
```

Nothing the kernel writes is outside those four entries. `uploads/` is the exception and it
belongs to somebody else: the [REST API](api.md) stages multipart uploads there, named by a
digest of the part set, so that `SourceService` — which registers a source by *path* — has a
path to be given. The kernel neither writes nor reads it, `open` simply tolerates it the way it
tolerates anything else beside the database and `blobs/`, and the CLI and MCP surfaces never
create one because they already hold real paths. Like blobs, staged uploads are never deleted.

The store runs in **WAL mode**, which is why the two sidecars are
part of the format: `close()` checkpoints them into `visionset.db` and removes them, so a
workspace at rest is still just the database and the blobs — but a workspace that is *open*,
or one whose process was killed, is all four entries.

**Copying a workspace that is open loses committed data** if you take only `visionset.db`.
Everything written since the last checkpoint lives in `visionset.db-wal` until then. Close the
workspace first, or copy all three files together.

Four of the six ports have no line in that layout, and that is the point: the [event
bus](events.md) is in-process, the two [media processors](media.md) are decoders, and the
[auth provider](auth.md) reads a table inside the database above, so none of them leaves anything
behind. They are composed here anyway, because a workspace is what services
are handed and every port has to arrive with it. One of each per open workspace, built by
`event_bus_factory`, `image_processor_factory`, `video_processor_factory` and
`auth_provider_factory` — never a module-level singleton, which two workspaces open at once must
not share.

`auth_provider_factory` is the one that takes arguments: `(metadata_store, workspace_id)`, because
it is the first port derived from another rather than from the path. No kernel service uses it —
it exists for the surfaces above — and it is composed here anyway, because the alternative is a
delivery module naming a kernel adapter.

A new port is appended **last** to `WorkspaceService.__init__`, never inserted: `init` and `open`
bind those arguments positionally, so a parameter added in the middle silently re-binds every one
after it.

`WorkspaceService` is the only place in the kernel that names `SqliteMetadataStore`,
`FilesystemBlobStore`, `InProcessEventBus`, `PillowImageProcessor`, `FfmpegVideoProcessor` or
`StoredTokenAuthProvider`.
Everything above it — later
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
its keep — that command is also the one that will have to decide whether `init` with no
path means "here" or means the resolver's answer, since the resolver deliberately walks
upward and `init` must not.

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

## Which workspace, when nobody said

`init` and `open` are handed a path. Deciding *which* path is a separate question, and it has one
answer for every surface: `resolve_workspace_root(explicit=None)`, beside `DB_FILENAME` in
`kernel/services/workspace_service.py`. It lives there because it is the same fact read from the
other end — the database file is what marks a directory as a workspace, and this is what goes
looking for the mark. It cannot live in either caller: import-linter forbids `visionset.server`
importing `visionset.cli`, so the rule the two share has to sit above both.

Precedence, first match wins:

| | Source | Walks up? |
| --- | --- | --- |
| 1 | `explicit` — the CLI's `--workspace` / `-w` | no |
| 2 | `VISIONSET_WORKSPACE`, when set to something non-empty | no |
| 3 | the nearest directory at or above the working directory holding a `visionset.db` | **yes** |
| 4 | the working directory | — |

A server started by import string has no argv, so it reaches only 2, 3 and 4.

**Only case 3 walks, and that asymmetry is the whole rule.** A flag and an environment variable are
somebody *stating* which workspace. If the stated directory holds none, walking to its parent and
quietly minting a credential into whatever workspace lives up there is the worst thing this
function could do. Git draws the line in the same place — discovery walks up, `--git-dir` and
`GIT_DIR` do not — and for the same reason.

**Finding nothing is not an error here.** This names a directory; `open` owns "is this a
workspace?" and already raises `NotAWorkspace` naming the path it was given. A refusal here would
be two errors for one condition, and would make the function non-total for the server, which calls
it inside a lazily opened handle that expects exactly one failure mode.

**Nothing is normalized.** `_resolved` is the one place a path becomes canonical and it runs inside
`init`/`open`; expanding `~` twice is how two spellings of one workspace start looking like two
workspaces.

An empty `VISIONSET_WORKSPACE` falls through to case 3 rather than resolving to `Path("")`, because
a shell cannot tell `VISIONSET_WORKSPACE=` from an unset variable.

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

One SQLite file in **WAL mode**, a **5 s `busy_timeout`** on every connection, no cross-process
lock, one engine per open `WorkspaceService`.

**Guaranteed, under any number of processes:** a workspace can never contain two `project`
rows whose names are equal under ASCII case folding. That holds because the guarantee is an
index evaluated inside SQLite's write transaction, not the service's `SELECT`. Every write
is a transaction, so no half-finished operation can be observed.

**Readers never block, and are never blocked.** That is what WAL buys, and it is the reason
this milestone adopted it: a background ingest holding a write transaction does not stall the
request handlers reading beside it. A reader sees the last committed state, not the writer's
work in progress.

**Writers are serialized, and wait up to `busy_timeout` for their turn.** SQLite permits one
writer at a time regardless of journal mode. A write that waits the timeout out raises
`WorkspaceBusy` — a domain error, translated in the adapter like every other (see
[persistence.md](persistence.md#connection-posture)), and transient: the remedy is to retry.
It is deliberately *not* `WorkspaceCorrupt`, which is
where the adapter files the failures retrying cannot fix.

**Still not guaranteed:** which error the loser of a name race sees. Two processes can both
pass the pre-check; then either the second insert hits the index and raises
`ConstraintViolated` — a caller re-raises that as `ProjectNameTaken`, so user-visible
behavior stays correct — or one of them waits out the timeout and gets `WorkspaceBusy`. Both
are honest answers, and both are now domain errors.

Opening the same path twice yields two independent engines with no shared cache and no
in-process lock: **VisionSet is single-writer by convention, not by enforcement.** A long
write transaction is therefore still a thing to avoid rather than a thing the store defends
against — which is why, for example, `SourceService` probes a clip *outside* its write
transaction. `busy_timeout` shortens the window; it does not make holding a transaction
across a subprocess acceptable.

Two hardenings remain untaken, and one of them is declined rather than merely pending.
`BEGIN IMMEDIATE` for write transactions would make every contended write wait instead of
ever failing fast — but `unit_of_work()` serves reads and writes alike, with no read-only
variant, so an immediate transaction would take the write lock for *every* read and serialize
exactly the concurrency WAL was adopted for. It stays off unless the unit of work grows a
read-only form. An advisory lock file, which would turn "single-writer by convention" into
enforcement, is still open.

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
  `workspace.event_bus`, `workspace.image_processor`, `workspace.video_processor`,
  `workspace.auth_provider`. No service other than `workspace_service` should name
  `SqliteMetadataStore`, `FilesystemBlobStore`, `InProcessEventBus`, `PillowImageProcessor`,
  `FfmpegVideoProcessor` or `StoredTokenAuthProvider` — if a second one does, the composition
  point has stopped being single.
- Publish [events](events.md) *after* the `unit_of_work()` block, never inside it. An
  announcement is about work that committed, and a subscriber that raises must have nothing
  left to roll back.
