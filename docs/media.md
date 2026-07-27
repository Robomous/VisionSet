# Media

Before anything can be annotated it has to be decoded, and the kernel has to know what it just
decoded. That is what the media ports are for: hand them bytes, and they either tell you what
the picture is or refuse it with a sentence naming the file.

```python
from visionset.kernel.services import WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    with open("photos/IMG_0043.jpg", "rb") as handle:
        metadata = workspace.image_processor.probe(handle)  # ImageMetadata(width=..., ...)
        preview = workspace.image_processor.thumbnail(handle)  # opaque JPEG bytes
```

## Two protocols, not one

`ImageProcessor` and `VideoProcessor` are separate ports rather than one `MediaProcessor` with
both jobs, because the two have almost nothing in common at the type level: an ffmpeg adapter
has no thumbnail to serve and a Pillow adapter has no frames to iterate. A shared protocol would
force each implementation to declare the other's methods and raise from them — a runtime failure
where a compile-time absence was available.

Each is declared by the task that implements it. `ImageProcessor` and the Pillow adapter behind
it exist today; `VideoProcessor` arrives with the ffmpeg one.

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
| `UnsupportedMedia` | not an image at all, an image in a format outside `ImageFormat`, or one declaring more pixels than the decoder will take | filter the input, convert the file, or ask for the format to be accepted |
| `CorruptMedia` | an accepted format whose bytes will not decode | re-fetch or re-export the file |

The split is by **remedy**, which is the only thing an error hierarchy should branch on. "Your
input folder contains a README" and "one of your JPEGs is truncated" have opposite answers, and
collapsing them into one error gives an ingest summary where ordinary operator noise buries real
data loss.

It is deliberately not three. A `ThumbnailFailed` would have no independent cause — a thumbnail
fails exactly when the decode fails. And splitting `UnsupportedMedia` into "not an image" versus
"unaccepted format" asks the decoder a question it cannot answer: an unidentifiable container
and an exotic one both come back as *I do not know what this is*.

The family is named for **media**, not images, because the video processor raises the same two
for the same reasons.

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

The image processor is the fourth port on `WorkspaceService`, reached as
`workspace.image_processor` and built by a zero-argument `image_processor_factory` on both
`init` and `open` — the shape the [event bus](events.md) uses, because neither is derived from
the workspace path. One per open workspace, never a module-level singleton, and nothing to
close: the decoder holds no state at all.

No service below the composition point ever names `PillowImageProcessor`. That is the rule
[workspaces.md](workspaces.md) describes, and it is what makes swapping a decoder a change to
two functions and to nowhere else.

## What is deliberately not here yet

- **No `Asset` field.** `ImageMetadata` is returned, not stored; putting `format` and origin on
  the asset row belongs with the ingest pipeline.
- **No blob write.** `thumbnail()` hands back bytes. Storing them content-addressed and
  recording a `thumbnail_hash` is the thumbnail-cache task.
- **No video.** `VideoProcessor`, fps probing and frame extraction arrive with the ffmpeg
  adapter.
