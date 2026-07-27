# Projects

A project is the aggregate root: the schema, sources, assets, batches, task groups,
annotations and the dataset all hang off exactly one. `ProjectService` owns its lifecycle,
and it is the **only** way to create one — `WorkspaceService` holds the name rules but has
no `create_project`, because a second door would be a door to a project without a dataset.

A new project has no annotation schema. That one is `SchemaService`'s to create, for the same
reason — see [schemas.md](schemas.md).

```python
from visionset.kernel.services import ProjectService, WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    projects = ProjectService(workspace)

    project = projects.create("Speed limits", "urban, 30-50 km/h")
    projects.get_dataset(project.id)  # created with it, empty, same name
    projects.rename(project.id, "Speed signs")
    projects.list()
    projects.delete(project.id, confirm=True)
```

## The project–dataset relation is 1:1

The dataset **is** the curated state of the project, not a thing kept beside it. Three
consequences, and all three are enforced rather than documented:

- `create` writes the project row and the dataset row in **one transaction**. If the name
  is taken, or anything else refuses, neither row lands — there is no window in which a
  project exists without its dataset.
- The dataset takes the project's name, and `rename` moves both together in one
  transaction. Letting them drift would make "the dataset is the project's curated state"
  a claim the data no longer supports.
- `get_dataset` reads the single dataset row. Finding none, or more than one, raises
  `WorkspaceCorrupt` rather than picking one: the invariant is broken on disk, and guessing
  would hide it.

What *fills* that dataset is `DatasetService`, not this one: assets enter it by promotion from
a completed batch and leave it by curation, each mutation appending to an audit log. See
[datasets.md](datasets.md). `ProjectService` keeps only the parts that are the project's — the
row's existence and its name.

Names follow the workspace rule — unique per workspace, ignoring case and surrounding
whitespace, NFC-normalized on the way in. See
[workspaces.md § Project names](workspaces.md#project-names) for why that rule is enforced
in two places. `rename` passes `exclude=project_id`, so correcting only the capitalization
of a name is not a collision with itself.

## Deleting a project

Deletion is guarded by a parameter, not by a prompt:

```python
projects.delete(project_id)  # ConfirmationRequired
projects.delete(project_id, confirm=True)  # gone
```

The kernel has no terminal and no user. Every surface — CLI, REST, MCP — asks in its own
idiom and passes the answer down, and refusing by default means a caller that forgets to
ask cannot delete anything by accident. A project id that does not exist raises
`ProjectNotFound` either way: nothing destructive is being guarded when there is no target.

### What it destroys

Metadata, and all of it. Every foreign key into the project subtree is `ON DELETE CASCADE`,
so a single statement takes the annotation schema, sources, ingest jobs, assets,
annotations, batches, task groups, annotation jobs, the dataset, its members, its change log
and its releases. There is no hand-rolled cascade to keep in sync with the tables.

### What it never destroys

**Blobs.** Content is addressed by its SHA-256 hash and shared — the same bytes ingested
into two projects are one blob — so no project can know whether it is the last owner. A
release that named a hash keeps its bytes under `<root>/blobs/` even after the release row
is gone.

That is the safe default rather than an oversight: `BlobStore` has no `delete`, and
reclaiming space correctly needs workspace-wide reachability (which hashes are still named
by any asset or any release manifest, in any project). That pass does not exist in M1.
Deleting a project therefore frees rows, not disk.

## Errors

| Error | When |
| --- | --- |
| `ProjectNotFound` | No project with that id in this workspace. A project belonging to a *different* workspace reads as missing too — this service speaks for one workspace, and anything outside it is not its to describe. |
| `ProjectNameTaken` | Another project in this workspace holds the name. Also what the loser of a cross-process race gets: the unique index refuses the insert and the service re-raises it in this vocabulary. |
| `InvalidName` | The name is empty, or blank once stripped. |
| `ConfirmationRequired` | `delete` was called without `confirm=True`. |
| `WorkspaceCorrupt` | The project does not have exactly one dataset. |
