# Ingest

There are two distinct ways raw data becomes an `Asset`, and they are two use cases rather than
one with a branch in it. `IngestService` turns a registered directory [source](sources.md) into
rows: it hashes every item, stores its bytes once, records the decoder output, and adds the
result to a draft [batch](batches.md) for approval. `VideoImportService` does the analogous job
for a browser-materialized video, but it is not ingest wearing a different hat - see
["A video import is a session, not a run"](#a-video-import-is-a-session-not-a-run) below for why
the two do not share a service. Nothing else in the kernel creates an `Asset`;
`examples/sdk_end_to_end.py` once did so but no longer does.

Everything in the image-directory half below is executed by
[`examples/ingest_end_to_end.py`](../../examples/ingest_end_to_end.py), which is walked through in
[examples.md](examples.md).

```python
source = sources.register_images(project.id, Path("~/dashcam/monday").expanduser())
result = ingest.ingest(source.id, batch_name="monday")

result.created  # assets new to this project
result.deduplicated  # items whose bytes the project already held
result.failures  # one line per item that was not simply read
result.failed  # of those, how many produced nothing
```

## `IngestService` does not know what a video is

It reads an origin *this process can open* - a directory of stills, and nothing else. A `VIDEO`
source is a receipt for frames a client already materialized, and pointed at one this service has
nothing to read; there is no `SourceKind` branch here at all, and no `register_video` beside
`register_images` for it to dispatch between - see [sources.md](sources.md) for why that second
registration method is gone rather than merely unused.

## Identity is content; origin is provenance

An asset **is** its bytes: `content_hash` is the SHA-256 of the file, and the same bytes ingested
twice are one asset over one blob. `uq_asset_project_content_hash` is the index under that rule.
Per project, not global - two projects ingesting one photograph are two assets sharing one blob,
which is exactly what makes `project_id` the asset's parent.

`source_id`, `frame_index` and `frame_timestamp` are a different kind of fact. They record where
the bytes were **first** seen, and a second sighting never rewrites them - the rule
`Source.registered_at` already follows. One image in two registered folders keeps the first
folder's path in its `uri` and the first source's id in its origin, because the alternative is an
asset whose recorded origin depends on which ingest happened to run last.

The deliberate consequence: an asset records **one** origin, and a duplicate across two sources
loses the second. A join table is the honest upgrade if that information is ever wanted; it would
be its own migration and is not needed by anything today.

Re-running an ingest is therefore not an error and not a no-op worth avoiding: it creates nothing,
reports every item as deduplicated, and is how a folder that grew by three files is caught up.

## What an image-directory ingest does

Every file at the **top level** is read, in filename order, decoded by `ImageProcessor.stills` -
anything Pillow reads, normalized to JPEG/PNG. `uri` is the file's absolute path, or
`/path/anim.gif#frame=3` for a decomposed animation frame, which is also the one case where
`frame_index`/`frame_timestamp` are set for a still ingest. Damage is one report line per file,
the whole file refused, and the run carries on.

Subdirectories are stepped over and recorded nowhere. Recursion is not a per-run option but a
question about what *the source is* - "the same source yields the same assets" - so it belongs to
a future `register_images(..., recursive=True)` rather than here, where it would silently change
what an already-registered source means. There is no suffix filter either: a `notes.txt` is
reported as unsupported rather than skipped, because guessing which files an operator meant to
offer is a policy the kernel would be inventing.

## Asking for a run and doing it are two calls

```python
job = ingest.enqueue(source.id, batch_name="monday")  # refuses now, reads nothing
result = ingest.resume(job.id)  # does the work
```

`ingest(...)` is those two composed, and that is all it is. The split exists because a caller
that cannot wait - the [REST API](api.md), and one day a queue - needs the **row before the
work**: the id it hands back has to name something the next request can find. Every refusal
`enqueue` can make it makes before the insert, so a launch that fails leaves no job at all and
a launch that succeeds leaves one that is already pollable.

`resume` is what picks a `pending` job up, which is why `pending → running` was in the
transition table from the start. `resumable(job_id)` is the same friendly pre-check without the
work, for a caller that runs the second half elsewhere and needs the refusal on its own thread -
a launch that answered "accepted" and only discovered in a worker that the job was already
`completed` would give nobody a way to tell a redo from a no-op.

Nothing here decides *when* the second half runs. That is deliberately not the kernel's
business: the API queues the work on the embedded executor (`docs/content/background-jobs.md`), the CLI
just calls `ingest`, and neither arrangement is visible in this module.

**An ingest therefore has two rows**: the `ingest_job` this document is about, which is the
domain record and what a client polls, and a generic `job` that records the *execution*. The
duplication is transitional and known - collapsing them is a migration with its own
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
started. That is why the state was spelled out before anything left one behind - adding it later
would have meant changing what a stored row means.

**`failed → running` is the only backward edge in this kernel**, and the argument against
reopening a [batch](batches.md) does not carry over. A batch pins a schema version at approval
and its jobs are already cut against that pin, so un-freezing one would invalidate work already
done. Nothing is pinned against an ingest run. It is a record of work, not an artifact with
dependents - so resuming is the same unit of work continuing, on the same row. A second row per
attempt would fork `batch_id` and turn `IngestService.list` into a list of retries.

**`running → running` is deliberately missing**, so a run stuck at `running` cannot be resumed.
That state is a process that died without reporting anything, not a failure anybody can read.
The remedy already exists - ingest the source again, which creates nothing - and it leaves the
stuck row as the only evidence the crash left.

## Progress a caller can poll

`processed` and `total` are written to the row **as the run goes**, so
`IngestService.get(job_id)` answers "where is it now" rather than "where did it end". That is
what `GET /ingest-jobs/{id}` returns and what the [ingest screen](#in-the-browser) polls; nothing
about it is specific to being in the same process.

| | what it means |
| --- | --- |
| `processed` | items dealt with - decoded and stored, or reported as unreadable |
| `total` | items the directory offered |

A directory can be listed, so `total` is stated before the first file - an empty one records
`0 of 0` rather than nothing. It is briefly `NULL` at the moment a run (or a resume) starts,
before the listing has happened; nothing outside this service observes that instant. A video
import's progress is a different pair on a different row - `expected_frame_count` and
`received_frame_count` on the `VideoImport` itself, since there is no listing to take a count
from - see ["A video import is a session, not a run"](#a-video-import-is-a-session-not-a-run).

The counter is written **once per item**, not on a cadence. An interval that suits five files
and one that suits fifty thousand are different numbers, and this service cannot know which it
is looking at; the cost of not choosing is one small commit beside a decode and a hash that
cost an order of magnitude more.

## Resuming a failed run

`IngestService.resume(job_id)` re-runs a failed job on its own row, into the batch the first
attempt was headed for. What qualifies is whatever the table says can reach `running` - `failed`,
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

Then, and only after the last block has exited, `IngestCompleted` goes on the bus - the rule every
emitter in this kernel follows.

Step 2 is outside a transaction because decoding is a Pillow pass over thousands of files, and
holding a write transaction open across it is how a single-writer SQLite store starts making
every other writer wait out its `busy_timeout` and fail with `WorkspaceBusy`. The blob writes are
out there too, before any
row exists: `BlobStore.put` is not transactional and a rollback cannot unwrite it - but a blob
nothing points at is harmless (content-addressed, shared, never deleted), while a row naming bytes
that were never stored is not.

The progress writes that happen *between* items are not a contradiction. Each is one `UPDATE`
that opens and commits while nothing is being decoded; what the single-writer warning is about
is a transaction held **across** the decode, not the existence of writes during that phase.

The honest consequence, stated rather than hidden: a process killed between transactions can leave
assets in the project with no batch and a job stuck at `running`. Finding it is what the job
record is for, and ingesting the source again is what fixes it - see the lifecycle above for why
that is the remedy rather than a resume.

Within a run, each file is **probed before it is stored**, so a file that is going to be refused
never leaves a blob behind.

## Failure splits by remedy, not by severity

A file that is not an image, or one whose bytes will not decode, is *reported*: one
`IngestFailure` carrying the item's name, the reason, and which of the two it was. The run carries
on, because an operator with five thousand files needs the other four thousand nine hundred. The
name and the reason are kept apart so a report renders as a table rather than as a list of
sentences, and `IngestFailureKind` exists so it can be **grouped** - real data loss must not be
buried under ordinary operator noise.

The report is on the row as well as in the return value, written as the run goes rather than at
the end: a report that only appeared once the run finished would be invisible for exactly as
long as it is interesting.

There used to be a third failure - `partial`, for a clip whose tail ran out mid-extraction, kept
alongside `frames_produced` and `frames_expected_estimate` - and it is gone along with the
server-side decoder that produced it. `IngestFailureKind` has two members now, both a total loss
for the one file they name, because there is no longer a decode running long enough to stop
*partway* inside this service. The failure mode the old section was written for has a different
shape now, and it is not this table's: see the next section.

## A video import that stops halfway leaves a session, not a partial batch

The `#452` problem this page used to describe - what to report when a clip is only half-decoded -
does not reach `IngestService` any more, because nothing here decodes a clip. It surfaces instead
as an incomplete `VideoImportService` session: a client that closes its tab, a browser that
crashes mid-materialization, a decode that a `VideoRefusal` stopped early. None of it puts an
asset anywhere. `commit` refuses with `VIDEO_IMPORT_INCOMPLETE` until every expected ordinal has
arrived, so the honest state of an interrupted import is a session sitting at `open`, holding
however many frames it managed and exactly zero assets - not eight images in a batch and one
report line explaining the other twelve. See ["A video import is a session, not a
run"](#a-video-import-is-a-session-not-a-run).

## A preview per asset, and it is allowed to fail

Every item also gets a thumbnail, stored content-addressed beside its content and named by
`asset.thumbnail_hash`. The M5 gallery is the reason: drawing a grid of hundreds of tiles by
decoding full-resolution images at request time is the wrong shape, and the cost is naturally
amortized here, where the bytes are already open and already decoded once.

**A thumbnail hash is a cache key, not an identity.** It is absent from every release manifest,
`ReleaseService.verify` never recomputes it, and two machines may legitimately hold different
preview bytes for one image - [media.md](media.md) has the determinism argument. Losing every
thumbnail blob loses only the time to render them again.

Everything else follows from that sentence.

**A preview that will not render is not an `IngestFailure`.** That error means "this file did not
become an asset, so fix the file"; here the asset exists, its bytes are stored and nothing was
lost. So the hash stays NULL and the run carries on with no entry in the report. Putting it there
would tell an operator that data was lost when it was not, and would bury real loss under it. The
NULL *is* the record, which is why nothing is logged: it is exactly what the backfill looks for.

**Frames get previews too, just not from here.** `VideoImportService` renders its own thumbnail
for each frame as it stages it, through the same `ImageProcessor.thumbnail` and onto the same
`asset.thumbnail_hash` this section describes - see its own docstring. It is a second call site
for the identical rule rather than a branch inside this one: a gallery with tiles for stills and
blanks for frames would be the worse outcome, whichever service put the asset there.

**One edge, one cache.** `DEFAULT_THUMBNAIL_MAX_EDGE` is pinned at the port and is not a
parameter on ingest or on the backfill. A per-call edge would fork the cache into variants
nothing can tell apart from a hash, and the column holds one pointer.

**A deduplicated asset has its NULL filled, and a value is never replaced.** Origin fields record
the first sighting and are never rewritten; a preview is not provenance, so filling an empty one
from whoever first held the bytes is not a rewrite. That is what makes re-ingesting a source
enough to give assets written before the cache existed their previews.

### The backfill

`IngestService.backfill_thumbnails(project_id)` renders a preview for every asset in a project
that has none - the remedy for all three things a NULL can mean, and idempotent, so a second pass
over a healthy project examines nothing. It reads assets by project, not by source, so a frame a
video import committed is caught up on exactly the same pass as a still an ingest brought in.

It reads the **blob**, never `asset.uri`: that path may be gone, renamed, or on another machine,
while `blob_store.get(asset.content_hash)` is what the workspace actually holds.

Three phases, and the rendering is in none of them - the same rule as a run. The first
transaction collects ids and hashes, the rendering happens outside any transaction, and the last
re-reads each asset before writing so an ingest that filled a preview meanwhile is not clobbered.

It reports rather than raises, on `ReleaseService.verify`'s terms: someone repairing a damaged
workspace needs the list, and one asset nobody can render must not abandon the other five
thousand. `ThumbnailBackfill` keeps `missing` (the content blob is gone - damage a preview pass
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
source's own folder. With one, that batch must still be a draft - checked **before** anything is
decoded, because finding out afterwards would mean finding out after the work.

Membership is everything the run ingested, deduplicated assets included: a duplicate is not new
data, but it is part of what the run was asked to gather. Order is ingest order, which for a
directory is filename order. A video import's batch is a separate story - built once, at
`commit`, in frame-ordinal order - and it is `VideoImportService.commit` that creates or reuses
it, never this service; see below. It takes the same pair, `batch_id` or `batch_name`, under the
same rule, and checks them at `start` for the same reason this service checks them at `enqueue`.

## At a terminal

```bash
BATCH=$(visionset ingest ./incoming --project road-signs --batch-name day-one)
```

`visionset ingest` takes a directory, and only a directory. Pointed at anything else - a video
file very much included - it refuses rather than guessing:

```
$ visionset ingest drive.mp4 --project road-signs
Error: drive.mp4 is not a directory. ingest takes a directory of still images. A video is
imported in the browser: run `visionset server`, open the project's Ingest screen and choose
the clip there — it is decoded on your machine and uploaded as frames. Nothing in this process
decodes video.
```

That refusal is a usage error (exit 2), fires before anything is registered, and names where a
clip is actually imported rather than leaving somebody to search for it - falling back to "treat
it as a folder" would put a decoder's refusal where the product's own answer belongs.

It is the only command in the CLI that is two SDK calls (`register_images` then `ingest`), and its
module says so. Both are safe to repeat: `register_images` is idempotent on the directory, and
content addressing means a second run creates nothing the first already did.

The batch id goes to stdout alone, so `BATCH=$(visionset ingest …)` is the whole idiom. The per-file
report goes to stderr, one line per refused file, so a redirected stdout stays a single id.

**The run is synchronous, and the CLI never calls `enqueue`.** A queued job needs a worker to pick
it up, and a CLI process has none - a detached job would simply never run. Polling is what the
server is for: `visionset server`, then `GET /ingest-jobs/{id}`.

**Interrupting a run leaves the job row at `running`, and there is no `--resume`.** The remedy needs
no new vocabulary: run the same line again. Registration finds the same source, `enqueue` does not
consult other jobs, and content addressing means the new run creates nothing the old one already
created. The stuck row stays as the only evidence that something was interrupted, which is the same
posture the kernel takes about a crashed process.

## Over HTTP

The image-directory half of the [API](api.md) is `enqueue` and `resume` with a worker between
them:

```
POST /projects/{id}/sources/images   multipart: the files + an optional name → 201 SourceOut
POST /sources/{id}/ingest-jobs                                             → 202 IngestJobOut
GET  /ingest-jobs/{id}                                                     → 200 IngestJobOut
GET  /batches/{id}/assets                                                  → 200 the assets
```

The launch calls `enqueue` on the request thread and hands the `pending` job to a **single
background worker** - one, so that runs serialize against a single-writer store rather than
racing each other. What that buys the *reader* is what [#80's concurrency posture](workspaces.md)
was for: a client polling while the worker holds a write transaction reads through WAL instead
of waiting on it.

**Where a refusal appears depends on when it can be known.** An unknown source or a blank batch
name is refused synchronously, with a 404 or a 422 - the launch never returns 202 pointing at a
job row nobody wrote. Everything after that is on the job: `state` becomes `failed` and `error`
carries the cause, while individual unreadable items sit in `failures` and do not fail the run
at all. That split is the same one this service already makes; HTTP just changes where you read
it.

Registration over HTTP is **upload-only**, and the bytes are staged content-addressed - see
[sources.md](sources.md). There is no video route here at all - `POST
/projects/{id}/sources/video` is gone, and a `VIDEO` source is opened by an entirely different
router, `video-imports` - see the next section and [api.md](api.md).

`batch_id` on the launch body is how a second source joins the first one's batch, and it waited
for batches to have endpoints. The objection was never the feature: it was that a refusal must
not leave a caller holding a 202 pointing at a job row nobody wrote. It does not - `enqueue`
resolves the batch in the same transaction that inserts the job, so an unknown batch is a **404**
and one past `draft` is a **409 `BATCH_NOT_EDITABLE`**, both answered on the request that asked
for them. See [batches.md](batches.md).

## What is deliberately not here yet

- **No scheduler.** `enqueue` and `resume` are two calls; nothing in the kernel decides when the
  second one runs. The API supplies one background worker, the CLI supplies the calling thread,
  and a queue would be a third arrangement neither of them would notice.
- **No cross-attempt history.** The report and the counters describe the current attempt. A
  resumed run overwrites them, and a log of every attempt would be its own table.

## A video import is a session, not a run

`IngestService.ingest` is one call because a directory can be listed and read to completion in
one process, one blocking pass. A video cannot be, for a reason that has nothing to do with
performance: **the server never receives the clip.** A browser demuxes and decodes it locally,
one PNG frame at a time, and posts each frame across however many requests that takes - which
means the work now has a *middle*, an arbitrary stretch of time between "here is what I am about
to send" and "that was all of it", and a single synchronous call has nowhere to put that. So
`VideoImportService` is a service of its own rather than a second branch in `IngestService`, with
its own lifecycle:

```
POST   /projects/{project_id}/video-imports    declare the clip, open the session   → VideoImportOut
POST   /video-imports/{import_id}/frames       stage a bounded chunk of frames      → VideoImportOut
POST   /video-imports/{import_id}/commit       every expected frame has arrived     → BatchOut
DELETE /video-imports/{import_id}              throw the session away               → 204
```

`start` is a **declaration**: `metadata` is what the client's own decoder read off the container,
taken as provenance rather than probed, because there is nothing here to probe it against. Its
`fps` is the rate the clip was *shot* at and is `null` for a variable-rate one, which has no
single rate; the rate it is being cut at is `extraction_fps`, and it is never put in the other's
place. The one
number not taken on trust is `expected_frame_count` - the ranges and rate the caller declared are
canonicalized and counted server-side, the same `expected_frames` arithmetic
[sources.md](sources.md) describes, so "every frame arrived" at commit is a fact this process
computed rather than a client's claim.

`append_frames` decodes what it is handed, through the same `ImageProcessor` an image-directory
ingest uses - see [media.md](media.md) - so a frame that is not a PNG is refused on the spot
rather than stored and discovered later. What it is checked *against* is the session's own
declaration: a frame must decode to the clip's width and height after `scale_percent`, the same
`scaled_dimension` arithmetic the materializer runs. Comparing a frame only with its own
descriptor would be circular, both halves being the client's, and would let a session declare one
geometry and hold assets of another. Those are display dimensions, so a clip the container rotates
needs nothing special, and a part is refused off its **weight** before any of that: the ceiling is
that geometry's own raster, which no honest encoding of it exceeds, and it is read off the handle
rather than after a decode. Parts are streamed, never read whole - `FRAMES_PER_REQUEST` bounds how
many arrive and never how big one is. It is also **idempotent by content**: the same ordinal carrying the same
bytes is an ordinary retry and writes nothing; the same ordinal carrying different bytes is
`FRAME_CONTENT_CONFLICT`, which a session cannot resolve on its own and has to be aborted and
restarted - and that adjudication holds under two genuinely concurrent appends at one ordinal,
where the unique index refuses the loser's insert and the re-read settles it.

**The invariant the whole session exists to protect: nothing staged is a project `Asset` before
`commit`.** Between `start` and `commit`, frames sit in the blob store and in `video_import_frame`
rows that no listing, batch or dataset membership check can see. A closed tab, a crashed decoder,
an aborted session - every one of them leaves the project exactly as it was before `start`, which
is the property an `IngestJob` never had to promise, because an ordinary ingest run is one
process's one pass and either completes or leaves a job stuck at `running` with whatever it had
already written. `commit` is the single moment that changes: it refuses with
`VIDEO_IMPORT_INCOMPLETE` while any expected ordinal is still missing, and otherwise turns every
staged frame into an asset, attaches them to a batch, and marks the session `committed` - all in
one transaction, and idempotent, so a retried commit answers the batch the first one made rather
than making a second. The batch is the draft `start` was given as `batch_id`, or one created here
named by `batch_name` and failing that after the clip; a target that was approved or deleted while
the clip decoded is refused - `BATCH_NOT_EDITABLE`, `BATCH_NOT_FOUND` - rather than replaced with
a batch nobody chose. The staged rows go at commit, exactly as they go at abort: they are assets
now, and a terminal session's frames are rows nothing will read again.

`abort` throws a session away: its frame rows go with it, its blobs do not (content-addressed, and
an orphan one is unreachable rather than wrong, the same policy an ingest that refuses a file after
storing part of it already lives with), and the `VIDEO` source it declared stays for the moment,
because aborting does not un-declare that somebody offered this clip.

**A session is a row somebody can ask for, so two bounds sit on `start`.** A project may hold only
so many sessions `open` at once - `TOO_MANY_OPEN_VIDEO_IMPORTS` past that, resolved by committing
or aborting one - and a declaration whose whole-clip grid holds more frames than a session may
stage is `VIDEO_IMPORT_TOO_LARGE`, which is how a duration and a rate that are each individually
in bounds are caught - as is a declared frame geometry no decoder here could open, which is also
what keeps the per-part weight ceiling a number rather than whatever a caller declared. The same call sweeps what was genuinely abandoned: a session neither
committed nor touched for a day is deleted *through its source*, which cascades the session and
every frame staged under it away together. Deleting the session alone would leave one `VIDEO`
source per abandoned attempt behind forever, which is the same unbounded growth one table over. A
committed session is never swept - its source is the provenance of assets somebody is annotating.

## In the browser

`@visionset/ui-core`'s ingest screen picks between two flows by source kind rather than running
one flow with a branch in it, mirroring the split on this page: `ImageIngestFlow` is the
directory/upload path this section used to describe alone, and `VideoImportFlow` is everything
around a `VideoImportService` session - inspection, capability refusal, ranges, rate and scale,
materialization, progress, commit and cancel. `clipProbe.ts`, the module that used to talk to a
server-side probe, is gone; a clip is inspected by `@visionset/media`, in the browser, before
anything is ever sent.

A clip `@visionset/media` can open gets a preview player and a timeline: dragging on it selects
one or more **clip ranges**, half-open stretches the import will read. The selection is stored
canonically — clamped to the clip, sorted, overlapping and touching ranges merged, a full cover
collapsing to the empty selection — on exactly the arithmetic `sources.md` describes, ported so a
frame count computed here matches what the server would derive from the same ranges. A clip the
browser's decoder refuses - no video track, a container it cannot parse, a codec `VideoDecoder`
will not touch, or a browser missing WebCodecs entirely - surfaces one of `VideoRefusal`'s
closed set of reasons rather than a generic failure, and starts no import at all.

The image-directory flow still shows `processed` against `total` and groups its per-file report
by `IngestFailureKind`, offering **Resume** only for a `failed` run - a stuck `running` job has no
button, because `running → running` is deliberately not a transition. See
[ui.md](ui.md#the-ingest-flow-and-the-order-the-domain-forces). The video flow shows a different
pair - a session's `received_frame_count` against `expected_frame_count` - and its actions are
**Commit**, available once the two are equal, and **Cancel**, available until then; there is no
resume, because a session that stalls is aborted and restarted rather than continued; the
`partial` failure this section used to describe here does not exist for either flow any more.
