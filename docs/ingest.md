# Ingest

Where a registered [source](sources.md) becomes rows. `IngestService` hashes every item, stores
the bytes once, records what the decoder made of them, and puts the result in a draft
[batch](batches.md) somebody can approve. Nothing else in the kernel creates an `Asset` —
`examples/sdk_end_to_end.py` used to, and no longer does.

Everything below is executed by [`examples/ingest_end_to_end.py`](../examples/ingest_end_to_end.py),
which is walked through in [examples.md](examples.md).

```python
source = sources.register_images(project.id, Path("~/dashcam/monday").expanduser())
result = ingest.ingest(source.id, batch_name="monday")

result.created  # assets new to this project
result.deduplicated  # items whose bytes the project already held
result.failures  # one line per item that could not be read at all
```

## One `ingest`, where registration has two methods

`SourceService` split `register_images` from `register_video` because their arguments genuinely
differ: a clip needs a decomposition rate and gets probed, a directory needs neither. Here they do
not differ at all. The source already carries its kind, its path and its rate, so the caller
passes one id and the service branches on `SourceKind`. A second entry point would ask callers to
re-state what the source already knows.

## Identity is content; origin is provenance

An asset **is** its bytes: `content_hash` is the SHA-256 of the file, and the same bytes ingested
twice are one asset over one blob. `uq_asset_project_content_hash` is the index under that rule.
Per project, not global — two projects ingesting one photograph are two assets sharing one blob,
which is exactly what makes `project_id` the asset's parent.

`source_id`, `frame_index` and `frame_timestamp` are a different kind of fact. They record where
the bytes were **first** seen, and a second sighting never rewrites them — the rule
`Source.registered_at` already follows. One image in two registered folders keeps the first
folder's path in its `uri` and the first source's id in its origin, because the alternative is an
asset whose recorded origin depends on which ingest happened to run last.

The deliberate consequence: an asset records **one** origin, and a duplicate across two sources
loses the second. A join table is the honest upgrade if that information is ever wanted; it would
be its own migration and is not needed by anything today.

Re-running an ingest is therefore not an error and not a no-op worth avoiding: it creates nothing,
reports every item as deduplicated, and is how a folder that grew by three files is caught up.

## What the two paths do

| | image directory | video |
| --- | --- | --- |
| what is read | every file at the **top level**, in filename order | one frame per extraction slot, at the rate the source records |
| decoded by | `ImageProcessor.probe` — dimensions and format from the bytes | `VideoProcessor.frames` — ffmpeg, deterministic within one build |
| `uri` | the file's absolute path | `/path/clip.mp4#frame=7` |
| frame position | none | `frame_index` and `frame_timestamp` |
| damage | one report line per file; the run carries on | the frames ffmpeg managed are kept, plus one report line |

Subdirectories are stepped over and recorded nowhere. Recursion is not a per-run option but a
question about what *the source is* — "the same source yields the same assets" — so it belongs to
a future `register_images(..., recursive=True)` rather than here, where it would silently change
what an already-registered source means. There is no suffix filter either: a `notes.txt` is
reported as unsupported rather than skipped, because guessing which files an operator meant to
offer is a policy the kernel would be inventing.

**Frames are not re-probed.** `VideoProcessor` guarantees every frame is a complete image in
`FRAME_FORMAT` at the dimensions `probe` reported, and that promise is asserted in the port's own
tests. Decoding each one again to re-confirm it would also route our own encoder's output into an
operator's per-file report — a failure nobody could act on.

## Asking for a run and doing it are two calls

```python
job = ingest.enqueue(source.id, batch_name="monday")  # refuses now, reads nothing
result = ingest.resume(job.id)  # does the work
```

`ingest(...)` is those two composed, and that is all it is. The split exists because a caller
that cannot wait — the [REST API](api.md), and one day a queue — needs the **row before the
work**: the id it hands back has to name something the next request can find. Every refusal
`enqueue` can make it makes before the insert, so a launch that fails leaves no job at all and
a launch that succeeds leaves one that is already pollable.

`resume` is what picks a `pending` job up, which is why `pending → running` was in the
transition table from the start. `resumable(job_id)` is the same friendly pre-check without the
work, for a caller that runs the second half elsewhere and needs the refusal on its own thread —
a launch that answered "accepted" and only discovered in a worker that the job was already
`completed` would give nobody a way to tell a redo from a no-op.

Nothing here decides *when* the second half runs. That is deliberately not the kernel's
business: the API queues the work on the embedded executor (`docs/background-jobs.md`), the CLI
just calls `ingest`, and neither arrangement is visible in this module.

**An ingest therefore has two rows**: the `ingest_job` this document is about, which is the
domain record and what a client polls, and a generic `job` that records the *execution*. The
duplication is transitional and known — collapsing them is a migration with its own
wire-contract discussion, and until then progress for an ingest stays here.

## The run has a lifecycle, and it is a table

`INGEST_TRANSITIONS` in `domain/ingest.py` is the whole of what is legal. `IngestService`
consults it through `require_move`; nothing restates it.

```
pending ──▶ running ──▶ completed
   │           │
   └────────▶ failed ──▶ running        (resume)
```

A job is created `pending` and moved to `running` by whoever picks the work up. Through
`ingest(...)` those are the same call and the state is over in microseconds; through
`enqueue` + `resume` they are not, and a `pending` row is a run somebody asked for that has not
started. That is why the state was spelled out before anything left one behind — adding it later
would have meant changing what a stored row means.

**`failed → running` is the only backward edge in this kernel**, and the argument against
reopening a [batch](batches.md) does not carry over. A batch pins a schema version at approval
and its jobs are already cut against that pin, so un-freezing one would invalidate work already
done. Nothing is pinned against an ingest run. It is a record of work, not an artifact with
dependents — so resuming is the same unit of work continuing, on the same row. A second row per
attempt would fork `batch_id` and turn `IngestService.list` into a list of retries.

**`running → running` is deliberately missing**, so a run stuck at `running` cannot be resumed.
That state is a process that died without reporting anything, not a failure anybody can read.
The remedy already exists — ingest the source again, which creates nothing — and it leaves the
stuck row as the only evidence the crash left.

## Progress a caller can poll

`processed` and `total` are written to the row **as the run goes**, so
`IngestService.get(job_id)` answers "where is it now" rather than "where did it end". That is
what `GET /ingest-jobs/{id}` returns and what the UI will poll; nothing about it is specific to
being in the same process.

| | what it means |
| --- | --- |
| `processed` | items dealt with — decoded and stored, or reported as unreadable |
| `total` | items the source offered, or **NULL** when that is not knowable up front |

A directory can be listed, so it states its total before the first file; an empty one records
`0 of 0` rather than nothing. A clip cannot: `VideoMetadata` carries no frame count by design —
it would be a guess for a variable-rate clip, and the number an ingest wants is what extraction
actually produced — so `total` stays NULL and `processed` climbs alone.

The counter is written **once per item**, not on a cadence. An interval that suits five files
and one that suits fifty thousand are different numbers, and this service cannot know which it
is looking at; the cost of not choosing is one small commit beside a decode and a hash that
cost an order of magnitude more.

## Resuming a failed run

`IngestService.resume(job_id)` re-runs a failed job on its own row, into the batch the first
attempt was headed for. What qualifies is whatever the table says can reach `running` — `failed`,
and also `pending`, which a synchronous run never leaves behind but a queued one would. A
`completed` or `running` job is refused with an ordinary `InvalidTransition` rather than an error
of its own.

It is a **redo, not a skip**. There is no per-file record of what the previous attempt managed,
and there does not need to be: blobs are content-addressed and assets are deduplicated by
content, so re-reading the whole source creates nothing it created before. The cost is
re-hashing what is already stored; what it buys is that resume has no second code path to get
wrong.

The counters, the per-file report and the fatal `error` are reset when the attempt starts, so
they describe the run somebody is watching rather than the one that failed. A run that *failed*
keeps them exactly where they stopped, which is the first thing anyone reading a failure wants.

`batch_name` is a column for this reason alone: a run that died during the decode reached no
batch, so without it a resumed run would fall back to naming the batch after the source folder
and quietly lose the name the caller asked for.

## Four transactions, and the middle of the run is in none of them

1. Resolve the source, decide the target batch, and insert the `IngestJob` as `running`.
2. **No transaction.** Decode, hash and `BlobStore.put` every item.
3. Write the asset rows, reusing whatever content the project already holds.
4. Put them in the batch (through `BatchService`), then mark the job `completed`.

Then, and only after the last block has exited, `IngestCompleted` goes on the bus — the rule every
emitter in this kernel follows.

Step 2 is outside a transaction because decoding is a Pillow pass over thousands of files or an
out-of-process ffmpeg, and holding a write transaction open across either is how a single-writer
SQLite store starts making every other writer wait out its `busy_timeout` and fail with
`WorkspaceBusy`. The blob writes are out there too, before any
row exists: `BlobStore.put` is not transactional and a rollback cannot unwrite it — but a blob
nothing points at is harmless (content-addressed, shared, never deleted), while a row naming bytes
that were never stored is not.

The progress writes that happen *between* items are not a contradiction. Each is one `UPDATE`
that opens and commits while nothing is being decoded; what the single-writer warning is about
is a transaction held **across** the decode, not the existence of writes during that phase.

The honest consequence, stated rather than hidden: a process killed between transactions can leave
assets in the project with no batch and a job stuck at `running`. Finding it is what the job
record is for, and ingesting the source again is what fixes it — see the lifecycle above for why
that is the remedy rather than a resume.

Within a run, each file is **probed before it is stored**, so a file that is going to be refused
never leaves a blob behind.

## Failure splits by remedy, not by severity

A file that is not an image, or one whose bytes will not decode, is *reported*: one
`IngestFailure` carrying the item's name, the reason, and which of the two it was. The run carries
on, because an operator with five thousand files needs the other four thousand nine hundred. The
name and the reason are kept apart so a report renders as a table rather than as a list of
sentences, and `IngestFailureKind` exists so it can be **grouped** — real data loss must not be
buried under ordinary operator noise.

The report is on the row as well as in the return value, written as the run goes rather than at
the end: a report that only appeared once the run finished would be invisible for exactly as
long as it is interesting.

A missing ffmpeg is not a file's fault at all. `MediaToolUnavailable` is recorded as the job's
`error` — a separate column from the per-file `failures`, which stays empty — the job is marked
`failed`, and it is re-raised, which is precisely why it sits outside the `MediaError` family.
One broken machine is not five thousand broken files.

## A preview per asset, and it is allowed to fail

Every item also gets a thumbnail, stored content-addressed beside its content and named by
`asset.thumbnail_hash`. The M5 gallery is the reason: drawing a grid of hundreds of tiles by
decoding full-resolution images at request time is the wrong shape, and the cost is naturally
amortized here, where the bytes are already open and already decoded once.

**A thumbnail hash is a cache key, not an identity.** It is absent from every release manifest,
`ReleaseService.verify` never recomputes it, and two machines may legitimately hold different
preview bytes for one image — [media.md](media.md) has the determinism argument. Losing every
thumbnail blob loses only the time to render them again.

Everything else follows from that sentence.

**A preview that will not render is not an `IngestFailure`.** That error means "this file did not
become an asset, so fix the file"; here the asset exists, its bytes are stored and nothing was
lost. So the hash stays NULL and the run carries on with no entry in the report. Putting it there
would tell an operator that data was lost when it was not, and would bury real loss under it. The
NULL *is* the record, which is why nothing is logged: it is exactly what the backfill looks for.

**Frames get previews too.** The frames of a clip are deliberately never re-probed — the port
guarantees each one, and re-decoding would put our own encoder's output into an operator's
report. That argument is about metadata a caller reads back as fact, and a preview is reported to
nobody, so it does not carry over. A gallery with tiles for stills and blanks for frames would be
the worse outcome.

**One edge, one cache.** `DEFAULT_THUMBNAIL_MAX_EDGE` is pinned at the port and is not a
parameter on ingest or on the backfill. A per-call edge would fork the cache into variants
nothing can tell apart from a hash, and the column holds one pointer.

**A deduplicated asset has its NULL filled, and a value is never replaced.** Origin fields record
the first sighting and are never rewritten; a preview is not provenance, so filling an empty one
from whoever first held the bytes is not a rewrite. That is what makes re-ingesting a source
enough to give assets written before the cache existed their previews.

### The backfill

`IngestService.backfill_thumbnails(project_id)` renders a preview for every asset in a project
that has none — the remedy for all three things a NULL can mean, and idempotent, so a second pass
over a healthy project examines nothing.

It reads the **blob**, never `asset.uri`: that path may be gone, renamed, or on another machine,
while `blob_store.get(asset.content_hash)` is what the workspace actually holds.

Three phases, and the rendering is in none of them — the same rule as a run. The first
transaction collects ids and hashes, the rendering happens outside any transaction, and the last
re-reads each asset before writing so an ingest that filled a preview meanwhile is not clobbered.

It reports rather than raises, on `ReleaseService.verify`'s terms: someone repairing a damaged
workspace needs the list, and one asset nobody can render must not abandon the other five
thousand. `ThumbnailBackfill` keeps `missing` (the content blob is gone — damage a preview pass
cannot repair) apart from `unreadable` (the bytes are there and will not decode). The second
reuses `IngestFailure` because the `UNSUPPORTED`/`CORRUPT` split says exactly the right thing
about stored bytes; the first does not, because `IngestFailureKind` answers "what is wrong with
this file" and a blob that is not there is not a file.

There is no progress to poll: a backfill has no `IngestJob` row. If that is ever wanted it is a
task of its own, not a flag on this one.

At a terminal this is `visionset backfill-thumbnails --project P`; its report is the
`ThumbnailBackfill` above, printed as counts on stderr with the unreadable files in a table. It is
the only command for a kernel read that no route exposes.

## The target batch

With no `batch_id`, the run creates a draft named `batch_name` or, failing that, after the
source's own file or folder. With one, that batch must still be a draft — checked **before**
anything is decoded, because finding out afterwards would mean finding out after the work.

Membership is everything the run ingested, deduplicated assets included: a duplicate is not new
data, but it is part of what the run was asked to gather. Order is ingest order, which is filename
order for a directory and frame order for a clip.

## At a terminal

```bash
BATCH=$(visionset ingest ./incoming --project road-signs --batch-name day-one)
visionset ingest ./clip.mp4 --project road-signs --fps 5
```

**One command where registration has two methods**, dispatched on whether the path is a directory.
That is the ergonomic mirror of the split above: the *caller* does not have to say which of the two
they have, because the filesystem already knows, and the source they end up with carries the kind,
the path and the rate from then on.

It is the only command in the CLI that is two SDK calls, and its module says so. Both are safe to
repeat: registration is idempotent on `(kind, path, extraction_fps)`, and content addressing means a
second run creates nothing the first already did.

The batch id goes to stdout alone, so `BATCH=$(visionset ingest …)` is the whole idiom. The per-file
report goes to stderr, one line per refused file, so a redirected stdout stays a single id.

**`--fps` is video-only, and a usage error on a folder.** Silently ignoring it would let somebody
believe they had chosen a rate. It is also checked for being positive before the call, because
`register_video` refuses a non-positive rate with a bare `ValueError` — not a `VisionSetError`, so
it would print a traceback rather than a sentence. A missing path is exit 2 for the same reason
(`FileNotFoundError`), which is why the argument carries Click's own `exists=True`.

**The run is synchronous, and the CLI never calls `enqueue`.** A queued job needs a worker to pick
it up, and a CLI process has none — a detached job would simply never run. Polling is what the
server is for: `visionset server`, then `GET /ingest-jobs/{id}`.

**Interrupting a run leaves the job row at `running`, and there is no `--resume`.** The remedy needs
no new vocabulary: run the same line again. Registration finds the same source, `enqueue` does not
consult other jobs, and content addressing means the new run creates nothing the old one already
created. The stuck row stays as the only evidence that something was interrupted, which is the same
posture the kernel takes about a crashed process.

## Over HTTP

The [API](api.md) is `enqueue` and `resume` with a worker between them.

```
POST /projects/{id}/sources/video   multipart: the clip + extraction_fps   → 201 SourceOut
POST /sources/{id}/ingest-jobs                                             → 202 IngestJobOut
GET  /ingest-jobs/{id}                                                     → 200 IngestJobOut
GET  /batches/{id}/assets                                                  → 200 the assets
```

The launch calls `enqueue` on the request thread and hands the `pending` job to a **single
background worker** — one, so that runs serialize against a single-writer store rather than
racing each other. What that buys the *reader* is what [#80's concurrency posture](workspaces.md)
was for: a client polling while the worker holds a write transaction reads through WAL instead
of waiting on it.

**Where a refusal appears depends on when it can be known.** An unknown source or a blank batch
name is refused synchronously, with a 404 or a 422 — the launch never returns 202 pointing at a
job row nobody wrote. Everything after that is on the job: `state` becomes `failed` and `error`
carries the cause, while individual unreadable items sit in `failures` and do not fail the run
at all. That split is the same one this service already makes; HTTP just changes where you read
it.

Registration over HTTP is **upload-only**, and the bytes are staged content-addressed — see
[sources.md](sources.md).

`batch_id` on the launch body is how a second source joins the first one's batch, and it waited
for batches to have endpoints. The objection was never the feature: it was that a refusal must
not leave a caller holding a 202 pointing at a job row nobody wrote. It does not — `enqueue`
resolves the batch in the same transaction that inserts the job, so an unknown batch is a **404**
and one past `draft` is a **409 `BATCH_NOT_EDITABLE`**, both answered on the request that asked
for them. See [batches.md](batches.md).

## What is deliberately not here yet

- **No scheduler.** `enqueue` and `resume` are two calls; nothing in the kernel decides when the
  second one runs. The API supplies one background worker, the CLI supplies the calling thread,
  and a queue would be a third arrangement neither of them would notice.
- **No cross-attempt history.** The report and the counters describe the current attempt. A
  resumed run overwrites them, and a log of every attempt would be its own table.


## In the browser

`@visionset/ui-core`'s ingest screen is three steps, and their order is forced by
the two facts on this page rather than chosen: **`extraction_fps` belongs to the
source**, so it is picked before anything is probed, and the probe only exists once
the source is registered. Registering the same clip at another rate creates a second
source, which the screen says out loud.

It shows `processed` against `total` for a directory and a bare count for a clip
(there is no denominator until an extraction is over), groups the per-file report by
`IngestFailureKind`, and offers **Resume** only for a `failed` run — a stuck
`running` job has no button, because `running → running` is deliberately not a
transition. See [ui.md](ui.md#the-ingest-flow-and-the-order-the-domain-forces).
