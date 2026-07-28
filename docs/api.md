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

Nothing else is retryable as-is.

## The full table

| Status | Codes |
| --- | --- |
| **404** | `PROJECT_NOT_FOUND` · `SCHEMA_NOT_FOUND` · `BATCH_NOT_FOUND` · `JOB_NOT_FOUND` · `INGEST_JOB_NOT_FOUND` · `ASSET_NOT_FOUND` · `SOURCE_NOT_FOUND` · `DATASET_NOT_FOUND` · `ANNOTATION_NOT_FOUND` · `RELEASE_NOT_FOUND` · `ASSET_NOT_IN_JOB` · `NO_SPLIT_RECIPE` · `NOT_FOUND` (no such route) |
| **405** | `METHOD_NOT_ALLOWED` |
| **401** | `UNAUTHORIZED` — with a `WWW-Authenticate: Bearer` challenge |
| **409** | `PROJECT_NAME_TAKEN` · `RELEASE_TAG_TAKEN` · `WORKSPACE_ALREADY_EXISTS` · `WORKSPACE_NOT_EMPTY` · `SCHEMA_VERSION_CONFLICT` · `INVALID_TRANSITION` · `BATCH_NOT_EDITABLE` · `BATCH_NOT_IN_ANNOTATION` · `BATCH_NOT_COMPLETE` · `JOB_NOT_COMPLETE` · `EMPTY_BATCH` · `EMPTY_RELEASE` · `CONFIRMATION_REQUIRED` · `DESTRUCTIVE_SCHEMA_CHANGE` · `SCHEMA_CHANGE_WOULD_ORPHAN` · `UNSERIALIZABLE_MANIFEST` |
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
