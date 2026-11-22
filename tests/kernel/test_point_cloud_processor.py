"""StdlibPointCloudProcessor: PCD and PLY scans built in memory, plus opt-in real samples."""

from __future__ import annotations

import io
import math
import struct
from pathlib import Path

import pytest
from PIL import Image

from visionset.kernel.adapters import point_cloud_processor as adapter
from visionset.kernel.adapters.point_cloud_processor import StdlibPointCloudProcessor
from visionset.kernel.domain import PointCloudFormat, ScanFrame
from visionset.kernel.errors import CorruptMedia, UnsupportedMedia
from visionset.kernel.ports import PointCloudProcessor
from visionset.kernel.ports import point_cloud_processor as port

NAN = float("nan")
POINTS = [(1.0, 2.0, 3.0), (-1.0, 0.5, 4.0), (0.0, -2.0, -1.0)]


def pcd_header(
    fields: str = "x y z",
    size: str = "4 4 4",
    kind: str = "F F F",
    count: str | None = "1 1 1",
    points: int = 3,
    data: str = "binary",
    width: int | None = None,
    height: int = 1,
    comment: bool = True,
) -> bytes:
    lines = ["# .PCD v0.7 - Point Cloud Data file format"] if comment else []
    lines += ["VERSION 0.7", f"FIELDS {fields}", f"SIZE {size}", f"TYPE {kind}"]
    if count is not None:
        lines.append(f"COUNT {count}")
    lines += [
        f"WIDTH {points if width is None else width}",
        f"HEIGHT {height}",
        "VIEWPOINT 0 0 0 1 0 0 0",
        f"POINTS {points}",
        f"DATA {data}",
    ]
    return ("\n".join(lines) + "\n").encode()


def pcd_binary(points: list[tuple[float, ...]], **header: object) -> bytes:
    body = b"".join(struct.pack(f"<{len(p)}f", *p) for p in points)
    return pcd_header(points=len(points), **header) + body  # type: ignore[arg-type]


def lzf_literal(data: bytes) -> bytes:
    out = bytearray()
    for i in range(0, len(data), 32):
        chunk = data[i : i + 32]
        out.append(len(chunk) - 1)
        out += chunk
    return bytes(out)


def lzf_encode(data: bytes) -> bytes:
    """Literal runs plus a back-reference for every repeat of the previous 3+ bytes."""
    out = bytearray()
    literal = bytearray()
    i = 0

    def flush() -> None:
        nonlocal literal
        out.extend(lzf_literal(bytes(literal)))
        literal = bytearray()

    while i < len(data):
        best = 0
        best_distance = 0
        for distance in range(1, min(i, 300) + 1):
            length = 0
            while (
                i + length < len(data)
                and length < 264
                and data[i + length] == data[i - distance + length]
            ):
                length += 1
            if length > best:
                best, best_distance = length, distance
        if best >= 3:
            flush()
            length = best - 2
            offset = best_distance - 1
            if length < 7:
                out.append((length << 5) | (offset >> 8))
            else:
                out.append((7 << 5) | (offset >> 8))
                out.append(length - 7)
            out.append(offset & 0xFF)
            i += best
        else:
            literal.append(data[i])
            i += 1
            if len(literal) == 32:
                flush()
    flush()
    return bytes(out)


def pcd_compressed(points: list[tuple[float, ...]], encoder=lzf_encode, **header: object) -> bytes:  # type: ignore[no-untyped-def]
    width = len(points[0])
    columns = b"".join(b"".join(struct.pack("<f", p[k]) for p in points) for k in range(width))
    packed = encoder(columns)
    return (
        pcd_header(points=len(points), data="binary_compressed", **header)  # type: ignore[arg-type]
        + struct.pack("<II", len(packed), len(columns))
        + packed
    )


def pcd_ascii(rows: list[str], **header: object) -> bytes:
    return (
        pcd_header(points=len(rows), data="ascii", **header).decode().encode()
        + (  # type: ignore[arg-type]
            "\n".join(rows) + "\n"
        ).encode()
    )


def ply_ascii_header(vertex_props: list[str], count: int, extra: str = "") -> str:
    props = "".join(f"property {p}\n" for p in vertex_props)
    return f"ply\nformat ascii 1.0\nelement vertex {count}\n{props}{extra}end_header\n"


def processor() -> StdlibPointCloudProcessor:
    return StdlibPointCloudProcessor()


def probe(data: bytes, **kwargs: object):  # type: ignore[no-untyped-def]
    return processor().probe(io.BytesIO(data), **kwargs)  # type: ignore[arg-type]


def decode(jpeg: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(jpeg))
    image.load()
    return image


class TestProtocol:
    def test_satisfies_the_port(self) -> None:
        assert isinstance(StdlibPointCloudProcessor(), PointCloudProcessor)


class TestPcdEncodings:
    def test_binary(self) -> None:
        meta = probe(pcd_binary(POINTS))
        assert meta.format is PointCloudFormat.PCD
        assert meta.point_count == 3
        assert meta.bounds.minimum == (-1.0, -2.0, -1.0)
        assert meta.bounds.maximum == (1.0, 2.0, 4.0)
        assert meta.fields == ("x", "y", "z")

    def test_ascii(self) -> None:
        meta = probe(pcd_ascii(["1 2 3", "-1 0.5 4", "0 -2 -1"]))
        assert meta.point_count == 3
        assert meta.bounds.maximum == (1.0, 2.0, 4.0)

    def test_ascii_extra_blank_lines_and_trailing_rows_tolerated(self) -> None:
        data = (
            pcd_ascii(["1 2 3", "", "4 5 6"])
            .replace(b"POINTS 3", b"POINTS 2")
            .replace(b"WIDTH 3", b"WIDTH 2")
        )
        assert probe(data).point_count == 2

    def test_binary_compressed_exercises_both_opcode_kinds(self) -> None:
        points = [(float(i % 4), float(i % 7), float(i % 3)) for i in range(200)]
        data = pcd_compressed(points)
        packed = data[data.index(b"DATA binary_compressed\n") + 23 :]
        controls = []
        i = 8
        while i < len(packed):
            c = packed[i]
            if c < 32:
                controls.append("literal")
                i += c + 2
            else:
                controls.append("reference")
                i += 3 if (c >> 5) == 7 else 2
        assert {"literal", "reference"} <= set(controls)
        meta = probe(data)
        assert meta.point_count == 200
        assert meta.bounds.maximum == (3.0, 6.0, 2.0)

    def test_binary_compressed_is_column_major(self) -> None:
        meta = probe(pcd_compressed(POINTS))
        assert meta.bounds.minimum == (-1.0, -2.0, -1.0)
        assert meta.bounds.maximum == (1.0, 2.0, 4.0)

    def test_header_without_count_defaults_to_one(self) -> None:
        assert probe(pcd_binary(POINTS, count=None)).point_count == 3

    def test_points_default_to_width_times_height(self) -> None:
        data = pcd_binary(POINTS).replace(b"POINTS 3\n", b"")
        assert probe(data).point_count == 3

    def test_no_leading_comment(self) -> None:
        assert probe(pcd_binary(POINTS, comment=False)).point_count == 3

    def test_double_precision(self) -> None:
        body = struct.pack("<3d", 1.0, 2.0, 3.0)
        data = pcd_header("x y z", "8 8 8", "F F F", "1 1 1", 1) + body
        assert probe(data).bounds.maximum == (1.0, 2.0, 3.0)


class TestPcdFields:
    def test_padding_field_is_skipped(self) -> None:
        points = [(1.0, 2.0, 3.0, 0.0), (4.0, 5.0, 6.0, 0.0)]
        data = pcd_binary(points, fields="x y z _", size="4 4 4 4", kind="F F F F", count="1 1 1 1")
        meta = probe(data)
        assert meta.fields == ("x", "y", "z")
        assert meta.bounds.maximum == (4.0, 5.0, 6.0)

    def test_padding_between_and_before_coordinates(self) -> None:
        body = b"".join(struct.pack("<ffff", 9.0, x, y, z) for x, y, z in POINTS)
        data = (
            pcd_header("_ x y z", "4 4 4 4", "U F F F", "1 1 1 1", 3).replace(
                b"U F F F", b"F F F F"
            )
            + body
        )
        assert probe(data).bounds.maximum == (1.0, 2.0, 4.0)

    def test_rgb_float_packed(self) -> None:
        points = [(1.0, 2.0, 3.0, 1.0), (4.0, 5.0, 6.0, 2.0)]
        data = pcd_binary(points, fields="x y z rgb", size="4 4 4 4", kind="F F F F", count=None)
        assert probe(data).fields == ("x", "y", "z", "rgb")

    def test_rgba_unsigned(self) -> None:
        body = b"".join(struct.pack("<fffI", *p, 0xFF336699) for p in POINTS)
        data = pcd_header("x y z rgba", "4 4 4 4", "F F F U", "1 1 1 1", 3) + body
        assert probe(data).fields == ("x", "y", "z", "rgb")

    def test_intensity_kept_any_numeric_type(self) -> None:
        body = b"".join(struct.pack("<fffH", *p, 7) for p in POINTS)
        data = pcd_header("x y z intensity", "4 4 4 2", "F F F U", "1 1 1 1", 3) + body
        assert probe(data).fields == ("x", "y", "z", "intensity")

    def test_intensity_and_rgb_listed_canonically(self) -> None:
        body = b"".join(struct.pack("<fffIf", *p, 1, 0.5) for p in POINTS)
        data = pcd_header("x y z rgb intensity", "4 4 4 4 4", "F F F U F", "1 1 1 1 1", 3) + body
        assert probe(data).fields == ("x", "y", "z", "intensity", "rgb")

    def test_multi_count_field_is_skipped_but_laid_out(self) -> None:
        body = b"".join(struct.pack("<fff4f", *p, 0, 0, 0, 0) for p in POINTS)
        data = pcd_header("x y z normal", "4 4 4 4", "F F F F", "1 1 1 4", 3) + body
        meta = probe(data)
        assert meta.fields == ("x", "y", "z")
        assert meta.bounds.maximum == (1.0, 2.0, 4.0)

    def test_multi_count_field_in_ascii(self) -> None:
        data = pcd_ascii(
            ["1 2 3 0 0 0 0", "4 5 6 0 0 0 0"],
            fields="x y z normal",
            size="4 4 4 4",
            kind="F F F F",
            count="1 1 1 4",
        )
        assert probe(data).bounds.maximum == (4.0, 5.0, 6.0)

    def test_missing_z_is_unsupported(self) -> None:
        data = pcd_binary(
            [(1.0, 2.0), (3.0, 4.0)], fields="x y", size="4 4", kind="F F", count="1 1"
        )
        with pytest.raises(UnsupportedMedia):
            probe(data)

    def test_integer_x_is_unsupported(self) -> None:
        body = struct.pack("<ifffxxxx", 1, 2.0, 3.0, 0.0)[:12]
        data = pcd_header("x y z", "4 4 4", "I F F", "1 1 1", 1) + body
        with pytest.raises(UnsupportedMedia):
            probe(data)

    def test_odd_float_size_is_unsupported(self) -> None:
        data = pcd_header("x y z", "2 4 4", "F F F", "1 1 1", 1) + b"\0" * 10
        with pytest.raises(UnsupportedMedia):
            probe(data)

    def test_unknown_data_mode_is_unsupported(self) -> None:
        with pytest.raises(UnsupportedMedia):
            probe(pcd_header(data="weird") + b"\0" * 36)

    def test_mismatched_header_lengths_are_corrupt(self) -> None:
        data = pcd_header("x y z", "4 4", "F F F", "1 1 1") + b"\0" * 36
        with pytest.raises(CorruptMedia):
            probe(data)

    def test_missing_data_line_is_corrupt(self) -> None:
        with pytest.raises(CorruptMedia):
            probe(pcd_header().replace(b"DATA binary\n", b""))


class TestNonFinitePoints:
    def test_organized_cloud_drops_nan_points(self) -> None:
        points = [(NAN, NAN, NAN), (1.0, 2.0, 3.0), (NAN, 2.0, 3.0), (5.0, 6.0, 7.0)]
        data = pcd_binary(points, width=2, height=2)
        meta = probe(data)
        assert meta.point_count == 2
        assert meta.bounds.minimum == (1.0, 2.0, 3.0)
        assert meta.bounds.maximum == (5.0, 6.0, 7.0)

    def test_infinite_coordinate_is_dropped(self) -> None:
        points = [(math.inf, 0.0, 0.0), (1.0, 1.0, 1.0)]
        assert probe(pcd_binary(points)).point_count == 1

    def test_nan_dropped_in_compressed_and_ascii(self) -> None:
        points = [(NAN, 0.0, 0.0), (1.0, 1.0, 1.0), (2.0, 2.0, 2.0)]
        assert probe(pcd_compressed(points)).point_count == 2
        assert probe(pcd_ascii(["nan 0 0", "1 1 1", "-nan 2 2"])).point_count == 1

    def test_only_nan_is_corrupt(self) -> None:
        with pytest.raises(CorruptMedia):
            probe(pcd_binary([(NAN, NAN, NAN), (NAN, 1.0, 1.0)]))

    def test_only_nan_ply_is_corrupt(self) -> None:
        data = ply_ascii_header(["float x", "float y", "float z"], 1) + "nan nan nan\n"
        with pytest.raises(CorruptMedia):
            probe(data.encode())


class TestPcdCorruption:
    def test_truncated_binary(self) -> None:
        with pytest.raises(CorruptMedia):
            probe(pcd_binary(POINTS)[:-1])

    def test_truncated_ascii(self) -> None:
        data = pcd_ascii(["1 2 3", "4 5 6"]).replace(b"POINTS 2", b"POINTS 3")
        with pytest.raises(CorruptMedia):
            probe(data)

    def test_ascii_wrong_token_count(self) -> None:
        with pytest.raises(CorruptMedia):
            probe(pcd_ascii(["1 2 3", "4 5"]))

    def test_ascii_non_numeric(self) -> None:
        with pytest.raises(CorruptMedia):
            probe(pcd_ascii(["1 2 3", "4 five 6"]))

    def test_truncated_compressed(self) -> None:
        with pytest.raises(CorruptMedia):
            probe(pcd_compressed(POINTS)[:-2])

    def test_compressed_missing_size_words(self) -> None:
        data = pcd_header(data="binary_compressed") + b"\0\0"
        with pytest.raises(CorruptMedia):
            probe(data)

    def test_lzf_declared_size_mismatch(self) -> None:
        good = pcd_compressed(POINTS)
        head = good.index(b"DATA binary_compressed\n") + 23
        compressed, uncompressed = struct.unpack("<II", good[head : head + 8])
        bad = good[:head] + struct.pack("<II", compressed, uncompressed + 4) + good[head + 8 :]
        with pytest.raises(CorruptMedia):
            probe(bad)

    def test_lzf_output_shorter_than_declared(self) -> None:
        columns = b"".join(struct.pack("<f", v) for p in POINTS for v in p)
        short = lzf_literal(columns[:-4])
        data = (
            pcd_header(data="binary_compressed")
            + struct.pack("<II", len(short), len(columns))
            + short
        )
        with pytest.raises(CorruptMedia):
            probe(data)

    def test_lzf_back_reference_before_output_start(self) -> None:
        bad_stream = bytes([0, 0x41, (1 << 5), 0x05])
        data = (
            pcd_header(points=1, data="binary_compressed")
            + struct.pack("<II", len(bad_stream), 12)
            + bad_stream
        )
        with pytest.raises(CorruptMedia, match="before the output start"):
            probe(data)

    def test_lzf_output_over_declared_size(self) -> None:
        from visionset.kernel.adapters.point_cloud_processor import _lzf_decompress

        stream = lzf_literal(b"\x01" * 12) + bytes([(7 << 5), 200, 0])
        with pytest.raises(CorruptMedia, match="exceeds"):
            _lzf_decompress(stream, 12, None)

    def test_lzf_truncated_literal_run(self) -> None:
        stream = bytes([30, 1, 2, 3])
        data = (
            pcd_header(points=1, data="binary_compressed")
            + struct.pack("<II", len(stream), 12)
            + stream
        )
        with pytest.raises(CorruptMedia):
            probe(data)

    def test_lzf_stream_ends_inside_back_reference(self) -> None:
        stream = lzf_literal(b"abcd") + bytes([(7 << 5)])
        data = (
            pcd_header(points=1, data="binary_compressed")
            + struct.pack("<II", len(stream), 12)
            + stream
        )
        with pytest.raises(CorruptMedia):
            probe(data)

    def test_lzf_overlapping_reference_repeats_pattern(self) -> None:
        stream = bytes([0, 7, (5 << 5), 0])
        assert adapter._lzf_decompress(stream, 8, None) == bytes([7] * 8)

    def test_declared_uncompressed_size_over_limit(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(port, "MAX_POINT_CLOUD_BYTES", 16)
        data = (
            pcd_header(points=1, data="binary_compressed") + struct.pack("<II", 4, 17) + b"\0" * 4
        )
        with pytest.raises(CorruptMedia):
            probe(data)


class TestLimits:
    def test_declared_points_over_limit(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(port, "MAX_POINT_CLOUD_POINTS", 2)
        with pytest.raises(UnsupportedMedia):
            probe(pcd_binary(POINTS))

    def test_limit_checked_before_decoding(self) -> None:
        data = pcd_header(points=port.MAX_POINT_CLOUD_POINTS + 1)
        with pytest.raises(UnsupportedMedia):
            probe(data)

    def test_ply_vertex_count_over_limit(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(port, "MAX_POINT_CLOUD_POINTS", 1)
        data = ply_ascii_header(["float x", "float y", "float z"], 2) + "0 0 0\n1 1 1\n"
        with pytest.raises(UnsupportedMedia):
            probe(data.encode())

    def test_binary_byte_limit(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(port, "MAX_POINT_CLOUD_BYTES", 12)
        with pytest.raises(UnsupportedMedia):
            probe(pcd_binary(POINTS))


class TestSniffing:
    @pytest.mark.parametrize(
        "data",
        [
            b"\x89PNG\r\n\x1a\n" + b"\0" * 64,
            b"just some text\nwith lines\n",
            b"",
            b"\0" * 200_000,
            b"# only a comment\n",
            b"plyx\nformat ascii 1.0\n",
        ],
    )
    def test_not_a_point_cloud(self, data: bytes) -> None:
        with pytest.raises(UnsupportedMedia):
            probe(data)

    def test_unterminated_header_is_corrupt(self) -> None:
        with pytest.raises(CorruptMedia):
            probe(b"VERSION 0.7\nFIELDS x y z\n")

    def test_runaway_header_is_bounded(self) -> None:
        data = b"VERSION 0.7\n" + b"#" * 200_000 + b"\n"
        with pytest.raises(CorruptMedia):
            probe(data)

    def test_bytes_decide_not_the_suffix(self, tmp_path: Path) -> None:
        pcd = tmp_path / "scan.ply"
        pcd.write_bytes(pcd_binary(POINTS))
        ply = tmp_path / "scan.pcd"
        ply.write_bytes(
            (ply_ascii_header(["float x", "float y", "float z"], 1) + "1 2 3\n").encode()
        )
        with pcd.open("rb") as handle:
            assert processor().probe(handle).format is PointCloudFormat.PCD
        with ply.open("rb") as handle:
            assert processor().probe(handle).format is PointCloudFormat.PLY

    def test_not_a_point_cloud_even_with_pcd_suffix(self, tmp_path: Path) -> None:
        path = tmp_path / "fake.pcd"
        path.write_bytes(b"\x89PNG\r\n\x1a\n")
        with path.open("rb") as handle, pytest.raises(UnsupportedMedia):
            processor().probe(handle)

    def test_error_names_the_stream_without_repeating_it(self) -> None:
        with pytest.raises(UnsupportedMedia) as caught:
            probe(b"nope\n", name="scan.pcd")
        assert caught.value.name == "scan.pcd"
        assert "scan.pcd" not in caught.value.reason


class TestStream:
    def test_probe_reads_from_the_start_and_leaves_stream_open(self) -> None:
        stream = io.BytesIO(pcd_binary(POINTS))
        stream.read()
        assert processor().probe(stream).point_count == 3
        assert not stream.closed

    def test_thumbnail_reads_from_the_start_and_leaves_stream_open(self) -> None:
        stream = io.BytesIO(pcd_binary(POINTS))
        stream.read()
        assert processor().thumbnail(stream, frame=ScanFrame.LIDAR_FLU, max_edge=16)
        assert not stream.closed

    def test_probe_twice_on_one_stream(self) -> None:
        stream = io.BytesIO(pcd_binary(POINTS))
        processor().probe(stream)
        assert processor().probe(stream).point_count == 3

    def test_failure_leaves_stream_open(self) -> None:
        stream = io.BytesIO(b"nope")
        with pytest.raises(UnsupportedMedia):
            processor().probe(stream)
        assert not stream.closed


class TestPly:
    def test_ascii_with_faces_after_vertices(self) -> None:
        text = (
            "ply\nformat ascii 1.0\ncomment made by hand\nelement vertex 3\n"
            "property float x\nproperty float y\nproperty float z\n"
            "property float confidence\nproperty float intensity\n"
            "element face 1\nproperty list uchar int vertex_indices\nend_header\n"
            "1 2 3 0.5 9\n-1 0.5 4 0.5 9\n0 -2 -1 0.5 9\n3 0 1 2\n"
        )
        meta = probe(text.encode())
        assert meta.format is PointCloudFormat.PLY
        assert meta.point_count == 3
        assert meta.fields == ("x", "y", "z", "intensity")
        assert meta.bounds.minimum == (-1.0, -2.0, -1.0)

    def test_ascii_crlf_header(self) -> None:
        text = ply_ascii_header(["float x", "float y", "float z"], 1) + "1 2 3\n"
        assert probe(text.replace("\n", "\r\n").encode()).point_count == 1

    def test_ascii_colors_and_extra_properties(self) -> None:
        props = [
            "double x",
            "double y",
            "double z",
            "float nx",
            "uchar red",
            "uchar green",
            "uchar blue",
            "uchar alpha",
        ]
        text = ply_ascii_header(props, 2) + "1 2 3 0 255 0 0 255\n4 5 6 1 0 255 0 255\n"
        meta = probe(text.encode())
        assert meta.fields == ("x", "y", "z", "rgb")
        assert meta.bounds.maximum == (4.0, 5.0, 6.0)

    def test_red_without_green_and_blue_is_not_rgb(self) -> None:
        text = ply_ascii_header(["float x", "float y", "float z", "uchar red"], 1) + "1 2 3 4\n"
        assert probe(text.encode()).fields == ("x", "y", "z")

    def test_ascii_element_before_vertex_is_skipped(self) -> None:
        text = (
            "ply\nformat ascii 1.0\nelement camera 2\nproperty float f\n"
            "element vertex 1\nproperty float x\nproperty float y\nproperty float z\n"
            "end_header\n0.5\n0.6\n1 2 3\n"
        )
        assert probe(text.encode()).bounds.maximum == (1.0, 2.0, 3.0)

    def test_binary_little_endian_with_list_element_before_vertex(self) -> None:
        header = (
            b"ply\nformat binary_little_endian 1.0\n"
            b"element strips 2\nproperty list uchar int vertex_indices\nproperty float w\n"
            b"element vertex 3\nproperty uchar tag\nproperty float x\nproperty float y\n"
            b"property float z\nproperty float confidence\n"
            b"element face 1\nproperty list uchar int vertex_indices\nend_header\n"
        )
        strips = struct.pack("<B3if", 3, 1, 2, 3, 0.5) + struct.pack("<Bf", 0, 0.25)
        vertices = b"".join(struct.pack("<Bffff", 7, *p, 0.9) for p in POINTS)
        faces = struct.pack("<B3i", 3, 0, 1, 2)
        meta = probe(header + strips + vertices + faces)
        assert meta.format is PointCloudFormat.PLY
        assert meta.point_count == 3
        assert meta.bounds.minimum == (-1.0, -2.0, -1.0)
        assert meta.bounds.maximum == (1.0, 2.0, 4.0)

    def test_binary_fixed_element_before_vertex(self) -> None:
        header = (
            b"ply\nformat binary_little_endian 1.0\nelement pad 2\nproperty int a\n"
            b"element vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n"
        )
        data = header + struct.pack("<2i", 1, 2) + struct.pack("<3f", 1, 2, 3)
        assert probe(data).bounds.maximum == (1.0, 2.0, 3.0)

    def test_binary_big_endian(self) -> None:
        header = (
            b"ply\nformat binary_big_endian 1.0\nelement vertex 2\nproperty float x\n"
            b"property float y\nproperty float z\nend_header\n"
        )
        data = header + struct.pack(">6f", 1, 2, 3, 4, 5, 6)
        assert probe(data).bounds.maximum == (4.0, 5.0, 6.0)

    def test_binary_coordinates_out_of_file_order(self) -> None:
        header = (
            b"ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float z\n"
            b"property float x\nproperty float y\nend_header\n"
        )
        data = header + struct.pack("<3f", 3, 1, 2)
        assert probe(data).bounds.maximum == (1.0, 2.0, 3.0)

    def test_binary_truncated_vertices(self) -> None:
        header = (
            b"ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\n"
            b"property float y\nproperty float z\nend_header\n"
        )
        with pytest.raises(CorruptMedia):
            probe(header + struct.pack("<5f", 1, 2, 3, 4, 5))

    def test_binary_truncated_before_vertex(self) -> None:
        header = (
            b"ply\nformat binary_little_endian 1.0\nelement strips 1\n"
            b"property list uchar int idx\nelement vertex 1\nproperty float x\n"
            b"property float y\nproperty float z\nend_header\n"
        )
        with pytest.raises(CorruptMedia):
            probe(header + struct.pack("<B", 3))

    def test_ascii_truncated(self) -> None:
        text = ply_ascii_header(["float x", "float y", "float z"], 3) + "1 2 3\n"
        with pytest.raises(CorruptMedia):
            probe(text.encode())

    def test_ascii_token_count_mismatch(self) -> None:
        text = ply_ascii_header(["float x", "float y", "float z"], 1) + "1 2\n"
        with pytest.raises(CorruptMedia):
            probe(text.encode())

    def test_integer_coordinates_are_unsupported(self) -> None:
        text = ply_ascii_header(["int x", "float y", "float z"], 1) + "1 2 3\n"
        with pytest.raises(UnsupportedMedia):
            probe(text.encode())

    def test_missing_z_is_unsupported(self) -> None:
        text = ply_ascii_header(["float x", "float y"], 1) + "1 2\n"
        with pytest.raises(UnsupportedMedia):
            probe(text.encode())

    def test_no_vertex_element_is_unsupported(self) -> None:
        text = "ply\nformat ascii 1.0\nelement face 0\nproperty list uchar int i\nend_header\n"
        with pytest.raises(UnsupportedMedia):
            probe(text.encode())

    def test_unknown_format_is_unsupported(self) -> None:
        text = "ply\nformat weird 1.0\nelement vertex 1\nproperty float x\nend_header\n"
        with pytest.raises(UnsupportedMedia):
            probe(text.encode())

    def test_header_without_end_is_corrupt(self) -> None:
        with pytest.raises(CorruptMedia):
            probe(b"ply\nformat ascii 1.0\nelement vertex 1\n")


class TestThumbnail:
    def _thumb(
        self,
        points: list[tuple[float, float, float]],
        frame: ScanFrame,
        max_edge: int = 32,
    ) -> Image.Image:
        jpeg = processor().thumbnail(io.BytesIO(pcd_binary(points)), frame=frame, max_edge=max_edge)
        return decode(jpeg)

    def test_deterministic(self) -> None:
        first = processor().thumbnail(io.BytesIO(pcd_binary(POINTS)), frame=ScanFrame.LIDAR_FLU)
        second = processor().thumbnail(io.BytesIO(pcd_binary(POINTS)), frame=ScanFrame.LIDAR_FLU)
        assert first == second

    def test_longest_edge_is_max_edge(self) -> None:
        points = [(0.0, 0.0, 0.0), (10.0, 4.0, 1.0)]
        image = self._thumb(points, ScanFrame.LIDAR_FLU, 64)
        assert image.size == (round(4 / 10 * 63) + 1, 64)
        wide = self._thumb([(0.0, 0.0, 0.0), (2.0, 20.0, 1.0)], ScanFrame.LIDAR_FLU, 64)
        assert max(wide.size) == 64
        assert wide.size[1] < 64

    def test_a_span_past_a_double_is_refused_as_media(self) -> None:
        points = [(-1e308, 0.0, 0.0), (1e308, 0.0, 0.0)]
        body = b"".join(struct.pack("<3d", *p) for p in points)
        data = pcd_header(size="8 8 8", points=2) + body
        assert probe(data).point_count == 2
        with pytest.raises(UnsupportedMedia, match="span"):
            processor().thumbnail(io.BytesIO(data), frame=ScanFrame.LIDAR_FLU)

    def test_is_a_jpeg(self) -> None:
        jpeg = processor().thumbnail(io.BytesIO(pcd_binary(POINTS)), frame=ScanFrame.LIDAR_FLU)
        assert jpeg[:2] == b"\xff\xd8"

    def test_lidar_forward_point_lands_in_top_half(self) -> None:
        points = [(0.0, 0.0, 0.0), (10.0, 0.0, 5.0), (-10.0, 0.0, 0.0)]
        image = self._thumb(points, ScanFrame.LIDAR_FLU).convert("L")
        width, height = image.size
        top = max(image.getpixel((x, y)) for x in range(width) for y in range(height // 2))  # type: ignore[type-var]
        assert image.getpixel((width // 2, 0)) > 128  # type: ignore[operator]
        assert top > 200

    def test_lidar_left_point_lands_in_left_half(self) -> None:
        points = [(0.0, 10.0, 5.0), (0.0, -10.0, 0.0)]
        image = self._thumb(points, ScanFrame.LIDAR_FLU).convert("L")
        width, height = image.size
        assert image.getpixel((0, height // 2)) > 200  # type: ignore[operator]
        assert image.getpixel((width - 1, height // 2)) < 150  # type: ignore[operator]

    def test_camera_forward_is_z_and_left_is_minus_x(self) -> None:
        points = [(0.0, 0.0, 0.0), (0.0, 0.0, 10.0), (-10.0, 0.0, 0.0)]
        image = self._thumb(points, ScanFrame.CAMERA_RDF).convert("L")
        assert image.size == (32, 32)
        assert image.getpixel((31, 0)) > 200  # type: ignore[operator]
        assert image.getpixel((0, 31)) > 200  # type: ignore[operator]
        assert image.getpixel((31, 31)) > 200  # type: ignore[operator]
        assert image.getpixel((0, 0)) < 40  # type: ignore[operator]

    def test_rfu_forward_is_y_and_left_is_minus_x(self) -> None:
        points = [(0.0, 0.0, 0.0), (0.0, 10.0, 0.0), (-10.0, 0.0, 0.0)]
        image = self._thumb(points, ScanFrame.LIDAR_RFU).convert("L")
        assert image.size == (32, 32)
        assert image.getpixel((31, 0)) > 200  # type: ignore[operator]
        assert image.getpixel((0, 31)) > 200  # type: ignore[operator]
        assert image.getpixel((31, 31)) > 200  # type: ignore[operator]
        assert image.getpixel((0, 0)) < 40  # type: ignore[operator]

    def test_camera_up_is_minus_y(self) -> None:
        points = [(0.0, -10.0, 0.0), (10.0, 10.0, 0.0)]
        image = self._thumb(points, ScanFrame.CAMERA_RDF, 16).convert("L")
        brightest = image.getextrema()[1]
        assert brightest >= 250

    def test_degenerate_single_point(self) -> None:
        image = decode(
            processor().thumbnail(
                io.BytesIO(pcd_binary([(1.0, 1.0, 1.0)])), frame=ScanFrame.LIDAR_FLU, max_edge=64
            )
        )
        assert image.size == (1, 1)

    def test_flat_line_has_one_pixel_minor_edge(self) -> None:
        points = [(0.0, 0.0, 0.0), (5.0, 0.0, 0.0)]
        assert self._thumb(points, ScanFrame.LIDAR_FLU, 40).size == (1, 40)

    def test_flat_cloud_is_drawn_bright(self) -> None:
        points = [(0.0, 0.0, 2.0), (5.0, 5.0, 2.0)]
        image = self._thumb(points, ScanFrame.LIDAR_FLU, 16).convert("L")
        assert image.getextrema()[1] > 230

    def test_max_edge_one(self) -> None:
        assert self._thumb(POINTS, ScanFrame.LIDAR_FLU, 1).size == (1, 1)

    def test_rejects_non_positive_max_edge(self) -> None:
        with pytest.raises(ValueError):
            processor().thumbnail(
                io.BytesIO(pcd_binary(POINTS)), frame=ScanFrame.LIDAR_FLU, max_edge=0
            )

    def test_highest_point_in_a_pixel_wins(self) -> None:
        points = [(0.0, 0.0, 0.0), (0.0, 0.0, 10.0), (5.0, 5.0, 0.0), (5.0, 5.0, 0.0)]
        image = self._thumb(points, ScanFrame.LIDAR_FLU, 2).convert("L")
        assert image.size == (2, 2)
        assert image.getpixel((1, 1)) > 230

    def test_unsupported_bytes_are_refused(self) -> None:
        with pytest.raises(UnsupportedMedia):
            processor().thumbnail(io.BytesIO(b"nope"), frame=ScanFrame.LIDAR_FLU)

    def test_ply_thumbnail(self) -> None:
        text = ply_ascii_header(["float x", "float y", "float z"], 2) + "0 0 0\n4 2 1\n"
        image = decode(
            processor().thumbnail(io.BytesIO(text.encode()), frame=ScanFrame.LIDAR_FLU, max_edge=20)
        )
        assert max(image.size) == 20


PLY_BINARY_XYZ = (
    "element vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n"
)


class TestHostileHeaders:
    """Every fault a header can provoke is one refused file, never a crash."""

    @pytest.mark.parametrize(
        ("change", "fragment"),
        [
            (
                {"fields": "x y z _", "size": "4 4 4 -8", "kind": "F F F U", "count": "1 1 1 1"},
                "SIZE below 1",
            ),
            (
                {"fields": "_ x y z", "size": "0 4 4 4", "kind": "U F F F", "count": "1 1 1 1"},
                "SIZE below 1",
            ),
            (
                {"fields": "x y z _", "size": "4 4 4 4", "kind": "F F F U", "count": "1 1 1 -2"},
                "negative COUNT",
            ),
        ],
        ids=["negative-padding", "zero-size", "negative-count"],
    )
    def test_a_size_or_count_out_of_range_is_corrupt(
        self, change: dict[str, str], fragment: str
    ) -> None:
        with pytest.raises(CorruptMedia, match=fragment):
            probe(pcd_header(points=5, **change) + b"\0" * 200)

    def test_a_width_below_one_is_corrupt(self) -> None:
        with pytest.raises(CorruptMedia, match="WIDTH or HEIGHT below 1"):
            probe(pcd_header(points=9, width=-3, height=-3, data="ascii") + b"1 2 3\n" * 9)

    def test_points_disagreeing_with_width_times_height_is_corrupt(self) -> None:
        with pytest.raises(CorruptMedia, match="not WIDTH times HEIGHT"):
            probe(pcd_header(points=1, width=100, data="ascii") + b"1 2 3\n")

    def test_an_ascii_row_past_the_line_limit_is_corrupt(self) -> None:
        with pytest.raises(CorruptMedia, match="longer than"):
            probe(pcd_header(points=1, data="ascii") + b"1" * (70 * 1024) + b" 2 3\n")

    def test_compressed_data_larger_than_lzf_can_make_is_corrupt(self) -> None:
        data = pcd_header(points=1, data="binary_compressed") + struct.pack("<II", 100, 12)
        with pytest.raises(CorruptMedia, match="larger than LZF"):
            probe(data + b"\0" * 100)

    def test_a_negative_ply_list_length_is_corrupt(self) -> None:
        data = (
            b"ply\nformat binary_little_endian 1.0\nelement face 1\n"
            b"property list char int idx\n" + PLY_BINARY_XYZ.encode() + b"\xff" + b"\0" * 12
        )
        with pytest.raises(CorruptMedia, match="negative length"):
            probe(data)

    @pytest.mark.parametrize("mode", ["ascii", "binary_little_endian"])
    def test_an_implausible_element_before_the_vertices_is_corrupt(self, mode: str) -> None:
        data = (
            f"ply\nformat {mode} 1.0\nelement junk 99999999999999999999\nproperty float a\n"
            + PLY_BINARY_XYZ
        ).encode() + b"\0" * 12
        with pytest.raises(CorruptMedia, match="implausible count"):
            probe(data)

    def test_a_property_named_twice_is_corrupt(self) -> None:
        data = ply_ascii_header(["float x", "float x", "float y", "float z"], 1) + "1 2 3 4\n"
        with pytest.raises(CorruptMedia, match="names a property twice"):
            probe(data.encode())

    def test_a_struct_fault_is_reported_as_corrupt(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import visionset.kernel.adapters.point_cloud_processor as adapter

        def broken(*_: object, **__: object) -> None:
            raise struct.error("boom")

        monkeypatch.setattr(adapter, "_unpack_rows", broken)
        with pytest.raises(CorruptMedia, match="will not decode"):
            probe(pcd_binary(POINTS))


class TestRead:
    def test_one_decode_answers_both(self) -> None:
        reading = processor().read(io.BytesIO(pcd_binary(POINTS)), frame=ScanFrame.LIDAR_FLU)
        assert reading.metadata == probe(pcd_binary(POINTS))
        assert reading.thumbnail == processor().thumbnail(
            io.BytesIO(pcd_binary(POINTS)), frame=ScanFrame.LIDAR_FLU
        )

    def test_a_preview_that_alone_fails_is_none(self) -> None:
        body = b"".join(struct.pack("<3d", *p) for p in [(-1e308, 0, 0), (1e308, 0, 0)])
        data = pcd_header(size="8 8 8", points=2) + body
        reading = processor().read(io.BytesIO(data), frame=ScanFrame.LIDAR_FLU)
        assert (reading.metadata.point_count, reading.thumbnail) == (2, None)

    def test_a_refused_scan_raises(self) -> None:
        with pytest.raises(UnsupportedMedia):
            processor().read(io.BytesIO(b"nope"), frame=ScanFrame.LIDAR_FLU)

    def test_a_spread_too_small_to_divide_by_is_drawn_as_one_spot(self) -> None:
        data = pcd_ascii(["0 0 0", "1e-310 0 0"], size="8 8 8")
        image = decode(processor().thumbnail(io.BytesIO(data), frame=ScanFrame.LIDAR_FLU))
        assert image.size == (1, 1)


@pytest.mark.parametrize("row", ["1 2", "1 2 3 4"], ids=["short", "long"])
def test_an_ascii_row_with_the_wrong_column_count_is_named(row: str) -> None:
    with pytest.raises(CorruptMedia, match="values, not 3"):
        probe(pcd_ascii([row]))
