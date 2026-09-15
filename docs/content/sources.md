# Sources

A **source** records raw data offered to a project: either a directory of still images this
process can open, or a declared video. A source is not annotatable and stores no pixels. Ingest
*materializes* assets from the source, which retains their origin.

A `VIDEO` source no longer means "a video file exists at a path the server can read." This
server does not decode video at all, so it means: *this set of image assets was materialized by a
client from this declared clip, under this extraction policy.* What used to be a probe of a file
on disk is now a client's own report of what its decoder read, taken as a declaration and stored
as provenance - and the frames that report describes arrive afterwards, through their own session.
See [ingest.md](ingest.md) for that session and [media.md](media.md) for why nothing here decodes
a clip.

## Two doors, one per kind

`SourceService` is the one door to an `IMAGE_DIRECTORY` source, and the only door that reads
either kind back:

```python
sources = SourceService(workspace)

stills = sources.register_images(project.id, Path("~/captures/2026-07").expanduser())
```

There is no `register_video` any more, and no `register(kind=...)` either. A `VIDEO` source is
made by `VideoImportService.start`, the same call that opens the session its frames stage into -
see [ingest.md](ingest.md) - because there is nothing left for a second, dedicated registration
step to do: the server never receives the clip, so there is no file to check and nothing to
probe. `SourceService.get`, `.list` and `require_source` still answer for both kinds; they read a
row and do not care which service wrote it.

`register_images` checks that the directory exists and is a directory, and stops there. What is
*in* it is read at ingest, because a count taken at registration would be stale by the time
anything used it.

## What a source records

| Field | Meaning |
| --- | --- |
| `kind` | `image_directory` or `video` - a `SourceKind` |
| `locator` | identifies the origin; only `image_directory` promises it is a path this process can open |
| `display_name` | what somebody asked this source to be *called*, or `None` for nobody said |
| `registered_at` | timezone-aware UTC, the **first** registration |
| `capture_params` | opaque operator-supplied provenance; nothing branches on it |
| `video` | a `VideoProvenance`, present exactly when `kind` is `video` |

`locator` is the domain's name for what used to be unconditionally `path`, and the rename is the
point: a directory's locator is a canonical filesystem path, `canonical_path`-normalized, and this
process may open it. A `VIDEO` source's locator is `video-import:<uuid4>` - a token naming that
import and nothing else, opaque to every reader but `VideoImportService` itself, and unique per
import so two clients declaring "the same" clip are still two sources rather than one row racing
to be first. Nothing downstream is entitled to treat it as a path; the underlying database column
is still named `path` and unchanged, because the rename is a domain-level promise, not a schema
migration.

`display_name` exists because not every locator has a readable last segment: an HTTP upload of
stills is staged under a content-addressed directory, so its basename is a 64-character digest,
and a video import's locator is a bare token with no segment a person would recognize at all -
while a directory named at a terminal, or a clip somebody titled before starting the import,
carries something a person chose. Like `capture_params` it is outside the identity key —
renaming must not fork one origin into two — and unlike `registered_at` a stated value *does*
refresh the stored one, because a label is curation rather than provenance. `Source.name` is the
one spelling of the resolution: the stated name, else the locator's last segment, and it is what
both wire projections publish.

`VideoProvenance` is what a client's decoder read off the container - width, height, the
*source* fps, duration, codec - plus the cut a decomposition will run at: `extraction_fps`, the
clip `ranges` extraction reads (empty meaning the whole clip), and `scale_percent`, the percent of
the native size frames are stored at (100 meaning unscaled). Ranges are stored canonically —
clamped to the clip, sorted, overlaps and touches merged, a full cover collapsing to the
empty selection — so two spellings of one selection cannot fork a source. The declared metadata is
kept whole rather than re-spelled field by field, because `metadata.fps` is the rate the file was
*shot* at and `extraction_fps` is the rate we chose to *cut* it at, and re-declaring the first
beside the second is how the two come to be confused. `metadata.fps` is `null` for a
variable-frame-rate clip, which has no single rate it was shot at; the extraction rate is never put
there to fill the gap.

Two more fields ride beside that cut, and they are about the decomposition rather than the clip:
`policy_version` names which spelling of the sampling rules — the grid, the rotation handling, the
scale rounding — produced these frames, and `materializer` names what actually decoded them (a
string like `"mediabunny/1.56.1"`, or `None` for a source registered before either field existed).
Frame bytes are not reproducible across decoders the way a JPEG's bytes are reproducible across
machines - two browsers can disagree over one container - so neither field promises a clip will
decode the same way twice; they say which policy was in force and what drew the frames, so a
future change to either is legible in the data instead of an unexplained difference between two
batches.

The `video`/`kind` pairing is an invariant, enforced on construction **and** on assignment -
`Source` is the only model in the domain with `validate_assignment` on, because a
`model_validator` does not re-run when you assign to a field. Reading it goes through
`source.require_video()`, which raises `WorkspaceCorrupt` rather than handing back a `None` that
every caller would have to assert away.

## Decomposition parameters live on the source, not on the job

A source can be ingested more than once, and the promise is that the same source yields the same
assets. That promise only means something if the parameters are part of what "the same source"
*is* - put them on the ingest job and two runs of one source could legitimately disagree, leaving
idempotency with nothing to be measured against.

The consequence is deliberate: **one clip registered at 1 fps and again at 5 fps — or at 100%
and again at 50% — is two sources over one file**, not one source with a history.

## Storing frames at a smaller size

A video import declares an optional `scale_percent` when it starts, and the client's own
materializer is what applies it: every frame it posts already comes out at
`max(1, (native * percent + 50) // 100)` per dimension - `scaledDimension` in `@visionset/media`,
the same integer formula `VideoProvenance.stored_width`/`stored_height` compute from the record.
The server does not resize anything; it only checks that a staged frame's declared size, decoded,
matches what the source says every frame of this import should be. Image directories always
store stills at their decoded size — an image batch mixes resolutions, and export is where a
uniform size is made.

This is not the export-time resize: [pre-processing recipes](preprocessing.md) bring every
exported image to one model input size at export. The import-time scale exists to cut upload
and storage cost for clips nobody needs at native resolution, and it is permanent — the assets
*are* the smaller pixels. Starting another import of the same clip at a different scale is a
second source.

## Image-directory registration is idempotent; a video import never merges

`register_images`'s match key is `(kind, locator)` within a project: registering the same
directory twice returns the same `Source` rather than a second one, so that once ingest gives
`asset.source_id` a target, "which source did this asset come from?" has one answer.
`capture_params` is deliberately left out of that key — fragmenting one directory into two
sources because an operator typed a different lens note would defeat the point — and differing
params are written onto the matched source instead.

A video import has no equivalent merge, on purpose. `VideoImportService.start` always creates a
new source, because its locator is a fresh `video-import:<uuid4>` every time - there is no
"already-known clip" to match against, since the server never has the bytes to compare. **Two
imports of what a person considers the same file are two sources**, exactly as two registrations
of one clip at different rates or ranges already were before this change; asset-level content
addressing is what actually deduplicates identical frames, and it does that regardless of how
many sources point at them.

The unique index underneath `register_images` still carries video's old columns -
`uq_source_project_kind_path_fps_ranges_scale`, over `(project_id, kind, path,
coalesce(json_extract(video, '$.extraction_fps'), 0), coalesce(json_extract(video, '$.ranges'),
''), coalesce(json_extract(video, '$.scale_percent'), 0))` - because the stored rows still carry
them and dropping a column is a migration nobody has asked for. For an `image_directory` row
those terms are always the same three zeros, so the index does what it always did: it is the
backstop under two concurrent registrations of one folder, which the module docstring for
`SourceService` calls dead weight for the one writer left there. For a `video` row every locator
is already unique, so the same index can never fire for one - the guarantee it existed to give
video sources is now given structurally, by the locator itself, rather than by this constraint.

### The gap this left, and how it was closed

The idempotency check above shipped without a backstop, which `docs/content/persistence.md`
calls a wish: two concurrent registrations of one folder could both pass the pre-check and both
insert. It was tolerable only because nothing referenced a source, so a duplicate was inert - and
[ingest](ingest.md) ended that, by giving `asset.source_id` a target and letting the winner of a
race decide an asset's recorded origin. The index above went in with it, `coalesce`d rather than
left to compare NULLs, because SQLite treats NULLs in a unique index as **distinct** - an image
directory, whose `video` is NULL, would otherwise never collide with itself, which is most of
what the index is for.

The two layers do what they do everywhere else in this store. The pre-check is what produces a
friendly answer; the index is the guarantee. A caller that loses the race sees a raw
`ConstraintViolated`, and the remedy is to call the same method again, which finds the winner's
row and returns it. A caller that instead waits out the store's `busy_timeout` sees
`WorkspaceBusy`, and the remedy is the same.

## Paths are canonicalized once, and only for a directory

`canonical_path` is `str(Path.resolve(strict=True))`: absolute, symlinks followed, so `./data`,
`../project/data` and `/abs/data` are one source. It applies to `register_images` alone - a
video import's locator is an opaque token the server minted itself, never a path anyone supplied,
so there is nothing to resolve. Two things `canonical_path` does not do:

- **It does not normalize case.** On a case-insensitive filesystem - macOS by default, Windows
  always - `/Data` and `/data` are one directory and would register as two sources. Lower-casing
  would be wrong on Linux, where they are genuinely two.
- **It does not look at the content.** Two hard links to one inode read as two origins. What the
  bytes *are* is asked at ingest, where the answer is a content hash.

`strict=True` means an origin that is not on disk is a `FileNotFoundError`, and a file offered
where a directory was wanted is a `NotADirectoryError`. Both are about the machine rather than
the workspace, so both stay outside the `VisionSetError` tree.

## Over HTTP, a directory is an upload; a clip is never one

`SourceService` registers a directory by path, and an HTTP client has bytes rather than a path.
So the [REST API](api.md)'s `POST /projects/{id}/sources/images` takes multipart - one `files`
part per image plus an optional `name` - writes the parts under `<workspace>/uploads/`, and
registers what it wrote. There is **no route that accepts a server-side path**: it would hand
every token holder an arbitrary-directory read, and the two surfaces that legitimately hold real
paths, the CLI and MCP, call the SDK in-process and never go through HTTP.

The staging directory is named by a **digest of the whole part set** - sha-256 over the sorted
`name:sha256` lines - which is what makes `register_images`'s idempotency survive the trip. The
same files under the same names stage to the same path, so a repeated upload returns the *same*
`Source` instead of a second one over a second copy on disk. Different bytes, or the same bytes
under a different filename, are a different offer and stage apart.

That upload-only choice has a quiet dividend: because the server just wrote the file, the
`FileNotFoundError` and `NotADirectoryError` above are unreachable from HTTP. Neither is a
`VisionSetError`, so neither has an entry in the API's error table - and neither needs one.

A client never sees `locator`. `SourceOut` publishes the source's name and nothing about the
machine - which for a `VIDEO` source is doubly true, since there was never a machine path to
begin with. A video source is never registered through `sources.py` at all: it comes into being
by `POST /projects/{id}/video-imports`, a JSON body of declared metadata and no bytes, documented
in [ingest.md](ingest.md).

## Declaring a source is not validating it

That was true of `register_video`'s probe, and it is still true of what replaced it. A clip whose
tail has been truncated still has a readable header, so a client's own probe reports a plausible
duration and `VideoImportService.start` records it without complaint - the server has no way to
know otherwise, since it never sees the bytes. The damage, if there is any, surfaces later and
per frame: each one is decoded by `ImageProcessor` as it is staged, and a frame that will not
decode, or that decodes to something other than its own declared size, is refused there. Anything
that treats a successful `start` as proof a clip will fully materialize is wrong, on the same
terms the old registration warning stated it.

## What is deliberately not here yet

- **No delete.** A source disappears with its project's cascade and no sooner. The question ingest
  raised does now have an answer, though: an asset **outlives** the receipt it came from. Deleting
  a source must not take the asset, its annotations, its dataset membership or the releases naming
  it, so a future `SourceService.delete` clears `asset.source_id` rather than cascading through it
 - and it has to do that itself, because that column is deliberately not a foreign key (see
  `adapters/_tables.py` for why, and what it costs).
- **No event.** Registering a source announces nothing. `IngestCompleted` is the event this area
  emits, and [the ingest pipeline](ingest.md) owns it.
- **No remote kinds.** `SourceKind` has two members and grows by a deliberate kernel change with
  a service method behind it - see the enum's own docstring for why it is an enum where
  `DatasetChange.operation` is a plain `str`.
