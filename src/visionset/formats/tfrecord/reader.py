# usage: from visionset.formats.tfrecord import TfrecordImporter
"""TensorFlow Object Detection TFRecords in: ``tf.train.Example`` boxes beside a label map.

This reads the TensorFlow Object Detection API's dataset schema, not any
TFRecord: a TFRecord is a container, and only its ``Example`` features say what
it holds. The source holds, at its top, one :data:`LABEL_MAP_FILENAME` (or one
other ``*.pbtxt``) of ``item { id: N name: "x" }`` blocks, and one record file
per split: ``<split>.tfrecord`` (or ``.record``), or a complete shard set
``<split>.tfrecord-00000-of-0000N``. A file starting with the gzip magic, and not
with a valid record header, is read as GZIP-compressed whatever its name, so
``<split>.tfrecord.gz`` is read too; it is decompressed once per importer, into
a temporary file outside the source, and the pictures are served from that.
Only :meth:`TfrecordImporter.read` checks each record's data checksum; serving a
picture checks the length's, and the import compares the bytes' hash anyway.

Each record is one picture. ``image/encoded`` holds its bytes, which the import
reads out of the record through :meth:`TfrecordImporter.open`: an image's path
is ``<record file>/<index>-<image/filename>``, a name no file can have, and
nothing is written into the source. ``image/height`` and ``image/width``, when
present, must equal the decoded picture's. ``image/object/bbox/xmin``,
``xmax``, ``ymin`` and ``ymax`` are float32 fractions of the picture, all four
the same length, within ``[0, 1]`` with each minimum below its maximum. A
corner is the fraction times the size rounded to :data:`PRECISION` decimals of a
pixel, so a box whose corners carry at most that many decimals, on a picture of
up to 16,384 pixels a side, reads back exactly; any other is within half a
thousandth of a pixel plus the size over 2**25.

A box's class is its ``image/object/class/text``, which must be a label-map
name; ``image/object/class/label``, when present beside it, must be that name's
id, and alone names the class by id. ``image/object/difficult``,
``truncated`` and ``is_crowd`` of ``0`` or ``1`` become boolean attributes of
those names. A label-map class with a ``display_name`` other than its ``name``
is named by its ``name``; one with only a ``display_name`` by that.

Lost, and reported: an example with no ``image/encoded`` (an ``image`` loss,
its boxes ``label`` losses), instance masks and keypoints (``geometry``; the
box is kept), ``image/object/area`` and any other feature (``attribute``), an
``image/source_id`` other than the filename's stem, and a ``display_name`` not
kept. ``image/key/sha256`` and ``image/format`` are derived from the bytes and
not reported. A feature of the wrong type, a malformed label map, an unknown
class or id, a text and id that disagree, an invalid coordinate, a declared size
the picture does not have, an unreadable picture, an incomplete shard set, and a
record that fails its checksum, is truncated or is followed by garbage refuse
the source.
"""

from __future__ import annotations

import gzip
import io
import math
import re
import shutil
import tempfile
import threading
import weakref
import zlib
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Final, cast

from visionset.formats._reading import Losses, contained, measure, read_text, to_dataset
from visionset.formats.tfrecord._wire import (
    HEADER,
    Feature,
    Kind,
    decode_example,
    is_header,
    read_record,
    skip_record,
)
from visionset.kernel.domain import (
    BboxGeometry,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLossKind,
)
from visionset.kernel.domain.schema import Attribute, AttributeValue
from visionset.kernel.errors import ImportSourceUnreadable

FORMAT_NAME: Final = "tfrecord"
LABEL_MAP_FILENAME: Final = "label_map.pbtxt"
SUFFIX: Final = ".tfrecord"

#: Decimal places of a pixel a corner keeps.
PRECISION: Final = 3

FLAGS: Final = ("difficult", "truncated", "is_crowd")

XMIN: Final = "image/object/bbox/xmin"
XMAX: Final = "image/object/bbox/xmax"
YMIN: Final = "image/object/bbox/ymin"
YMAX: Final = "image/object/bbox/ymax"
CLASS_TEXT: Final = "image/object/class/text"
CLASS_LABEL: Final = "image/object/class/label"

_LABEL: Final = "TFRecord"
_GZIP: Final = b"\x1f\x8b"
_RECORD_FILE: Final = re.compile(
    r"(?P<split>[A-Za-z0-9_]+)\.(?:tfrecord|record)"
    r"(?:-(?P<shard>\d{5})-of-(?P<count>\d{5}))?(?:\.gz)?",
    re.ASCII,
)
_PICTURE: Final = re.compile(r"(?P<index>\d{1,9})-[A-Za-z0-9._-]{1,120}", re.ASCII)
_UNSAFE: Final = re.compile(r"[^A-Za-z0-9._-]", re.ASCII)
_IMAGE_FEATURES: Final[dict[str, Kind]] = {
    "image/height": "int64",
    "image/width": "int64",
    "image/filename": "bytes",
    "image/source_id": "bytes",
    "image/encoded": "bytes",
    "image/format": "bytes",
    "image/key/sha256": "bytes",
}
_OBJECT_FEATURES: Final[dict[str, Kind]] = {
    XMIN: "float",
    XMAX: "float",
    YMIN: "float",
    YMAX: "float",
    CLASS_TEXT: "bytes",
    CLASS_LABEL: "int64",
    **{f"image/object/{flag}": "int64" for flag in FLAGS},
}
_MASK: Final = "image/object/mask"
_KEYPOINT: Final = "image/object/keypoint/"
_OBJECT: Final = "image/object/"
_MASK_LOST: Final = "instance masks are not imported; the box is kept"
_KEYPOINTS_LOST: Final = "keypoints are not imported; the box is kept"
_NO_PICTURE: Final = "an example with no image/encoded picture; its boxes are not imported"


class TfrecordImporter:
    """Reads TensorFlow Object Detection TFRecords into an ``ImportedDataset``."""

    format_name = FORMAT_NAME

    def __init__(self) -> None:
        self._held: dict[Path, _Held] = {}
        self._spools: list[BinaryIO] = []
        self._lock = threading.Lock()
        weakref.finalize(self, _close_all, self._spools)

    def close(self) -> None:
        """Drop every decompressed copy this importer holds."""
        with self._lock:
            _close_all(self._spools)
            self._held.clear()

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(f"the TFRecord source {src.name!r} is not a directory")
        root = src.resolve()
        label_map, losses = _label_map(src, root)
        ids = {name: number for number, name in label_map.items()}
        flagged: dict[str, set[str]] = {name: set() for name in ids}
        images: list[ImportedImage] = []
        self.close()
        for path in _record_files(src, root):
            where = path.name
            held = self._hold(path, where)
            starts: list[int] = []
            with self._lock, _records(path, held, where) as stream:
                for index, data in _indexed(stream, where, starts):
                    at = f"{where} record {index}"
                    found, picture_losses = _image(data, at, where, index, label_map, ids)
                    losses.update(picture_losses)
                    if found is None:
                        losses[(ImportLossKind.IMAGE, where, _NO_PICTURE)] += 1
                        continue
                    for label in found.labels:
                        flagged[label.class_name].update(label.attributes)
                    images.append(found)
            held.starts = starts

        return to_dataset(
            (
                ImportedClass(
                    name=name,
                    geometries=(GeometryType.BBOX,),
                    attributes=tuple(
                        Attribute(name=flag, kind="boolean")
                        for flag in FLAGS
                        if flag in flagged[name]
                    ),
                )
                for name in sorted(ids)
            ),
            images,
            losses,
            _LABEL,
        )

    def open(self, src: Path, path: PurePosixPath) -> BinaryIO:
        """The picture a record holds at ``path``, as :meth:`read` named it."""
        parts = path.parts
        if len(parts) != 2 or not _RECORD_FILE.fullmatch(parts[0]):
            raise FileNotFoundError(str(path))
        picture = _PICTURE.fullmatch(parts[1])
        if picture is None:
            raise FileNotFoundError(str(path))
        index = int(picture["index"])
        file = contained(src, src.resolve(), src / parts[0])
        if not file.is_file():
            raise FileNotFoundError(str(path))
        where = file.name
        held = self._hold(file, where)
        with self._lock, _records(file, held, where) as stream:
            if held.starts is None:
                held.starts = _starts(stream, where)
            data = None
            if index < len(held.starts):
                stream.seek(held.starts[index])
                data = read_record(stream, where, verify=False)
        if data is None:
            raise FileNotFoundError(str(path))
        at = f"{where} record {index}"
        features = decode_example(data, at)
        encoded = _single(_values(features, "image/encoded", "bytes", at), "image/encoded", at)
        if not isinstance(encoded, bytes) or not encoded:
            raise FileNotFoundError(str(path))
        if _picture_name(index, features, at) != parts[1]:
            raise FileNotFoundError(str(path))
        return io.BytesIO(encoded)

    def _hold(self, path: Path, where: str) -> _Held:
        """What this importer keeps of ``path``: a GZIP file decompressed once, to a temp file."""
        key = _key(path)
        with self._lock:
            held = self._held.get(key[0])
            if held is not None and held.key == key:
                return held
            spool = _decompressed(path, where) if _compressed(path, where) else None
            if spool is not None:
                self._spools.append(spool)
            held = _Held(key=key, spool=spool)
            self._held[key[0]] = held
            return held


# --- the files ----------------------------------------------------------------


def _key(path: Path) -> tuple[Path, int, int]:
    stat = path.stat()
    return path.resolve(), stat.st_size, stat.st_mtime_ns


@dataclass
class _Held:
    key: tuple[Path, int, int]
    spool: BinaryIO | None
    starts: list[int] | None = None


def _close_all(spools: list[BinaryIO]) -> None:
    for spool in spools:
        spool.close()
    spools.clear()


def _compressed(path: Path, where: str) -> bool:
    """Whether ``path`` is GZIP: it starts with the magic and not with a valid record header.

    A record whose length happens to start ``1f 8b`` is still a record.
    """
    try:
        with path.open("rb") as raw:
            head = raw.read(HEADER)
    except OSError as exc:
        raise ImportSourceUnreadable(f"{where} is not readable: {exc}") from None
    if not head.startswith(_GZIP):
        return False
    try:
        is_header(head, where)
    except ImportSourceUnreadable:
        return True
    return False


def _decompressed(path: Path, where: str) -> BinaryIO:
    # Kept open past this call; TfrecordImporter.close, or its finalizer, closes it.
    spool = cast(BinaryIO, tempfile.TemporaryFile())  # noqa: SIM115
    try:
        with path.open("rb") as raw, gzip.GzipFile(fileobj=raw, mode="rb") as unzipped:
            shutil.copyfileobj(unzipped, spool)
    except (OSError, EOFError, zlib.error) as exc:
        spool.close()
        raise ImportSourceUnreadable(f"{where} is not a readable TFRecord file: {exc}") from None
    return spool


@contextmanager
def _records(path: Path, held: _Held, where: str) -> Iterator[BinaryIO]:
    """The file's records, from its decompressed copy when it is GZIP, from its start."""
    if held.spool is not None:
        held.spool.seek(0)
        yield held.spool
        return
    try:
        with path.open("rb") as raw:
            yield raw
    except OSError as exc:
        raise ImportSourceUnreadable(f"{where} is not readable: {exc}") from None


def _indexed(stream: BinaryIO, where: str, starts: list[int]) -> Iterator[tuple[int, bytes]]:
    index = 0
    while True:
        start = stream.tell()
        data = read_record(stream, where)
        if data is None:
            return
        starts.append(start)
        yield index, data
        index += 1


def _starts(stream: BinaryIO, where: str) -> list[int]:
    starts: list[int] = []
    while True:
        start = stream.tell()
        if not skip_record(stream, where):
            return starts
        starts.append(start)


def _record_files(src: Path, root: Path) -> list[Path]:
    """Each split's record files in shard order, splits in name order."""
    whole: dict[str, Path] = {}
    shards: dict[str, dict[int, Path]] = {}
    counts: dict[str, int] = {}
    for entry in sorted(src.iterdir()):
        matched = _RECORD_FILE.fullmatch(entry.name)
        if matched is None or not entry.is_file():
            continue
        path = contained(src, root, entry)
        split = matched["split"]
        if matched["shard"] is None:
            if split in whole:
                raise ImportSourceUnreadable(
                    f"{whole[split].name} and {path.name} both hold the {split!r} split"
                )
            whole[split] = path
            continue
        shard, count = int(matched["shard"]), int(matched["count"])
        if counts.setdefault(split, count) != count or shard >= count:
            raise ImportSourceUnreadable(f"{path.name} does not belong to the {split!r} shard set")
        if shard in shards.setdefault(split, {}):
            raise ImportSourceUnreadable(
                f"{shards[split][shard].name} and {path.name} are the same shard of {split!r}"
            )
        shards[split][shard] = path
    for split, held in shards.items():
        if split in whole:
            raise ImportSourceUnreadable(
                f"the {split!r} split is held both whole and in shards; keep one"
            )
        if len(held) != counts[split]:
            missing = sorted(set(range(counts[split])) - set(held))
            raise ImportSourceUnreadable(
                f"the {split!r} shard set lacks shard(s) {', '.join(map(str, missing[:10]))}"
            )
    if not whole and not shards:
        raise ImportSourceUnreadable(
            f"the TFRecord source {src.name!r} holds no <split>{SUFFIX} record file"
        )
    ordered: list[Path] = []
    for split in sorted({*whole, *shards}):
        if split in whole:
            ordered.append(whole[split])
        else:
            ordered.extend(shards[split][shard] for shard in range(counts[split]))
    return ordered


# --- the label map --------------------------------------------------------------

_TOKEN: Final = re.compile(
    r"""(?P<skip>[\s,;]+|\#[^\n]*)
    |(?P<punct>[{}:])
    |(?P<string>"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')
    |(?P<word>[A-Za-z_][A-Za-z0-9_]*|[+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)""",
    re.VERBOSE,
)
_OCTAL: Final = re.compile(r"[0-7]{1,3}")
_HEX: Final = re.compile(r"[0-9A-Fa-f]{1,2}")
_ESCAPES: Final = {"n": b"\n", "t": b"\t", "r": b"\r", "\\": b"\\", "'": b"'", '"': b'"'}


def _tokens(text: str, where: str) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    at = 0
    while at < len(text):
        matched = _TOKEN.match(text, at)
        if matched is None:
            line = text.count("\n", 0, at) + 1
            found_text = text[at : at + 20]
            raise ImportSourceUnreadable(f"{where} line {line}: {found_text!r} is not pbtxt")
        at = matched.end()
        kind = matched.lastgroup
        if kind is not None and kind != "skip":
            found.append((kind, matched.group()))
    return found


def _unquoted(token: str, where: str) -> str:
    body = token[1:-1]
    out = bytearray()
    at = 0
    while at < len(body):
        char = body[at]
        if char != "\\":
            out.extend(char.encode("utf-8"))
            at += 1
            continue
        escape = body[at + 1]
        if escape in _ESCAPES:
            out.extend(_ESCAPES[escape])
            at += 2
        elif octal := _OCTAL.match(body, at + 1):
            out.append(int(octal.group(), 8) & 0xFF)
            at = octal.end()
        elif escape == "x" and (hexadecimal := _HEX.match(body, at + 2)):
            out.append(int(hexadecimal.group(), 16))
            at = hexadecimal.end()
        else:
            raise ImportSourceUnreadable(f"{where}: {token[:40]} holds an unknown escape")
    try:
        return out.decode("utf-8")
    except UnicodeDecodeError:
        raise ImportSourceUnreadable(f"{where}: {token[:40]} is not UTF-8") from None


def parse_label_map(text: str, where: str) -> list[dict[str, str | int]]:
    """Each ``item`` block's ``id``, ``name`` and ``display_name``; other fields are skipped."""
    tokens = _tokens(text, where)
    items: list[dict[str, str | int]] = []
    at = 0

    def expect(kind: str, value: str | None = None) -> str:
        nonlocal at
        if at >= len(tokens) or tokens[at][0] != kind or (value and tokens[at][1] != value):
            seen = tokens[at][1] if at < len(tokens) else "the end of the file"
            raise ImportSourceUnreadable(f"{where}: expected {value or kind}, found {seen[:40]!r}")
        at += 1
        return tokens[at - 1][1]

    def skip_block() -> None:
        nonlocal at
        depth = 1
        while depth:
            if at >= len(tokens):
                raise ImportSourceUnreadable(f"{where}: a block is never closed")
            depth += {"{": 1, "}": -1}.get(tokens[at][1], 0) if tokens[at][0] == "punct" else 0
            at += 1

    while at < len(tokens):
        if expect("word") != "item":
            raise ImportSourceUnreadable(f"{where}: a label map holds only item blocks")
        if tokens[at] == ("punct", ":"):
            at += 1
        expect("punct", "{")
        item: dict[str, str | int] = {}
        while at < len(tokens) and tokens[at] != ("punct", "}"):
            name = expect("word")
            if tokens[at : at + 1] == [("punct", ":")]:
                at += 1
            if tokens[at : at + 1] == [("punct", "{")]:
                at += 1
                skip_block()
                continue
            if at >= len(tokens) or tokens[at][0] == "punct":
                raise ImportSourceUnreadable(f"{where}: field {name!r} has no value")
            kind, value = tokens[at]
            at += 1
            if name not in ("id", "name", "display_name"):
                continue
            if name in item:
                raise ImportSourceUnreadable(f"{where}: an item names {name} twice")
            if name == "id":
                if kind != "word" or not re.fullmatch(r"[+-]?\d+", value):
                    raise ImportSourceUnreadable(f"{where}: id {value[:40]!r} is not an integer")
                item[name] = int(value)
            else:
                if kind != "string":
                    raise ImportSourceUnreadable(f"{where}: {name} {value[:40]!r} is not a string")
                item[name] = _unquoted(value, where)
        expect("punct", "}")
        items.append(item)
    return items


def _label_map(src: Path, root: Path) -> tuple[dict[int, str], Losses]:
    found = sorted(
        contained(src, root, entry)
        for entry in src.iterdir()
        if entry.suffix == ".pbtxt" and entry.is_file()
    )
    if not found:
        raise ImportSourceUnreadable(
            f"the TFRecord source {src.name!r} holds no {LABEL_MAP_FILENAME} to name its classes"
        )
    if len(found) > 1:
        listed = ", ".join(path.name for path in found)
        raise ImportSourceUnreadable(f"the TFRecord source holds {listed}; keep one label map")
    path = found[0]
    where = path.name
    names: dict[int, str] = {}
    losses: Losses = Counter()
    for item in parse_label_map(read_text(path, where), where):
        number = item.get("id")
        if not isinstance(number, int):
            raise ImportSourceUnreadable(f"{where}: an item has no id")
        if number < 1:
            raise ImportSourceUnreadable(
                f"{where}: id {number} is reserved; a class id starts at 1"
            )
        name, display = item.get("name"), item.get("display_name")
        chosen = str(name if name is not None else display or "").strip()
        if not chosen:
            raise ImportSourceUnreadable(f"{where}: item {number} has no name")
        if number in names:
            raise ImportSourceUnreadable(f"{where}: id {number} is given twice")
        if chosen in names.values():
            raise ImportSourceUnreadable(f"{where}: name {chosen!r} is given twice")
        names[number] = chosen
        if name is not None and display is not None and str(display).strip() != chosen:
            reason = f"display_name {str(display)[:80]} is not kept; the class is its name"
            losses[(ImportLossKind.ATTRIBUTE, chosen, reason)] += 1
    return names, losses


# --- one example ----------------------------------------------------------------


def _values(
    features: dict[str, Feature], key: str, kind: Kind, at: str
) -> tuple[bytes, ...] | tuple[float, ...] | tuple[int, ...]:
    feature = features.get(key)
    if feature is None or feature.kind is None:
        return ()
    if feature.kind != kind:
        raise ImportSourceUnreadable(
            f"{at}: {key} holds {feature.kind} values where {kind} values are expected"
        )
    if kind == "bytes":
        return feature.bytes_list
    if kind == "float":
        return feature.float_list
    return feature.int64_list


def _single(values: tuple[object, ...], key: str, at: str) -> object:
    if len(values) > 1:
        raise ImportSourceUnreadable(f"{at}: {key} holds {len(values)} values where one belongs")
    return values[0] if values else None


def _text(features: dict[str, Feature], key: str, at: str) -> str:
    value = _single(_values(features, key, "bytes", at), key, at)
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else ""


def _picture_name(index: int, features: dict[str, Feature], at: str) -> str:
    named = PurePosixPath(_text(features, "image/filename", at)).name
    named = named or _text(features, "image/source_id", at) or "image"
    return f"{index}-{_UNSAFE.sub('_', named)[:120]}"


def _image(
    data: bytes,
    at: str,
    where: str,
    index: int,
    label_map: dict[int, str],
    ids: dict[str, int],
) -> tuple[ImportedImage | None, Losses]:
    """The example's picture and boxes, ``None`` when it holds no picture, and its losses."""
    features = decode_example(data, at)
    for key, kind in {**_IMAGE_FEATURES, **_OBJECT_FEATURES}.items():
        _values(features, key, kind, at)
    corners = [_floats(features, key, at) for key in (XMIN, XMAX, YMIN, YMAX)]
    count = len(corners[0])
    if any(len(one) != count for one in corners):
        raise ImportSourceUnreadable(f"{at}: the four bbox coordinate lists differ in length")
    classes = _classes(features, count, label_map, ids, at)
    flags = {flag: _flag(features, flag, count, at) for flag in FLAGS}
    boxes = [_checked(box, at) for box in zip(*corners, strict=True)]

    losses: Losses = Counter()
    encoded = _single(_values(features, "image/encoded", "bytes", at), "image/encoded", at)
    if not isinstance(encoded, bytes) or not encoded:
        if count:
            losses[(ImportLossKind.LABEL, where, "a box on an example with no picture")] += count
        return None, losses
    size = measure(io.BytesIO(encoded))
    if size is None:
        raise ImportSourceUnreadable(f"{at}: image/encoded is not a readable picture")
    for key, measured in (("image/width", size[0]), ("image/height", size[1])):
        declared = _single(_values(features, key, "int64", at), key, at)
        if declared is not None and declared != measured:
            raise ImportSourceUnreadable(
                f"{at}: {key} is {declared} but the picture is {size[0]}x{size[1]}"
            )

    _example_losses(features, classes, where, at, losses)
    labels = tuple(
        ImportedLabel(
            class_name=class_name,
            geometry=_scaled(box, size, at),
            attributes={
                flag: values[position] for flag, values in flags.items() if values is not None
            },
        )
        for position, (class_name, box) in enumerate(zip(classes, boxes, strict=True))
    )
    path = PurePosixPath(where, _picture_name(index, features, at))
    return ImportedImage(path=path, width=size[0], height=size[1], labels=labels), losses


def _floats(features: dict[str, Feature], key: str, at: str) -> tuple[float, ...]:
    return tuple(float(value) for value in _values(features, key, "float", at))


def _classes(
    features: dict[str, Feature],
    count: int,
    label_map: dict[int, str],
    ids: dict[str, int],
    at: str,
) -> list[str]:
    texts = [
        value.decode("utf-8", errors="replace").strip()
        for value in _values(features, CLASS_TEXT, "bytes", at)
        if isinstance(value, bytes)
    ]
    numbers = [int(value) for value in _values(features, CLASS_LABEL, "int64", at)]
    for key, values in ((CLASS_TEXT, texts), (CLASS_LABEL, numbers)):
        if values and len(values) != count:
            raise ImportSourceUnreadable(
                f"{at}: {key} holds {len(values)} values for {count} boxes"
            )
    if count and not texts and not numbers:
        raise ImportSourceUnreadable(f"{at}: the boxes have neither {CLASS_TEXT} nor {CLASS_LABEL}")
    names: list[str] = []
    for position in range(count):
        number = numbers[position] if numbers else None
        if number is not None and number not in label_map:
            raise ImportSourceUnreadable(f"{at}: class id {number} is not in the label map")
        if not texts and number is not None:
            names.append(label_map[number])
            continue
        text = texts[position]
        if text not in ids:
            raise ImportSourceUnreadable(f"{at}: class {text[:80]!r} is not in the label map")
        if number is not None and ids[text] != number:
            raise ImportSourceUnreadable(
                f"{at}: class {text!r} is id {ids[text]} in the label map, "
                f"but the box says {number}"
            )
        names.append(text)
    return names


def _flag(
    features: dict[str, Feature], flag: str, count: int, at: str
) -> list[AttributeValue] | None:
    key = f"image/object/{flag}"
    values = _values(features, key, "int64", at)
    if not values:
        return None
    if len(values) != count:
        raise ImportSourceUnreadable(f"{at}: {key} holds {len(values)} values for {count} boxes")
    if any(value not in (0, 1) for value in values):
        raise ImportSourceUnreadable(f"{at}: {key} holds a value other than 0 or 1")
    return [value == 1 for value in values]


def _checked(box: tuple[float, ...], at: str) -> tuple[float, float, float, float]:
    x_min, x_max, y_min, y_max = box
    if not all(math.isfinite(value) and 0.0 <= value <= 1.0 for value in box):
        raise ImportSourceUnreadable(f"{at}: a box coordinate is not a fraction in [0, 1]")
    if x_max <= x_min or y_max <= y_min:
        raise ImportSourceUnreadable(f"{at}: a box's maximum must exceed its minimum")
    return x_min, x_max, y_min, y_max


def _scaled(
    corners: tuple[float, float, float, float], size: tuple[int, int], at: str
) -> BboxGeometry:
    x_min, x_max, y_min, y_max = corners
    left, right = _pixel(x_min, size[0]), _pixel(x_max, size[0])
    top, bottom = _pixel(y_min, size[1]), _pixel(y_max, size[1])
    width, height = round(right - left, PRECISION) + 0.0, round(bottom - top, PRECISION) + 0.0
    if width <= 0 or height <= 0:
        raise ImportSourceUnreadable(f"{at}: a box is narrower than its picture can measure")
    return BboxGeometry(x=left, y=top, width=width, height=height)


def _pixel(fraction: float, extent: int) -> float:
    return round(fraction * extent, PRECISION) + 0.0


def _example_losses(
    features: dict[str, Feature], classes: list[str], where: str, at: str, losses: Losses
) -> None:
    source_id = _text(features, "image/source_id", at)
    stem = PurePosixPath(_text(features, "image/filename", at)).stem
    if source_id and source_id != stem:
        losses[(ImportLossKind.ATTRIBUTE, where, "image/source_id is not kept")] += 1
    reasons: list[tuple[ImportLossKind, str]] = []
    for key in sorted(features):
        feature = features[key]
        held = feature.bytes_list or feature.float_list or feature.int64_list
        if key in _IMAGE_FEATURES or key in _OBJECT_FEATURES or not held:
            continue
        if not key.startswith(_OBJECT):
            losses[(ImportLossKind.ATTRIBUTE, where, f"{key[:80]} is not imported")] += 1
        elif key == _MASK:
            reasons.append((ImportLossKind.GEOMETRY, _MASK_LOST))
        elif key.startswith(_KEYPOINT):
            reasons.append((ImportLossKind.GEOMETRY, _KEYPOINTS_LOST))
        else:
            reasons.append((ImportLossKind.ATTRIBUTE, f"{key[:80]} is not imported"))
    for kind, reason in dict.fromkeys(reasons):
        for class_name in classes:
            losses[(kind, class_name, reason)] += 1


__all__ = [
    "FLAGS",
    "LABEL_MAP_FILENAME",
    "PRECISION",
    "SUFFIX",
    "TfrecordImporter",
    "parse_label_map",
]
