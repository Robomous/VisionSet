# jobs

[`src/visionset/jobs/`](../../../../src/visionset/jobs/) holds the handlers for work
such as ingest, export, weight download, integrity checks, pre-labeling, and
thumbnail backfill. The REST API queues that work for a worker. Some CLI commands
and MCP tools run the same work inline.

## Launch and poll

```mermaid
sequenceDiagram
    participant C as Client
    participant R as REST API
    participant Q as JobQueue (SQLite)
    participant W as worker process
    participant H as handler

    C->>R: POST …/export
    R->>R: refuse what a request can refuse
    R->>Q: enqueue
    R-->>C: 202 + Location
    Q->>W: spawn
    W->>H: run
    H->>Q: progress, then a result
    loop until settled
        C->>R: GET /background-jobs/{id}
        R->>Q: read job
        Q-->>R: state and progress
        R-->>C: state, processed / total
    end
```

The export route checks consent before enqueueing, so the caller receives a
409 from the launch request. The worker checks consent again when it runs the
export.

**There is no generic launch route.** Nothing creates a job by naming a type and a
payload: an export is launched from `POST /releases/{id}/export`, an ingest from
`POST /sources/{id}/ingest-jobs`. A generic endpoint would be a remote-code
surface with a token in front of it, and the payloads are internal contracts that
would become public the day one shipped.

## Where it sits

`visionset.jobs` may not import `visionset.server`, `visionset.cli`,
`visionset.mcp`, `fastapi`, `typer` or `uvicorn` - the `Job handlers are below the
surfaces` contract.

The reason is sharper than layering. A handler runs in a worker the dispatcher
started with `spawn`, so the child imports whatever the handler names. If it named
`visionset.server`, the child would re-execute that module's `app = create_app()`
and build a **second application** - with its own workspace handle and its own
dispatcher - inside a worker.

The kernel, in turn, may not import `visionset.jobs`: a handler resolves a format
plugin, so `jobs` imports `formats`, and a kernel that could reach a handler could
reach a plugin through it. It is also what keeps `SqliteJobQueue` unable to resolve
a job type, which is why `UnknownJobType` is raised outside the kernel.

`visionset.jobs` imports `visionset.tracking` to record each execution attempt as a
run, and never the reverse: tracking knows nothing about jobs, and what crosses into
a worker is the tracking settings, not a client. See
[experiment tracking](../../tracking.md#background-jobs).

## Related

[`docs/content/background-jobs.md`](../../background-jobs.md) is the executor itself: the
`JobQueue` port, the SQLite queue, the dispatcher, and the handler contract. It is
a different thing from [`docs/content/jobs.md`](../../jobs.md), which is *human* annotation
work.
