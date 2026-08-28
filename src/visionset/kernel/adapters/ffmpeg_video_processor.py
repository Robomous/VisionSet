"""Default VideoProcessor adapter: ffprobe for metadata, ffmpeg for frames."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from collections.abc import Iterator, Mapping
from itertools import chain, count
from pathlib import Path
from typing import IO, Final

from visionset.kernel.domain import TimeRange, VideoFrame, VideoMetadata, grid_bounds
from visionset.kernel.errors import CorruptMedia, MediaToolUnavailable, UnsupportedMedia
from visionset.kernel.ports.video_processor import DEFAULT_EXTRACTION_FPS

#: The two programs this adapter shells out to. They ship together in every
#: distribution of ffmpeg, and are still checked separately: a method asks for
#: what it is about to run, so a broken install fails where it is used.
_FFMPEG: Final = "ffmpeg"
_FFPROBE: Final = "ffprobe"

#: Appended to :class:`MediaToolUnavailable`, because "not installed" without a
#: remedy tells an operator nothing they had not already worked out. Worded to
#: match ``tests/fixtures/media.py``, which has to say the same thing to explain
#: a skipped test; the two are duplicated rather than shared because the kernel
#: does not import from ``tests``.
_INSTALL_HINT: Final = (
    "install it with `brew install ffmpeg` (macOS) or `sudo apt-get install ffmpeg` (Debian/Ubuntu)"
)

#: Everything ffprobe is asked for, in one invocation.
#:
#: ``-select_streams v:0`` because a clip's second video stream is a cover image
#: or a thumbnail track, never the picture; ``-show_format`` because a container
#: often knows its duration when the stream does not.
_PROBE_ARGS: Final = (
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    "-select_streams", "v:0",
)  # fmt: skip

#: Every ffmpeg argument that decides what comes out, pinned. Each one earns it:
#:
#: **There is deliberately no ``-xerror``**, and its absence is the least obvious
#: thing here. It looks like the way to make a damaged clip fail loudly, but it
#: aborts *in place* without flushing the frames already queued for the muxer,
#: and that queue's depth is the decoder's thread count — which ffmpeg picks from
#: the host's core count. One truncated clip therefore salvaged 46 frames on four
#: cores, 34 on sixteen and 30 on twenty. Letting the run finish makes the output
#: byte-identical at every thread count and loses nothing: the error still
#: arrives on stderr, where :func:`_extract` reads it. ``-err_detect explode`` is
#: not here either — it rejects perfectly good files.
#:
#: ``fps=...:round=up`` is the extraction grid *and* the reason
#: ``timestamp = index / fps`` is honest. The filter maps each input frame onto an
#: output slot and the last one to land there wins; under the default ``near`` the
#: winner is the frame nearest the slot's midpoint, so at 1 fps a clip shot at 10
#: yields the pictures from 0.4 s and 1.4 s while claiming 0.0 s and 1.0 s.
#: ``up`` makes the frame at the grid point itself the winner, which puts the
#: reported timestamp within one *source* frame of the pixels — the best any
#: resampler can do. Frame counts are identical either way.
#:
#: There is **no seek**. Input seeking lands on a keyframe and is approximate,
#: output seeking interacts with the filter; extraction reads the clip from the
#: start every time, which is what makes it reproducible.
#:
#: ``-pred`` and ``-compression_level`` pin the PNG encoder, whose bytes are the
#: content hash of the asset each frame becomes; ``+bitexact`` strips the encoder
#: version string that would otherwise change with every ffmpeg upgrade. Together
#: they buy determinism *within one installed ffmpeg* — never across builds.
_EXTRACTION_ARGS: Final = (
    "-an",
    "-f", "image2pipe",
    "-c:v", "png",
    "-pred", "none",
    "-compression_level", "6",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
)  # fmt: skip

#: Output pacing under a ``select`` filter, appended only when clip ranges drop
#: frames: without ``vfr`` the muxer would re-duplicate frames to fill the gaps
#: the selection just made. A whole-clip run keeps today's exact command.
_RANGE_ARGS: Final = ("-fps_mode", "vfr")

#: ``\x89PNG\r\n\x1a\n``. Every frame on the pipe starts with it.
_PNG_SIGNATURE: Final = b"\x89PNG\r\n\x1a\n"

#: A PNG chunk header is a four-byte big-endian length plus a four-byte type,
#: and the payload is followed by a four-byte CRC. Walking those is how frames
#: are split apart; searching for the signature would risk matching a byte
#: sequence inside compressed pixel data.
_CHUNK_HEADER: Final = 8
_CHUNK_CRC: Final = 4
_END_CHUNK: Final = b"IEND"

#: How long a decoder gets to exit after it is asked politely, before it is
#: killed. It is being told to stop reading a local file; a second is generous.
_STOP_TIMEOUT: Final = 1.0

#: How much of the decoder's own complaint to quote back. Enough to name the
#: cause, short enough that ``MediaError.reason`` stays a table cell.
_DIAGNOSTIC_LINES: Final = 2

#: What a path becomes when it is taken out of a quoted diagnostic. ffmpeg names
#: the file it was given in most of its errors, and ``MediaError.reason`` is not
#: allowed to: the name is a column of the report, not a prefix on every sentence
#: in it. Redacted rather than dropped, so the sentence still parses and it is
#: obvious something was removed.
_REDACTED: Final = "<file>"


def _require_tool(program: str) -> str:
    """The program's path, or refuse before anything is attempted.

    Looked up per call rather than cached on the instance, which keeps the
    adapter as stateless as its image sibling. The cost is one PATH scan per
    clip — not per frame — against a decode of the whole file.
    """
    found = shutil.which(program)
    if found is None:
        raise MediaToolUnavailable(f"{program} is not installed or not on PATH; {_INSTALL_HINT}")
    return found


def _require_file(source: Path) -> None:
    """A plain ``FileNotFoundError``, deliberately outside the ``MediaError`` family.

    Nothing is wrong with the media: there is no media. Handing this to an ingest
    as a per-file media error would file "the operator deleted it mid-run" under
    the same heading as "this codec is not supported", which are not the same
    conversation.
    """
    if not source.is_file():
        raise FileNotFoundError(f"no video file at {source}")


def _clip_name(source: Path, name: str | None) -> str:
    """What to call this clip in an error: the caller's word, then the path.

    Unlike the image processor's version this never answers ``None``. There is
    always a path — that is what taking a ``Path`` instead of a stream buys — so
    an unnamed clip is not a case that exists.
    """
    return name if name is not None else str(source)


def _rational(value: object) -> float | None:
    """ffprobe's ``"30000/1001"`` as 29.97. Also accepts a plain number.

    ``0/0`` is ffprobe's way of saying it does not know, and comes back as
    ``None`` rather than as a division error.
    """
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if value > 0 else None
    if not isinstance(value, str):
        return None
    numerator, separator, denominator = value.partition("/")
    try:
        result = float(numerator) / float(denominator) if separator else float(numerator)
    except (ValueError, ZeroDivisionError):
        return None
    return result if result > 0 else None


def _positive_number(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if value > 0 else None
    if not isinstance(value, str):
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if parsed > 0 else None


def _integer(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return round(value)
    if isinstance(value, str):
        try:
            return round(float(value))
        except ValueError:
            return None
    return None


def _text(mapping: Mapping[str, object], key: str) -> str | None:
    value = mapping.get(key)
    return value if isinstance(value, str) else None


def _rotation(stream: Mapping[str, object]) -> int:
    """How far the container says to turn this picture before showing it.

    Two places to look, because the vocabulary moved. Modern files carry a
    display matrix in the stream's side data; older ones carry a ``rotate`` tag,
    which recent ffmpeg no longer even writes but still reads. Absent from both
    is the ordinary case and means upright.
    """
    side_data = stream.get("side_data_list")
    if isinstance(side_data, list):
        for entry in side_data:
            if isinstance(entry, dict) and _text(entry, "side_data_type") == "Display Matrix":
                degrees = _integer(entry.get("rotation"))
                if degrees is not None:
                    return degrees % 360
    tags = stream.get("tags")
    if isinstance(tags, dict):
        degrees = _integer(tags.get("rotate"))
        if degrees is not None:
            return degrees % 360
    return 0


def _oriented(width: int, height: int, rotation: int) -> tuple[int, int]:
    """The edges as a viewer sees them: swapped by a quarter turn, not by a half.

    Pure, and separately swept by a test, because it is the one line where a
    dataset silently acquires sideways dimensions. ``% 180`` rather than a
    membership test so that -90, 270 and 630 all mean the same thing, which is
    what ffprobe's mix of conventions requires.
    """
    return (height, width) if rotation % 180 == 90 else (width, height)


def _read_exactly(stream: IO[bytes], count: int) -> bytes:
    """``count`` bytes, or everything left if the stream ends first.

    A pipe hands back what has arrived, not what was asked for, so every read
    here loops. Short output is not an error at this level: it means the decoder
    stopped, and its exit code is what says whether that was the end of the clip
    or the end of the file.
    """
    chunks: list[bytes] = []
    remaining = count
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _png_frames(stream: IO[bytes]) -> Iterator[bytes]:
    """Split a concatenated PNG stream into whole images, by walking its chunks.

    ``image2pipe`` writes one complete PNG after another with nothing between
    them, so the frames have to be found rather than delimited. Chunk lengths are
    declared, which makes this exact; scanning for the signature would be a guess
    that happens to work until a compressed scanline reproduces those eight bytes.

    A truncated frame is dropped rather than yielded — half a picture is not a
    picture — and the caller's exit-code check is what turns that into an error.
    """
    while True:
        signature = _read_exactly(stream, len(_PNG_SIGNATURE))
        if signature != _PNG_SIGNATURE:
            return
        parts = [signature]
        while True:
            header = _read_exactly(stream, _CHUNK_HEADER)
            if len(header) < _CHUNK_HEADER:
                return
            payload = _read_exactly(stream, int.from_bytes(header[:4], "big") + _CHUNK_CRC)
            parts.append(header)
            parts.append(payload)
            if header[4:] == _END_CHUNK:
                break
        yield b"".join(parts)


def _stop(process: subprocess.Popen[bytes]) -> None:
    """Leave no decoder running, however the iteration ended.

    Reached on the ordinary path (where the process has already exited and this
    does nothing) and on the one that matters: a caller that breaks out of the
    loop closes the generator, which raises ``GeneratorExit`` at the ``yield``
    and lands here with ffmpeg still decoding a file nobody is reading.
    """
    if process.poll() is not None:
        return
    if process.stdout is not None:
        process.stdout.close()
    process.terminate()
    try:
        process.wait(timeout=_STOP_TIMEOUT)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def _redacted(detail: str, *names: str) -> str:
    """One line of decoder output with every mention of the file taken out.

    ``MediaError.reason`` never repeats the name — that is what makes an ingest
    report a table instead of five thousand sentences — and ffmpeg quotes the
    path it was handed in nearly everything it complains about. Whitespace is
    squeezed afterwards, because the quoted line may have been wrapped.
    """
    for name in names:
        if name:
            detail = detail.replace(name, _REDACTED)
    return " ".join(detail.split())


def _last_lines(output: str, *names: str) -> str:
    """The last thing the decoder said, as one line fit for an error report."""
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    tail = [_redacted(line, *names) for line in lines[-_DIAGNOSTIC_LINES:]]
    return "; ".join(tail) if tail else "the decoder gave no reason"


def _complaint(diagnostics: IO[bytes]) -> str:
    """Everything the decoder wrote, raw — and for an intact clip that is nothing.

    At ``-loglevel error`` ffmpeg is silent on a file it read to the end, so an
    empty answer here is a positive statement and not merely an absent one. That
    is what lets :func:`_extract` treat *anything at all* as the break, rather
    than parsing which complaint it was.
    """
    diagnostics.seek(0)
    return diagnostics.read().decode("utf-8", "replace").strip()


class FfmpegVideoProcessor:
    """Probes clips with ffprobe and decomposes them into frames with ffmpeg.

    Holds no state at all — no handle, no cache, no configuration — so
    ``WorkspaceService`` builds one per workspace from a zero-argument factory
    and never closes it. What *does* need closing is an iterator: a live
    :meth:`frames` owns a running decoder, and the workspace knows nothing about
    it.

    **ffmpeg is a binary, not a dependency.** It is not installable from
    ``pyproject.toml`` and a machine can perfectly well run VisionSet's image
    half without it, so its absence is discovered here rather than at import and
    reported as ``MediaToolUnavailable`` — which is not a ``MediaError``, because
    no file is at fault.

    **Validation is the decode**, as it is for images: :meth:`probe` reads what
    the container declares, and :meth:`frames` refuses the clip whose pixels
    actually fail. The two refusals divide by remedy rather than by symptom, and
    the division is enforced by the order they run in. A container ffmpeg cannot
    open at all is ``UnsupportedMedia`` — including a clip whose index went
    missing with its tail, which is why probing before extracting matters. A
    clip that opens and then runs out mid-decode is ``CorruptMedia``.

    **The extracted frames are the product, not the video.** Nothing here stores
    or re-encodes the clip; it is a source, and what enters the dataset are PNGs
    in the port's ``FRAME_FORMAT``. That is why there is no accepted-codec list
    to keep up to date — see ``domain/media.py``.
    """

    def probe(self, source: Path, *, name: str | None = None) -> VideoMetadata:
        """What this clip is, at the dimensions a viewer would show.

        Raises:
            MediaToolUnavailable: ffprobe is not installed.
            FileNotFoundError: there is nothing at ``source``.
            UnsupportedMedia: not a video ffprobe can open, or nothing in it is
                an identifiable video stream.
            CorruptMedia: it opened, and what it says about itself is unusable.
        """
        ffprobe = _require_tool(_FFPROBE)
        _require_file(source)
        clip = _clip_name(source, name)

        document = _run_ffprobe(ffprobe, source, clip)
        stream = _video_stream(document, clip)

        width = _integer(stream.get("width"))
        height = _integer(stream.get("height"))
        if width is None or height is None or width < 1 or height < 1:
            raise CorruptMedia("the video stream declares no usable dimensions", name=clip)

        codec = _text(stream, "codec_name")
        if codec is None:
            raise UnsupportedMedia("the video stream carries no identifiable codec", name=clip)

        # avg_frame_rate is frames over duration; r_frame_rate is the base rate
        # ffmpeg guessed, which doubles on interlaced content. Prefer the honest
        # one and fall back only when the container declined to compute it.
        fps = _rational(stream.get("avg_frame_rate")) or _rational(stream.get("r_frame_rate"))
        if fps is None:
            raise CorruptMedia("the video stream declares no frame rate", name=clip)

        duration = _positive_number(stream.get("duration"))
        if duration is None:
            container = document.get("format")
            if isinstance(container, Mapping):
                duration = _positive_number(container.get("duration"))
        if duration is None:
            raise CorruptMedia(
                "neither the stream nor the container declares a duration", name=clip
            )

        oriented_width, oriented_height = _oriented(width, height, _rotation(stream))
        return VideoMetadata(
            width=oriented_width,
            height=oriented_height,
            fps=fps,
            duration_seconds=duration,
            codec=codec,
        )

    def frames(
        self,
        source: Path,
        *,
        fps: float = DEFAULT_EXTRACTION_FPS,
        ranges: tuple[TimeRange, ...] = (),
        name: str | None = None,
        scale: tuple[int, int] | None = None,
    ) -> Iterator[VideoFrame]:
        """Frames taken off ``source`` at ``fps``, one at a time, in grid order.

        ``ranges`` is a canonical selection on the port's terms: the clip is
        still read from the start — selection is a filter, never a seek — and
        each kept frame carries its grid index, byte-identical to the frame a
        whole-clip run yields at that index.

        ``scale`` is the exact ``(width, height)`` every emitted frame is
        resized to, computed by the caller from the probe — never ffmpeg-side
        arithmetic, so the command stays deterministic and the probe's
        display-oriented dimensions stay authoritative. ``None`` emits frames
        at the decoded size.

        Not a generator itself, on purpose. A generator's body does not run until
        something asks it for a value, so writing it that way would report a
        missing ffmpeg — or a negative ``fps`` — at the first iteration, in
        whatever loop happened to consume it, rather than here where the mistake
        was made.

        The iterator owns a running decoder until it is exhausted or closed.

        Raises:
            ValueError: ``fps`` is not positive. A programming error rather than
                a media one, so it is not translated into the ``MediaError``
                family.
            MediaToolUnavailable: ffmpeg is not installed.
            FileNotFoundError: there is nothing at ``source``.
            UnsupportedMedia: ffmpeg never opened the clip. Raised on first
                iteration, because that is when the decoder has said so.
            CorruptMedia: ffmpeg opened the clip and its bytes ran out. Raised
                after the frames that did decode have been yielded.
        """
        if fps <= 0:
            raise ValueError(f"fps must be greater than zero, got {fps}")
        ffmpeg = _require_tool(_FFMPEG)
        _require_file(source)
        bounds = grid_bounds(ranges, fps=fps)
        return _extract(ffmpeg, source, fps, bounds, scale, _clip_name(source, name))


def _run_ffprobe(ffprobe: str, source: Path, clip: str) -> Mapping[str, object]:
    """One ffprobe run, or the refusal that says this is not a video."""
    result = subprocess.run(
        [ffprobe, *_PROBE_ARGS, str(source)],
        capture_output=True,
        stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        detail = _last_lines(result.stderr.decode("utf-8", "replace"), str(source), clip)
        raise UnsupportedMedia(f"not a video ffmpeg can open ({detail})", name=clip)
    try:
        document = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise UnsupportedMedia(f"the probe returned nothing readable ({exc})", name=clip) from exc
    if not isinstance(document, dict):
        raise UnsupportedMedia("the probe returned no description of this file", name=clip)
    return document


def _video_stream(document: Mapping[str, object], clip: str) -> Mapping[str, object]:
    """The first video stream, or the refusal for a file that has none.

    An audio file, or a container holding only subtitles, gets here rather than
    failing the probe: ffprobe reads it happily and reports no picture. The
    remedy is the operator's, so it is ``UnsupportedMedia``.
    """
    streams = document.get("streams")
    if isinstance(streams, list):
        for entry in streams:
            if isinstance(entry, dict) and _text(entry, "codec_type") == "video":
                return entry
    raise UnsupportedMedia("the file holds no video stream", name=clip)


def _filtergraph(
    fps: float, bounds: tuple[tuple[int, int], ...], scale: tuple[int, int] | None
) -> str:
    """The resampling grid, plus — under a selection — the frames kept off it.

    ``select`` runs *after* ``fps`` and compares the integer output frame number
    ``n`` against bounds precomputed in Python, never a float timestamp inside
    ffmpeg: the arithmetic naming the kept frames is the same ``grid_bounds``
    the expected count uses, so the two cannot disagree. The quotes around the
    expression are filtergraph quoting — they keep its commas from splitting
    the graph. ``scale`` runs last, so a selection drops frames before any of
    them are resized.
    """
    grid = f"fps=fps={fps}:round=up"
    if bounds:
        kept = "+".join(f"gte(n,{a})*lt(n,{b})" for a, b in bounds)
        grid = f"{grid},select='{kept}'"
    if scale is not None:
        width, height = scale
        grid = f"{grid},scale={width}:{height}"
    return grid


def _extract(
    ffmpeg: str,
    source: Path,
    fps: float,
    bounds: tuple[tuple[int, int], ...],
    scale: tuple[int, int] | None,
    clip: str,
) -> Iterator[VideoFrame]:
    """Stream frames off one ffmpeg process, and account for how it ended.

    stderr goes to a temporary **file** rather than to a pipe, which is not
    fastidiousness: reading stdout while an unread stderr pipe fills its buffer
    deadlocks, and a damaged clip — the exact input this has to survive — is what
    makes ffmpeg talkative.

    That file is also the signal. Without ``-xerror`` (see ``_EXTRACTION_ARGS``)
    ffmpeg decodes as far as it can, hands back every frame it got, and exits
    **zero** on a clip whose bytes ran out — so what happened is read from what it
    said rather than from how it exited. The two are near enough the same event:
    ``-xerror`` is a check for the error-level log this reads, bolted to an
    immediate exit. Dropping it keeps the report and drops the truncation.

    The exit code is still consulted, and still carries the case stderr cannot: a
    file ffmpeg never opened at all.
    """
    command = [
        ffmpeg,
        "-nostdin",
        "-loglevel", "error",
        "-i", str(source),
        "-vf", _filtergraph(fps, bounds, scale),
        *_EXTRACTION_ARGS,
        *(_RANGE_ARGS if bounds else ()),
        "-",
    ]  # fmt: skip

    with tempfile.TemporaryFile() as diagnostics:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=diagnostics,
        )
        stdout = process.stdout
        if stdout is None:  # unreachable: the call above asked for a pipe
            _stop(process)
            raise RuntimeError("ffmpeg was started without a readable stdout")

        produced = 0
        grid = chain.from_iterable(range(a, b) for a, b in bounds) if bounds else count()
        try:
            for content in _png_frames(stdout):
                produced += 1
                # The grid, not the source's own presentation timestamps: with
                # round=up the filter emits the frame sitting at each grid point,
                # so this is the arithmetic ffmpeg would have produced anyway,
                # without a second stream of text to parse. It counts from the
                # start of the stream, so a clip whose first frame is not at zero
                # is reported relative to its own beginning. Under a selection
                # the kept frames arrive in grid order, so the next index inside
                # the bounds is this frame's name.
                index = next(grid)
                yield VideoFrame(index=index, timestamp=index / fps, content=content)
            returncode = process.wait()
        finally:
            _stop(process)

        complaint = _complaint(diagnostics)
        if returncode != 0 or complaint:
            detail = _last_lines(complaint, str(source), clip)
            if produced == 0:
                # It never got a picture out, so there was nothing here to break:
                # an intact file that is not one we can read.
                raise UnsupportedMedia(f"ffmpeg could not decode this video ({detail})", name=clip)
            raise CorruptMedia(
                f"the video is damaged or truncated after {produced} frames ({detail})", name=clip
            )
