# The REST API

The REST surface is a thin client of the SDK: a route parses input, calls one service, and
shapes the output. This document covers the part of the contract that is *not* any single
endpoint — what a failure looks like, and how to read one.

The routes themselves are described by [`openapi.json`](../openapi.json) at the repo root, which
is generated (`uv run python scripts/export_openapi.py`) and diffed in CI. Never hand-edit it.

## Authentication

Every endpoint except `/health` requires a workspace API token:

```
Authorization: Bearer vst_hK3n...
```

Missing, malformed, unknown and revoked are one identical **401** with a `WWW-Authenticate:
Bearer` challenge — deliberately indistinguishable, so a client cannot use the response to probe
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
GET    /projects/{project_id}/schema                      the version in force
POST   /projects/{project_id}/schema/versions
GET    /projects/{project_id}/schema/versions
GET    /projects/{project_id}/schema/versions/{version}
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
GET    /projects/{project_id}/batches
GET    /batches/{batch_id}
POST   /batches/{batch_id}/approve                        with a partition spec
POST   /batches/{batch_id}/start
POST   /batches/{batch_id}/complete
GET    /batches/{batch_id}/jobs
GET    /batches/{batch_id}/assets                         paged
GET    /jobs/{job_id}
GET    /jobs/{job_id}/progress
POST   /jobs/{job_id}/start
POST   /jobs/{job_id}/complete
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
DELETE /datasets/{dataset_id}/assets/{asset_id}           curation, not deletion
GET    /datasets/{dataset_id}/changes
POST   /batches/{batch_id}/promote                        the one gate into the trunk
POST   /datasets/{dataset_id}/releases
GET    /datasets/{dataset_id}/releases
GET    /releases/{release_id}
GET    /releases/{release_id}/manifest                    bytes
GET    /releases/{release_id}/verify
GET    /releases/{release_id}/assignment
POST   /releases/{release_id}/export                      ?format=&allow_lossy=, bytes
GET    /formats
```

A project's dataset is reached at a **singular** path, because the relation is 1:1 and there is
no collection to list. `POST /batches/{id}/promote` sits under the batch rather than the dataset
because `DatasetService.promote` takes a batch id and derives everything else from it — a
`dataset_id` in front would be a segment no service ever checks, and a path parameter nobody
validates is a lie a client will eventually rely on.

The active schema is the collection's **parent**, not a member of it, because "in force" is a
property of the schema rather than a version number a client could guess.

A **collection** hangs off whatever owns it; an individually addressable **resource** does not.
A source belongs to one project, so listing and creating happen under it — but a source has an
id of its own, and nesting `/projects/{p}/sources/{s}/ingest-jobs/{j}` would put four segments
in front of a job that one id already identifies. A schema version has no such id, which is why
it stays nested all the way down.

**Ids are UUIDs**, canonical hyphenated form, in the path. One deliberate exception: a **schema
version is an integer 1..N**, because that is the handle the domain itself uses — an annotation
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

**Paging is on the two large collections and nowhere else** — `GET /batches/{id}/assets` and
`GET /datasets/{id}/assets`, the batch that an ingest can fill with fifty thousand frames and
the trunk that accumulates every batch a project ever completed. It bounds the *response*, not
the read. The kernel has no windowed read, so `limit` and `offset` slice a list that was fetched
whole — worth doing, because a batch of fifty thousand frames must not be sent to a gallery in
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

**Statuses.** 201 with the created resource in the body; 200 for a read or an update; 204 with an
empty body for a delete. And **202 when the work has not happened yet** — see below.

**A long operation is launched and then polled.** Ingest is the first one, and the shape it set
is the one every later long operation uses:

```
POST /sources/{id}/ingest-jobs   →  202 Accepted
                                    Location: /ingest-jobs/{job_id}
                                    { "id": …, "state": "pending", "processed": 0, … }

GET  /ingest-jobs/{job_id}       →  200 { "state": "running",   "processed": 12, … }
GET  /ingest-jobs/{job_id}       →  200 { "state": "completed", "batch_id": …,   … }
```

**202, not 201**: the row exists, the work does not. The row is what makes the id worth handing
back — it is written and committed before the response is sent, so the first poll always finds
something. That is also why anything the request can refuse is refused *synchronously*: an
unknown source is a 404 here rather than a 202 pointing at a job nobody wrote, and resuming a
`completed` run is a 409 here rather than a background no-op a client could not distinguish from
a redo. Everything that goes wrong *after* the launch is reported on the job — `error` for the
one fatal cause, `failures` for the per-item report — because by then there is no request left
to answer.

**Uploads are multipart, and the only non-JSON request shape.** Registering a source means
sending the bytes: one `files` part per image, or one `file` part plus an `extraction_fps` field
for a clip. VisionSet sets **no size limit of its own** — parts are spooled to disk past 1 MiB
and streamed from there, so memory does not grow with the file — which means the real ceilings
are your reverse proxy's (`client_max_body_size` in nginx) and free disk. Uploaded bytes are
staged under `<workspace>/uploads/<digest>/` and, like blobs, are **never deleted**: a workspace
grows with what was offered to it, not only with what it kept. Re-uploading identical files
under identical names is free — it stages to the same path and returns the same source.

**Bytes are streamed, and their URLs are immutable.** Four responses are not JSON: an asset's
content and its thumbnail, a release's manifest, and an export's archive. Nothing is buffered
whole — the blob store hands back an open handle and the response walks it — so serving a
fifty-megapixel frame costs no more memory than serving a thumbnail.

All four are named by something content-addressed, so all four carry
`Cache-Control: public, max-age=31536000, immutable` and an `ETag` holding the hash. That is not
optimism: identity *is* content in VisionSet, so the bytes behind one of these URLs cannot
change. A client that cached one never needs to revalidate it.

The two asset routes take an **asset id**, not a content hash, and the issue that asked for them
said hash. A hash names bytes and says nothing about what they are, so a route keyed on one
could only answer `application/octet-stream` — which a gallery cannot put in an `<img>`.
Resolving a hash back to its asset would fix that and needs a query the persistence port
deliberately does not have: its whole surface is one `parent_id` filter, so *no query language
leaks into the port*. Widening it for a download route would be the tail wagging the dog, so the
hash ships as the `ETag` instead, which is where it was doing the real work anyway.

`Content-Type` on the content route is whatever the ingest actually probed. An asset written
before the pipeline recorded a format is served as `application/octet-stream`, because inventing
one would be worse than admitting it. A thumbnail is always `image/jpeg`. An asset with no
cached preview is `404 THUMBNAIL_NOT_CACHED` rather than an empty success — a preview is a cache
and reading one never renders one, so the remedy is a backfill and the code says so.

**Request bodies forbid unknown fields.** A misspelled key is a 422 `VALIDATION_ERROR`, never a
silently ignored one — a typo that looked like it worked is worse than a refusal.

**Only what a service can honour is on the wire.** `PATCH /projects/{id}` takes a name and nothing
else, because the SDK has no way to update a description. The API does not grow a field it would
have to fake.

**Response shapes are wire models, not domain models.** They live in `server/models.py` and are
written out field by field, so a field reaches a client because somebody published it and never
because somebody added it to an entity.

## The error body

Every failure — a domain refusal, a missing route, a malformed payload, an unhandled bug —
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
| `detail` | Extra structure, or absent. Its shape depends on the `code` — it is not uniform. |

### Branch on `code`, not on the status

Statuses are coarse by design, and two errors sharing one is normal. The case that makes this
concrete: `DESTRUCTIVE_SCHEMA_CHANGE` and `SCHEMA_CHANGE_WOULD_ORPHAN` are **both 409**. The
first is retryable — resubmit with `allow_destructive=true` and it succeeds. The second has no
override at all, because annotations already depend on what the change would remove. A client
that saw 409 and retried with the flag would loop forever against the second one. The kernel's
own error hierarchy is built to prevent exactly that loop; over HTTP, the `code` is the only
thing carrying that distinction.

## What decides the status

Three rules, not one per error.

**404 — the caller named something that is not there.** A project, batch, job, asset, source,
dataset, annotation or release that was never created, was deleted, or belongs to a different
workspace. Cross-scope references read as *missing*, never as *forbidden*: an asset in another
project is a 404, not a 403. `NO_SPLIT_RECIPE` is here too — a release published without a
recipe has no split sub-resource, and never will, because a release is immutable.

One status covers more than one situation, which is the whole reason to branch on `code`:
`GET /projects/{id}/schema` answers 404 `PROJECT_NOT_FOUND` when the project is unknown and 404
`SCHEMA_NOT_FOUND` when the project is real and simply has no schema yet. Only the code separates
"you named nothing" from "there is nothing to name".

**409 — the request is well-formed; the resource's state refuses it.** The remedy is to change
that state and resubmit the identical request: finish the outstanding jobs, approve the batch,
promote something into the dataset, pass `confirm=true`. Name and tag collisions are here, as is
`UNSERIALIZABLE_MANIFEST` — the request body is fine and the defect is in state stored long
before, so the remedy is to fix the annotation and publish again.

**422 — the payload itself is wrong.** A blank name, a schema that declares two classes with one
name, an annotation that names a class the batch's pinned version does not have. Media failures
are here as well: `UNSUPPORTED_MEDIA` and `CORRUPT_MEDIA` describe a file that cannot become an
asset. They are deliberately *not* 415 — 415 is about the request's own `Content-Type`, and these
are raised while reading a file on disk that the operator pointed at.

**503 — transient, and waiting helps.** Exactly one error: `WORKSPACE_BUSY`. See below.

**500 — nothing the caller can do.** A corrupt or unreadable workspace, a store constraint no
service pre-checked, a missing ffmpeg, or a bug.

### The two shapes of 422

Both are reachable on the same route, and they differ in `detail`:

- **`VALIDATION_ERROR`** — the request failed pydantic validation before any service ran.
  `detail.errors` carries pydantic's own list of per-field problems.
- **A domain refusal** (`INVALID_NAME`, `INVALID_SCHEMA`, `LABEL_CLASS_NOT_IN_SCHEMA`, …) — the
  payload parsed, and a kernel rule rejected it. `detail` is usually `null`.

Most malformed input arrives as the first: a `LabelClass` that cannot be constructed never
reaches a service to be refused by one.

A refusal from a **bulk write** carries `detail.index` — the position in the array you sent of
the item that caused it:

```json
{ "code": "LABEL_CLASS_NOT_IN_SCHEMA", "message": "class 'ghost' is not in schema version 1, …",
  "detail": { "index": 2 } }
```

Bulk writes are all-or-nothing, so *nothing was stored* and the code alone cannot say which of
forty annotations meant it. The `message` is the reason; the index is the handle. It appears
only where it means something — a refusal about the call rather than about one item (a closed
batch, an unknown job) has no index and no `detail`.

## The 5xx contract

A 5xx body carries an **`incident_id`** in `detail`, and its `message` is a fixed generic
sentence. The real message and traceback go to the server log under the same id — so an operator
greps one string, and a response body never becomes a channel for filesystem paths, SQL text, or
a stack trace.

Three errors opt out and expose their real message, each because that message *is* the remedy:

| Code | Why the message is published |
| --- | --- |
| `WORKSPACE_BUSY` | Names the contention; and the whole point is that a retry works. |
| `WORKSPACE_FORMAT_TOO_NEW` | "Upgrade VisionSet to open it" is the entire fix. |
| `MEDIA_TOOL_UNAVAILABLE` | Carries the install hint. Without it the error says nothing an operator did not suspect. |

A **mapped** 5xx keeps its own code (`WORKSPACE_CORRUPT`, `CONSTRAINT_VIOLATED`). An exception no
rule covers — a bug — gets `INTERNAL_ERROR`. That difference is how the two are told apart in a
log without reading the message.

`MEDIA_TOOL_UNAVAILABLE` is a 500 rather than a 503 on purpose: 503 promises that waiting helps,
and no amount of retrying installs ffmpeg.

## Retrying

| Code | Status | How to retry |
| --- | --- | --- |
| `WORKSPACE_BUSY` | 503 | Wait. The response carries `Retry-After`, currently **5 seconds** — matched to the store's own busy timeout, because a client that gets this has *already* waited that long losing to another writer, and a shorter hint would aim a retry storm at the contention being reported. |
| `SCHEMA_VERSION_CONFLICT` | 409 | Immediately. Two writers computed the same next version and this one lost; a retry re-reads the maximum and lands on the one after. No `Retry-After`, because there is nothing to wait for. |
| `DESTRUCTIVE_SCHEMA_CHANGE` | 409 | With `allow_destructive=true`, if narrowing the contract is what you meant. |
| `CONFIRMATION_REQUIRED` | 409 | With `confirm=true`, after asking whoever is destroying the data. |
| `LOSSY_EXPORT_NOT_CONSENTED` | 409 | With `allow_lossy=true`, if an incomplete copy is what you want. A third gate word beside the two above, because it guards a third thing: not destroying data and not narrowing a contract, but emitting a copy that leaves the original intact. |

Nothing else is retryable as-is. Note that three of these four are 409s and one of the 409s in
the table above — `SCHEMA_CHANGE_WOULD_ORPHAN` — is not retryable at all, which is the whole
argument for branching on `code`.

## The full table

| Status | Codes |
| --- | --- |
| **404** | `PROJECT_NOT_FOUND` · `SCHEMA_NOT_FOUND` · `BATCH_NOT_FOUND` · `JOB_NOT_FOUND` · `INGEST_JOB_NOT_FOUND` · `ASSET_NOT_FOUND` · `SOURCE_NOT_FOUND` · `DATASET_NOT_FOUND` · `ANNOTATION_NOT_FOUND` · `RELEASE_NOT_FOUND` · `ASSET_NOT_IN_JOB` · `NO_SPLIT_RECIPE` · `EXPORT_FORMAT_NOT_FOUND` · `THUMBNAIL_NOT_CACHED` · `NOT_FOUND` (no such route) |
| **405** | `METHOD_NOT_ALLOWED` |
| **401** | `UNAUTHORIZED` — with a `WWW-Authenticate: Bearer` challenge |
| **409** | `PROJECT_NAME_TAKEN` · `RELEASE_TAG_TAKEN` · `WORKSPACE_ALREADY_EXISTS` · `WORKSPACE_NOT_EMPTY` · `SCHEMA_VERSION_CONFLICT` · `INVALID_TRANSITION` · `BATCH_NOT_EDITABLE` · `BATCH_NOT_IN_ANNOTATION` · `BATCH_NOT_COMPLETE` · `JOB_NOT_COMPLETE` · `EMPTY_BATCH` · `EMPTY_RELEASE` · `CONFIRMATION_REQUIRED` · `DESTRUCTIVE_SCHEMA_CHANGE` · `SCHEMA_CHANGE_WOULD_ORPHAN` · `UNSERIALIZABLE_MANIFEST` · `LOSSY_EXPORT_NOT_CONSENTED` |
| **422** | `VALIDATION_ERROR` · `INVALID_NAME` · `INVALID_SCHEMA` · `UNSUPPORTED_GEOMETRY` · `INVALID_ANNOTATION` · `LABEL_CLASS_NOT_IN_SCHEMA` · `DISALLOWED_GEOMETRY` · `MISSING_REQUIRED_ATTRIBUTE` · `UNKNOWN_ATTRIBUTE` · `INVALID_ATTRIBUTE_VALUE` · `INVALID_PARTITION` · `MEDIA_ERROR` · `UNSUPPORTED_MEDIA` · `CORRUPT_MEDIA` |
| **503** | `WORKSPACE_BUSY` |
| **500** | `WORKSPACE_CORRUPT` · `NOT_A_WORKSPACE` · `WORKSPACE_FORMAT_TOO_NEW` · `ENTITY_NOT_FOUND` · `ENTITY_ALREADY_EXISTS` · `CONSTRAINT_VIOLATED` · `MEDIA_TOOL_UNAVAILABLE` · `INTERNAL_ERROR` |

`CORRUPT_MEDIA` and `UNSUPPORTED_MEDIA` carry `detail.reason`. The file's *name* is deliberately
absent from both the detail and the message: on the ingest path it is an absolute path inside a
directory the operator, not the client, pointed at.

---

## For contributors

### Adding an endpoint

Raise the kernel's domain error and stop. The handlers registered by `create_app()` do the rest,
and a route that catches a domain error to translate it itself is how a second error shape gets
into the contract.

`server/errors.py` holds one table, `ERROR_RULES`, with one entry per error class declared in
`kernel/errors.py`. `tests/server/test_errors.py` asserts that correspondence is **exact**, so a
new kernel error fails the suite until somebody maps it deliberately — which is the point.

Codes are written out as literals rather than derived from the class name. A code is a public
contract keyed to a Python identifier, and deriving it means a pure refactor rename silently
breaks every client while passing every test. A test asserts each literal still matches its class
name today; when a class genuinely is renamed, add it to that test's `RENAMED` map and leave the
code alone.

### Overriding a status for one route

A couple of errors legitimately differ by route — an asset id in a path is a 404, and the same id
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
— which is precisely when `WorkspaceBusy` fires. Yield the *service*; the kernel already commits
inside its own `unit_of_work()`.

**422 is declared at app level, and that is load-bearing.** It displaces FastAPI's generated
`HTTPValidationError`, keeping that model — and the second error shape it implies — out of
`openapi.json` entirely. A test asserts it never comes back.

**401 is *not* declared at app level, and that is load-bearing too.** `/health` is public and
cannot 401, so the guard and its documented response travel together on the router —
`protected_router()` in `server/dependencies.py`. Build every non-public router with it rather
than repeating `Depends(require_token)` per route; see [auth.md](auth.md).
