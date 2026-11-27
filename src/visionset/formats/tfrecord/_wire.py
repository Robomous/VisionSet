# usage: from visionset.formats.tfrecord._wire import decode_example, encode_example, frame
"""TFRecord framing and the ``tf.train.Example`` protobuf wire format, by hand.

A record is ``uint64 length``, the masked CRC32C of those eight bytes, ``length``
bytes of data and the masked CRC32C of the data, all little-endian. The data is
one serialized ``tf.train.Example``:

- ``Example``: ``Features features = 1``;
- ``Features``: ``map<string, Feature> feature = 1``, each entry ``key = 1``,
  ``value = 2``;
- ``Feature``: one of ``BytesList bytes_list = 1``, ``FloatList float_list = 2``
  or ``Int64List int64_list = 3``, each a ``repeated value = 1``; floats and
  int64s are read packed or unpacked and written packed.

Written here because the format needs nothing else from TensorFlow or protobuf.
Every malformation refuses with :class:`ImportSourceUnreadable`.
"""

from __future__ import annotations

import struct
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import BinaryIO, Final, Literal

from visionset.kernel.errors import ImportSourceUnreadable

Kind = Literal["bytes", "float", "int64"]

#: The largest record read: a corrupt length must not allocate gigabytes.
MAX_RECORD: Final = 512 * 1024 * 1024

HEADER: Final = 12

_MASK_DELTA: Final = 0xA282EAD8
_U32: Final = 0xFFFFFFFF
_U64: Final = 0xFFFFFFFFFFFFFFFF


def _tables() -> tuple[tuple[int, ...], ...]:
    first: list[int] = []
    for byte in range(256):
        crc = byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0x82F63B78 if crc & 1 else crc >> 1
        first.append(crc)
    tables = [first]
    for _ in range(7):
        previous = tables[-1]
        tables.append([(previous[i] >> 8) ^ first[previous[i] & 0xFF] for i in range(256)])
    return tuple(tuple(table) for table in tables)


#: Slicing-by-8: eight bytes per step, a few times faster than one in pure Python.
_TABLES: Final = _tables()


def crc32c(data: bytes | memoryview) -> int:
    """CRC-32C (Castagnoli), as TFRecord checksums its length and data."""
    t0, t1, t2, t3, t4, t5, t6, t7 = _TABLES
    view = memoryview(data).cast("B")
    whole = len(view) - len(view) % 8
    crc = _U32
    for (word,) in struct.iter_unpack("<Q", view[:whole]):
        word ^= crc
        crc = (
            t7[word & 0xFF]
            ^ t6[(word >> 8) & 0xFF]
            ^ t5[(word >> 16) & 0xFF]
            ^ t4[(word >> 24) & 0xFF]
            ^ t3[(word >> 32) & 0xFF]
            ^ t2[(word >> 40) & 0xFF]
            ^ t1[(word >> 48) & 0xFF]
            ^ t0[word >> 56]
        )
    for byte in view[whole:]:
        crc = t0[(crc ^ byte) & 0xFF] ^ (crc >> 8)
    return crc ^ _U32


def masked_crc(data: bytes | memoryview) -> int:
    crc = crc32c(data)
    return ((((crc >> 15) | (crc << 17)) & _U32) + _MASK_DELTA) & _U32


def frame(data: bytes) -> bytes:
    """One TFRecord record holding ``data``."""
    length = struct.pack("<Q", len(data))
    return (
        length + struct.pack("<I", masked_crc(length)) + data + struct.pack("<I", masked_crc(data))
    )


def read_record(stream: BinaryIO, where: str, *, verify: bool = True) -> bytes | None:
    """The next record's data, ``None`` at a clean end of the stream.

    ``verify=False`` skips only the data checksum, the slow part; the length's
    is always checked, so a record boundary is never trusted unchecked.
    """
    length = is_header(stream.read(HEADER), where)
    if length is None:
        return None
    payload = _exactly(stream, length, where)
    checksum = _exactly(stream, 4, where)
    if verify and struct.unpack("<I", checksum)[0] != masked_crc(payload):
        raise ImportSourceUnreadable(f"{where}: a record's data fails its checksum")
    return payload


def skip_record(stream: BinaryIO, where: str) -> bool:
    """Step over the next record without reading its data; ``False`` at the end."""
    length = is_header(stream.read(HEADER), where)
    if length is None:
        return False
    stream.seek(length + 4, 1)
    return True


def is_header(header: bytes, where: str) -> int | None:
    """The record length ``header`` states, ``None`` for an empty one; anything else refuses."""
    if not header:
        return None
    if len(header) != HEADER:
        raise ImportSourceUnreadable(f"{where}: the last record is truncated")
    if struct.unpack("<I", header[8:])[0] != masked_crc(header[:8]):
        raise ImportSourceUnreadable(f"{where}: a record's length fails its checksum")
    length: int = struct.unpack("<Q", header[:8])[0]
    if length > MAX_RECORD:
        raise ImportSourceUnreadable(
            f"{where}: a record of {length} bytes is over the {MAX_RECORD}-byte limit"
        )
    return length


def _exactly(stream: BinaryIO, size: int, where: str) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise ImportSourceUnreadable(f"{where}: the last record is truncated")
    return data


@dataclass(frozen=True)
class Feature:
    """One ``tf.train.Feature``; ``kind`` is ``None`` for one holding no list."""

    kind: Kind | None = None
    bytes_list: tuple[bytes, ...] = field(default=())
    float_list: tuple[float, ...] = field(default=())
    int64_list: tuple[int, ...] = field(default=())


def bytes_feature(*values: bytes) -> Feature:
    return Feature(kind="bytes", bytes_list=values)


def float_feature(*values: float) -> Feature:
    return Feature(kind="float", float_list=values)


def int64_feature(*values: int) -> Feature:
    return Feature(kind="int64", int64_list=values)


# --- encoding ---------------------------------------------------------------


def _varint(value: int) -> bytes:
    value &= _U64
    out = bytearray()
    while True:
        bits = value & 0x7F
        value >>= 7
        if value:
            out.append(bits | 0x80)
        else:
            out.append(bits)
            return bytes(out)


def _delimited(number: int, payload: bytes) -> bytes:
    return _varint(number << 3 | 2) + _varint(len(payload)) + payload


def _encode_feature(feature: Feature) -> bytes:
    if feature.kind == "bytes":
        inner = b"".join(_delimited(1, value) for value in feature.bytes_list)
        return _delimited(1, inner)
    if feature.kind == "float":
        packed = struct.pack(f"<{len(feature.float_list)}f", *feature.float_list)
        return _delimited(2, _delimited(1, packed) if packed else b"")
    if feature.kind == "int64":
        packed = b"".join(_varint(value) for value in feature.int64_list)
        return _delimited(3, _delimited(1, packed) if packed else b"")
    return b""


def encode_example(features: dict[str, Feature]) -> bytes:
    """A serialized ``tf.train.Example``, its map entries in key order."""
    entries = b"".join(
        _delimited(1, _delimited(1, key.encode("utf-8")) + _delimited(2, _encode_feature(value)))
        for key, value in sorted(features.items())
    )
    return _delimited(1, entries)


# --- decoding ---------------------------------------------------------------


class _Cursor:
    def __init__(self, data: bytes, where: str) -> None:
        self.data = data
        self.at = 0
        self.where = where

    def done(self) -> bool:
        return self.at >= len(self.data)

    def varint(self) -> int:
        value = 0
        for shift in range(0, 70, 7):
            if self.at >= len(self.data):
                raise self.refuse("a varint runs past its message")
            byte = self.data[self.at]
            self.at += 1
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                if value > _U64:
                    raise self.refuse("a varint is wider than 64 bits")
                return value
        raise self.refuse("a varint is longer than ten bytes")

    def take(self, size: int) -> bytes:
        if size > len(self.data) - self.at:
            raise self.refuse("a field runs past its message")
        chunk = self.data[self.at : self.at + size]
        self.at += size
        return chunk

    def field(self) -> tuple[int, int]:
        key = self.varint()
        number, wire = key >> 3, key & 7
        if number == 0:
            raise self.refuse("a field is numbered 0")
        return number, wire

    def skip(self, wire: int) -> None:
        if wire == 0:
            self.varint()
        elif wire == 1:
            self.take(8)
        elif wire == 2:
            self.take(self.varint())
        elif wire == 5:
            self.take(4)
        else:
            raise self.refuse(f"wire type {wire} is not one an Example uses")

    def refuse(self, what: str) -> ImportSourceUnreadable:
        return ImportSourceUnreadable(f"{self.where}: not a tf.train.Example: {what}")


def _signed(value: int) -> int:
    return value - (1 << 64) if value >= 1 << 63 else value


def _bytes_list(data: bytes, where: str) -> tuple[bytes, ...]:
    cursor = _Cursor(data, where)
    values: list[bytes] = []
    while not cursor.done():
        number, wire = cursor.field()
        if number == 1 and wire == 2:
            values.append(cursor.take(cursor.varint()))
        elif number == 1:
            raise cursor.refuse("a BytesList value is not length-delimited")
        else:
            cursor.skip(wire)
    return tuple(values)


def _float_list(data: bytes, where: str) -> tuple[float, ...]:
    cursor = _Cursor(data, where)
    values: list[float] = []
    while not cursor.done():
        number, wire = cursor.field()
        if number == 1 and wire == 2:
            packed = cursor.take(cursor.varint())
            if len(packed) % 4:
                raise cursor.refuse("a packed FloatList is not whole float32 values")
            values.extend(struct.unpack(f"<{len(packed) // 4}f", packed))
        elif number == 1 and wire == 5:
            values.append(struct.unpack("<f", cursor.take(4))[0])
        elif number == 1:
            raise cursor.refuse("a FloatList value is not a float32")
        else:
            cursor.skip(wire)
    return tuple(values)


def _int64_list(data: bytes, where: str) -> tuple[int, ...]:
    cursor = _Cursor(data, where)
    values: list[int] = []
    while not cursor.done():
        number, wire = cursor.field()
        if number == 1 and wire == 2:
            packed = _Cursor(cursor.take(cursor.varint()), where)
            while not packed.done():
                values.append(_signed(packed.varint()))
        elif number == 1 and wire == 0:
            values.append(_signed(cursor.varint()))
        elif number == 1:
            raise cursor.refuse("an Int64List value is not a varint")
        else:
            cursor.skip(wire)
    return tuple(values)


def _decode_feature(data: bytes, where: str) -> Feature:
    cursor = _Cursor(data, where)
    feature = Feature()
    while not cursor.done():
        number, wire = cursor.field()
        if number not in (1, 2, 3):
            cursor.skip(wire)
            continue
        if wire != 2:
            raise cursor.refuse("a Feature's list is not length-delimited")
        body = cursor.take(cursor.varint())
        if feature.kind is not None:
            raise cursor.refuse("a Feature holds two lists")
        if number == 1:
            feature = bytes_feature(*_bytes_list(body, where))
        elif number == 2:
            feature = float_feature(*_float_list(body, where))
        else:
            feature = int64_feature(*_int64_list(body, where))
    return feature


def _entry(data: bytes, where: str) -> tuple[str, Feature]:
    cursor = _Cursor(data, where)
    key = b""
    value = Feature()
    while not cursor.done():
        number, wire = cursor.field()
        if number in (1, 2) and wire != 2:
            raise cursor.refuse("a feature map entry is not length-delimited")
        if number == 1:
            key = cursor.take(cursor.varint())
        elif number == 2:
            value = _decode_feature(cursor.take(cursor.varint()), where)
        else:
            cursor.skip(wire)
    try:
        return key.decode("utf-8"), value
    except UnicodeDecodeError:
        raise cursor.refuse("a feature name is not UTF-8") from None


def decode_example(data: bytes, where: str) -> dict[str, Feature]:
    """The features of one serialized ``tf.train.Example``, by name; a name twice refuses."""
    cursor = _Cursor(data, where)
    features: dict[str, Feature] = {}
    while not cursor.done():
        number, wire = cursor.field()
        if number != 1:
            cursor.skip(wire)
            continue
        if wire != 2:
            raise cursor.refuse("its features are not length-delimited")
        inner = _Cursor(cursor.take(cursor.varint()), where)
        while not inner.done():
            entry_number, entry_wire = inner.field()
            if entry_number != 1:
                inner.skip(entry_wire)
                continue
            if entry_wire != 2:
                raise inner.refuse("a feature map entry is not length-delimited")
            key, value = _entry(inner.take(inner.varint()), where)
            if key in features:
                raise inner.refuse(f"feature {key[:80]!r} is named twice")
            features[key] = value
    return features


def records(stream: BinaryIO, where: str) -> Iterator[bytes]:
    while (data := read_record(stream, where)) is not None:
        yield data


__all__ = [
    "HEADER",
    "MAX_RECORD",
    "Feature",
    "Kind",
    "bytes_feature",
    "crc32c",
    "decode_example",
    "encode_example",
    "float_feature",
    "frame",
    "is_header",
    "int64_feature",
    "masked_crc",
    "read_record",
    "records",
    "skip_record",
]
