# The REST API

The REST surface is a thin SDK client: each route parses input, calls one service, and shapes
the output. This document covers the parts of the contract shared by all endpoints, including
the failure format and how clients should interpret it.

The routes themselves are described by [`openapi.json`](../../openapi.json) at the repo root, which
is generated (`uv run python scripts/export_openapi.py`) and diffed in CI. Never hand-edit it.

For a worked external client, [`examples/http_end_to_end.py`](../../examples/http_end_to_end.py) starts
`visionset server` on a free port and drives the whole cycle - upload, launch-and-poll ingest,
annotate, promote, publish, verify, export - with `urllib` and a bearer token, and nothing else. It
is deliberately dependency-free: a contract only a smart client can drive is not really a contract.

## Authentication

Every endpoint except `/health` requires a workspace API token:

```
Authorization: Bearer vst_hK3n...
```

Missing, malformed, unknown and revoked are one identical **401** with a `WWW-Authenticate:
Bearer` challenge - deliberately indistinguishable, so a client cannot use the response to probe
which credentials exist. Tokens come from `visionset token create`; the server serves the single
workspace named by `VISIONSET_WORKSPACE`, and one pointed at something else answers 500
`NOT_A_WORKSPACE`. See [auth.md](auth.md) for the whole picture, including how to build a
protected route.

## Conventions

Decided once, by the project and schema endpoints, and inherited by every endpoint after them.

**Paths.** Plural collection nouns, and a sub-resource nested under whatever owns it:

```
POST   /projects
GET    /projects
GET    /projects/{project_id}
PATCH  /projects/{project_id}
DELETE /projects/{project_id}
GET    /projects/{project_id}/stats                       everything ingested
GET    /projects/{project_id}/assets                      paged, every asset
GET    /projects/{project_id}/schema                      the version in force
POST   /projects/{project_id}/schema/versions
GET    /projects/{project_id}/schema/versions
GET    /projects/{project_id}/schema/versions/{version}
GET    /projects/{project_id}/schema/compare             ?from=&to=
POST   /projects/{project_id}/schema/preview             would this publish?
POST   /projects/{project_id}/schema/blocking-assets     paged, what is in the way
GET    /projects/{project_id}/schema/drafts/{kind}        curated or annotation
PUT    /projects/{project_id}/schema/drafts/{kind}        409 STALE_WRITE
DELETE /projects/{project_id}/schema/drafts/{kind}
POST   /projects/{project_id}/schema/drafts/{kind}/publish
POST   /projects/{project_id}/sources/images              multipart
POST   /projects/{project_id}/sources/video               multipart
GET    /projects/{project_id}/sources
GET    /sources/{source_id}
POST   /sources/{source_id}/ingest-jobs                   launch
GET    /sources/{source_id}/ingest-jobs
GET    /ingest-jobs/{job_id}                              poll
POST   /ingest-jobs/{job_id}/resume
GET    /projects/{project_id}/assets/{asset_id}
GET    /projects/{project_id}/assets/{asset_id}/content   bytes
GET    /projects/{project_id}/assets/{asset_id}/thumbnail bytes
GET    /projects/{project_id}/assets/{asset_id}/batches    which batches carry it
GET    /projects/{project_id}/batches
POST   /projects/{project_id}/batches                     curate one by hand
GET    /batches/{batch_id}
DELETE /batches/{batch_id}                                ?confirm=true
POST   /batches/{batch_id}/approve                        with a partition spec
POST   /batches/{batch_id}/start
GET    /batches/{batch_id}/pre-label?connection_id=&geometries=   the classes a run would ask for, and the shapes it writes
POST   /batches/{batch_id}/pre-label                      launch over every open job of the batch; one row per open job
POST   /projects/{project_id}/batches/pre-label           launch over every open batch, or the named ones; one row per open job
POST   /batches/{batch_id}/repin                          ?allow_destructive=
POST   /batches/{batch_id}/complete
POST   /batches/{batch_id}/corrections                    a new batch over a completed one
GET    /batches/{batch_id}/jobs
GET    /batches/{batch_id}/assets                         paged; ?progress=&sort=&job=
POST   /batches/{batch_id}/assets                         draft only
DELETE /batches/{batch_id}/assets?id=&id=                 draft only
GET    /jobs/{job_id}
GET    /jobs/{job_id}/progress
POST   /jobs/{job_id}/start
POST   /jobs/{job_id}/complete
POST   /jobs/{job_id}/pre-label                           launch over one job; replace_model_labels redoes an earlier pass, geometries narrows the shapes
GET    /jobs/{job_id}/next                                the next n waiting assets
PUT    /jobs/{job_id}/assets/{asset_id}/progress
GET    /jobs/{job_id}/assets/{asset_id}/annotations
POST   /jobs/{job_id}/annotations                         bulk, all-or-nothing
PATCH  /jobs/{job_id}/annotations                         bulk, all-or-nothing
DELETE /jobs/{job_id}/annotations                         ?id=&id=
GET    /projects/{project_id}/dataset                     the one trunk
GET    /datasets/{dataset_id}
GET    /datasets/{dataset_id}/stats
GET    /datasets/{dataset_id}/assets                      paged
GET    /datasets/{dataset_id}/assets/{asset_id}/annotations  the trunk's view of one member
DELETE /datasets/{dataset_id}/assets/{asset_id}           curation, not deletion
GET    /datasets/{dataset_id}/changes
POST   /batches/{batch_id}/promote                        the one gate into the trunk
POST   /datasets/{dataset_id}/releases
GET    /datasets/{dataset_id}/releases
GET    /releases/{release_id}
GET    /releases/{release_id}/manifest                    bytes
GET    /releases/{release_id}/verify
GET    /releases/{release_id}/assignment
GET    /releases/{release_id}/export-compatibility        ?format=
POST   /releases/{release_id}/export                      ?format=&allow_lossy=, launch
GET    /formats

GET    /inference/connections
POST   /inference/connections
GET    /inference/connections/{connection_id}
PATCH  /inference/connections/{connection_id}
DELETE /inference/connections/{connection_id}             no confirmation gate
POST   /inference/connections/{connection_id}/download    launch
POST   /inference/connections/{connection_id}/check-integrity   launch
GET    /inference/download-size                           ?model_id=&model_revision=
GET    /inference/providers                               which models the installation can run
POST   /inference/suggest                                 a shape under some points

GET    /background-jobs                                   every launched job
GET    /background-jobs/{job_id}                          poll
GET    /background-jobs/{job_id}/artifact                 bytes
POST   /background-jobs/{job_id}/cancel

GET    /health                                            the one route needing no token
```

Two families sit outside the project tree, and both are workspace-scoped for the same
reason: an [inference connection](inference.md) carries no project id — every project uses
the same ones — and a [background job](background-jobs.md) is about whatever its payload
names, which for different job types is a different resource. `/health` is outside it
because it answers before any workspace has been resolved.

A project's dataset is reached at a **singular** path, because the relation is 1:1 and there is
no collection to list. `POST /batches/{id}/promote` sits under the batch rather than the dataset
because `DatasetService.promote` takes a batch id and derives everything else from it - a
`dataset_id` in front would be a segment no service ever checks, and a path parameter nobody
validates is a lie a client will eventually rely on.

The active schema is the collection's **parent**, not a member of it, because "in force" is a
property of the schema rather than a version number a client could guess.

**There are three asset listings, and they window different things.**
`GET /projects/{id}/assets` is every asset the project holds;
`GET /batches/{id}/assets` is one work unit's, in membership order;
`GET /datasets/{id}/assets` is the curated trunk's. A project page reads the first, a gallery
the second, a release the third.

**One job's frames are the batch listing narrowed, not a listing of their own.** `?job=` keeps
the assets that job carries, composing with `progress` and `sort`, and `total` is the size of
what matched; a job the batch does not have is 404 `JOB_NOT_FOUND`, resolved after the batch
itself, and a draft - which has no jobs - matches nothing rather than refusing. A
`/jobs/{id}/assets` of its own would be a fourth window onto assets a batch already indexes by
job, and two addresses for one page is two places paging, sorting and filtering can drift.

The project listing is **ordered by arrival, newest first**, which `Asset.ingested_at` is what
made possible: until that field existed nothing recorded when an asset arrived, and the listing
was deterministic but arbitrary. A whole ingest run shares one timestamp, so *within* a run the
order falls through to the one that means something — grouped by source, then by frame index
within a clip, then by path, then by id, so a clip's frames come back in order and a directory's
stills in filename order, and two calls can never disagree.

**An asset with no recorded arrival sorts last.** That is every asset ingested before
`Asset.ingested_at` existed, and it cannot be backfilled — the information exists nowhere, and `Source.registered_at` is not
the proxy it looks like, because registration is idempotent on `(kind, path, extraction_fps, ranges)`
and is never rewritten. Sorting them last is the only reading that degrades quietly: treating
the missing value as the epoch invents a date, and treating it as *now* would pin the oldest
rows in the product to the top of a "recent" list forever. A workspace that has ingested nothing
since upgrading therefore looks exactly as it did before.

**`ingested_at` is on every asset payload, and null still means *unknown*.** Until #283 the
field decided the project listing's order and reached no client at all - the only thing that
crossed the boundary was the project-level aggregate, `ProjectStats.last_ingest_at`. It is now
on `AssetOut`, and therefore on `BatchAssetOut`, which inherits it. A client deriving an age
from it renders three states rather than two: a moment, and *unknown*, which is neither a
moment nor zero. The batch view's header is the first caller.

**There are two stats endpoints, and they disagree on purpose.**
`GET /projects/{id}/stats` counts every asset ingested into the project, whatever batch it
landed in; `GET /datasets/{id}/stats` counts the curated trunk, which an asset reaches only by
being promoted out of a completed batch. A project mid-annotation has assets in the first and
none in the second, and both numbers are true - they answer "what does this project hold?" and
"what would I train on?", which are different questions. Neither is derivable from the other, so
a client showing a project page reads the first and a client shaping a release reads the second.

Three smaller rules the project's stats carry: `class_count` is what the **active schema version
declares**, so a project that has authored an ontology and labeled nothing still reports its
classes, while `classes` lists only the ones somebody has used; `annotated_pct` is **`0` for
a project with no assets**, never `null` and never an error; and `last_ingest_at` is the newest
`Asset.ingested_at` in the project, **`null` when unknown**. Null there means *unknown*, not
*never*: a project whose assets all predate the field reads null, and so does an empty one, and the
two are deliberately not distinguished because no caller can act differently on them. A count
has an honest identity element and a date does not, which is why this one is not defaulted the
way `annotated_pct` is.

A **collection** hangs off whatever owns it; an individually addressable **resource** does not.
A source belongs to one project, so listing and creating happen under it - but a source has an
id of its own, and nesting `/projects/{p}/sources/{s}/ingest-jobs/{j}` would put four segments
in front of a job that one id already identifies. A schema version has no such id, which is why
it stays nested all the way down.

**Ids are UUIDs**, canonical hyphenated form, in the path. One deliberate exception: a **schema
version is an integer 1..N**, because that is the handle the domain itself uses - an annotation
records `schema_version`, and a batch pins one at approval. A malformed UUID never reaches a
service, so it is a **422 `VALIDATION_ERROR`** and not a 404: the request could not have named
anything.

**Collections answer with an envelope**, never a bare array:

```json
{ "items": [ { "id": "…", "name": "road-signs", "description": null } ], "total": 1 }
```

An array cannot grow a field without breaking every client that parsed it. `total` means
*matching the query* rather than *in this page*, which is exactly what let paging arrive on one
route without moving the shape everything else already spoke. An empty collection is
`{"items": [], "total": 0}` and a 200, never a 404.

**Paging is on the asset listings and nowhere else** - `GET /projects/{id}/assets`,
`GET /batches/{id}/assets`, `GET /datasets/{id}/assets` and
`POST /projects/{id}/schema/blocking-assets`. What they have in common is that their size is a
property of how many frames somebody ingested rather than of how many things somebody made: an
ingest can fill a batch with fifty thousand, the trunk accumulates every batch a project ever
completed, and the last of them is a *subset* of the first - the frames in the way of one
narrowing, which is bounded by nothing but the project. It bounds the *response*, not
the read. The kernel has no windowed read, so `limit` and `offset` slice a list that was fetched
whole - worth doing, because a batch of fifty thousand frames must not be sent to a gallery in
one body, but not a cheap query and not advertised as one. Every other collection is small by
construction and gets these parameters when a caller shows up rather than in advance. Because
`total` is the size of the whole collection, a client pages until it has seen `total` items; an
offset past the end is an empty page and a 200. When the read itself starts to cost, the fix is
a windowed method on the persistence port and none of this contract moves.

**Gates are query parameters; bodies carry content.** Destroying data needs `?confirm=true`, and
narrowing a schema needs `?allow_destructive=true`. Neither is a body field, so recovering from
the 409 is resending the *identical* request with one extra parameter. The route does not
pre-check either one: the flag goes to the SDK and the SDK's refusal is what carries
`CONFIRMATION_REQUIRED` or `DESTRUCTIVE_SCHEMA_CHANGE`.

**A stateful resource declares what it allows.** `BatchOut`, `JobOut` and `BatchAssetOut` each
carry `allowed_actions` - a list of names, closed and published in the spec as `BatchAction`,
`JobAction` and `AssetAction`.

```
GET /batches/{id}   →  { "state": "in_annotation",
                         "allowed_actions": ["complete", "repin", "delete"], … }
```

**A capability nothing can perform is withdrawn, not declared.** The rule above cuts both ways:
if a client must render what the wire declares, the wire may only declare what some surface can
actually do. `BatchAction.DELETE` was withdrawn for exactly that reason in #331 - the rule and
the service method were real, the route was not - and came back in #376 together with
`DELETE /batches/{id}`, its MCP tool and its controls, which is the condition the withdrawal
set. `tests/architecture/test_capability_reachability.py` is what now measures it: every member
of `BatchAction` is resolved against the published paths and the MCP tool listing, computed from
the enum rather than from a list somebody maintains.

**What a resource *is* is a second declaration, and not the same question.** `ConnectionOut`
carries `capabilities` beside its `allowed_actions`: an action is something you may do **to** the
connection and is decided by its state, a capability is what its model **answers** and is decided
by the weights. Offering a tool needs both - a connection being `ready` says its files are here,
not that they are the right kind of model - and either list may be empty without the other being.

```
GET /inference/connections/{id}  →  { "setup_state": "ready",
                                      "allowed_actions": ["download_weights", …],
                                      "capabilities": ["point_suggest"],
                                      "produces": ["bbox", "polygon"], … }
```

`produces` is the third declaration on the same row: the shapes the model answers in, sorted
by value, empty exactly when `capabilities` is. `origin` sits beside them and is not a
declaration but a fact about the weights - `huggingface`, `custom` or `robomous`, a closed
vocabulary like the kind's - set on creation and derived from the kind when the request does
not say.

An empty `capabilities` is not a refusal to act on: the server judges every request on its own
either way. It says only that nothing can yet rely on this connection for a particular tool -
because its weights never arrived, because its config declared a model type no installed driver
serves, or because it is an `http` connection nobody has asked yet - see [Asking an endpoint
what it answers](inference.md#asking-an-endpoint-what-it-answers).

**A client renders these; it never computes them.** Re-deriving the rules from `state` and
`progress` is what the browser used to do, and its copy drifted by dropping the batch-state
dimension - which is why skipping a frame was offered on a batch the kernel refused every write
into. If an action you need is missing, the fix is in the projection, never a second copy of the
rule.

The declarations come from `kernel/domain/capabilities.py`, which reads the same transition
tables and named sets the services enforce with;
`tests/kernel/test_capabilities.py` drives both halves over a real workspace for every reachable
state, so the two cannot move apart.

Two of them are worth reading precisely:

- **`complete` on a batch is declared from the transition table alone**, so it can still answer
  409 `BATCH_NOT_COMPLETE`: completion is derived from the jobs, which is a read the projection
  does not make. Read it as *this batch is at the point where completing is the next move*. A
  job's `complete` carries no such caveat - a job ships its own per-asset tally, so the
  `SETTLED_PROGRESS` condition is applied.
- **`annotate` on a batch asset is the right to write labels**, not a progress move: it is
  declared exactly when `POST /jobs/{id}/annotations` will be accepted. An annotator deciding
  whether to open in edit mode should read this rather than infer it.

An empty list is normal and means what it says. Every asset of a `completed` batch declares
nothing, because nothing may be written into a batch that has closed.

**Statuses.** 201 with the created resource in the body; 200 for a read or an update; 204 with an
empty body for a delete. And **202 when the work has not happened yet** - see below.

**A long operation is launched and then polled.** Ingest is the first one, and the shape it set
is the one every later long operation uses:

```
POST /sources/{id}/ingest-jobs   →  202 Accepted
                                    Location: /ingest-jobs/{job_id}
                                    { "id": …, "state": "pending", "processed": 0, … }

GET  /ingest-jobs/{job_id}       →  200 { "state": "running",   "processed": 12, … }
GET  /ingest-jobs/{job_id}       →  200 { "state": "completed", "batch_id": …,   … }
```

Export follows the same shape, over the generic surface #328 added:

```
POST /releases/{id}/export?format=yolo   →  202 Accepted
                                            Location: /background-jobs/{job_id}

GET  /background-jobs/{job_id}           →  200 { "state": "running",   "processed": 12, … }
GET  /background-jobs/{job_id}/artifact  →  200 application/zip
```

The two surfaces are separate because they describe different things. An ingest job knows what it
is *about* - a source, a batch - and publishes those as fields a client can navigate. A background
job is about whatever its payload says, so it publishes `type` and `result` instead. What they
share is the progress shape, deliberately: `processed`, `total`, `failures` and `error` mean the
same thing on both, so a progress bar written against one renders the other unchanged. A
background job that failed on a declared error also carries `error_code` — the code the same
refusal answers under when it happens to a request — and `null` where the failure was anything
else; branch on it exactly as you would on an error body's `code`, never on the sentence.

**There is no `POST /background-jobs`.** What work means belongs to the resource it is about, so
every launch is on that resource. A generic route taking a type and a payload would be a
remote-code surface with a token in front of it, and every payload shape would become public the
day it shipped.

**202, not 201**: the row exists, the work does not. The row is what makes the id worth handing
back - it is written and committed before the response is sent, so the first poll always finds
something. That is also why anything the request can refuse is refused *synchronously*: an
unknown source is a 404 here rather than a 202 pointing at a job nobody wrote, and resuming a
`completed` run is a 409 here rather than a background no-op a client could not distinguish from
a redo. Everything that goes wrong *after* the launch is reported on the job - `error` for the
one fatal cause, `failures` for the per-item report - because by then there is no request left
to answer.

**Uploads are multipart, and the only non-JSON request shape.** Registering a source means
sending the bytes: one `files` part per image, or one `file` part plus `extraction_fps` — and
optionally `ranges`, a JSON array of half-open `{start_seconds, end_seconds}` stretches to
extract — for a clip. VisionSet sets **no size limit of its own** - parts are spooled to disk past 1 MiB
and streamed from there, so memory does not grow with the file - which means the real ceilings
are your reverse proxy's (`client_max_body_size` in nginx) and free disk. Uploaded bytes are
staged under `<workspace>/uploads/<digest>/` and, like blobs, are **never deleted**: a workspace
grows with what was offered to it, not only with what it kept. Re-uploading identical files
under identical names is free - it stages to the same path and returns the same source.

**Bytes are streamed, and their URLs are immutable.** Four responses are not JSON: an asset's
content and its thumbnail, a release's manifest, and an export's archive. Nothing is buffered
whole - the blob store hands back an open handle and the response walks it - so serving a
fifty-megapixel frame costs no more memory than serving a thumbnail.

All four are named by something content-addressed, so all four carry
`Cache-Control: public, max-age=31536000, immutable` and an `ETag` holding the hash. That is not
optimism: identity *is* content in VisionSet, so the bytes behind one of these URLs cannot
change. A client that cached one never needs to revalidate it.

The two asset routes take an **asset id**, not a content hash, and the issue that asked for them
said hash. A hash names bytes and says nothing about what they are, so a route keyed on one
could only answer `application/octet-stream` - which a gallery cannot put in an `<img>`.
Resolving a hash back to its asset would fix that and needs a query the persistence port
deliberately does not have: its whole surface is one `parent_id` filter, so *no query language
leaks into the port*. Widening it for a download route would be the tail wagging the dog, so the
hash ships as the `ETag` instead, which is where it was doing the real work anyway.

`Content-Type` on the content route is whatever the ingest actually probed. An asset written
before the pipeline recorded a format is served as `application/octet-stream`, because inventing
one would be worse than admitting it. A thumbnail is always `image/jpeg`. An asset with no
cached preview is `404 THUMBNAIL_NOT_CACHED` rather than an empty success - a preview is a cache
and reading one never renders one, so the remedy is a backfill and the code says so.

**Request bodies forbid unknown fields.** A misspelled key is a 422 `VALIDATION_ERROR`, never a
silently ignored one - a typo that looked like it worked is worse than a refusal.

**Only what a service can honour is on the wire.** `PATCH /projects/{id}` takes a name and nothing
else, because the SDK has no way to update a description. The API does not grow a field it would
have to fake.

**Response shapes are wire models, not domain models.** They live in `server/models.py` and are
written out field by field, so a field reaches a client because somebody published it and never
because somebody added it to an entity.

**One endpoint is a projection rather than a resource, and it is the exception that states the
rule.** `GET /home` composes the workspace's front page - totals across every project, the batch
to carry on with, what is waiting, and a feed derived from timestamps that already exist. It takes
no path parameters, has no verb but `GET`, and carries **no `allowed_actions`**: there is nothing
here to act on, only rows pointing at resources that declare their own capabilities. It exists
because the page it answers asks four questions that each span every project, and answering them
as separate resources would be a request per project per question.

**`resume` declares its own kind, and that is the field to read first.** `annotate` means
`next_asset_id` is a frame nobody has labeled, `review` means it is one awaiting a reviewer, and
`open` means the batch is settled throughout and `next_asset_id` is null - so the caller opens its
gallery rather than the editor. The three are in priority order and the order is resolved here: it
is a judgment about what somebody should do next rather than a fact the rest of the response
restates, and a client that worked it out again from the other fields would be keeping a second
copy of a rule that can drift. Contrast the first-run state, which is deliberately *not* a field
because `totals.projects` already answers it.

Batches are ranked by when somebody last worked them - the one work-dating timestamp in the
storage format. Ones nobody has worked since that became recordable rank last, ordered among
themselves by how far through they are, which is every batch in a workspace created before the
stamp existed: it was added without a backfill, because a moment that was never recorded cannot be
reconstructed. Such a workspace behaves as it did before and converges as soon as anybody uses it.

One further field is honest about a limit the storage format still imposes, and a client should
render it as described rather than as it might wish. An `ingest` activity entry is the newest
asset arrival in a project rather than one run finishing, because an ingest job records no times.

## Where the UI lives

The compiled application is mounted at **`/app`** and `/` redirects to it. `visionset server` starts
both halves with one command; see [cli.md](cli.md#visionset-server).

**The API owns the root, and that is why the app does not.** `/projects/{project_id}` is a shipped
route, so an application served from `/` could never claim `/projects/abc` as one of its *own*
client routes - the API route matches first and answers 404 `PROJECT_NOT_FOUND`. That is not
something a later milestone can lift; it is the consequence of an unprefixed API. The prefix costs
one `base` line in `frontend/app/vite.config.ts` today and a public URL migration if left later.

**Neither is in `openapi.json`, deliberately.** A static mount is not an operation, and `/` is
declared `include_in_schema=False`. The spec is the *REST* contract; where a browser finds HTML is
not part of it, and keeping it out is also what keeps the drift gate and the generated client still
across a change to how the UI is served.

**Nothing about the mount changes the API's answers.** A root-level catch-all would have - it
matches every path, so it beats the *partial* match that produces a 405, and it shadows any route
registered after the application is built. `POST /health` is still 405 `METHOD_NOT_ALLOWED`, and an
unknown path under the prefix is still a 404 in the one error body below.

**The deep-link fallback, since #58.** A client route like `/app/projects/abc` is resolved by the
router in the browser, but a *reload* on it is a real request for a path no file backs - so without
a fallback, refreshing any page but the index is a 404, and so is every bookmark. The index is now
served for a 404 under three conditions, and each keeps something alive:

| condition | what it protects |
| --- | --- |
| the path is under `/app/` | an unknown `/projects/nope` is still the API's own 404 - the same argument that put the bundle at `/app` |
| the method is `GET` | a `POST` to a client route is not a page load |
| `Accept` contains `text/html` | httpx and every other API client send `*/*`, so **the JSON 404 below is untouched** |

That substring test is why no other test in `tests/server` needed changing when the fallback landed:
an API client never claims to be a browser. The response is **200**, not 404 with a body - a page
that renders correctly must not claim to be missing.

It is installed by replacing the `HTTPException` handler and falling through to the normal one, not
as middleware: `@app.middleware("http")` wraps the application in `BaseHTTPMiddleware`, which buffers
a `StreamingResponse`, and four routes stream. And it is keyed on **Starlette's** `HTTPException`,
not FastAPI's subclass - the router raises the Starlette class for an unknown path and `StaticFiles`
raises it for a missing file, so keying on the subclass makes the fallback dead code for exactly the
two things that produce the 404 it exists for.

In a source checkout the bundle is absent until `pnpm bundle:static` runs, and `/` then answers a
404 naming that command. The API is unaffected.

## The error body

Every failure - a domain refusal, a missing route, a malformed payload, an unhandled bug -
arrives as one shape, declared in the spec as `ErrorBody`:

```json
{
  "code": "BATCH_NOT_IN_ANNOTATION",
  "message": "batch 3f2a… is approved, not in_annotation",
  "detail": null
}
```

| Field | |
| --- | --- |
| `code` | Stable and machine-readable. **This is what a client branches on.** |
| `message` | A sentence for a human. The wording is not part of the contract and may change. |
| `detail` | Extra structure, or absent. Its shape depends on the `code` - it is not uniform. |

### Branch on `code`, not on the status

Statuses are coarse by design, and two errors sharing one is normal. The case that makes this
concrete: `DESTRUCTIVE_SCHEMA_CHANGE` and `SCHEMA_CHANGE_WOULD_ORPHAN` are **both 409**. The
first is retryable - resubmit with `allow_destructive=true` and it succeeds. The second has no
override at all, because annotations already depend on what the change would remove. A client
that saw 409 and retried with the flag would loop forever against the second one. The kernel's
own error hierarchy is built to prevent exactly that loop; over HTTP, the `code` is the only
thing carrying that distinction.

## What decides the status

Three rules, not one per error.

**404 - the caller named something that is not there.** A project, batch, job, asset, source,
dataset, annotation or release that was never created, was deleted, or belongs to a different
workspace. Cross-scope references read as *missing*, never as *forbidden*: an asset in another
project is a 404, not a 403. `NO_SPLIT_RECIPE` is here too - a release published without a
recipe has no split sub-resource, and never will, because a release is immutable.

One status covers more than one situation, which is the whole reason to branch on `code`:
`GET /projects/{id}/schema` answers 404 `PROJECT_NOT_FOUND` when the project is unknown and 404
`SCHEMA_NOT_FOUND` when the project is real and simply has no schema yet. Only the code separates
"you named nothing" from "there is nothing to name".

**409 - the request is well-formed; the resource's state refuses it.** The remedy is to change
that state and resubmit the identical request: finish the outstanding jobs, approve the batch,
promote something into the dataset, pass `confirm=true`. Name and tag collisions are here, as are
`UNSERIALIZABLE_MANIFEST` and `RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA` - the request body is fine
and the defect is in stored content, so reconcile the annotations and publish again.

**422 - the payload itself is wrong.** A blank name, a schema that declares two classes with one
name, an annotation that names a class the batch's pinned version does not have. Media failures
are here as well: `UNSUPPORTED_MEDIA` and `CORRUPT_MEDIA` describe a file that cannot become an
asset. They are deliberately *not* 415 - 415 is about the request's own `Content-Type`, and these
are raised while reading a file on disk that the operator pointed at.

**503 - transient, and waiting helps.** Exactly one error: `WORKSPACE_BUSY`. See below.

**500 - nothing the caller can do.** A corrupt or unreadable workspace, a store constraint no
service pre-checked, a missing ffmpeg, or a bug.

### The two shapes of 422

Both are reachable on the same route, and they differ in `detail`:

- **`VALIDATION_ERROR`** - the request failed pydantic validation before any service ran.
  `detail.errors` carries pydantic's own list of per-field problems.
- **A domain refusal** (`INVALID_NAME`, `INVALID_SCHEMA`, `LABEL_CLASS_NOT_IN_SCHEMA`, ...) - the
  payload parsed, and a kernel rule rejected it. `detail` is usually `null`.

Most malformed input arrives as the first: a `LabelClass` that cannot be constructed never
reaches a service to be refused by one.

A refusal from a **bulk write** carries `detail.index` - the position in the array you sent of
the item that caused it:

```json
{ "code": "LABEL_CLASS_NOT_IN_SCHEMA", "message": "class 'ghost' is not in schema version 1, …",
  "detail": { "index": 2 } }
```

Bulk writes are all-or-nothing, so *nothing was stored* and the code alone cannot say which of
forty annotations meant it. The `message` is the reason; the index is the handle. It appears
only where it means something - a refusal about the call rather than about one item (a closed
batch, an unknown job) has no index and no `detail`.

## The 5xx contract

A 5xx body carries an **`incident_id`** in `detail`, and its `message` is a fixed generic
sentence. The real message and traceback go to the server log under the same id - so an operator
greps one string, and a response body never becomes a channel for filesystem paths, SQL text, or
a stack trace.

Eight errors opt out and expose their real message, each because that message *is* the remedy:

| Code | Why the message is published |
| --- | --- |
| `WORKSPACE_BUSY` | Names the contention; and the whole point is that a retry works. |
| `WORKSPACE_FORMAT_TOO_NEW` | Says which of the two things happened - a later VisionSet wrote it, or one that numbered its generations differently - and only one of those has a fix. |
| `WORKSPACE_SCHEMA_MISMATCH` | Names the table and column the workspace lacks. Opaque, this is a 500 with no cause on a route with no connection to it, and the answer is only in the server's log. |
| `MEDIA_TOOL_UNAVAILABLE` | Carries the install hint. Without it the error says nothing an operator did not suspect. |
| `LOCAL_INFERENCE_UNAVAILABLE` | Carries the `pip install` for the optional runtime, on the same licence `ffmpeg` gets. |
| `INFERENCE_CONNECTION_NOT_RUNNABLE` | Says which of the two things nothing installed here can run - a recorded driver that is not installed, or a model family (declared by the config, or by the endpoint) no installed driver serves - and lists what is installed instead. A fact about the installation rather than about the request, and one that changes when a driver is installed. |
| `INFERENCE_OUT_OF_MEMORY` | Names which memory ran out - the device's or the machine's - and the ways off it, which are not the same ways: a full device can be answered by moving the connection to the CPU, and a full machine is only made worse by it. No generic sentence can carry that. |
| `INFERENCE_ENDPOINT_UNAVAILABLE` | Names the endpoint an `http` connection points at and what it did - unreachable, timed out, a bad status, or a body outside the contract - which is the whole remedy: look at the endpoint, not at this connection or this machine. |

A **mapped** 5xx keeps its own code (`WORKSPACE_CORRUPT`, `CONSTRAINT_VIOLATED`). An exception no
rule covers - a bug - gets `INTERNAL_ERROR`. That difference is how the two are told apart in a
log without reading the message.

`MEDIA_TOOL_UNAVAILABLE` is a 500 rather than a 503 on purpose: 503 promises that waiting helps,
and no amount of retrying installs ffmpeg.

## Retrying

| Code | Status | How to retry |
| --- | --- | --- |
| `WORKSPACE_BUSY` | 503 | Wait. The response carries `Retry-After`, currently **5 seconds** - matched to the store's own busy timeout, because a client that gets this has *already* waited that long losing to another writer, and a shorter hint would aim a retry storm at the contention being reported. |
| `SCHEMA_VERSION_CONFLICT` | 409 | Immediately. Two writers computed the same next version and this one lost; a retry re-reads the maximum and lands on the one after. No `Retry-After`, because there is nothing to wait for. |
| `STALE_WRITE` | 409 | Immediately, **after re-reading**. Somebody moved the thing between your read and your write, so the retry is not the identical request - it is the request you would have sent had you seen the state the message names. There is deliberately no flag that writes anyway: that is the lost update this refusal exists to prevent. |
| `DESTRUCTIVE_SCHEMA_CHANGE` | 409 | With `allow_destructive=true`, if narrowing the contract is what you meant. |
| `CONFIRMATION_REQUIRED` | 409 | With `confirm=true`, after asking whoever is destroying the data. |
| `LOSSY_EXPORT_NOT_CONSENTED` | 409 | With `allow_lossy=true`, if an incomplete copy is what you want. A third gate word beside the two above, because it guards a third thing: not destroying data and not narrowing a contract, but emitting a copy that leaves the original intact. |

Nothing else is retryable as-is. Note that four of these five are 409s and one of the 409s in
the table above - `SCHEMA_CHANGE_WOULD_ORPHAN` - is not retryable at all, which is the whole
argument for branching on `code`.

## The full table

| Status | Codes |
| --- | --- |
| **401** | `UNAUTHORIZED` — with a `WWW-Authenticate: Bearer` challenge |
| **404** | `PROJECT_NOT_FOUND` · `SCHEMA_NOT_FOUND` · `SCHEMA_DRAFT_NOT_FOUND` · `BATCH_NOT_FOUND` · `JOB_NOT_FOUND` · `INGEST_JOB_NOT_FOUND` · `BACKGROUND_JOB_NOT_FOUND` · `ASSET_NOT_FOUND` · `SOURCE_NOT_FOUND` · `DATASET_NOT_FOUND` · `ANNOTATION_NOT_FOUND` · `RELEASE_NOT_FOUND` · `TOKEN_NOT_FOUND` · `INFERENCE_CONNECTION_NOT_FOUND` · `ASSET_NOT_IN_JOB` · `ASSET_NOT_IN_DATASET` · `NO_SPLIT_RECIPE` · `EXPORT_FORMAT_NOT_FOUND` · `EXPORT_TARGET_NOT_FOUND` · `THUMBNAIL_NOT_CACHED` · `NOT_FOUND` (no such route) |
| **405** | `METHOD_NOT_ALLOWED` |
| **409** | `PROJECT_NAME_TAKEN` · `RELEASE_TAG_TAKEN` · `TOKEN_NAME_TAKEN` · `INFERENCE_CONNECTION_NAME_TAKEN` · `WORKSPACE_ALREADY_EXISTS` · `WORKSPACE_NOT_EMPTY` · `SCHEMA_VERSION_CONFLICT` · `INVALID_TRANSITION` · `STALE_WRITE` · `BATCH_NOT_EDITABLE` · `BATCH_IMMUTABLE` · `BATCH_NOT_IN_ANNOTATION` · `ASSET_NOT_WRITABLE` · `JOB_FINISHED` · `BATCH_NOT_COMPLETE` · `JOB_NOT_COMPLETE` · `EMPTY_BATCH` · `EMPTY_RELEASE` · `RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA` · `CONFIRMATION_REQUIRED` · `DESTRUCTIVE_SCHEMA_CHANGE` · `SCHEMA_CHANGE_WOULD_ORPHAN` · `SCHEMA_HAS_NO_DETECTABLE_CLASS` · `UNSERIALIZABLE_MANIFEST` · `LOSSY_EXPORT_NOT_CONSENTED` · `EXPORT_SOURCE_UNREADABLE` · `INFERENCE_CONNECTION_NOT_DOWNLOADABLE` · `INFERENCE_CONNECTION_NOT_CHECKABLE` · `INFERENCE_CONNECTION_NOT_TESTABLE` · `INFERENCE_CONNECTION_MODEL_FIXED` · `WEIGHTS_DAMAGED` · `INFERENCE_CONNECTION_NOT_SET_UP` |
| **422** | `VALIDATION_ERROR` · `ASSET_NOT_IN_BATCH` · `ANNOTATION_NOT_FROM_MODEL` · `INVALID_NAME` · `INFERENCE_CONNECTION_INVALID` · `INVALID_SCHEMA` · `UNSUPPORTED_GEOMETRY` · `INVALID_ANNOTATION` · `LABEL_CLASS_NOT_IN_SCHEMA` · `DISALLOWED_GEOMETRY` · `ANNOTATION_GEOMETRY_OUT_OF_BOUNDS` · `DUPLICATE_CLASSIFICATION_TAG` · `MISSING_REQUIRED_ATTRIBUTE` · `UNKNOWN_ATTRIBUTE` · `INVALID_ATTRIBUTE_VALUE` · `INVALID_PARTITION` · `UNKNOWN_JOB_TYPE` · `MEDIA_ERROR` · `UNSUPPORTED_MEDIA` · `CORRUPT_MEDIA` · `UNSUPPORTED_PROMPT` · `PROMPT_POINT_OUT_OF_BOUNDS` · `GEOMETRY_NOT_PRODUCED` |
| **502** | `INFERENCE_ENDPOINT_UNAVAILABLE` |
| **503** | `WORKSPACE_BUSY` |
| **500** | `WORKSPACE_CORRUPT` · `NOT_A_WORKSPACE` · `WORKSPACE_FORMAT_TOO_NEW` · `WORKSPACE_SCHEMA_MISMATCH` · `ENTITY_NOT_FOUND` · `ENTITY_ALREADY_EXISTS` · `CONSTRAINT_VIOLATED` · `MEDIA_TOOL_UNAVAILABLE` · `LOCAL_INFERENCE_UNAVAILABLE` · `INFERENCE_CONNECTION_NOT_RUNNABLE` · `INFERENCE_OUT_OF_MEMORY` · `EXPORT_TARGET_CONFLICT` · `INVALID_EXPORT_TARGET` · `INTERNAL_ERROR` |

Every row but `VALIDATION_ERROR`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `UNAUTHORIZED` and
`INTERNAL_ERROR` — the five the framework and the auth guard raise — comes from `ERROR_RULES`
in `server/errors.py`, which `tests/server/test_errors.py` holds in exact correspondence with
`kernel/errors.py`. A new kernel error fails that suite until somebody maps it.

**That same suite reads this table.** It parses the rows above and holds them to `ERROR_RULES`
in both directions — a code that ships without a row here fails, and so does a row naming a code
that no longer exists or sitting under the wrong status. The table is a mirror, and an unchecked
mirror drifts: this one was nineteen codes behind before anybody noticed (#524).

`CORRUPT_MEDIA` and `UNSUPPORTED_MEDIA` carry `detail.reason`. The file's *name* is deliberately
absent from both the detail and the message: on the ingest path it is an absolute path inside a
directory the operator, not the client, pointed at.

### The two narrowing refusals

They share a status, and only one of them has a way forward, so each carries the actionable half of
itself as structure rather than as prose:

```json
{ "code": "DESTRUCTIVE_SCHEMA_CHANGE",
  "detail": { "classes": ["lane"] } }

{ "code": "SCHEMA_CHANGE_WOULD_ORPHAN",
  "detail": { "blockers": [ { "label_class": "lane", "annotations": 12, "assets": 3 } ] } }
```

`classes` is the blast radius a confirmation has to name. It carries **no counts**, and that is the
difference between the two: this refusal is about intent and is raised before anything on disk is
consulted, so attaching counts would put a walk over every asset in the project in front of the one
refusal that does not need it. A client that wants them asks the preview below.

`blockers` is why no flag helps, counted two ways — a thousand labels over a thousand images and the
same thousand over ten are the same `annotations` and a very different problem. It counts and does
not name: which frames those are is a page, and it is asked for separately below.

Neither is available by parsing `message`, and neither should be: `message`'s own field description
says the wording is not part of the contract.

### Asking before you are refused

```
POST /projects/{project_id}/schema/preview
```

The body is the **same document** `POST .../schema/versions` takes, so a client previews and
publishes without reshaping anything (`description` and `provenance` are accepted and ignored —
neither enters a diff). It writes nothing.

```json
{ "diff": { "is_destructive": true, "destructive_classes": ["lane"], "changes": [] },
  "blockers": [ { "label_class": "lane", "annotations": 12, "assets": 3 } ],
  "is_refused": true }
```

`diff.is_destructive` decides whether the publish needs `allow_destructive=true`. **`is_refused`
decides whether any flag would help** — and `blockers` is byte-for-byte the structure
`SCHEMA_CHANGE_WOULD_ORPHAN` puts in its `detail`, so one renderer serves the warning and the
refusal.

It is **advisory**. Nothing is locked and nothing is reserved: somebody can label a class between
the preview and the publish, in which case the publish refuses and that refusal is the
authoritative one. What the preview removes is the round trip that was doomed before it was sent,
not the need to handle being refused.

A POST because the proposal is a whole class list, which does not belong in a query string. It is
still a read.

### Reaching what is in the way

```
POST /projects/{project_id}/schema/blocking-assets        ?limit=&offset=
```

`blockers` counts; this lists. Same body, same walk over the project — the guards are derived
from the diff here exactly as the preview derives them, which is why the two cannot come to
disagree about one proposal. A client that sent its own guards could send a set the gate does not
match, so it does not get to.

```json
{ "items": [ { "asset": { "id": "…", "width": 1920, "height": 1080 },
               "label_classes": ["lane"],
               "annotations": 4,
               "batch_ids": ["…"] } ],
  "total": 3 }
```

`annotations` is how many of **that frame's** labels the change would orphan, not how many it
carries. `batch_ids` is a list because an asset put in a batch and later in a correction of it is
in both, and no stored fact makes one of them the answer — it is what turns "this frame is in the
way" into somewhere to go and fix it.

A frame blocking under two classes is **one item**, so `total` is not the sum of the preview's
per-class `assets`. `total` is every blocking frame and never the size of the page, on the paging
convention above.

---

## For contributors

### Adding an endpoint

Raise the kernel's domain error and stop. The handlers registered by `create_app()` do the rest,
and a route that catches a domain error to translate it itself is how a second error shape gets
into the contract.

`server/errors.py` holds one table, `ERROR_RULES`, with one entry per error class declared in
`kernel/errors.py`. `tests/server/test_errors.py` asserts that correspondence is **exact**, so a
new kernel error fails the suite until somebody maps it deliberately - which is the point.

Codes are written out as literals rather than derived from the class name. A code is a public
contract keyed to a Python identifier, and deriving it means a pure refactor rename silently
breaks every client while passing every test. A test asserts each literal still matches its class
name today; when a class genuinely is renamed, add it to that test's `RENAMED` map and leave the
code alone.

### Overriding a status for one route

A couple of errors legitimately differ by route - an asset id in a path is a 404, and the same id
in a request body is a 422. Catch it and return the renderer directly:

```python
try:
    service.record(...)
except AssetNotInJob as exc:
    return error_response(exc, status=422)
```

That is the whole escape hatch. Raising a bare `HTTPException` instead would produce a body in
the right shape but with a status-derived code nothing can branch on.

### Two things that will bite

**Do not commit a unit of work inside a `Depends(...)` teardown.** FastAPI gives yield-dependencies
their own exit stack, and an exception raised there after the response has started produces
`RuntimeError: Caught handled exception, but response already started` rather than an `ErrorBody`
 - which is precisely when `WorkspaceBusy` fires. Yield the *service*; the kernel already commits
inside its own `unit_of_work()`.

**422 is declared at app level, and that is load-bearing.** It displaces FastAPI's generated
`HTTPValidationError`, keeping that model - and the second error shape it implies - out of
`openapi.json` entirely. A test asserts it never comes back.

**401 is *not* declared at app level, and that is load-bearing too.** `/health` is public and
cannot 401, so the guard and its documented response travel together on the router -
`protected_router()` in `server/dependencies.py`. Build every non-public router with it rather
than repeating `Depends(require_token)` per route; see [auth.md](auth.md).

## The generated client

Nobody writes a VisionSet HTTP call by hand. `frontend/ui-core/src/generated/api.ts` is generated
from the committed `openapi.json` by [`openapi-typescript`](https://openapi-ts.dev), pinned to an
**exact** version in the root `package.json`, and `@visionset/ui-core` wraps it in a typed client:

```ts
import { createApiClient } from "@visionset/ui-core";

const api = createApiClient({ baseUrl: "http://127.0.0.1:8000", token });

const { data, error } = await api.GET("/projects/{project_id}", {
  params: { path: { project_id: id } },
});
```

The URL, its path parameters, the query, the request body and both response shapes are all typed
off the contract. A misspelled route or a wrong parameter type fails to compile.

Regenerate with `pnpm generate:client` and **commit the result** - never hand-edit it. The output
is a tracked artifact for the same reason the spec is: a contract change then shows up in the pull
request as a reviewable type diff instead of appearing silently on somebody's next install.

### Two gates, deliberately separate

| Gate | Where | Answers |
| --- | --- | --- |
| Spec matches the app | the `openapi` CI job, and `tests/server/test_openapi_contract.py` | did somebody change a route and forget to export? |
| Client matches the spec | the `frontend` CI job, and `tests/scripts/generate_client.test.mjs` | did somebody change the contract and forget to regenerate? |

The frontend job installs no Python: it reads the *committed* spec, which the first gate has
already established is current. Each half also runs inside the test suite of its own language, so
the failure arrives where the mistake was made rather than on a pushed branch.

The pin is exact rather than a caret range because the output is committed - a routine minor bump
would otherwise regenerate different bytes and fail the drift gate for a reason nobody chose.

One consequence worth knowing: `openapi.json` embeds `info.version` from the repo-root `VERSION`,
but the generated client contains only `paths`, `components` and `operations`. A version bump moves
the spec and leaves the client byte-identical. The two gates are genuinely independent.

### Responses are checked, not assumed

`openapi-typescript` gives every response a static type off the contract and verifies
nothing at runtime. That gap is real: a well-formed JSON document of the *wrong* type
satisfies the compiler, reaches a screen intact, and takes the page down in the first
formatter that reads a field it does not have. It happened three times while the project
view was being rebuilt.

So `pnpm generate:client` emits a second committed artifact beside the types -
`frontend/ui-core/src/generated/checks.ts`, one check per schema a 2xx JSON response can
carry, plus one alias per operation named after its `operationId` - and `unwrap` takes one:

```ts
import { checkGetProjectStats } from "@visionset/ui-core";

const stats = unwrap(
  await api.GET("/projects/{project_id}/stats", { params: { path: { project_id: id } } }),
  checkGetProjectStats,
);
```

A body that does not match is an `ApiError` under `MALFORMED_RESPONSE`, carrying the path
that disagreed (`/classes/2/annotations should be an integer`) - the same treatment an
unrecognisable *error* body has always had. The argument is in
`frontend/ui-core/src/data/check.ts`; four parts of it are worth stating here, because
each is a decision somebody will otherwise try to "fix":

- **Unknown keys pass.** `additionalProperties: false` constrains what the API *accepts*,
  not what it may one day *send*. A client that refused an added field would turn every
  backward-compatible release into a broken page.
- **An unknown member of an *open* vocabulary passes.** Seven vocabularies carry
  `x-visionset-open` in the spec — the four `allowed_actions` sets, `capabilities`,
  `SuggestionOut.parameters`, and the reasons a class is left out of a pre-label prompt — and
  the generated check for one accepts a member this client
  never compiled against, exactly as it accepts an added field. Every other enum still
  refuses, and refuses the whole response with it: a value the client must *switch* on has no
  honest rendering to fall back to. The line between them is the field's shape. A vocabulary
  may be open only where it is referenced solely as an array item, which is where a client
  filters rather than switches, and only where no request can reach it, so what the server
  *accepts* stays closed either way. `tests/server/test_openapi_contract.py` gates both halves,
  in both directions, and the generated types tell a consumer which it is holding: an open
  vocabulary's own type admits any string, while `KnownMembers` names the members this build
  compiled against.
- **`format` is not enforced.** A `uuid` is checked as a string and no further. A renderer
  is protected by the type; rejecting a legal ISO-8601 variant would be a new bug.
- **A property with a `default` is treated as always present.** A default means the server
  serializes it every time, which is why `openapi-typescript` types it as non-optional -
  and the check has to agree with the type or it would not compile against it.

The parameter is required, so a call site cannot forget it. It does **not** stop a call
site passing the *wrong* check: a type predicate is assignable whenever its asserted type
is, so `unwrap(projectResult, checkDatasetOut)` compiles and silently re-narrows. Pairing
each call with its own operation is enforced by `tests/scripts/checks_wiring.test.mjs`
instead - which is not a theoretical safeguard, since it caught two mispaired calls the
compiler accepted on the day it was written.

### Binary responses type as `unknown`

Four operations answer with bytes rather than JSON - asset content, thumbnails, the release
manifest and the export archive - and the spec declares them with an empty schema, OpenAPI's way
of saying "bytes, and there is nothing more to say about their shape". The generator is run with
`emptyObjectsUnknown`, so they come out as `unknown`.

That is deliberate, and it should not be "fixed" by declaring `{"type": "string", "format":
"binary"}` on the Python side. That would make the generated type `string`, which is a lie in a
browser where the value is a `Blob`. Read those responses through `response.blob()`.

Every media type a route can actually send is declared, though - `get_asset_content` lists
`application/octet-stream` beside the two image types, because an asset ingested before the
pipeline probed formats really is served that way, and a response the contract omits is a lie the
generated client inherits.
