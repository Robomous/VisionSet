# Ingest

Where a registered [source](sources.md) becomes rows. `IngestService` hashes every item, stores
the bytes once, records what the decoder made of them, and puts the result in a draft
[batch](batches.md) somebody can approve. Nothing else in the kernel creates an `Asset` —
`examples/sdk_end_to_end.py` used to, and no longer does.

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

## The run has a lifecycle, and it is a table

`INGEST_TRANSITIONS` in `domain/ingest.py` is the whole of what is legal. `IngestService`
consults it through `require_move`; nothing restates it.

```
pending ──▶ running ──▶ completed
   │           │
   └────────▶ failed ──▶ running        (resume)
```

A job is created `pending` and moved to `running` by whoever picks the work up. Today that is
the same call, and the state is over in microseconds — it is spelled out anyway because it is
the vocabulary a queue needs, and adding it later would mean changing what a stored row means.

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
the contract the HTTP API and the UI will reuse; nothing about it is specific to being in the
same process.

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
SQLite store starts reporting "database is locked". The blob writes are out there too, before any
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

## The target batch

With no `batch_id`, the run creates a draft named `batch_name` or, failing that, after the
source's own file or folder. With one, that batch must still be a draft — checked **before**
anything is decoded, because finding out afterwards would mean finding out after the work.

Membership is everything the run ingested, deduplicated assets included: a duplicate is not new
data, but it is part of what the run was asked to gather. Order is ingest order, which is filename
order for a directory and frame order for a clip.

## What is deliberately not here yet

- **No thumbnails.** Generating one per asset at ingest and recording `asset.thumbnail_hash` is
  #21, for the M5 gallery.
- **No background execution.** A run is synchronous and in-process. The service API is shaped so
  that moving it behind a queue changes the caller's waiting, not its vocabulary — which is why
  a job is created `pending` and why progress is read off the row rather than off a callback.
- **No cross-attempt history.** The report and the counters describe the current attempt. A
  resumed run overwrites them, and a log of every attempt would be its own table.
