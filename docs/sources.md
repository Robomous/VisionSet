# Sources

A **source** is the record that raw data was offered to a project: a directory of stills, or a
video file. It is not annotatable and holds no pixels. Assets are what an ingest *materializes*
from a source; the source is the receipt that says where they came from.

`SourceService` is the one door to a `Source`. Nothing else writes `uow.sources`.

## Two registration methods, not one

```python
sources = SourceService(workspace)

stills = sources.register_images(project.id, Path("~/captures/2026-07").expanduser())
clip = sources.register_video(project.id, Path("~/captures/drive.mp4"), extraction_fps=5.0)
```

There is no `register(kind=...)`, because the arguments genuinely differ. A clip needs a
decomposition rate and gets probed; a directory needs neither and is not walked. That is the same
argument that made `ImageProcessor` and `VideoProcessor` two protocols instead of one — see
[media.md](media.md). A single entry point would have to accept parameters that are meaningless
for half its callers.

`register_images` checks that the directory exists and is a directory, and stops there. What is
*in* it is read at ingest, because a count taken at registration would be stale by the time
anything used it.

`register_video` probes the file through the workspace's `VideoProcessor` and stores the answer.
The probe runs **before** the transaction opens: it is an out-of-process decoder, and holding a
write transaction open across a subprocess is how a single-writer SQLite store ends up making
every other writer wait out its `busy_timeout` and fail with `WorkspaceBusy`.

## What a source records

| Field | Meaning |
| --- | --- |
| `kind` | `image_directory` or `video` — a `SourceKind` |
| `path` | the canonical absolute path of the origin |
| `display_name` | what somebody asked this source to be *called*, or `None` for nobody said |
| `registered_at` | timezone-aware UTC, the **first** registration |
| `capture_params` | opaque operator-supplied provenance; nothing branches on it |
| `video` | a `VideoProvenance`, present exactly when `kind` is `video` |

`display_name` exists because not every path has a readable last segment: an HTTP upload of
stills is staged under a content-addressed directory, so its basename is a 64-character digest,
while a directory or a clip named at a terminal carries something a person chose. Like
`capture_params` it is outside the identity key — renaming must not fork one origin into two —
and unlike `registered_at` a stated value *does* refresh the stored one, because a label is
curation rather than provenance. `Source.name` is the one spelling of the resolution: the stated
name, else the path's last segment, and it is what both wire projections publish. Only
`register_images` takes it, because a clip's basename is already its filename.

`VideoProvenance` is the port's own `VideoMetadata` — original fps, duration, displayed
dimensions, codec — plus the `extraction_fps` a decomposition will run at. The probe result is
kept whole rather than re-spelled field by field, because `metadata.fps` is the rate the file was
*shot* at and `extraction_fps` is the rate we chose to *cut* it at, and re-declaring the first
beside the second is how the two come to be confused.

The `video`/`kind` pairing is an invariant, enforced on construction **and** on assignment —
`Source` is the only model in the domain with `validate_assignment` on, because a
`model_validator` does not re-run when you assign to a field. Reading it goes through
`source.require_video()`, which raises `WorkspaceCorrupt` rather than handing back a `None` that
every caller would have to assert away.

## Decomposition parameters live on the source, not on the job

A source can be ingested more than once, and the promise is that the same source yields the same
assets. That promise only means something if the parameters are part of what "the same source"
*is* — put them on the ingest job and two runs of one source could legitimately disagree, leaving
idempotency with nothing to be measured against.

The consequence is deliberate: **one clip registered at 1 fps and again at 5 fps is two sources
over one file**, not one source with a history.

## Registration is idempotent

The match key is `(kind, path, extraction_fps)`. Registering the same origin twice returns the
same `Source` rather than a second one, so that once ingest gives `asset.source_id` a target,
"which source did this asset come from?" has one answer.

Two things the key deliberately leaves out:

- **`capture_params`.** Fragmenting one directory into two sources because an operator typed a
  different lens note would defeat the point. Differing params are written onto the matched
  source instead.
- **The probed `VideoMetadata`.** A clip replaced at a known path is still that path's source, so
  its recorded provenance is *refreshed in place* rather than left describing a file that is
  gone. `registered_at` is never rewritten — it is the first registration, not the last.

That second rule has a corollary worth knowing: re-registering an already-known clip still needs
ffmpeg, because the fresh probe is what keeps the record honest.

### The gap this left, and how it was closed

This rule shipped without a backstop, which `docs/persistence.md` calls a wish: two concurrent
registrations of one folder could both pass the pre-check and both insert. It was tolerable only
because nothing referenced a source, so a duplicate was inert — and [ingest](ingest.md) ended
that, by giving `asset.source_id` a target and letting the winner of a race decide an asset's
recorded origin.

`uq_source_project_kind_path_fps` went in with it, over
`(project_id, kind, path, coalesce(json_extract(video, '$.extraction_fps'), 0))`. The fourth term
is an expression rather than a column, and it is `coalesce`d rather than left to be NULL, because
SQLite treats NULLs in a unique index as **distinct** — an image directory, whose `video` is NULL,
would otherwise never collide with itself, which is most of what the index is for. `0` cannot be
mistaken for a real rate: `extraction_fps` is `gt=0`.

The two layers do what they do everywhere else in this store. The pre-check is what produces a
friendly answer; the index is the guarantee. A caller that loses the race sees a raw
`ConstraintViolated`, and the remedy is to call the same method again, which finds the winner's
row and returns it. A caller that instead waits out the store's `busy_timeout` sees
`WorkspaceBusy`, and the remedy is the same.

## Paths are canonicalized once

`canonical_path` is `str(Path.resolve(strict=True))`: absolute, symlinks followed, so `./data`,
`../project/data` and `/abs/data` are one source. Two things it does not do:

- **It does not normalize case.** On a case-insensitive filesystem — macOS by default, Windows
  always — `/Data` and `/data` are one directory and would register as two sources. Lower-casing
  would be wrong on Linux, where they are genuinely two.
- **It does not look at the content.** Two hard links to one inode read as two origins. What the
  bytes *are* is asked at ingest, where the answer is a content hash.

`strict=True` means an origin that is not on disk is a `FileNotFoundError`, and a file offered
where a directory was wanted is a `NotADirectoryError`. Both are about the machine rather than
the workspace, so both stay outside the `VisionSetError` tree — the same line
`MediaToolUnavailable` sits on.

## Over HTTP, a path is an upload

`SourceService` registers by path, and an HTTP client has bytes rather than a path. So the
[REST API](api.md) takes multipart — one `files` part per image, or one `file` part plus an
`extraction_fps` field for a clip — writes the parts under `<workspace>/uploads/`, and registers
what it wrote. There is **no route that accepts a server-side path**: it would hand every token
holder an arbitrary-directory read, and the two surfaces that legitimately hold real paths, the
CLI and MCP, call the SDK in-process and never go through HTTP.

The staging directory is named by a **digest of the whole part set** — sha-256 over the sorted
`name:sha256` lines — which is what makes the idempotency above survive the trip. The same files
under the same names stage to the same path, so a repeated upload returns the *same* `Source`
instead of a second one over a second copy on disk. Different bytes, or the same bytes under a
different filename, are a different offer and stage apart.

That upload-only choice has a quiet dividend: because the server just wrote the file, the
`FileNotFoundError` and `NotADirectoryError` below are unreachable from HTTP. Neither is a
`VisionSetError`, so neither has an entry in the API's error table — and neither needs one.

A client never sees `path`. `SourceOut` publishes the filename and nothing about the machine.

## Registration is not a validation pass

`register_video` probes; it does not decode. A clip whose tail has been truncated still has a
readable header, so it registers successfully and records the duration the intact file would have
had. The damage surfaces when frames are actually extracted. Anything downstream that treats a
successful registration as proof the file will decode is wrong.

## What is deliberately not here yet

- **No delete.** A source disappears with its project's cascade and no sooner. The question ingest
  raised does now have an answer, though: an asset **outlives** the receipt it came from. Deleting
  a source must not take the asset, its annotations, its dataset membership or the releases naming
  it, so a future `SourceService.delete` clears `asset.source_id` rather than cascading through it
  — and it has to do that itself, because that column is deliberately not a foreign key (see
  `adapters/_tables.py` for why, and what it costs).
- **No event.** Registering a source announces nothing. `IngestCompleted` is the event this area
  emits, and [the ingest pipeline](ingest.md) owns it.
- **No remote kinds.** `SourceKind` has two members and grows by a deliberate kernel change with
  a service method behind it — see the enum's own docstring for why it is an enum where
  `DatasetChange.operation` is a plain `str`.
