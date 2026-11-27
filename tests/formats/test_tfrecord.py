"""TensorFlow Object Detection TFRecords: the wire codec, what is read, refused and reported.

Every fixture is framed and encoded by this file's own writer, and every export
is decoded by this file's own parser, so neither side checks the codec against
itself.
"""

from __future__ import annotations

import gzip
import math
import os
import random
import struct
from collections import Counter
from collections.abc import Iterator
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO
from uuid import uuid4

import pytest
from PIL import Image
from tests.formats.test_open_images import _stored
from tests.formats.test_ultralytics import Fixture

from visionset.formats.registry import exporters, importers
from visionset.formats.tfrecord import (
    LABEL_MAP_FILENAME,
    TfrecordExporter,
    TfrecordImporter,
    label_map_text,
    reader,
)
from visionset.formats.tfrecord._wire import (
    bytes_feature,
    crc32c,
    decode_example,
    encode_example,
    float_feature,
    frame,
    int64_feature,
    masked_crc,
    records,
)
from visionset.formats.tfrecord.reader import PRECISION, parse_label_map
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    Attribute,
    BboxGeometry,
    GeometryType,
    ImportConsent,
    ImportedDataset,
    ImportLossKind,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PolygonGeometry,
    Release,
    SplitRecipe,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader
from visionset.kernel.services import ImportService, ProjectService, WorkspaceService

SIZE = (32, 24)
LABEL_MAP = 'item {\n  id: 1\n  name: "car"\n}\nitem {\n  id: 2\n  name: "person"\n}\n'

# --- an independent TFRecord and protobuf writer and reader ---------------------------


def _crc32c(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82F63B78 * (crc & 1))
    return crc ^ 0xFFFFFFFF


def _masked(data: bytes) -> int:
    crc = _crc32c(data)
    return (((crc >> 15) | (crc << 17)) + 0xA282EAD8) & 0xFFFFFFFF


def _record(data: bytes) -> bytes:
    length = struct.pack("<Q", len(data))
    return length + struct.pack("<I", _masked(length)) + data + struct.pack("<I", _masked(data))


def _varint(value: int) -> bytes:
    value &= (1 << 64) - 1
    out = bytearray()
    while value > 0x7F:
        out.append(value & 0x7F | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def _delimited(number: int, payload: bytes) -> bytes:
    return _varint(number << 3 | 2) + _varint(len(payload)) + payload


Features = dict[str, tuple[str, list[Any]]]


def _example(features: Features, *, packed: bool = True) -> bytes:
    entries = b""
    for key, (kind, values) in features.items():
        if kind == "bytes":
            feature = _delimited(1, b"".join(_delimited(1, value) for value in values))
        elif kind == "float":
            inner = (
                _delimited(1, struct.pack(f"<{len(values)}f", *values))
                if packed
                else b"".join(_varint(1 << 3 | 5) + struct.pack("<f", v) for v in values)
            )
            feature = _delimited(2, inner)
        else:
            inner = (
                _delimited(1, b"".join(_varint(value) for value in values))
                if packed
                else b"".join(_varint(1 << 3) + _varint(value) for value in values)
            )
            feature = _delimited(3, inner)
        entries += _delimited(1, _delimited(1, key.encode("utf-8")) + _delimited(2, feature))
    return _delimited(1, entries)


def _read_varint(data: bytes, at: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, at


def _fields(data: bytes) -> Iterator[tuple[int, int, Any]]:
    at = 0
    while at < len(data):
        key, at = _read_varint(data, at)
        number, wire = key >> 3, key & 7
        value: Any
        if wire == 0:
            value, at = _read_varint(data, at)
        elif wire == 2:
            size, at = _read_varint(data, at)
            value, at = data[at : at + size], at + size
        elif wire == 5:
            value, at = data[at : at + 4], at + 4
        else:
            raise AssertionError(f"unexpected wire type {wire}")
        yield number, wire, value


def _parse_example(data: bytes) -> Features:
    parsed: Features = {}
    for _, _, features in _fields(data):
        for _, _, entry in _fields(features):
            key, feature = b"", b""
            for number, _, value in _fields(entry):
                if number == 1:
                    key = value
                else:
                    feature = value
            kind, values = "none", []
            for number, _, body in _fields(feature):
                if number == 1:
                    kind, values = "bytes", [value for _, _, value in _fields(body)]
                elif number == 2:
                    kind = "float"
                    for _, inner_wire, value in _fields(body):
                        count = len(value) // 4
                        values.extend(
                            struct.unpack(f"<{count}f", value) if inner_wire == 2 else [value]
                        )
                elif number == 3:
                    kind = "int64"
                    for _, inner_wire, value in _fields(body):
                        if inner_wire == 0:
                            values.append(value)
                            continue
                        at = 0
                        while at < len(value):
                            one, at = _read_varint(value, at)
                            values.append(one - (1 << 64) if one >= 1 << 63 else one)
            parsed[key.decode("utf-8")] = (kind, values)
    return parsed


def _parse_records(blob: bytes) -> list[bytes]:
    found: list[bytes] = []
    at = 0
    while at < len(blob):
        length_bytes = blob[at : at + 8]
        assert struct.unpack("<I", blob[at + 8 : at + 12])[0] == _masked(length_bytes)
        (length,) = struct.unpack("<Q", length_bytes)
        data = blob[at + 12 : at + 12 + length]
        assert struct.unpack("<I", blob[at + 12 + length : at + 16 + length])[0] == _masked(data)
        found.append(data)
        at += 16 + length
    return found


def _f32(value: float) -> float:
    return float(struct.unpack("<f", struct.pack("<f", value))[0])


# --- fixtures ------------------------------------------------------------------------


def _picture(size: tuple[int, int] = SIZE, *, seed: int = 0, kind: str = "PNG") -> bytes:
    buffer = BytesIO()
    image = Image.new("RGB", size, ((seed * 53) % 256, (seed * 97) % 256, 7))
    image.save(buffer, format=kind)
    return buffer.getvalue()


def _features(
    picture: bytes | None = None,
    *,
    size: tuple[int, int] = SIZE,
    boxes: list[tuple[float, float, float, float]] | None = None,
    texts: list[str] | None = None,
    labels: list[int] | None = None,
    filename: str = "a.png",
    extra: Features | None = None,
) -> Features:
    """One TF Object Detection example; ``boxes`` are ``(xmin, xmax, ymin, ymax)``."""
    boxes = [(0.25, 0.5, 0.25, 0.5)] if boxes is None else boxes
    texts = ["car"] * len(boxes) if texts is None else texts
    labels = [{"car": 1, "person": 2}.get(text, 9) for text in texts] if labels is None else labels
    features: Features = {
        "image/height": ("int64", [size[1]]),
        "image/width": ("int64", [size[0]]),
        "image/filename": ("bytes", [filename.encode()]),
        "image/source_id": ("bytes", [PurePosixPath(filename).stem.encode()]),
        "image/encoded": ("bytes", [_picture(size) if picture is None else picture]),
        "image/format": ("bytes", [b"png"]),
        "image/object/bbox/xmin": ("float", [box[0] for box in boxes]),
        "image/object/bbox/xmax": ("float", [box[1] for box in boxes]),
        "image/object/bbox/ymin": ("float", [box[2] for box in boxes]),
        "image/object/bbox/ymax": ("float", [box[3] for box in boxes]),
        "image/object/class/text": ("bytes", [text.encode() for text in texts]),
        "image/object/class/label": ("int64", labels),
    }
    features.update(extra or {})
    return features


def _write(
    src: Path,
    examples: list[Features],
    *,
    name: str = "train.tfrecord",
    label_map: str | None = LABEL_MAP,
    compress: bool = False,
    packed: bool = True,
) -> Path:
    src.mkdir(parents=True, exist_ok=True)
    if label_map is not None:
        (src / LABEL_MAP_FILENAME).write_text(label_map, encoding="utf-8")
    blob = b"".join(_record(_example(one, packed=packed)) for one in examples)
    (src / name).write_bytes(gzip.compress(blob) if compress else blob)
    return src


def _losses(dataset: ImportedDataset) -> dict[tuple[ImportLossKind, str, str], int]:
    return {(loss.kind, loss.subject, loss.reason): loss.count for loss in dataset.losses}


def _boxes(dataset: ImportedDataset) -> dict[str, list[tuple[str, object]]]:
    return {
        str(image.path): [(label.class_name, label.geometry) for label in image.labels]
        for image in dataset.images
    }


# --- the codec ------------------------------------------------------------------------


def test_the_plugins_are_discovered_by_name() -> None:
    assert isinstance(importers()["tfrecord"], TfrecordImporter)
    assert isinstance(exporters()["tfrecord"], TfrecordExporter)


def test_crc32c_is_castagnoli_and_masked_as_tfrecord_masks_it() -> None:
    assert crc32c(b"123456789") == 0xE3069283
    assert crc32c(b"") == 0
    generator = random.Random(3)
    for size in (1, 7, 8, 9, 15, 16, 64, 1000, 4099):
        data = generator.randbytes(size)
        assert crc32c(data) == _crc32c(data)
        assert masked_crc(data) == _masked(data)


def test_a_record_is_framed_as_tfrecord_specifies() -> None:
    assert frame(b"abc") == (
        b"\x03\x00\x00\x00\x00\x00\x00\x00"
        + struct.pack("<I", _masked(b"\x03" + b"\x00" * 7))
        + b"abc"
        + struct.pack("<I", _masked(b"abc"))
    )
    assert list(records(BytesIO(_record(b"one") + _record(b"") + _record(b"x")), "t")) == [
        b"one",
        b"",
        b"x",
    ]


def test_an_example_round_trips_through_an_independent_parser() -> None:
    encoded = encode_example(
        {
            "b": bytes_feature(b"x", b""),
            "f": float_feature(0.5, 0.1),
            "i": int64_feature(-1, 0, 2**40),
            "empty": float_feature(),
        }
    )
    assert _parse_example(encoded) == {
        "b": ("bytes", [b"x", b""]),
        "empty": ("float", []),
        "f": ("float", [0.5, _f32(0.1)]),
        "i": ("int64", [-1, 0, 2**40]),
    }
    for packed in (True, False):
        written = _example({"f": ("float", [0.25, 1.0]), "i": ("int64", [3, -2])}, packed=packed)
        decoded = decode_example(written, "t")
        assert decoded["f"].float_list == (0.25, 1.0)
        assert decoded["i"].int64_list == (3, -2)


def test_google_protobuf_parses_an_encoded_example() -> None:
    descriptor_pb2 = pytest.importorskip("google.protobuf.descriptor_pb2")
    from google.protobuf import (  # type: ignore[import-untyped]
        descriptor_pool,
        message_factory,
    )

    field = descriptor_pb2.FieldDescriptorProto
    proto = descriptor_pb2.FileDescriptorProto(name="t.proto", package="t", syntax="proto3")
    for name, kind in (("BytesList", 12), ("FloatList", 2), ("Int64List", 3)):
        message = proto.message_type.add(name=name)
        message.field.add(name="value", number=1, type=kind, label=field.LABEL_REPEATED)
    feature = proto.message_type.add(name="Feature")
    feature.oneof_decl.add(name="kind")
    for number, name in enumerate(("bytes_list", "float_list", "int64_list"), start=1):
        type_name = f".t.{name.title().replace('_', '')}"
        feature.field.add(name=name, number=number, type=11, type_name=type_name, oneof_index=0)
    features = proto.message_type.add(name="Features")
    entry = features.nested_type.add(name="FeatureEntry")
    entry.options.map_entry = True
    entry.field.add(name="key", number=1, type=9, label=field.LABEL_OPTIONAL)
    entry.field.add(name="value", number=2, type=11, type_name=".t.Feature")
    features.field.add(
        name="feature",
        number=1,
        type=11,
        type_name=".t.Features.FeatureEntry",
        label=field.LABEL_REPEATED,
    )
    example = proto.message_type.add(name="Example")
    example.field.add(name="features", number=1, type=11, type_name=".t.Features")
    pool = descriptor_pool.DescriptorPool()
    pool.Add(proto)
    parsed = message_factory.GetMessageClass(pool.FindMessageTypeByName("t.Example"))()

    parsed.ParseFromString(
        encode_example({"b": bytes_feature(b"x"), "f": float_feature(0.5), "i": int64_feature(-3)})
    )
    assert list(parsed.features.feature["b"].bytes_list.value) == [b"x"]
    assert list(parsed.features.feature["f"].float_list.value) == [0.5]
    assert list(parsed.features.feature["i"].int64_list.value) == [-3]


# --- reading ----------------------------------------------------------------------------


def test_known_normalized_boxes_read_as_pixels_with_classes_and_flags(tmp_path: Path) -> None:
    wide, tall = (40, 10), (64, 48)
    _write(
        tmp_path,
        [
            _features(
                _picture(wide),
                size=wide,
                boxes=[(0.05, 0.25, 0.3, 0.9), (0.0, 1.0, 0.0, 1.0)],
                texts=["car", "person"],
                filename="dir/wide.png",
                extra={
                    "image/object/difficult": ("int64", [1, 0]),
                    "image/object/is_crowd": ("int64", [0, 0]),
                },
            ),
            _features(
                _picture(tall, kind="JPEG"),
                size=tall,
                boxes=[(0.1609375, 0.225, 0.05, 0.1)],
                filename="tall.jpg",
            ),
        ],
        packed=False,
    )

    dataset = TfrecordImporter().read(tmp_path)

    assert _boxes(dataset) == {
        "train.tfrecord/0-wide.png": [
            ("car", BboxGeometry(x=2, y=3, width=8, height=6)),
            ("person", BboxGeometry(x=0, y=0, width=40, height=10)),
        ],
        "train.tfrecord/1-tall.jpg": [
            ("car", BboxGeometry(x=10.3, y=2.4, width=4.1, height=2.4)),
        ],
    }
    first, second = dataset.images
    assert (first.width, first.height, second.width, second.height) == (*wide, *tall)
    assert [label.attributes for label in first.labels] == [
        {"difficult": True, "is_crowd": False},
        {"difficult": False, "is_crowd": False},
    ]
    assert second.labels[0].attributes == {}
    assert [(c.name, [a.name for a in c.attributes]) for c in dataset.classes] == [
        ("car", ["difficult", "is_crowd"]),
        ("person", ["difficult", "is_crowd"]),
    ]
    assert dataset.losses == ()


def test_a_class_is_named_by_text_alone_or_by_id_alone(tmp_path: Path) -> None:
    by_text = _features(texts=["person"], filename="a.png")
    del by_text["image/object/class/label"]
    by_id = _features(texts=[], labels=[2], filename="b.png")
    del by_id["image/object/class/text"]
    _write(tmp_path, [by_text, by_id])

    assert [
        label.class_name
        for image in TfrecordImporter().read(tmp_path).images
        for label in image.labels
    ] == ["person", "person"]


@pytest.mark.parametrize(
    ("texts", "labels", "match"),
    [
        (["car"], [2], "is id 1 in the label map, but the box says 2"),
        (["bus"], [1], "class 'bus' is not in the label map"),
        ([], [7], "class id 7 is not in the label map"),
        (["car", "car"], [1], "holds 2 values for 1 boxes"),
        ([], [], "neither"),
    ],
)
def test_a_class_text_and_id_that_disagree_or_are_unknown_refuse(
    tmp_path: Path, texts: list[str], labels: list[int], match: str
) -> None:
    _write(tmp_path, [_features(texts=texts, labels=labels)])
    with pytest.raises(ImportSourceUnreadable, match=match):
        TfrecordImporter().read(tmp_path)


@pytest.mark.parametrize(
    ("key", "feature"),
    [
        ("image/object/bbox/xmin", ("bytes", [b"0.25"])),
        ("image/encoded", ("int64", [1])),
        ("image/object/class/text", ("float", [1.0])),
        ("image/height", ("float", [24.0])),
        ("image/object/difficult", ("bytes", [b"1"])),
    ],
)
def test_a_feature_of_the_wrong_type_refuses(
    tmp_path: Path, key: str, feature: tuple[str, list[Any]]
) -> None:
    _write(tmp_path, [_features(extra={key: feature})])
    with pytest.raises(ImportSourceUnreadable, match=f"{key} holds"):
        TfrecordImporter().read(tmp_path)


@pytest.mark.parametrize(
    ("boxes", "match"),
    [
        ([(0.25, 1.5, 0.25, 0.5)], r"not a fraction in \[0, 1\]"),
        ([(-0.1, 0.5, 0.25, 0.5)], r"not a fraction in \[0, 1\]"),
        ([(math.nan, 0.5, 0.25, 0.5)], r"not a fraction in \[0, 1\]"),
        ([(0.5, 0.5, 0.25, 0.5)], "maximum must exceed its minimum"),
        ([(0.25, 0.5, 0.75, 0.5)], "maximum must exceed its minimum"),
        ([(0.25, 0.5, 0.25, 0.250001)], "narrower than its picture can measure"),
    ],
)
def test_an_invalid_coordinate_refuses(
    tmp_path: Path, boxes: list[tuple[float, float, float, float]], match: str
) -> None:
    _write(tmp_path, [_features(boxes=boxes)])
    with pytest.raises(ImportSourceUnreadable, match=match):
        TfrecordImporter().read(tmp_path)


def test_coordinate_lists_of_different_lengths_refuse(tmp_path: Path) -> None:
    _write(tmp_path, [_features(extra={"image/object/bbox/ymax": ("float", [0.5, 0.6])})])
    with pytest.raises(ImportSourceUnreadable, match="differ in length"):
        TfrecordImporter().read(tmp_path)


def test_an_example_with_no_picture_is_an_image_loss_and_its_boxes_label_losses(
    tmp_path: Path,
) -> None:
    missing = _features(filename="gone.png", boxes=[(0.1, 0.2, 0.1, 0.2)] * 2)
    del missing["image/encoded"]
    empty = _features(filename="blank.png", extra={"image/encoded": ("bytes", [b""])})
    _write(tmp_path, [missing, _features(filename="kept.png"), empty])

    dataset = TfrecordImporter().read(tmp_path)

    assert list(_boxes(dataset)) == ["train.tfrecord/1-kept.png"]
    assert _losses(dataset) == {
        (
            ImportLossKind.IMAGE,
            "train.tfrecord",
            "an example with no image/encoded picture; its boxes are not imported",
        ): 2,
        (ImportLossKind.LABEL, "train.tfrecord", "a box on an example with no picture"): 3,
    }


def test_an_empty_example_is_a_picture_with_no_boxes(tmp_path: Path) -> None:
    bare = {
        "image/encoded": ("bytes", [_picture()]),
        "image/filename": ("bytes", [b"bare.png"]),
    }
    _write(tmp_path, [_features(boxes=[], filename="none.png"), bare])

    dataset = TfrecordImporter().read(tmp_path)

    assert _boxes(dataset) == {"train.tfrecord/0-none.png": [], "train.tfrecord/1-bare.png": []}
    assert dataset.losses == ()
    assert [c.name for c in dataset.classes] == ["car", "person"]


def test_a_declared_size_the_picture_does_not_have_refuses(tmp_path: Path) -> None:
    _write(tmp_path, [_features(extra={"image/width": ("int64", [SIZE[0] + 1])})])
    with pytest.raises(ImportSourceUnreadable, match="image/width is 33 but the picture is 32x24"):
        TfrecordImporter().read(tmp_path)


def test_an_unreadable_picture_refuses(tmp_path: Path) -> None:
    _write(tmp_path, [_features(b"not a picture")])
    with pytest.raises(ImportSourceUnreadable, match="not a readable picture"):
        TfrecordImporter().read(tmp_path)


def test_masks_keypoints_and_other_features_are_reported_lost(tmp_path: Path) -> None:
    label_map = LABEL_MAP.replace('name: "person"', 'name: "person"\n  display_name: "Human"')
    two = [(0.1, 0.2, 0.1, 0.2), (0.3, 0.4, 0.3, 0.4)]
    _write(
        tmp_path,
        [
            _features(
                boxes=two,
                texts=["car", "person"],
                filename="a.png",
                extra={
                    "image/object/mask": ("bytes", [b"m1", b"m2"]),
                    "image/object/keypoint/x": ("float", [0.1, 0.2]),
                    "image/object/keypoint/y": ("float", [0.1, 0.2]),
                    "image/object/area": ("float", [4.0, 4.0]),
                    "image/object/view": ("bytes", []),
                    "image/caption": ("bytes", [b"two things"]),
                    "image/source_id": ("bytes", [b"coco-17"]),
                    "image/key/sha256": ("bytes", [b"abc"]),
                },
            )
        ],
        label_map=label_map,
    )

    dataset = TfrecordImporter().read(tmp_path)

    assert len(dataset.images[0].labels) == 2
    masks = "instance masks are not imported; the box is kept"
    keypoints = "keypoints are not imported; the box is kept"
    area = "image/object/area is not imported"
    assert _losses(dataset) == {
        (
            ImportLossKind.ATTRIBUTE,
            "person",
            "display_name Human is not kept; the class is its name",
        ): 1,
        (ImportLossKind.ATTRIBUTE, "train.tfrecord", "image/source_id is not kept"): 1,
        (ImportLossKind.ATTRIBUTE, "train.tfrecord", "image/caption is not imported"): 1,
        (ImportLossKind.GEOMETRY, "car", masks): 1,
        (ImportLossKind.GEOMETRY, "person", masks): 1,
        (ImportLossKind.GEOMETRY, "car", keypoints): 1,
        (ImportLossKind.GEOMETRY, "person", keypoints): 1,
        (ImportLossKind.ATTRIBUTE, "car", area): 1,
        (ImportLossKind.ATTRIBUTE, "person", area): 1,
    }


def _framed(tmp_path: Path, blob: bytes) -> Path:
    (tmp_path / LABEL_MAP_FILENAME).write_text(LABEL_MAP, encoding="utf-8")
    (tmp_path / "train.tfrecord").write_bytes(blob)
    return tmp_path


def _corrupt(how: str) -> bytes:
    good = _record(_example(_features()))
    if how == "length checksum":
        return good[:8] + bytes([good[8] ^ 1]) + good[9:]
    if how == "data checksum":
        return good[:-1] + bytes([good[-1] ^ 1])
    if how == "data":
        return good[:20] + bytes([good[20] ^ 1]) + good[21:]
    if how == "truncated data":
        return good[:-3]
    if how == "truncated header":
        return good + good[:5]
    return good + b"garbage-after-the-last-record"


@pytest.mark.parametrize(
    ("how", "match"),
    [
        ("length checksum", "length fails its checksum"),
        ("data checksum", "data fails its checksum"),
        ("data", "data fails its checksum"),
        ("truncated data", "truncated"),
        ("truncated header", "truncated"),
        ("trailing garbage", "length fails its checksum"),
    ],
)
def test_corrupt_framing_refuses(tmp_path: Path, how: str, match: str) -> None:
    _framed(tmp_path, _corrupt(how))
    with pytest.raises(ImportSourceUnreadable, match=match):
        TfrecordImporter().read(tmp_path)


def test_a_record_that_is_not_an_example_refuses(tmp_path: Path) -> None:
    _framed(tmp_path, _record(b"\x0a\xff\xff\xff"))
    with pytest.raises(ImportSourceUnreadable, match="not a tf.train.Example"):
        TfrecordImporter().read(tmp_path)


@pytest.mark.parametrize("name", ["train.tfrecord.gz", "train.tfrecord", "train.record"])
def test_gzip_compressed_records_are_read_by_their_magic(tmp_path: Path, name: str) -> None:
    _write(tmp_path, [_features(filename="a.png")], name=name, compress=name != "train.record")
    importer = TfrecordImporter()
    dataset = importer.read(tmp_path)
    assert list(_boxes(dataset)) == [f"{name}/0-a.png"]
    with importer.open(tmp_path, dataset.images[0].path) as served:
        assert served.read() == _picture()


def test_corrupt_gzip_refuses(tmp_path: Path) -> None:
    blob = gzip.compress(_record(_example(_features())))
    _framed(tmp_path, blob[:-12])
    with pytest.raises(ImportSourceUnreadable, match="not a readable TFRecord file"):
        TfrecordImporter().read(tmp_path)


def test_a_shard_set_is_read_in_shard_order_and_splits_stay_apart(tmp_path: Path) -> None:
    for shard, filename in ((1, "c.png"), (0, "b.png")):
        _write(
            tmp_path, [_features(filename=filename)], name=f"train.tfrecord-0000{shard}-of-00002"
        )
    _write(tmp_path, [_features(filename="v.png")], name="val.tfrecord")

    dataset = TfrecordImporter().read(tmp_path)

    assert list(_boxes(dataset)) == [
        "train.tfrecord-00000-of-00002/0-b.png",
        "train.tfrecord-00001-of-00002/0-c.png",
        "val.tfrecord/0-v.png",
    ]


@pytest.mark.parametrize(
    ("names", "match"),
    [
        (["train.tfrecord-00000-of-00002"], r"lacks shard\(s\) 1"),
        (["train.tfrecord-00000-of-00002", "train.tfrecord-00001-of-00003"], "shard set"),
        (["train.tfrecord-00000-of-00001", "train.tfrecord"], "both whole and in shards"),
        (["train.tfrecord", "train.tfrecord.gz"], "both hold the 'train' split"),
        ([], "holds no <split>.tfrecord"),
    ],
)
def test_an_incomplete_or_ambiguous_record_set_refuses(
    tmp_path: Path, names: list[str], match: str
) -> None:
    tmp_path.joinpath(LABEL_MAP_FILENAME).write_text(LABEL_MAP, encoding="utf-8")
    for name in names:
        _write(tmp_path, [_features()], name=name)
    with pytest.raises(ImportSourceUnreadable, match=match):
        TfrecordImporter().read(tmp_path)


def test_a_label_map_reads_comments_quotes_escapes_nested_blocks_and_display_names() -> None:
    text = """
    # the classes
    item {
      name: 'traffic \\'sign\\''
      id: 1
      keypoints { id: 0 label: "tip" }
      frequency: FREQUENT
    }
    item: { id: 2, display_name: "caf\\303\\251" }
    item { id: 3 name: "a\\"b" display_name: "A B" }
    """
    assert parse_label_map(text, "map") == [
        {"name": "traffic 'sign'", "id": 1},
        {"id": 2, "display_name": "café"},
        {"id": 3, "name": 'a"b', "display_name": "A B"},
    ]


@pytest.mark.parametrize(
    ("label_map", "match"),
    [
        ('item { id: 0 name: "bg" }', "id 0 is reserved"),
        ('item { id: -2 name: "x" }', "id -2 is reserved"),
        ('item { id: 1 name: "a" } item { id: 1 name: "b" }', "id 1 is given twice"),
        ('item { id: 1 name: "a" } item { id: 2 name: "a" }', "name 'a' is given twice"),
        ('item { name: "a" }', "an item has no id"),
        ("item { id: 1 }", "item 1 has no name"),
        ('item { id: 1 name: "a" ', "expected }"),
        ('item { id: "1" name: "a" }', "is not an integer"),
        ("item { id: 1 name: a }", "is not a string"),
        ('label { id: 1 name: "a" }', "holds only item blocks"),
        ('item { id: 1 name: "a" } @', "is not pbtxt"),
        ('item { id: 1 name: "a" id: 2 }', "names id twice"),
    ],
)
def test_a_malformed_label_map_refuses(tmp_path: Path, label_map: str, match: str) -> None:
    _write(tmp_path, [_features(boxes=[])], label_map=label_map)
    with pytest.raises(ImportSourceUnreadable, match=match):
        TfrecordImporter().read(tmp_path)


def test_a_source_needs_exactly_one_label_map(tmp_path: Path) -> None:
    _write(tmp_path, [_features()], label_map=None)
    with pytest.raises(ImportSourceUnreadable, match="holds no label_map.pbtxt"):
        TfrecordImporter().read(tmp_path)
    (tmp_path / "a.pbtxt").write_text(LABEL_MAP, encoding="utf-8")
    (tmp_path / "b.pbtxt").write_text(LABEL_MAP, encoding="utf-8")
    with pytest.raises(ImportSourceUnreadable, match="keep one label map"):
        TfrecordImporter().read(tmp_path)


def test_open_serves_a_record_s_picture_with_or_without_a_prior_read(tmp_path: Path) -> None:
    pictures = [_picture(seed=seed) for seed in range(3)]
    _write(
        tmp_path,
        [_features(one, filename=f"{n}.png") for n, one in enumerate(pictures)],
        name="train.tfrecord.gz",
        compress=True,
    )
    paths = [image.path for image in TfrecordImporter().read(tmp_path).images]
    for importer in (TfrecordImporter(), _read_first(tmp_path)):
        for path, picture in zip(reversed(paths), reversed(pictures), strict=True):
            with importer.open(tmp_path, path) as served:
                assert served.read() == picture
        for absent in ("train.tfrecord.gz/3-3.png", "train.tfrecord.gz/0-other.png", "a/b/c"):
            with pytest.raises(FileNotFoundError):
                importer.open(tmp_path, PurePosixPath(absent))


class _CountedGzip(gzip.GzipFile):
    opened = 0

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        type(self).opened += 1
        super().__init__(*args, **kwargs)


def test_a_gzip_file_is_decompressed_once_however_many_pictures_are_opened(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(reader.gzip, "GzipFile", _CountedGzip)
    pictures = [_picture(seed=seed) for seed in range(12)]
    _write(
        tmp_path,
        [_features(one, filename=f"{n}.png") for n, one in enumerate(pictures)],
        name="train.tfrecord.gz",
        compress=True,
    )
    before = sorted(path.name for path in tmp_path.iterdir())

    importer = TfrecordImporter()
    paths = [image.path for image in importer.read(tmp_path).images]
    for _ in range(2):
        for path, picture in zip(paths, pictures, strict=True):
            with importer.open(tmp_path, path) as served:
                assert served.read() == picture
    assert _CountedGzip.opened == 1

    fresh = TfrecordImporter()
    for path in reversed(paths):
        fresh.open(tmp_path, path).close()
    assert _CountedGzip.opened == 2

    held = importer._spools[0]
    importer.close()
    assert held.closed
    assert importer._spools == []
    assert sorted(path.name for path in tmp_path.iterdir()) == before


def test_a_rewritten_gzip_file_is_decompressed_again(tmp_path: Path) -> None:
    _write(tmp_path, [_features(_picture(seed=1))], name="t.tfrecord.gz", compress=True)
    importer = TfrecordImporter()
    (image,) = importer.read(tmp_path).images
    _write(tmp_path, [_features(_picture(seed=2))], name="t.tfrecord.gz", compress=True)
    os.utime(tmp_path / "t.tfrecord.gz", ns=(1, 1))
    with importer.open(tmp_path, image.path) as served:
        assert served.read() == _picture(seed=2)


def test_open_skips_only_the_data_checksum_which_read_verifies(tmp_path: Path) -> None:
    good = _record(_example(_features()))
    _framed(tmp_path, good[:-1] + bytes([good[-1] ^ 1]))
    with pytest.raises(ImportSourceUnreadable, match="data fails its checksum"):
        TfrecordImporter().read(tmp_path)
    with TfrecordImporter().open(tmp_path, PurePosixPath("train.tfrecord/0-a.png")) as served:
        assert served.read() == _picture()

    _framed(tmp_path, good[:8] + bytes([good[8] ^ 1]) + good[9:])
    with pytest.raises(ImportSourceUnreadable, match="length fails its checksum"):
        TfrecordImporter().open(tmp_path, PurePosixPath("train.tfrecord/0-a.png"))


def test_an_uncompressed_record_whose_length_starts_like_the_gzip_magic_is_a_record(
    tmp_path: Path,
) -> None:
    target = 0x8B1F
    base = len(_example(_features(extra={"image/key/sha256": ("bytes", [b""])})))
    padded = next(
        example
        for pad in range(target - base - 32, target - base + 32)
        if len(example := _example(_features(extra={"image/key/sha256": ("bytes", [b"k" * pad])})))
        == target
    )
    _framed(tmp_path, _record(padded))
    assert (tmp_path / "train.tfrecord").read_bytes()[:2] == b"\x1f\x8b"

    importer = TfrecordImporter()
    (image,) = importer.read(tmp_path).images
    assert importer._spools == []
    with importer.open(tmp_path, image.path) as served:
        assert served.read() == _picture()


def _read_first(src: Path) -> TfrecordImporter:
    importer = TfrecordImporter()
    importer.read(src)
    return importer


def test_an_import_reads_pictures_out_of_the_records_and_writes_nothing_into_the_source(
    tmp_path: Path,
) -> None:
    src = _write(
        tmp_path / "src",
        [
            _features(_picture(seed=1), filename="a.png"),
            _features(_picture(seed=2), filename="b.png"),
        ],
    )
    before = sorted((path.name, path.read_bytes()) for path in src.iterdir())
    workspace = WorkspaceService.init(tmp_path / "ws")
    project = ProjectService(workspace).create("tf")
    imports = ImportService(workspace)

    plan = imports.inspect(project.id, TfrecordImporter(), src)
    run = imports.commit(project.id, TfrecordImporter(), src, consent=ImportConsent())

    assert plan.missing_images == ()
    assert run.annotations_written == 2
    assert sorted((path.name, path.read_bytes()) for path in src.iterdir()) == before
    with workspace.unit_of_work() as uow:
        stored = sorted(
            workspace.blob_store.get(asset.content_hash).read()
            for asset in uow.assets.list(project.id)
        )
    assert stored == sorted([_picture(seed=1), _picture(seed=2)])
    workspace.close()


# --- writing ------------------------------------------------------------------------------


def _release() -> Release:
    return Release(
        dataset_id=uuid4(),
        tag="v1",
        manifest_hash="0" * 64,
        schema_version=1,
        asset_count=0,
        annotation_count=0,
    )


CAR = LabelClass(
    name="car",
    geometries=(GeometryType.BBOX, GeometryType.POLYGON),
    attributes=(
        Attribute(name="difficult", kind="boolean"),
        Attribute(name="colour", kind="string"),
    ),
)
BUS = LabelClass(name="bus", geometries=(GeometryType.BBOX,))


def _annotation(
    geometry: object, label_class: str = "car", **attributes: object
) -> ManifestAnnotation:
    return ManifestAnnotation.model_validate(
        {
            "id": uuid4(),
            "label_class": label_class,
            "schema_version": 1,
            "geometry": geometry,
            "attributes": attributes,
            "provenance": "human",
        }
    )


def _content(blobs: dict[str, bytes]) -> ContentReader:
    def content(content_hash: str) -> BinaryIO:
        return BytesIO(blobs[content_hash])

    return content


#: Pixel boxes, the picture they sit on, and their corners as float32 fractions.
KNOWN: list[tuple[tuple[int, int], BboxGeometry]] = [
    ((40, 10), BboxGeometry(x=2, y=3, width=8, height=6)),
    ((64, 48), BboxGeometry(x=10.3, y=2.4, width=4.1, height=2.4)),
    ((64, 48), BboxGeometry(x=0.125, y=47, width=63.875, height=1)),
]


def _known_release(tmp_path: Path) -> tuple[dict[str, bytes], dict[str, BboxGeometry]]:
    assets: list[ManifestAsset] = []
    blobs: dict[str, bytes] = {}
    expected: dict[str, BboxGeometry] = {}
    for position, (size, box) in enumerate(KNOWN):
        content_hash = f"{position:x}" * 64
        expected[content_hash] = box
        blobs[content_hash] = _picture(size, seed=position, kind="JPEG" if position else "PNG")
        annotations = (
            _annotation(box, difficult=True, colour="red") if position == 0 else _annotation(box),
            _annotation(PolygonGeometry(points=[(1, 1), (9.5, 1), (9.5, 7.25)])),
        )
        assets.append(
            ManifestAsset(
                asset_id=uuid4(),
                content_hash=content_hash,
                uri=f"/{position}",
                width=size[0],
                height=size[1],
                annotations=annotations,
            )
        )
    blobs["e" * 64] = _picture(SIZE, seed=9)
    assets.append(
        ManifestAsset(
            asset_id=uuid4(), content_hash="e" * 64, uri="/e", width=SIZE[0], height=SIZE[1]
        )
    )
    manifest = Manifest(schema_version=1, classes=(CAR, BUS), assets=tuple(assets))
    TfrecordExporter().export(
        _release(), manifest, tmp_path, content=_content(blobs), assignment=None
    )
    return blobs, expected


def test_an_independent_parser_reads_the_export_as_the_object_detection_api_does(
    tmp_path: Path,
) -> None:
    blobs, expected = _known_release(tmp_path)

    assert sorted(path.name for path in tmp_path.iterdir()) == [
        LABEL_MAP_FILENAME,
        "train.tfrecord",
    ]
    assert (tmp_path / LABEL_MAP_FILENAME).read_text(encoding="utf-8") == (
        'item {\n  id: 1\n  name: "bus"\n}\nitem {\n  id: 2\n  name: "car"\n}\n'
    )
    examples = [
        _parse_example(data) for data in _parse_records((tmp_path / "train.tfrecord").read_bytes())
    ]
    assert len(examples) == 4

    for example, (content_hash, box), (size, _) in zip(
        examples, expected.items(), KNOWN, strict=False
    ):
        width, height = size
        assert example["image/encoded"] == ("bytes", [blobs[content_hash]])
        assert example["image/height"] == ("int64", [height])
        assert example["image/width"] == ("int64", [width])
        assert example["image/source_id"] == ("bytes", [content_hash.encode()])
        suffix, kind = (b".png", b"png") if content_hash[0] == "0" else (b".jpg", b"jpeg")
        assert example["image/filename"] == ("bytes", [content_hash.encode() + suffix])
        assert example["image/format"] == ("bytes", [kind])
        assert example["image/object/class/text"] == ("bytes", [b"car"])
        assert example["image/object/class/label"] == ("int64", [2])
        corners = [
            example[f"image/object/bbox/{key}"][1] for key in ("xmin", "xmax", "ymin", "ymax")
        ]
        assert corners == [
            [_f32(box.x / width)],
            [_f32((box.x + box.width) / width)],
            [_f32(box.y / height)],
            [_f32((box.y + box.height) / height)],
        ]
    assert examples[0]["image/object/difficult"] == ("int64", [1])
    assert "image/object/difficult" not in examples[1]
    empty = examples[3]
    assert empty["image/object/bbox/xmin"] == ("float", [])
    assert empty["image/encoded"] == ("bytes", [blobs["e" * 64]])


def test_known_pixel_boxes_are_written_and_read_back_exactly(tmp_path: Path) -> None:
    blobs, expected = _known_release(tmp_path)

    importer = TfrecordImporter()
    dataset = importer.read(tmp_path)

    assert dataset.losses == ()
    assert [c.name for c in dataset.classes] == ["bus", "car"]
    by_hash = {image.path.name.split("-", 1)[1].split(".")[0]: image for image in dataset.images}
    assert set(by_hash) == {*expected, "e" * 64}
    for content_hash, box in expected.items():
        assert [label.geometry for label in by_hash[content_hash].labels] == [box]
        with importer.open(tmp_path, by_hash[content_hash].path) as served:
            assert served.read() == blobs[content_hash]
    assert by_hash["0" * 64].labels[0].attributes == {"difficult": True}


def test_a_box_hanging_off_its_picture_is_clamped_into_it(tmp_path: Path) -> None:
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="a" * 64,
        uri="/a",
        width=SIZE[0],
        height=SIZE[1],
        annotations=(_annotation(BboxGeometry(x=-4, y=20, width=10, height=8)),),
    )
    manifest = Manifest(schema_version=1, classes=(CAR,), assets=(asset,))
    TfrecordExporter().export(
        _release(), manifest, tmp_path, content=_content({"a" * 64: _picture()}), assignment=None
    )
    (image,) = TfrecordImporter().read(tmp_path).images
    assert [label.geometry for label in image.labels] == [
        BboxGeometry(x=0, y=20, width=6, height=4)
    ]


def test_a_webp_picture_is_refused_by_name(tmp_path: Path) -> None:
    asset = ManifestAsset(
        asset_id=uuid4(), content_hash="a" * 64, uri="/a", width=SIZE[0], height=SIZE[1]
    )
    manifest = Manifest(schema_version=1, classes=(CAR,), assets=(asset,))
    with pytest.raises(ExportSourceUnreadable, match="not a JPEG or PNG"):
        TfrecordExporter().export(
            _release(),
            manifest,
            tmp_path,
            content=_content({"a" * 64: _picture(kind="WEBP")}),
            assignment=None,
        )


@pytest.mark.parametrize("extent", [1, 640, 1920, 4096, 16384])
def test_float32_corners_of_three_decimals_read_back_exactly_up_to_16384_pixels(
    extent: int,
) -> None:
    from visionset.formats.tfrecord.reader import _pixel

    generator = random.Random(extent)
    corners = [float(value) for value in range(extent + 1)]
    corners += [round(generator.uniform(0, extent), PRECISION) for _ in range(5000)]
    assert [_pixel(_f32(corner / extent), extent) for corner in corners] == corners
    worst = max(
        abs(_pixel(_f32(value / extent), extent) - value)
        for value in (generator.uniform(0, extent) for _ in range(5000))
    )
    assert worst <= 0.5 * 10**-PRECISION + extent * 2**-25


def _drawn(label_class: str, geometry: BboxGeometry, **attributes: Any) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=geometry,
        provenance="human",
        attributes=attributes,
    )


def test_boxes_bytes_and_splits_round_trip_through_a_release(tmp_path: Path) -> None:
    sign = LabelClass(
        name="sign",
        geometries=(GeometryType.BBOX,),
        attributes=(Attribute(name="truncated", kind="boolean"),),
    )
    fixture = Fixture(tmp_path / "origin", classes=[sign])
    fixture.label(
        {
            0: [_drawn("sign", BboxGeometry(x=8, y=12, width=16, height=24), truncated=True)],
            1: [
                _drawn("sign", BboxGeometry(x=10.3, y=2.7, width=4.1, height=1.9), truncated=False),
                _drawn("sign", BboxGeometry(x=1.5, y=2.25, width=10, height=8), truncated=True),
            ],
        }
    )
    exported = tmp_path / "exported"
    fixture.releases.export(
        fixture.publish(split=SplitRecipe(train=0.5, val=0.5, test=0.0, seed=1)),
        TfrecordExporter(),
        exported,
        allow_lossy=True,
    )
    original = _stored(fixture.workspace, fixture.project.id)
    with fixture.workspace.unit_of_work() as uow:
        original_bytes = {
            asset.content_hash: fixture.workspace.blob_store.get(asset.content_hash).read()
            for asset in uow.assets.list(fixture.project.id)
        }
    fixture.close()

    assert (exported / LABEL_MAP_FILENAME).is_file()
    assert sorted(path.name for path in exported.glob("*.tfrecord")) == [
        "train.tfrecord",
        "val.tfrecord",
    ]
    workspace = WorkspaceService.init(tmp_path / "copy")
    project = ProjectService(workspace).create("copy")
    imports = ImportService(workspace)
    plan = imports.inspect(project.id, TfrecordImporter(), exported)
    run = imports.commit(project.id, TfrecordImporter(), exported, consent=ImportConsent())

    assert plan.losses == ()
    assert run.losses == ()
    assert _stored(workspace, project.id) == original
    splits = Counter(str(image.path).split("/")[0] for image in plan.images)
    assert splits == {"train.tfrecord": 2, "val.tfrecord": 1}
    with workspace.unit_of_work() as uow:
        copied = {
            asset.content_hash: workspace.blob_store.get(asset.content_hash).read()
            for asset in uow.assets.list(project.id)
        }
    assert copied == original_bytes
    workspace.close()


def test_the_label_map_writer_escapes_and_orders_by_id() -> None:
    text = label_map_text({'say "hi"': 2, "a\\b": 1})
    assert (
        text == 'item {\n  id: 1\n  name: "a\\\\b"\n}\nitem {\n  id: 2\n  name: "say \\"hi\\""\n}\n'
    )
    assert parse_label_map(text, "map") == [
        {"id": 1, "name": "a\\b"},
        {"id": 2, "name": 'say "hi"'},
    ]
