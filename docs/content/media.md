# Media

Media must be decoded before it can be annotated, and the kernel must know what was decoded.
`ImageProcessor` accepts bytes and either returns information about the image or rejects it with
a message that names the stream.

```python
from visionset.kernel.services import WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    with open("photos/IMG_0043.jpg", "rb") as handle:
        metadata = workspace.image_processor.probe(handle)  # ImageMetadata(width=..., ...)
        preview = workspace.image_processor.thumbnail(handle)  # opaque JPEG bytes
```

## The kernel has one decoder, and it is for stills

`ImageProcessor` is the only media port `WorkspaceService` composes, and it is named for stills
rather than for media because that is all it ever reads. This process never decodes video: a
client materializes a clip into PNG frames on its own machine and posts them here, and from that
point on each one is an ordinary image - decoded, hashed and thumbnailed by exactly the same
`ImageProcessor` a directory of photos goes through. See [ingest.md](ingest.md) for the session
that stages those frames, and [sources.md](sources.md) for what a video source records once they
land. There used to be a second, parallel port here for a server-side video decoder; it is gone,
and nothing replaced it in this process - see "Video moved to the browser" below.

`ImageProcessor` takes an open binary **stream**, never a path: every caller already has one, a
source is read through a file handle and a blob in the blob store is opened the same way, so
nothing is lost by not accepting a bare path.

## The dataset holds two formats; ingest reads far more

`ImageFormat` names everything a dataset may contain: **JPEG and PNG**, frozen. Acceptance is
deliberately wider. `ImageProcessor.stills` reads anything Pillow decodes - WebP, HEIC and HEIF
(what an iPhone writes), BMP, TIFF, GIF and the rest - and normalizes everything outside the two
into them at ingest, so a dataset consumer never needs a third decoder.

| You give VisionSet | The dataset holds |
| --- | --- |
| JPG / JPEG, PNG | your exact bytes, untouched |
| WebP, HEIC / HEIF, BMP, TIFF, anything else Pillow decodes | a JPEG, re-encoded at ingest |
| animated GIF, animated WebP | one PNG per frame, `anim.gif#frame=3` |
| MP4, MOV, AVI, WebM, MKV, or anything a browser can demux | one PNG per extracted frame, materialized client-side |

A converted or decomposed still keeps the original path in its `uri`, so provenance stays
legible: an asset at `photo.heic` whose `format` reads `jpeg` was transcoded on the way in, and
the original file on disk is untouched. Transcoding is repeatable within one Pillow build, not
across builds - the same caveat a browser's video materializer carries across its own versions.

Out of scope for this distribution: RAW camera formats (CR2, NEF, DNG), AVIF, and JPEG XL. A
Live Photo is two files; the photo ingests as a still, and its clip may be registered as an
ordinary video source.

The frozen enum is the promise that matters: VisionSet will decode, hash, thumbnail and export
JPEG and PNG for as long as the workspaces written today are readable. What can be *read* may
drift with the installed Pillow; what a dataset *holds* may not.

`MPO` is a special case worth knowing about and is **not** a third format. It is a
multi-picture JPEG container - what phones write in portrait and burst modes - so it is an
alias in the decoder's table, and its primary frame is what every viewer shows and what
VisionSet reads. Leaving it out would have rejected a large share of real camera output as
unsupported.

**The bytes decide the format, not the filename.** A `.png` holding JPEG bytes reports `jpeg`.
A suffix is a hint for choosing which files to look at; what a file *is* comes from decoding it.

### There is no `VideoFormat`, on purpose

The video side has no curated list at all: `VideoMetadata.codec` is a plain `str` recording
whatever a client's decoder read off the container, not a member of an enum this distribution
maintains.

The asymmetry is the argument. **An image is an asset; a video is a source.** Curating
`ImageFormat` buys something real, because those exact bytes enter the dataset and the promise
above is made about them. A video's bytes never do - they leave the decoder as PNG frames - so a
closed list of codecs would gate nothing while going stale every time a camera vendor ships a new
profile. `codec` therefore *records* what was read instead of *deciding* what may be read, which
is the same split as `DatasetChange.operation` being a `str` while `DatasetOperation` is the enum
a writer picks from.

## Orientation is applied, not reported

`ImageMetadata.width` and `.height` are **as displayed**. A 32×24 JPEG carrying EXIF orientation
6 probes as 24×32, and its thumbnail comes out 24×32 to match.

The alternative - report the stored dimensions and pass the tag along - pushes the rotation onto
every consumer, and the consumers are an annotation canvas, an exporter and a bounding box in
pixel coordinates. One of them forgetting is a dataset whose labels are ninety degrees off,
discovered by a model that will not converge. There is deliberately **no `orientation_applied`
flag**: a caller that could branch on it would be a caller who was handed the un-normalized case
after all, and nothing persists it.

Orientations 5 through 8 involve a quarter turn and swap the edges; 1 through 4 are identity,
mirror and 180° and do not. An image with no EXIF at all - which is most images - reports its
stored dimensions, and that is the ordinary path rather than a fallback.

The policy is **format-independent**. PNG carries EXIF in an `eXIf` chunk and is oriented on
exactly the same terms as JPEG, which is the case a hand-rolled tag-274 reader gets wrong.

It is **modality-independent** too, in the sense that a video frame arriving here has already had
the same problem solved before it ever reached `ImageProcessor`: a clip carries its turn in a
display matrix rather than in an EXIF tag, a phone held upright writes a landscape stream plus a
quarter turn, and the client materializing the clip applies that matrix before it ever encodes a
frame to PNG. What lands on the asset is the swapped edges, on the same terms as `VideoMetadata`
reports them - see [sources.md](sources.md).

## Thumbnails: one encoding, pinned

Every `thumbnail()` returns a **JPEG**, at most 256 pixels on its longest edge unless the caller
says otherwise, opaque, with the aspect ratio preserved and no metadata from the source. The
encoder arguments are fixed in one dict - quality 85, 4:4:4 chroma, no Huffman optimization, no
progressive scan - and each of those is a knob whose default has moved between library builds.

The format is fixed by the *port*, not chosen per call, because a thumbnail is meant to be
content-addressed: the bytes are the cache key, so a per-call format would give one image
several equally correct hashes. Changing any of these values invalidates every thumbnail ever
stored - which is safe, they are a cache - but it is a decision, not an edit, and a test will
make you make it on purpose.

Three behaviours worth stating outright:

- **It never enlarges.** An image already inside the box comes back at its own size. Inventing
  pixels to fill a preview is a lie the gallery would then have to display.
- **Transparency is composited onto white**, not flattened. JPEG has no alpha channel, and
  `convert("RGB")` keeps whatever colour happened to sit *under* a fully transparent pixel - so
  a transparent red pixel comes out red, which is arbitrary and usually wrong.
- **The output is built on a fresh canvas.** An ICC profile or a JFIF density riding along in
  the source would be a second input to bytes that are supposed to depend on nothing but the
  pixels.

### What determinism actually promises

Identical source bytes give identical thumbnail bytes, across runs, across processes and across
two processor instances, **on one machine with one installed Pillow**. Nothing in the path reads
a clock, a PID or a random source.

It does *not* hold across Pillow versions, libjpeg builds or platforms - resampling
coefficients and SIMD kernels differ, and the same picture can legitimately encode to different
bytes on a colleague's laptop. The consequence is the practical rule: **assert repeatability,
never a hardcoded hash.**

What follows for anything built on top: a thumbnail hash is a **cache key, not an identity**.
Two machines ingesting one image may store two thumbnail blobs, which costs a few kilobytes and
nothing else. What must not be built on it is a release manifest recording a thumbnail hash, or
a verification pass recomputing one - source-content hashes are reproducible, derived-artifact
hashes are not, and conflating the two is how a "verified" release starts failing on a different
machine.

`asset.thumbnail_hash` is where that cache key is recorded, and it holds itself to every word of
this paragraph: it is absent from `Manifest`, `ReleaseService.verify` does not touch it, and a
NULL there is an ordinary state rather than a fault. See [ingest.md](ingest.md).

## Refusals

Two errors under one `MediaError` base, so an ingest can catch the family once, record the
failure against the item it was reading, and carry on with the next file.

| Error | Means | Remedy |
| --- | --- | --- |
| `UnsupportedMedia` | not an image at all, an image in a format outside `ImageFormat`, one declaring more pixels than the decoder will take, or - for a staged video frame - a declared width/height that disagrees with what the bytes decode to | filter the input, convert the file, or ask for the format to be accepted |
| `CorruptMedia` | an accepted format whose bytes will not decode | re-fetch, re-export, or re-materialize the frame |

The split is by **remedy**, which is the only thing an error hierarchy should branch on. "Your
input folder contains a README" and "one of your JPEGs is truncated" have opposite answers, and
collapsing them into one error gives an ingest summary where ordinary operator noise buries real
data loss.

It is deliberately not three. A `ThumbnailFailed` would have no independent cause - a thumbnail
fails exactly when the decode fails. And splitting `UnsupportedMedia` into "not an image" versus
"unaccepted format" asks the decoder a question it cannot answer: an unidentifiable container
and an exotic one both come back as *I do not know what this is*.

The family is named for **media**, not images, for a reason that outlived the server-side video
decoder that first justified it: `VideoImportService` runs every posted video frame through this
same `ImageProcessor` before it is staged, so a malformed frame from a browser's materializer
raises exactly one of these two, on the same terms a bad file on disk would. See
[ingest.md](ingest.md).

A missing file is a `FileNotFoundError`, and a `max_edge < 1` passed to `thumbnail()` is a
`ValueError` - both sit outside the family on purpose, because neither is a property of any
media.

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
  stays an honest answer rather than a fabricated one - an in-memory frame genuinely has no
  filename, and a handle from the blob store has one that is true and useless.

## Validation is the decode

Nothing here trusts a header. A file is accepted only once its pixels have actually come out,
because a dataset that admits an asset on a convincing header is a dataset that discovers the
truth during a training run. That is why probing pays for a full decode per file instead of
sniffing, and why `Image.verify()` is never called - it walks checksums without producing
pixels, and it leaves the image in a state where a later `load()` raises `AssertionError`, which
is neither a media error nor catchable as one.

The adapter also leaves Pillow's process-wide globals alone. `MAX_IMAGE_PIXELS` stays at its
default, so a header claiming forty thousand pixels a side is refused for free before a decoder
runs; raising that limit is the embedding program's call, not a library's. And
`LOAD_TRUNCATED_IMAGES` stays `False` - setting it turns *this file is corrupt* into *here is
half an image and no error*, which is the silent failure these ports exist to prevent.

## Streams

Both methods **read from the beginning** and **do not close what they were given**. That first
rule is what lets an ingest hash, probe and thumbnail one open handle in any order with no
position bookkeeping; without it, hashing a file and then probing the same handle reports a
perfectly good JPEG as corrupt - a bug that looks exactly like the feature working.

A non-seekable stream (a pipe) works, and serves exactly one call: it cannot be rewound, so the
second call sees nothing. A test says so, rather than leaving it to be discovered.

## Composition

`ImageProcessor` is the fourth port on `WorkspaceService`, reached as `workspace.image_processor`
and built by a zero-argument `image_processor_factory` on both `init` and `open` - the shape the
[event bus](events.md) uses, because it is not derived from the workspace path. One per open
workspace, never a module-level singleton, and nothing to close: the decoder holds no state at
all.

A new port is appended **last** to `WorkspaceService.__init__`, never inserted: both classmethods
bind those arguments positionally, so a parameter added in the middle silently re-binds every one
after it.

No service below the composition point ever names `PillowImageProcessor`. That is the rule
[workspaces.md](workspaces.md) describes, and it is what makes swapping the decoder a change to
two functions and to nowhere else.

## Video moved to the browser

This page used to describe a second port here, `VideoProcessor`, backed by an adapter that shelled
out to ffmpeg: given a path, it probed a clip's metadata and streamed extracted PNG frames back,
pinned encoder arguments and all, so that identical input produced identical output on one
installed ffmpeg build. None of that runs in this process any more. The kernel declares no
video-decoding port at all, ffmpeg is not a dependency of anything this distribution ships, and a
video's bytes never reach this server - a client demuxes and decodes the clip on the machine it
already sits on, and posts the PNG frames it produced through the session `VideoImportService`
manages. See [ingest.md](ingest.md) for that session and [sources.md](sources.md) for what a video
source records about the client that produced its frames.

The reasons a dedicated video port existed are still true of the code that replaced it - a
decoder that seeks needs an addressable clip rather than a stream, and the sampling grid, the
rotation handling and the scale rounding all had to be pinned somewhere for two independent
readings of one clip to agree on a frame count. They are just true of a browser package now
instead of a server-side adapter, one that ports this kernel's own grid arithmetic across the
language boundary rather than re-deriving it.

## Everything on this page now has a caller

Two things used to be listed here as not built yet, and neither is. `Source` came off the list
with registration, which records what a client's decoder read off a clip and the extraction
policy chosen for it, built on `VideoMetadata` exactly as anticipated - see
[sources.md](sources.md). The `Asset` fields came off it with [ingest](ingest.md): what a probe
reports is stored as `asset.format`, and a video frame's ordinal and timestamp land on the asset
as `frame_index`/`frame_timestamp` beside the source it was cut from - now set at
`VideoImportService.commit`, once every frame a session expects has arrived, rather than at
extraction time.

The thumbnail write came off it too. `thumbnail()` still only hands back bytes - storing them is
not the port's job - but those bytes go into the blob store as each frame is staged, and the hash
lands on `asset.thumbnail_hash`. The cache-key-not-identity rule above is what that column is
built on, and `IngestService.backfill_thumbnails` is how an asset that predates it, or one whose
preview would not render, gets caught up. See [ingest.md](ingest.md).

`ImageProcessor` is called from two places in this process now, `IngestService` and
`VideoImportService`, and both are named above - never from a route, a CLI command or an MCP
tool directly, so decoding one more kind of bytes has stayed a change to a service, not to the
port or to what calls it.
