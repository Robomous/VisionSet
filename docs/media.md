# Media

Before anything can be annotated it has to be decoded, and the kernel has to know what it just
decoded. That is what the media ports are for: hand them bytes, and they either tell you what
the picture is or refuse it with a sentence naming the file.

```python
from pathlib import Path

from visionset.kernel.services import WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    with open("photos/IMG_0043.jpg", "rb") as handle:
        metadata = workspace.image_processor.probe(handle)  # ImageMetadata(width=..., ...)
        preview = workspace.image_processor.thumbnail(handle)  # opaque JPEG bytes

    clip = Path("footage/dashcam.mp4")
    info = workspace.video_processor.probe(clip)  # VideoMetadata(fps=29.97, ...)
    for frame in workspace.video_processor.frames(clip, fps=1):
        ...  # frame.index, frame.timestamp, frame.content — a PNG
```

## Two protocols, not one

`ImageProcessor` and `VideoProcessor` are separate ports rather than one `MediaProcessor` with
both jobs, because the two have almost nothing in common at the type level: an ffmpeg adapter
has no thumbnail to serve and a Pillow adapter has no frames to iterate. A shared protocol would
force each implementation to declare the other's methods and raise from them — a runtime failure
where a compile-time absence was available.

Each is declared by the task that implements it, in its own file, and both exist today:
`ImageProcessor` behind `PillowImageProcessor`, `VideoProcessor` behind `FfmpegVideoProcessor`.

They also take different inputs, and that asymmetry is deliberate rather than an inconsistency
waiting to be tidied. `ImageProcessor` takes a **stream**; `VideoProcessor` takes a **path**. A
video decoder is an out-of-process program that seeks: handed a pipe it cannot say how long a
clip is without decoding all of it, and cannot revisit a byte it has already read. Nothing is
lost by requiring a file, because no caller has video bytes without one — a source is a path on
disk, and a blob in the default blob store is a path too.

| | `ImageProcessor` | `VideoProcessor` |
| --- | --- | --- |
| Input | an open binary stream | a `Path` |
| Reads | `probe` → `ImageMetadata` | `probe` → `VideoMetadata` |
| Produces | `thumbnail` → JPEG bytes | `frames` → an iterator of `VideoFrame` |
| Needs | Pillow, a dependency | ffmpeg, a binary on `PATH` |

## The accepted list is two formats, and widening it is a decision

`ImageFormat` names everything VisionSet decodes: **JPEG and PNG**. Extending it is exactly two
edits — a member on the enum, and the decoder's own spelling of it in the adapter's
`_FORMAT_BY_PILLOW_NAME` — and a test asserts the two cover the same set, so a half-done
extension fails on the first run rather than at the first file.

That cost is the point. Accepting a format is a promise that VisionSet will decode it, hash it,
thumbnail it and export it for as long as the workspaces written today are readable. A
`try: decode` that admitted whatever the installed Pillow happened to support would make that
promise depend on a wheel, and it would quietly let in the long tail where image-decoder CVEs
live. WEBP is the obvious next member; it is not here yet because a format with no generated
fixture is a format nobody is testing.

`MPO` is a special case worth knowing about and is **not** a third format. It is a
multi-picture JPEG container — what phones write in portrait and burst modes — so it is an
alias in the decoder's table, and its primary frame is what every viewer shows and what
VisionSet reads. Leaving it out would have rejected a large share of real camera output as
unsupported.

**The bytes decide the format, not the filename.** A `.png` holding JPEG bytes reports `jpeg`.
A suffix is a hint for choosing which files to look at; what a file *is* comes from decoding it.

### There is no `VideoFormat`, on purpose

The video side has no curated list at all: it accepts whatever ffmpeg's demuxer opens, and
`VideoMetadata.codec` is a plain `str` recording what that turned out to be.

The asymmetry is the argument. **An image is an asset; a video is a source.** Curating
`ImageFormat` buys something real, because those exact bytes enter the dataset and the promise
above is made about them. A video's bytes never do — they leave the decoder as PNG frames — so a
closed list of codecs would gate nothing while going stale every time a camera vendor ships a new
profile. `codec` therefore *records* what was read instead of *deciding* what may be read, which
is the same split as `DatasetChange.operation` being a `str` while `DatasetOperation` is the enum
a writer picks from.

## Orientation is applied, not reported

`ImageMetadata.width` and `.height` are **as displayed**. A 32×24 JPEG carrying EXIF orientation
6 probes as 24×32, and its thumbnail comes out 24×32 to match.

The alternative — report the stored dimensions and pass the tag along — pushes the rotation onto
every consumer, and the consumers are an annotation canvas, an exporter and a bounding box in
pixel coordinates. One of them forgetting is a dataset whose labels are ninety degrees off,
discovered by a model that will not converge. There is deliberately **no `orientation_applied`
flag**: a caller that could branch on it would be a caller who was handed the un-normalized case
after all, and nothing persists it.

Orientations 5 through 8 involve a quarter turn and swap the edges; 1 through 4 are identity,
mirror and 180° and do not. An image with no EXIF at all — which is most images — reports its
stored dimensions, and that is the ordinary path rather than a fallback.

The policy is **format-independent**. PNG carries EXIF in an `eXIf` chunk and is oriented on
exactly the same terms as JPEG, which is the case a hand-rolled tag-274 reader gets wrong.

It is **modality-independent** too. A clip carries its turn in a display matrix rather than in an
EXIF tag — a phone held upright writes a landscape stream plus a quarter turn — and ffmpeg
applies that matrix when it decodes. So `VideoMetadata` reports the swapped edges, and the frames
`frames()` yields come out at exactly those dimensions. Reporting the stored numbers would
describe a picture nobody will ever see, and would put every extracted frame at odds with the
metadata stamped beside it. ffprobe spells the same quarter turn as `90`, as `-90` and as `270`
depending on the file and the build, so the rule is arithmetic on the angle (`rotation % 180`)
and never a membership test against three literals.

## Frames: the extraction is pinned, and it does not seek

`frames()` streams one frame at a time off a running ffmpeg — nothing buffers a clip — and every
argument that decides what comes out is fixed in one tuple in the adapter. Four of them are worth
knowing about:

- **`fps=N:round=up`** is the extraction grid, and it is what makes `frame.timestamp` honest. The
  filter maps each input frame onto an output slot and the last one to land there wins; under the
  default `near` rounding the winner is the frame nearest the slot's *midpoint*, so at 1 fps a
  clip shot at 10 yields the pictures from 0.4 s and 1.4 s while labelling them 0.0 s and 1.0 s.
  `up` makes the frame at the grid point itself the winner, which puts the reported timestamp
  within one *source* frame of the pixels — the best any resampler can do. Frame counts are
  identical either way.
- **There is no seek.** Input seeking lands on a keyframe and is approximate; output seeking
  interacts with the filter. Extraction reads the clip from the start every time, which is
  exactly what makes it reproducible.
- **`-xerror`** is the least obvious and the most load-bearing. Without it ffmpeg reports a
  truncated clip on stderr, exits **zero**, and hands back the frames it managed to decode — so a
  damaged file would ingest as a merely short one and nothing would ever say so. Its opposite
  number, `-err_detect explode`, is deliberately not used: it rejects perfectly good files.
- **`-pred none -compression_level 6` and `+bitexact`** pin the PNG encoder, whose bytes become
  the content hash of the asset each frame turns into.

Two consequences worth stating outright:

- **A frame's `index` counts the extracted sequence, not the source.** A source frame number
  means nothing for a variable-rate stream and cannot be reproduced without knowing the rate the
  file was shot at. `timestamp` is the locator that survives — it says where in the clip to look,
  whatever rate the next decomposition runs at.
- **Asking for a higher rate than the clip has duplicates frames.** This is documented rather
  than clamped: clamping would mean probing inside `frames()`, and an ingest content-addresses
  what it stores, so the duplicates collapse into one asset anyway. The honest fix is not to ask.

### The iterator owns a running program

`frames()` is not itself a generator — it validates its arguments, checks for ffmpeg and returns
an inner one — so a missing binary or a negative `fps` is reported at the call rather than at the
first iteration inside whatever loop happened to consume it.

What comes back holds a live decoder until it is exhausted or closed. A `for` loop that runs to
the end is fine, and so is one that `break`s (closing the generator terminates ffmpeg); a caller
that stashes the iterator somewhere should close it, `contextlib.closing`-style.

### What video determinism costs, and who pays

The same caveat as thumbnails, with a bigger consequence. Identical clip, identical `fps`,
identical frames — across runs and across processes, **on one machine with one installed
ffmpeg**. It does *not* hold across ffmpeg builds.

Frames are content-addressed, so this propagates: **video-derived asset identity is reproducible
within an ffmpeg build, not across one.** Re-ingesting the same clip after an ffmpeg upgrade
yields different hashes and therefore new assets beside the old ones. Images do not have this
property — a JPEG's bytes are its bytes — and video does, because the asset is something we
computed rather than something we were given. The practical rule is the familiar one: assert
repeatability, never a hardcoded hash, and do not build a cross-machine identity claim on a
frame.

## Thumbnails: one encoding, pinned

Every `thumbnail()` returns a **JPEG**, at most 256 pixels on its longest edge unless the caller
says otherwise, opaque, with the aspect ratio preserved and no metadata from the source. The
encoder arguments are fixed in one dict — quality 85, 4:4:4 chroma, no Huffman optimization, no
progressive scan — and each of those is a knob whose default has moved between library builds.

The format is fixed by the *port*, not chosen per call, because a thumbnail is meant to be
content-addressed: the bytes are the cache key, so a per-call format would give one image
several equally correct hashes. Changing any of these values invalidates every thumbnail ever
stored — which is safe, they are a cache — but it is a decision, not an edit, and a test will
make you make it on purpose.

Three behaviours worth stating outright:

- **It never enlarges.** An image already inside the box comes back at its own size. Inventing
  pixels to fill a preview is a lie the gallery would then have to display.
- **Transparency is composited onto white**, not flattened. JPEG has no alpha channel, and
  `convert("RGB")` keeps whatever colour happened to sit *under* a fully transparent pixel — so
  a transparent red pixel comes out red, which is arbitrary and usually wrong.
- **The output is built on a fresh canvas.** An ICC profile or a JFIF density riding along in
  the source would be a second input to bytes that are supposed to depend on nothing but the
  pixels.

### What determinism actually promises

Identical source bytes give identical thumbnail bytes, across runs, across processes and across
two processor instances, **on one machine with one installed Pillow**. Nothing in the path reads
a clock, a PID or a random source.

It does *not* hold across Pillow versions, libjpeg builds or platforms — resampling
coefficients and SIMD kernels differ, and the same picture can legitimately encode to different
bytes on a colleague's laptop. This is the same caveat `tests/fixtures/media.py` records for
ffmpeg, and it has the same consequence: **assert repeatability, never a hardcoded hash.**

What follows for anything built on top: a thumbnail hash is a **cache key, not an identity**.
Two machines ingesting one image may store two thumbnail blobs, which costs a few kilobytes and
nothing else. What must not be built on it is a release manifest recording a thumbnail hash, or
a verification pass recomputing one — source-content hashes are reproducible, derived-artifact
hashes are not, and conflating the two is how a "verified" release starts failing on a different
machine.

## Refusals

Two errors under one `MediaError` base, so an ingest can catch the family once, record the
failure against the item it was reading, and carry on with the next file.

| Error | Means | Remedy |
| --- | --- | --- |
| `UnsupportedMedia` | not an image at all, an image in a format outside `ImageFormat`, one declaring more pixels than the decoder will take, or a file ffmpeg never opened | filter the input, convert the file, or ask for the format to be accepted |
| `CorruptMedia` | an accepted format whose bytes will not decode, or a clip that decoded for a while and then ran out | re-fetch or re-export the file |

The split is by **remedy**, which is the only thing an error hierarchy should branch on. "Your
input folder contains a README" and "one of your JPEGs is truncated" have opposite answers, and
collapsing them into one error gives an ingest summary where ordinary operator noise buries real
data loss.

It is deliberately not three. A `ThumbnailFailed` would have no independent cause — a thumbnail
fails exactly when the decode fails. And splitting `UnsupportedMedia` into "not an image" versus
"unaccepted format" asks the decoder a question it cannot answer: an unidentifiable container
and an exotic one both come back as *I do not know what this is*.

The family is named for **media**, not images, because the video processor raises the same two
for the same reasons — the split is by remedy, and remedies have no modality. For video the two
are separated by *when* the decoder gave up, and the order of the calls is what keeps that
honest. A container ffmpeg cannot open at all is `UnsupportedMedia`, and that includes a clip
whose index went missing with its tail; a clip that opens, yields frames and then runs out is
`CorruptMedia`, and it hands back the frames that did decode before it raises.

### `MediaToolUnavailable` is not in the family

The default video adapter needs ffmpeg on the machine, and its absence is a `MediaToolUnavailable`
— deliberately **not** a `MediaError`, so `except MediaError` will not catch it.

Every error in that family answers *what is wrong with this file?*; this one answers *what is
wrong with this machine?*. An ingest catches the media family per item and carries on, so if this
were in it a missing decoder would be recorded five thousand times against five thousand innocent
files, and the run would report a data problem it does not have. It is the single fatal cause an
ingest job records beside its per-file report, and its message carries an install hint, because
the remedy is a package manager.

It is also why nothing checks for ffmpeg at import or when a workspace opens: a machine with no
ffmpeg still opens workspaces and still ingests images perfectly well, so the check belongs to
the call that actually needs to decode a video.

Two more refusals sit outside the family on purpose, for the same reason `max_edge < 1` does: a
missing file is a `FileNotFoundError` and a non-positive `fps` is a `ValueError`. Neither is a
property of any media.

### `name` and `reason`

`MediaError` is the only error in the kernel with a constructor, and it carries two attributes
so that a per-file report is a table rather than a list of sentences:

```python
try:
    metadata = workspace.image_processor.probe(handle, name=str(path))
except MediaError as exc:
    report.append({"item": exc.name, "kind": type(exc).__name__, "reason": exc.reason})
```

- **`reason` never repeats the name.** The name is a column.
- **`name` is reporting, never identity.** Nothing looks a file up by it. A caller that already
  knows which item it was iterating should key its report on that.
- An explicit `name=` wins; otherwise the stream's own filename is used when it has one. `None`
  stays an honest answer rather than a fabricated one — an in-memory frame genuinely has no
  filename, and a handle from the blob store has one that is true and useless.

## Validation is the decode

Nothing here trusts a header. A file is accepted only once its pixels have actually come out,
because a dataset that admits an asset on a convincing header is a dataset that discovers the
truth during a training run. That is why probing pays for a full decode per file instead of
sniffing, and why `Image.verify()` is never called — it walks checksums without producing
pixels, and it leaves the image in a state where a later `load()` raises `AssertionError`, which
is neither a media error nor catchable as one.

The adapter also leaves Pillow's process-wide globals alone. `MAX_IMAGE_PIXELS` stays at its
default, so a header claiming forty thousand pixels a side is refused for free before a decoder
runs; raising that limit is the embedding program's call, not a library's. And
`LOAD_TRUNCATED_IMAGES` stays `False` — setting it turns *this file is corrupt* into *here is
half an image and no error*, which is the silent failure these ports exist to prevent.

## Streams

Both methods **read from the beginning** and **do not close what they were given**. That first
rule is what lets an ingest hash, probe and thumbnail one open handle in any order with no
position bookkeeping; without it, hashing a file and then probing the same handle reports a
perfectly good JPEG as corrupt — a bug that looks exactly like the feature working.

A non-seekable stream (a pipe) works, and serves exactly one call: it cannot be rewound, so the
second call sees nothing. A test says so, rather than leaving it to be discovered.

## Composition

The two media processors are the fourth and fifth ports on `WorkspaceService`, reached as
`workspace.image_processor` and `workspace.video_processor` and built by zero-argument
`image_processor_factory` / `video_processor_factory` on both `init` and `open` — the shape the
[event bus](events.md) uses, because none of them is derived from the workspace path. One of each
per open workspace, never a module-level singleton, and nothing to close: the decoders hold no
state at all. A live frame iterator *does* own a running program, but that belongs to whoever
asked for it, not to the workspace.

A new port is appended **last** to `WorkspaceService.__init__`, never inserted: both classmethods
bind those arguments positionally, so a parameter added in the middle silently re-binds every one
after it.

No service below the composition point ever names `PillowImageProcessor` or
`FfmpegVideoProcessor`. That is the rule [workspaces.md](workspaces.md) describes, and it is what
makes swapping a decoder a change to two functions and to nowhere else.

## ffmpeg is a binary; Pillow is a dependency

Pillow is in `[project].dependencies` and arrives with the wheel. ffmpeg cannot: it is a program,
not a package, so `pip install visionset` does not put one on the machine and a user may
legitimately never need it. Hence the lazy check, the install hint, and the fact that video tests
**skip** locally when it is missing — with one guard, because a silently skipped video test looks
exactly like a passing one. CI installs ffmpeg and sets `VISIONSET_REQUIRE_FFMPEG=1`, which turns
that skip into a hard error, so a broken install step goes red rather than quietly shrinking the
suite.

Neither library needs an import-linter change. The contracts forbid *frameworks* inside the
kernel — FastAPI, Typer, MCP, uvicorn — not third-party libraries, and ffmpeg is reached through
`subprocess` and is not an import at all.

## What is deliberately not here yet

- **No thumbnail write.** `thumbnail()` hands back bytes. Storing them content-addressed and
  recording an `asset.thumbnail_hash` is the thumbnail-cache task, for the M5 gallery.

Two things used to be on that list and no longer are. `Source` came off it with registration,
which records a clip's original rate and the decomposition parameters chosen for it, built on
`VideoMetadata` exactly as anticipated — see [sources.md](sources.md). The `Asset` fields came off
it with [ingest](ingest.md): what a probe reported is now stored as `asset.format`, and a frame's
`index`/`timestamp` land on the asset as `frame_index`/`frame_timestamp` beside the source it was
cut from. Both ports are called from exactly one place, and that is where.
