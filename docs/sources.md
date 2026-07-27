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
write transaction open across a subprocess is how a single-writer SQLite store ends up reporting
"database is locked".

## What a source records

| Field | Meaning |
| --- | --- |
| `kind` | `image_directory` or `video` — a `SourceKind` |
| `path` | the canonical absolute path of the origin |
| `registered_at` | timezone-aware UTC, the **first** registration |
| `capture_params` | opaque operator-supplied provenance; nothing branches on it |
| `video` | a `VideoProvenance`, present exactly when `kind` is `video` |

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

### The gap this leaves, and when to close it

`docs/persistence.md` says a rule with no backstop is a wish, and every other uniqueness rule in
this store has a unique index behind it. This one does not. Two concurrent registrations of one
folder can both pass the pre-check and both insert.

That is tolerated today because no row references a source, so a duplicate is inert. It stops
being tolerable when ingest gives `asset.source_id` a target and the winner of a race starts
deciding an asset's recorded origin — **that is when this needs an index under it**. It sits
alongside the store's other known concurrency gap, the untranslated `OperationalError`.

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

## Registration is not a validation pass

`register_video` probes; it does not decode. A clip whose tail has been truncated still has a
readable header, so it registers successfully and records the duration the intact file would have
had. The damage surfaces when frames are actually extracted. Anything downstream that treats a
successful registration as proof the file will decode is wrong.

## What is deliberately not here yet

- **No delete.** A source disappears with its project's cascade and no sooner. Nothing yet
  references one, so there is no orphan to reason about; when ingest gives `asset.source_id` a
  target, deletion becomes a real question with a real answer.
- **No event.** Registering a source announces nothing. `IngestCompleted` is the event this area
  will emit, and the ingest pipeline owns it.
- **No remote kinds.** `SourceKind` has two members and grows by a deliberate kernel change with
  a service method behind it — see the enum's own docstring for why it is an enum where
  `DatasetChange.operation` is a plain `str`.
