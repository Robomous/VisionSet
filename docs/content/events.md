# Events

Subscribe to events to react to work performed in the current process. Domain services publish
events after committing their changes. The in-process bus calls subscribers synchronously and
keeps no delivery history.

```python
from visionset.kernel.domain import BatchApproved, DomainEvent, ReleasePublished
from visionset.kernel.services import BatchService, WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    workspace.event_bus.subscribe(BatchApproved, lambda e: print("approved", e.batch_id))
    workspace.event_bus.subscribe(DomainEvent, audit_log)  # everything

    BatchService(workspace).approve(batch.id)  # prints, after the transaction commits
```

## Subscriptions are by type

`subscribe(BatchApproved, handler)` narrows what the handler is handed; `subscribe(DomainEvent,
handler)` is the catch-all, because the bus matches with `isinstance` and every event derives
from `DomainEvent`. A topic string would put the same information somewhere the type checker
cannot read it, and a handler would have to re-check what it received.

Delivery is **registration order**. That is not a claim about causality or priority - it is
simply the only order that is reproducible, said out loud so nobody infers a scheme from it.

## Two rules, and they are the whole contract

### Emission happens after the commit

Every emitting domain service follows the same pattern: the work happens inside `unit_of_work()`, the result
is bound to a local, the block exits - which is where SQLite actually commits - and only then is
the event published.

```python
with self._workspace.unit_of_work() as uow:
    ...
    approved = uow.batches.update(...)

self._workspace.event_bus.publish(BatchApproved(...))
return approved
```

Two things follow, and both matter more than they look:

- A subscriber can never see work that was rolled back. An event is only ever about a
  transaction that succeeded.
- A subscriber cannot *cause* a rollback. By the time it runs there is no open transaction for
  its exception to land in.

`ReleaseService.publish` publishes after its `except ConstraintViolated` clause, not merely after
the `with`: a lost tag race surfaces at commit time, so announcing any earlier would announce a
release that does not exist.

### A subscriber that raises is contained, but not silenced

`InProcessEventBus` runs each handler inside `try/except Exception`. A handler that raises is
logged with its traceback, the handlers registered after it still run, and `publish` returns
normally. `BaseException` is deliberately not caught - a `KeyboardInterrupt` is the operator
talking, and swallowing it would make Ctrl-C depend on whether an event happened to be in flight.

There is no circuit breaker. A subscriber that failed on one event is offered the next one:
at-most-once is a property of each delivery, not a verdict on the subscriber.

The log is the kernel's only logger, `visionset.kernel.adapters.in_process_event_bus`. It is
never configured here - a library that calls `basicConfig` has taken a decision belonging to the
program embedding it, so the CLI, the REST server and MCP each set up handlers for themselves.

## At most once

No retries, no queue, no persistence, no outbox. An event whose subscriber raised is gone, and so
is one the process died before delivering. That is a deliberate ceiling rather than an oversight:
making delivery reliable means making it durable, which means a table, which means a second
source of truth about what happened beside the one the transaction already wrote.

Anything needing more wants a durable bus, and the `EventBus` port can front one later without a
single caller changing. Until then, **a subscriber must not be the only thing that knows
something**. Anything load-bearing is derived from the store, the way batch completion and
annotation progress already are.

## The events

Every event carries `id`, `name`, and `occurred_at`. The timestamp is normalized to UTC and
requires a time zone. Event models are frozen and serialize to JSON. Sequence fields such as
`asset_ids` are tuples. The success event for a background job also carries a JSON result mapping.

| Event | Emitted by | Carries |
| --- | --- | --- |
| `BatchApproved` | `BatchService.approve` | `batch_id`, `project_id`, `schema_version`, `job_ids`, `asset_count` |
| `BatchCompleted` | `BatchService.complete` or `BatchService.finish` | `batch_id`, `project_id`, `asset_count` |
| `AnnotationsWritten` | `AnnotationService.add` / `enter_unreviewed` / `update` / `delete` | `job_id`, `batch_id`, `operation`, `asset_ids`, `annotation_ids` |
| `ReleasePublished` | `ReleaseService.publish` | `release_id`, `dataset_id`, `project_id`, `tag`, `manifest_hash`, `schema_version`, `asset_count`, `annotation_count` |
| `IngestCompleted` | `IngestService` | `ingest_job_id`, `project_id`, `source_id`, `asset_count` |
| `BackgroundJobSucceeded` | Background job dispatcher | `job_id`, `job_type`, `processed`, `result` |
| `BackgroundJobFailed` | Background job dispatcher | `job_id`, `job_type`, `error`, `attempt` |

`AnnotationsWritten` is one per **call**, not one per box: all four writes are all-or-nothing
over a whole payload, so one call is one thing that happened. `enter_unreviewed` reports `add` when it writes labels and `delete` when replacement only removes labels. Its `asset_ids` are
deduplicated - several boxes on one image are one asset touched.

`ReleasePublished` carries `manifest_hash` so a subscriber can read the entire frozen snapshot
out of the blob store without being handed it. It is also why publishing writes no
[dataset change-log](datasets.md) entry: the log records mutations of the trunk, and publishing
mutates nothing in it. "A release happened" is an event.

`IngestCompleted.asset_count` includes both asset rows created by the run and existing assets
matched by content. It counts the assets returned by the run, which can complete without
creating a batch.

If the server runs ingestion in a worker process, the worker has its own bus. Subscribers in
the API process can observe the background-job outcome on the dispatcher bus. See
[Background jobs](background-jobs.md#events).

### `name`, and why it is two types

`name` is a plain `str` on `DomainEvent` and a narrowed `Literal` default on each subclass. A
*writer* therefore cannot misspell one, while a *reader* holding a payload some later VisionSet
emitted can still load it as a `DomainEvent` and see what it was called. It is the same split as
[`DatasetChange.operation` vs `DatasetOperation`](datasets.md), for the same reason: a record
outlives the build that wrote it.

## Composition

The bus is the third port on the [workspace](workspaces.md), beside the metadata store and the
blob store, and it is reached the same way - `workspace.event_bus`. So a service still takes one
dependency, and `WorkspaceService` is still the only module in the kernel that names an adapter.

One bus per open workspace, built by `event_bus_factory` on `init`/`open`. Never a module-level
singleton: two workspaces open in one process must not share subscribers, and reopening a
workspace must not inherit the last one's.

```python
workspace = WorkspaceService.open("./road-signs", event_bus_factory=lambda: my_bus)
```

The bus is not closed by `WorkspaceService.close()` and has nothing to close - it holds a list of
callables. Only the database keeps a connection.

## What is deliberately not here

- **No persistence.** Events are not rows, there is no migration, and `format_version` is
  untouched by this. An event log would be a second account of what happened beside the one the
  transaction wrote.
- **No async, no threads.** `publish` calls handlers on the caller's thread and returns when they
  are done. A slow subscriber slows the call that emitted the event - which is a reason to keep
  subscribers cheap, and a reason a durable bus is the eventual answer for anything that is not.
- **No ordering guarantee beyond one process.** Registration order within one bus is all that is
  promised.
- **No event on every operation.** Creating a project, renaming one, promoting into the trunk and
  starting a batch emit nothing. The five above are the ones something outside the kernel has a
  reason to react to; the rest can be added when a subscriber wants them, rather than in advance.
