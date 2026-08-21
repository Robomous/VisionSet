# Background jobs

Work that outlives the request that asked for it: a queue, a dispatcher, and five
handlers. Introduced by #328.

`docs/content/jobs.md` describes an **annotation** job: a slice of a batch assigned
to an annotator. Annotation jobs and background jobs share only a name. The API
therefore uses `/background-jobs`, and the models use a `Background` prefix.

## The shape

```
FastAPI process                              worker process (spawn)
 ├─ routes ── enqueue ──> job table           ├─ imports the handler by name
 │                          ▲   │             ├─ opens the workspace (once)
 └─ dispatcher thread ──────┘   │             └─ runs it, reporting progress
      claim ──> submit ─────────┼───────────────────────> execute
      settle <── future ────────┘
```

One thread claims, one pool runs. Claiming is a SQLite statement measured in
microseconds; running is a decode pass over five thousand files or an exporter
walking a manifest. `server/runner.py` used to do the second in a thread, which
is why this exists: CPU-bound work in the API process competes with request
handling for one GIL.

## What is queued today

| Type | Handler | Launched by |
| --- | --- | --- |
| `ingest.resume` | `visionset/jobs/ingest.py` | `POST /sources/{id}/ingest-jobs`, `POST /ingest-jobs/{id}/resume` |
| `export.release` | `visionset/jobs/export.py` | `POST /releases/{id}/export` |
| `inference.download_weights` | `visionset/jobs/weights.py` | `POST /inference/connections/{id}/download` |
| `inference.check_integrity` | `visionset/jobs/integrity.py` | `POST /inference/connections/{id}/check-integrity` |
| `annotation.pre_label` | `visionset/jobs/prelabel.py` | `POST /batches/{id}/pre-label`, `POST /projects/{id}/batches/pre-label` (one row per batch) |

The last three are why the throttled progress below matters: a weight download is
gigabytes, an integrity check reads every byte of them, and pre-labeling is one
forward pass per untouched asset, so all three report for minutes rather than
seconds. `processed` and `total` are counted in **assets** for pre-labeling, where
the other two count bytes and files. None of the three CLI equivalents queues:
`visionset inference download`, `visionset inference check-integrity`, and
`visionset batch pre-label` run their shared bodies inline because a terminal has no worker.

They are also the only three launchers that **join a run instead of starting a
second one**: asked for a kind this connection or this batch already has queued
or running, the route answers with that job. It is the route's own read of the
queue rather than anything `enqueue` does, so every other launcher above queues a
fresh job each time it is asked — and because nothing brackets the read and the
enqueue, even these three coalesce the ordinary repetition rather than
guaranteeing uniqueness. `docs/content/inference.md` and `docs/content/batches.md` say what that
buys and what it deliberately does not refuse.

Verify, publish, promote and thumbnail backfill are still synchronous. They are
future job types, not an oversight - each answers inside its request today and
nobody has been made to wait.

## The decisions, and why

**`spawn`, pinned.** `fork` is disqualified rather than discouraged: the metadata
store keeps a live pooled SQLite connection, and a forked child that inherits an
open handle can corrupt the file. Pinning the context also makes Linux behave
like macOS and Windows - and like Python 3.14, where `spawn` becomes the default
 - so CI exercises what a laptop runs.

**One worker by default.** SQLite has a single writer and a run writes progress
as it goes. `VISIONSET_JOB_WORKERS` takes a larger number and the contention
degrades to `WorkspaceBusy`, which is a 503 with `Retry-After` and defined
behaviour - but the shipped default is one, and that is a property of the store
rather than a conservative guess.

**Same database.** The queue is a table in `visionset.db`. A second file would
mean a second family of WAL sidecars to enumerate, a second thing to copy when
somebody backs a workspace up, and a second place for `format_version` to be
wrong. What it would buy is relief from contention between the dispatcher's poll
and the work - and the poll is a *read*, which WAL already makes free of the
writer.

**The claim is one guarded `UPDATE`.** `UPDATE job SET state='running' ... WHERE
id = ? AND state='queued'`, and `rowcount` is the answer. The same shape
`UnitOfWork.set_asset_progress` uses, for the same reason: a read followed by a
write has a window a second dispatcher fits into, and the symptom is one job run
twice with one row to report it. There is no version column, because the
contended datum *is* the state.

**No lease, no heartbeat.** A `running` row observed at startup - before this
process has started anything - belongs to a process that is gone, so
`sweep_orphans()` is exact rather than heuristic. That is licensed entirely by
how VisionSet is deployed: one server process owns every worker. A queue shared
by several servers needs both, and needs them in *its* adapter.

**A retry is a new row.** `BACKGROUND_JOB_TRANSITIONS` has no `failed → queued`
edge, which is the one deliberate difference from `INGEST_TRANSITIONS`. An ingest
job resumes on its own row because a run is the same unit of work continuing;
here `attempt` on one row would have to mean two different things, and a list of
jobs would hide a history behind a single line. So the orphan sweep re-enqueues
an idempotent job as a fresh one, and a list shows the crash *and* the recovery.

**The `job` table has no `project_id`, and no foreign key at all.** Settled, not
outstanding - it is the thing about this schema most likely to read as an
oversight, so: do not add one.

A job is *workspace-scoped execution plumbing*. What a job is **about** lives in
its `payload`, keyed by id, and different types are about different things: an
export is about a release, an ingest about an ingest job, the next one about
something else again. A `project_id` would be null for some types and wrong for
others, and a column that is sometimes meaningless is one every reader learns to
distrust.

The keyless half is load-bearing. Under `PRAGMA foreign_keys = ON` a key means a
cascade, and a cascade here would delete the record of work that already
*happened*: "this export ran and here is where it put the archive" stays true
after the release is gone, and a job row outliving its subject is the behaviour
rather than a leak. It also leaves this the one table a later migration can widen
freely - a column carrying a foreign key cannot arrive by `ALTER TABLE` in
SQLite, so a table with no keys never needs the rebuild that `_tables.py`
documents for everything else.

What it costs, stated: there is no `GET /projects/{id}/background-jobs` and there
cannot be one without reading payloads. Nobody has asked. If somebody does, the
honest shape is a nullable, unindexed, **no-key** `scope` column written by
whoever enqueues - not a foreign key.

**Cancellation is cooperative.** A queued job is cancelled outright; a running
one is only *told*, and its handler decides where stopping is safe. Nothing is
killed mid-statement, because a handler halfway through writing rows would leave
a workspace no reader could interpret. A handler that never asks simply cannot be
cancelled once it starts, which is an honest thing for a short job to be.

**Progress is throttled.** At most one write per `VISIONSET_JOB_PROGRESS_MIN_INTERVAL_S`
(half a second by default). `IngestService._record_progress` writes after every
item and argues, correctly for its own case, that no cadence constant suits both
five files and fifty thousand - but that argument held while exactly one thread
ever wrote. The final numbers never depend on the throttle: they come off the
outcome, precisely because the last item's write is the one most likely to be
swallowed.

## Handlers

```python
def run(
    workspace_root: Path, payload: dict[str, JsonValue], reporter: ProgressReporter
) -> dict[str, JsonValue]: ...
```

Three arguments, and each is what it is because of the process boundary:

- **A path, not a `WorkspaceService`.** Measured against a real workspace, the
  service, the store, the SQLAlchemy engine, the auth provider and every kernel
  service fail to pickle - each transitively holds an engine whose `connect` is a
  closure. `visionset.jobs.context.workspace_for(root)` is the one line that turns
  the path back into a handle, and it caches one **per worker**, because
  `WorkspaceService.open` runs the pragmas, the migration check *and* a full
  schema reflection.
- **Plain JSON data, not domain models.** The payload has crossed a database
  column by the time a handler sees it.
- **A reporter, not a queue.** A handler may say how far it has got and ask
  whether to stop, and must not be able to settle itself.

The return value is the job's `result`: small, JSON-shaped, and read by whoever
polls. Anything large belongs in the blob store with its hash in there.

Handlers are registered by **import string**, never by function object, and
resolved in the worker. A function object would have to pickle by reference into
an interpreter that imported nothing, and the failure mode is an `AttributeError`
inside a pool with no job id in the traceback.

### Adding one

1. Write `run` in a new module under `visionset/jobs/`.
2. `register(HandlerRef(type=…, func=f"{__name__}:run", idempotent=…))` at module
   scope, and a `payload_for(...)` beside it so one place names the payload's keys
   and the same place reads them.
3. Import the module from `visionset/jobs/__init__.py` - **the registry is
   populated by import**, so a type is known because something named it.
4. Launch it from the route that owns the resource. There is no generic launch
   route, deliberately.

`idempotent` is the whole retry policy, and it is one boolean because the only
decision is whether running the work twice is safe. All five of today's are, and
each had to argue it in its own module.

## Why `visionset.jobs` is not in the kernel

The export handler resolves an `Exporter` through `visionset.formats.registry`,
and import-linter forbids `visionset.kernel` from importing it - the same wall
that makes `ReleaseService.export` take an instance rather than a format name. So
handlers sit one package out, beside `visionset.formats` and `visionset.wire`.

A second contract keeps them out of the delivery packages, and that one is
load-bearing under `spawn`: a worker importing `visionset.server` would
re-execute its module-level `app = create_app()` and build a second application
inside a worker.

The kernel still owns the vocabulary - `JobQueue` and `ProgressReporter` are
ports, `BackgroundJob` is a domain model, `SqliteJobQueue` is a kernel adapter.
What lives in `visionset.jobs` is *what the work is* and *where it runs*.

## Settings

The repository's first `pydantic-settings` object, `server/settings.py`, and
server-side only - the executor takes these as plain constructor arguments, so
nothing below the delivery layer reads an environment variable.

| Variable | Default | What it is |
| --- | --- | --- |
| `VISIONSET_JOB_WORKERS` | `1` | Worker processes. See "one worker by default". |
| `VISIONSET_JOB_POLL_INTERVAL_S` | `0.5` | How long the dispatcher sleeps with nothing to claim. An enqueue wakes it immediately, so this only governs the case nobody is watching. |
| `VISIONSET_JOB_PROGRESS_MIN_INTERVAL_S` | `0.5` | How often a running job may touch its row. |

The four pre-existing bare `os.environ` reads stay where they are; migrating them
is a change to four shipped surfaces for no behaviour.

## Events

`BackgroundJobSucceeded` and `BackgroundJobFailed` are published by the
**dispatcher**, in the API process, when a future resolves. That placement is the
point: a handler runs in another process where the bus is a different object with
no subscribers, so an event it published would reach nobody. A cancellation
announces nothing - it is something a person just did through an API that already
answered them.

## Limits, stated

- **No priorities.** The queue is oldest-first. Nobody has asked, and adding a
  column now would mean every future caller choosing a number for no reason.
- **No scheduled or recurring jobs.** A job exists because a request made one.
- **No hard cancellation.** See above.
- **No cross-process events.** A durable outbox is pro/multi-node territory.
- **No artifact retention policy.** What a job leaves in `<workspace>/exports/`
  stays there until somebody deletes it - no TTL, no size cap, no sweeper, and no
  `DELETE` route. Deliberate: the disk is the user's, and it is the posture blobs
  and staged uploads already have. `docs/content/releases.md` and `docs/content/workspaces.md`
  argue it; a deployment that wants a policy owns one, over plain files.
- **No `project_id` on the `job` table**, and no foreign key at all. See "The
  decisions, and why" above - scoping lives in the payload, and a key would
  cascade away the record of work that already happened.
- **`ingest_job` and `job` coexist.** An ingest has two rows for one run: the
  `ingest_job` is the domain record and the wire contract, the `job` is execution
  plumbing. Collapsing them is a migration with its own wire-contract discussion.
  Progress for every job type introduced from here on lives on the `job` row.
