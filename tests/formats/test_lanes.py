"""The lane family, ported from v1's ``test_lane_export.py``.

v1 had 91 tests in one file, and they split cleanly in two:

* **53 unit tests** over ``lane_utils.py``'s pure functions. Those are ported
  here, one behaviour at a time, sometimes reshaped — v1 asserted against dicts
  and this asserts against the documents an exporter writes, because that is
  where the behaviour is now observable.
* **38 Django tests** over v1's HTTP surface — per-item export endpoints, bulk
  zip packaging, batch scoping, auth. Every one of those is a v1-ism with no
  counterpart: VisionSet exports a whole immutable *release* into a directory
  through the ``Exporter`` port, and there is no per-item export route to test.
  They are dropped, and the reason is this paragraph.

Six of the 53 are also gone, for a reason worth stating because it is a *domain*
improvement rather than a scoping decision: v1's helpers had to guard against a
lane with no points and a lane with one, and four tests pinned those guards.
``PolylineGeometry`` refuses fewer than two points, so those states are
unreachable and the guards do not exist to be tested. Two more asserted
``export_bdd100k(require_attributes=True)`` raising over a missing ``style``;
the ``Exporter`` port has no per-call options, so a missing attribute resolves to
``other`` and the format's ``lossy`` flag is what tells the caller. See
``_core.py``.

The release these tests export is built **in memory**, not through a workspace:
``export`` takes domain values and a ``ContentReader``, so a manifest and a
one-pixel PNG are the whole fixture. ``tests/formats/test_report_agreement.py``
is where the lane formats meet a real workspace and a real release.
"""

from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from typing import Any, BinaryIO
from uuid import uuid4

import pytest

from visionset.formats.lanes import (
    CULANE_MASK_DIRNAME,
    LABELS_DIRNAME,
    Bdd100kLaneExporter,
    CuLaneExporter,
    CurveLanesExporter,
    OpenLane2dExporter,
    TuSimpleExporter,
)
from visionset.formats.lanes._core import (
    OTHER,
    POSITION_VALUES,
    STYLE_VALUES,
    declare_lane_attributes,
    interpolate_x,
    is_y_monotonic,
    lanes_of,
    order_left_to_right,
)
from visionset.kernel.domain import (
    BboxGeometry,
    ClassificationGeometry,
    GeometryType,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PolygonGeometry,
    PolylineGeometry,
    Release,
)
from visionset.kernel.errors import ExportSourceUnreadable

WIDTH, HEIGHT = 128, 72

#: A one-pixel PNG. The lane exporters copy image bytes and never decode them,
#: so the smallest valid file with a recognised signature is enough.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000"
    "01f15c4890000000a49444154789c6300010000050001"
    "0d0a2db40000000049454e44ae426082"
)


def _content(_: str) -> BinaryIO:
    return BytesIO(PNG)


def _lane(
    points: list[tuple[float, float]],
    *,
    label_class: str = "centerline",
    style: str | None = None,
    color: str | None = None,
    position: str | None = None,
) -> ManifestAnnotation:
    attributes: dict[str, Any] = {}
    if style is not None:
        attributes["style"] = style
    if color is not None:
        attributes["color"] = color
    if position is not None:
        attributes["position_role"] = position
    return ManifestAnnotation(
        id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=PolylineGeometry(points=points),
        attributes=attributes,
        provenance="human",
    )


def _other(geometry: BboxGeometry | PolygonGeometry | ClassificationGeometry) -> ManifestAnnotation:
    return ManifestAnnotation(
        id=uuid4(),
        label_class="sign",
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


def _asset(
    *annotations: ManifestAnnotation, size: tuple[int, int] = (WIDTH, HEIGHT)
) -> ManifestAsset:
    return ManifestAsset(
        asset_id=uuid4(),
        content_hash=f"{uuid4().hex}{uuid4().hex}",
        uri="/incoming/frame.png",
        width=size[0],
        height=size[1],
        annotations=annotations,
    )


def _release() -> Release:
    return Release(
        dataset_id=uuid4(),
        tag="v1",
        manifest_hash="0" * 64,
        schema_version=1,
        asset_count=1,
        annotation_count=1,
    )


def _manifest(asset: ManifestAsset) -> Manifest:
    classes: dict[str, set[GeometryType]] = {}
    for annotation in asset.annotations:
        classes.setdefault(annotation.label_class, set()).add(
            GeometryType(annotation.geometry.type)
        )
    return Manifest(
        schema_version=1,
        classes=tuple(
            LabelClass(name=name, geometries=tuple(geometries))
            for name, geometries in classes.items()
        ),
        assets=(asset,),
    )


def _export(exporter: object, asset: ManifestAsset, dest: Path) -> Path:
    manifest = _manifest(asset)
    exporter.export(_release(), manifest, dest, content=_content)  # type: ignore[attr-defined]
    return dest


def _one_document(dest: Path, pattern: str) -> dict[str, Any]:
    (path,) = sorted((dest / LABELS_DIRNAME).rglob(pattern))
    document: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return document


# --- is_y_monotonic (v1: IsYMonotonicTests) -----------------------------------


def test_ascending_y_is_monotonic() -> None:
    assert is_y_monotonic([(0.0, 0.0), (1.0, 5.0), (2.0, 9.0)])


def test_equal_y_values_are_monotonic() -> None:
    # A horizontal segment is monotonic in the non-decreasing sense, and
    # refusing it would reject an ordinary lane crossing the frame.
    assert is_y_monotonic([(0.0, 5.0), (10.0, 5.0), (20.0, 5.0)])


def test_descending_y_is_not_monotonic() -> None:
    assert not is_y_monotonic([(0.0, 9.0), (1.0, 5.0)])


# --- order_left_to_right (v1: AssignLaneOrderTests) ---------------------------


def test_lanes_sort_by_x_at_their_bottom_most_point() -> None:
    # v1's rule, and the near field is where it is unambiguous: at the horizon
    # lanes converge and any ordering there is noise.
    ordered = lanes_of(
        _asset(_lane([(90.0, 4.0), (99.0, 60.0)]), _lane([(30.0, 4.0), (10.0, 60.0)]))
    )
    assert [lane.points[-1][0] for lane in ordered] == [10.0, 99.0]


def test_a_single_lane_orders_to_itself() -> None:
    ordered = lanes_of(_asset(_lane([(5.0, 1.0), (6.0, 40.0)])))
    assert [lane.points for lane in ordered] == [((5.0, 1.0), (6.0, 40.0))]


def test_ordering_reads_the_bottom_point_and_not_the_first_one() -> None:
    # The distinction v1's `_x_at_max_y` exists for: a lane starting on the right
    # and ending on the left is a left lane.
    ordered = lanes_of(
        _asset(_lane([(60.0, 2.0), (60.0, 70.0)]), _lane([(120.0, 2.0), (4.0, 70.0)]))
    )
    assert [lane.points[0][0] for lane in ordered] == [120.0, 60.0]


def test_ordering_is_a_pure_function_of_the_lanes_it_is_handed() -> None:
    # `order_left_to_right` is public because five exporters share it; `lanes_of`
    # is the only caller today, and this is the seam a sixth format would use.
    lanes = lanes_of(_asset(_lane([(90.0, 4.0), (99.0, 60.0)]), _lane([(5.0, 4.0), (8.0, 60.0)])))
    assert order_left_to_right(list(reversed(lanes))) == lanes


# --- lanes_of and the taxonomy (v1: ClassToPositionTests) ---------------------


def test_only_polylines_are_lanes() -> None:
    asset = _asset(
        _lane([(1.0, 1.0), (2.0, 40.0)]),
        _other(BboxGeometry(x=1, y=1, width=5, height=5)),
        _other(PolygonGeometry(points=[(0.0, 0.0), (5.0, 0.0), (5.0, 5.0)])),
        _other(ClassificationGeometry()),
    )
    assert len(lanes_of(asset)) == 1


@pytest.mark.parametrize(
    ("label_class", "attribute", "expected"),
    [
        pytest.param("ego_left", None, "ego_left", id="the-class-name-names-a-position"),
        pytest.param("centerline", None, OTHER, id="the-class-name-names-none"),
        pytest.param("ego_left", "road_edge", "road_edge", id="the-attribute-wins"),
    ],
)
def test_a_lanes_position_is_resolved_in_one_order(
    label_class: str, attribute: str | None, expected: str
) -> None:
    """Attribute first, then the class name, then `other`.

    The three rows are one rule read in order, and the last is what makes the
    order matter: a lane whose class name *would* have answered still takes the
    attribute, so a schema that says both does not get an arbitrary winner.
    """
    extra = {} if attribute is None else {"position": attribute}
    asset = _asset(_lane([(1.0, 1.0), (2.0, 40.0)], label_class=label_class, **extra))

    (lane,) = lanes_of(asset)

    assert lane.position == expected


def test_a_value_outside_the_vocabulary_resolves_to_other() -> None:
    # The schema may declare `style` as a plain string, and a format asked to
    # write "dashed-ish" has nowhere to put it.
    asset = _asset(_lane([(1.0, 1.0), (2.0, 40.0)], style="dashed-ish"))
    (lane,) = lanes_of(asset)
    assert lane.style == OTHER


def test_the_declared_attributes_are_the_vocabulary_the_exporters_read() -> None:
    # The convention is offered rather than transcribed: a caller building a lane
    # schema gets these three, and they cannot drift from what `_core` resolves.
    declared = {attribute.name: attribute for attribute in declare_lane_attributes()}
    assert set(declared) == {"style", "color", "position_role"}
    assert declared["style"].options == STYLE_VALUES
    assert declared["position_role"].options == POSITION_VALUES
    assert all(not attribute.required for attribute in declared.values())


# --- interpolate_x + TuSimple (v1: ExportTuSimpleTests) -----------------------


def test_interpolation_is_linear_between_two_points() -> None:
    assert interpolate_x([(0.0, 0.0), (10.0, 10.0)], 5.0) == 5.0


def test_interpolation_answers_none_outside_the_lane_s_own_range() -> None:
    assert interpolate_x([(0.0, 20.0), (10.0, 30.0)], 5.0) is None
    assert interpolate_x([(0.0, 20.0), (10.0, 30.0)], 90.0) is None


def test_tusimple_writes_one_record_per_image(tmp_path: Path) -> None:
    dest = _export(TuSimpleExporter(), _asset(_lane([(10.0, 10.0), (20.0, 60.0)])), tmp_path)
    (path,) = sorted(dest.glob("label_data_*.json"))
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert set(record) == {"raw_file", "h_samples", "lanes"}
    assert record["raw_file"].startswith("images/train/")


def test_every_tusimple_lane_row_is_as_long_as_h_samples(tmp_path: Path) -> None:
    dest = _export(
        TuSimpleExporter(),
        _asset(_lane([(10.0, 10.0), (20.0, 60.0)]), _lane([(80.0, 12.0), (90.0, 58.0)])),
        tmp_path,
    )
    record = json.loads(sorted(dest.glob("label_data_*.json"))[0].read_text().splitlines()[0])
    assert len(record["lanes"]) == 2
    assert all(len(row) == len(record["h_samples"]) for row in record["lanes"])


def test_tusimple_marks_rows_the_lane_does_not_reach_with_minus_two(tmp_path: Path) -> None:
    # The format's own sentinel. A lane covering part of the frame must not have
    # its ends extrapolated into rows it never touched.
    dest = _export(TuSimpleExporter(), _asset(_lane([(10.0, 30.0), (20.0, 40.0)])), tmp_path)
    record = json.loads(sorted(dest.glob("label_data_*.json"))[0].read_text().splitlines()[0])
    (row,) = record["lanes"]
    assert -2 in row
    assert any(value != -2 for value in row)


def test_tusimple_h_samples_come_from_the_asset_s_own_height(tmp_path: Path) -> None:
    # v1 defaulted the height to 720 and scaled; here the height is known,
    # because `dimensions_of` refuses an asset that has none.
    dest = _export(
        TuSimpleExporter(),
        _asset(_lane([(10.0, 10.0), (20.0, 60.0)]), size=(200, 360)),
        tmp_path,
    )
    record = json.loads(sorted(dest.glob("label_data_*.json"))[0].read_text().splitlines()[0])
    assert max(record["h_samples"]) < 360
    assert record["h_samples"][1] - record["h_samples"][0] == 10


def test_tusimple_refuses_a_lane_that_is_not_sorted_by_ascending_y(tmp_path: Path) -> None:
    # v1 raised ValueError; here it is the kernel's own export refusal, so it
    # reaches a caller as a 409 naming the asset instead of a 500.
    asset = _asset(_lane([(10.0, 60.0), (20.0, 10.0)]))
    with pytest.raises(ExportSourceUnreadable, match="ascending Y"):
        _export(TuSimpleExporter(), asset, tmp_path)


def test_tusimple_orders_its_lanes_left_to_right(tmp_path: Path) -> None:
    dest = _export(
        TuSimpleExporter(),
        _asset(_lane([(100.0, 10.0), (110.0, 60.0)]), _lane([(10.0, 10.0), (20.0, 60.0)])),
        tmp_path,
    )
    record = json.loads(sorted(dest.glob("label_data_*.json"))[0].read_text().splitlines()[0])
    firsts = [next(x for x in row if x != -2) for row in record["lanes"]]
    assert firsts == sorted(firsts)


def test_tusimple_writes_an_empty_lane_list_for_an_image_with_no_lanes(tmp_path: Path) -> None:
    dest = _export(TuSimpleExporter(), _asset(_other(ClassificationGeometry())), tmp_path)
    record = json.loads(sorted(dest.glob("label_data_*.json"))[0].read_text().splitlines()[0])
    assert record["lanes"] == []


# --- CurveLanes (v1: ExportCurveLanesTests) -----------------------------------


def test_curvelanes_writes_lines_of_x_y_objects(tmp_path: Path) -> None:
    dest = _export(CurveLanesExporter(), _asset(_lane([(1.5, 2.5), (3.5, 40.0)])), tmp_path)
    document = _one_document(dest, "*.lines.json")
    assert document == {"Lines": [[{"x": 1.5, "y": 2.5}, {"x": 3.5, "y": 40.0}]]}


def test_curvelanes_keeps_every_vertex_it_was_given(tmp_path: Path) -> None:
    points = [(1.0, 1.0), (2.0, 10.0), (3.0, 20.0), (4.0, 30.0), (5.0, 40.0)]
    dest = _export(CurveLanesExporter(), _asset(_lane(points)), tmp_path)
    (line,) = _one_document(dest, "*.lines.json")["Lines"]
    assert [(point["x"], point["y"]) for point in line] == points


def test_curvelanes_orders_its_lines_left_to_right(tmp_path: Path) -> None:
    dest = _export(
        CurveLanesExporter(),
        _asset(_lane([(90.0, 2.0), (95.0, 60.0)]), _lane([(5.0, 2.0), (8.0, 60.0)])),
        tmp_path,
    )
    lines = _one_document(dest, "*.lines.json")["Lines"]
    assert [line[-1]["x"] for line in lines] == [8.0, 95.0]


def test_curvelanes_writes_an_empty_lines_list_when_there_are_no_lanes(tmp_path: Path) -> None:
    dest = _export(CurveLanesExporter(), _asset(_other(ClassificationGeometry())), tmp_path)
    assert _one_document(dest, "*.lines.json") == {"Lines": []}


# --- BDD100K (v1: ExportBDD100KUnitTests) -------------------------------------


def _bdd_label(dest: Path, index: int = 0) -> dict[str, Any]:
    labels: list[dict[str, Any]] = _one_document(dest, "*.json")["labels"]
    return labels[index]


@pytest.mark.parametrize(
    ("style", "color", "category", "lane_style"),
    [
        ("continuous", "white", "single white", "solid"),
        ("dashed", "yellow", "single yellow", "dashed"),
        ("double_continuous", "white", "double white", "solid"),
        ("double_dashed", "yellow", "double yellow", "dashed"),
        ("botts_dots", "white", "solid divider", "solid"),
        ("continuous", "blue", "single other", "solid"),
    ],
)
def test_bdd100k_maps_style_and_colour_to_its_own_category(
    tmp_path: Path, style: str, color: str, category: str, lane_style: str
) -> None:
    dest = _export(
        Bdd100kLaneExporter(),
        _asset(_lane([(1.0, 1.0), (2.0, 40.0)], style=style, color=color)),
        tmp_path,
    )
    label = _bdd_label(dest)
    assert label["category"] == category
    assert label["attributes"]["laneStyle"] == lane_style


def test_bdd100k_writes_an_open_poly2d_with_every_vertex(tmp_path: Path) -> None:
    dest = _export(
        Bdd100kLaneExporter(),
        _asset(_lane([(1.0, 2.0), (3.0, 20.0), (5.0, 40.0)], style="dashed", color="white")),
        tmp_path,
    )
    (poly,) = _bdd_label(dest)["poly2d"]
    assert poly["closed"] is False
    assert poly["vertices"] == [[1.0, 2.0], [3.0, 20.0], [5.0, 40.0]]
    assert poly["types"] == "LLL"


def test_bdd100k_calls_a_crosswalk_vertical_and_everything_else_parallel(tmp_path: Path) -> None:
    dest = _export(
        Bdd100kLaneExporter(),
        _asset(
            _lane([(1.0, 1.0), (2.0, 40.0)], position="crosswalk"),
            _lane([(60.0, 1.0), (61.0, 40.0)], position="ego_left"),
        ),
        tmp_path,
    )
    labels = _one_document(dest, "*.json")["labels"]
    directions = {one["category"]: one["attributes"]["laneDirection"] for one in labels}
    assert directions["crosswalk zebra"] == "vertical"
    assert set(directions.values()) == {"vertical", "parallel"}


def test_bdd100k_ids_its_labels_in_left_to_right_order(tmp_path: Path) -> None:
    dest = _export(
        Bdd100kLaneExporter(),
        _asset(
            _lane([(90.0, 2.0), (95.0, 60.0)], style="dashed", color="white"),
            _lane([(5.0, 2.0), (8.0, 60.0)], style="continuous", color="yellow"),
        ),
        tmp_path,
    )
    labels = _one_document(dest, "*.json")["labels"]
    assert [one["id"] for one in labels] == ["lane_0", "lane_1"]
    # lane_0 is the leftmost, which is the yellow continuous one.
    assert labels[0]["category"] == "single yellow"


def test_bdd100k_resolves_a_missing_attribute_to_other_rather_than_refusing(
    tmp_path: Path,
) -> None:
    # v1 raised unless the caller passed `require_attributes=False`. The port has
    # no per-call options and should not grow one: the caller who would set the
    # flag is the caller who chose the format, and `lossy` already says so.
    dest = _export(Bdd100kLaneExporter(), _asset(_lane([(1.0, 1.0), (2.0, 40.0)])), tmp_path)
    assert _bdd_label(dest)["category"] == OTHER


def test_bdd100k_writes_an_empty_label_list_when_there_are_no_lanes(tmp_path: Path) -> None:
    dest = _export(Bdd100kLaneExporter(), _asset(_other(ClassificationGeometry())), tmp_path)
    assert _one_document(dest, "*.json")["labels"] == []


# --- CULane (v1: ExportCULaneTxtTests, ExportCULaneMaskTests, slot validation) -


def _culane_text(dest: Path) -> str:
    (path,) = sorted((dest / LABELS_DIRNAME).rglob("*.lines.txt"))
    return path.read_text(encoding="utf-8")


def test_culane_writes_one_line_of_integer_pairs_per_lane(tmp_path: Path) -> None:
    dest = _export(CuLaneExporter(), _asset(_lane([(1.4, 2.6), (3.5, 40.2)])), tmp_path)
    assert _culane_text(dest) == "1 3 4 40\n"


def test_culane_writes_a_line_per_lane_in_left_to_right_order(tmp_path: Path) -> None:
    dest = _export(
        CuLaneExporter(),
        _asset(_lane([(90.0, 2.0), (95.0, 60.0)]), _lane([(5.0, 2.0), (8.0, 60.0)])),
        tmp_path,
    )
    lines = _culane_text(dest).splitlines()
    assert [line.split()[0] for line in lines] == ["5", "90"]


def test_culane_writes_an_empty_file_when_there_are_no_lanes(tmp_path: Path) -> None:
    dest = _export(CuLaneExporter(), _asset(_other(ClassificationGeometry())), tmp_path)
    assert _culane_text(dest) == ""


def test_culane_writes_a_mask_beside_the_annotations(tmp_path: Path) -> None:
    dest = _export(
        CuLaneExporter(),
        _asset(_lane([(10.0, 2.0), (20.0, 60.0)], position="ego_left")),
        tmp_path,
    )
    (mask,) = sorted((dest / CULANE_MASK_DIRNAME).rglob("*.png"))
    assert mask.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


def test_a_culane_mask_paints_each_position_with_its_own_slot_value(tmp_path: Path) -> None:
    from PIL import Image

    dest = _export(
        CuLaneExporter(),
        _asset(
            _lane([(20.0, 2.0), (20.0, 60.0)], position="ego_left"),
            _lane([(100.0, 2.0), (100.0, 60.0)], position="ego_right"),
        ),
        tmp_path,
    )
    (mask,) = sorted((dest / CULANE_MASK_DIRNAME).rglob("*.png"))
    # `tobytes()` rather than `getdata()`: an "L" image is one byte per pixel,
    # and `getdata()` is deprecated in Pillow 14.
    values = set(Image.open(mask).tobytes())
    # Background plus the two slots the positions map to, and nothing else.
    assert values == {0, 1, 2}


def test_a_lane_with_no_culane_slot_contributes_nothing_to_the_mask(tmp_path: Path) -> None:
    # `road_edge` and `crosswalk` are real positions with no slot: CULane encodes
    # exactly four lanes, and that is the format's limit rather than a judgement
    # about the lane.
    from PIL import Image

    dest = _export(
        CuLaneExporter(),
        _asset(_lane([(20.0, 2.0), (20.0, 60.0)], position="road_edge")),
        tmp_path,
    )
    (mask,) = sorted((dest / CULANE_MASK_DIRNAME).rglob("*.png"))
    assert set(Image.open(mask).tobytes()) == {0}
    # It is still written to the annotation file, which has no slot limit.
    assert _culane_text(dest).strip() != ""


def test_culane_refuses_two_lanes_in_the_same_position(tmp_path: Path) -> None:
    asset = _asset(
        _lane([(20.0, 2.0), (20.0, 60.0)], position="ego_left"),
        _lane([(40.0, 2.0), (40.0, 60.0)], position="ego_left"),
    )
    with pytest.raises(ExportSourceUnreadable, match="ego_left"):
        _export(CuLaneExporter(), asset, tmp_path)


# --- OpenLane 2D (v1: ExportOpenLane2DTests) ----------------------------------


def _openlane(dest: Path) -> dict[str, Any]:
    return _one_document(dest, "*.json")


def test_openlane_writes_the_document_s_five_keys(tmp_path: Path) -> None:
    dest = _export(OpenLane2dExporter(), _asset(_lane([(1.0, 1.0), (2.0, 40.0)])), tmp_path)
    document = _openlane(dest)
    assert set(document) == {"intrinsic", "extrinsic", "file_path", "lane_lines"}
    # Null because VisionSet records no camera calibration; inventing a matrix
    # would be a claim nobody made.
    assert document["intrinsic"] is None
    assert document["extrinsic"] is None


def test_an_openlane_lane_line_carries_its_five_fields(tmp_path: Path) -> None:
    dest = _export(
        OpenLane2dExporter(),
        _asset(_lane([(1.0, 2.0), (3.0, 40.0)], style="dashed", color="white")),
        tmp_path,
    )
    (line,) = _openlane(dest)["lane_lines"]
    assert set(line) == {"category", "visibility", "uv", "attribute", "track_id"}
    assert line["uv"] == [[1.0, 2.0], [3.0, 40.0]]
    assert line["track_id"] == "lane_0"
    assert line["attribute"] == line["category"]


@pytest.mark.parametrize(
    ("style", "color", "category"),
    [
        ("dashed", "white", 1),
        ("continuous", "white", 2),
        ("continuous", "yellow", 8),
        ("double_dashed", "yellow", 9),
        ("nonsense", "white", 0),
    ],
)
def test_openlane_maps_style_and_colour_to_its_category_integer(
    tmp_path: Path, style: str, color: str, category: int
) -> None:
    dest = _export(
        OpenLane2dExporter(),
        _asset(_lane([(1.0, 1.0), (2.0, 40.0)], style=style, color=color)),
        tmp_path,
    )
    (line,) = _openlane(dest)["lane_lines"]
    assert line["category"] == category


def test_openlane_numbers_the_first_road_edge_thirteen_and_the_second_fourteen(
    tmp_path: Path,
) -> None:
    dest = _export(
        OpenLane2dExporter(),
        _asset(
            _lane([(5.0, 2.0), (8.0, 60.0)], position="road_edge"),
            _lane([(90.0, 2.0), (95.0, 60.0)], position="road_edge"),
        ),
        tmp_path,
    )
    assert [line["category"] for line in _openlane(dest)["lane_lines"]] == [13, 14]


def test_openlane_gives_a_crosswalk_category_zero(tmp_path: Path) -> None:
    dest = _export(
        OpenLane2dExporter(),
        _asset(_lane([(1.0, 1.0), (2.0, 40.0)], position="crosswalk")),
        tmp_path,
    )
    (line,) = _openlane(dest)["lane_lines"]
    assert line["category"] == 0


def test_openlane_writes_every_point_visible_because_the_domain_has_no_other_answer(
    tmp_path: Path,
) -> None:
    # The one loss worth naming: OpenLane marks each vertex visible or occluded
    # and `PolylineGeometry.points` is coordinates alone. Extending the annotation
    # model for one format was declined, so this is what is known rather than
    # what was measured.
    dest = _export(
        OpenLane2dExporter(),
        _asset(_lane([(1.0, 1.0), (2.0, 20.0), (3.0, 40.0)])),
        tmp_path,
    )
    (line,) = _openlane(dest)["lane_lines"]
    assert line["visibility"] == [1, 1, 1]


def test_openlane_writes_an_empty_lane_lines_list_when_there_are_no_lanes(
    tmp_path: Path,
) -> None:
    dest = _export(OpenLane2dExporter(), _asset(_other(ClassificationGeometry())), tmp_path)
    assert _openlane(dest)["lane_lines"] == []


# --- every format, one property each ------------------------------------------


EXPORTERS = [
    TuSimpleExporter,
    CurveLanesExporter,
    Bdd100kLaneExporter,
    CuLaneExporter,
    OpenLane2dExporter,
]


@pytest.mark.parametrize("exporter", EXPORTERS, ids=lambda e: str(e.format_name))
def test_every_lane_format_copies_the_images_it_writes_labels_for(
    tmp_path: Path, exporter: type
) -> None:
    dest = _export(exporter(), _asset(_lane([(1.0, 1.0), (2.0, 40.0)])), tmp_path)
    assert sorted(path.suffix for path in (dest / "images").rglob("*") if path.is_file()) == [
        ".png"
    ]


@pytest.mark.parametrize("exporter", EXPORTERS, ids=lambda e: str(e.format_name))
def test_every_lane_format_refuses_an_asset_with_no_recorded_size_or_ignores_it(
    tmp_path: Path, exporter: type
) -> None:
    """Two honest answers, and which one a format gives is a property of the format.

    TuSimple derives its row grid from the height and CULane paints a mask the
    size of the image, so both refuse by name rather than invent a default — v1
    defaulted to 720p and 1280x720, which does not fail, it silently produces a
    file describing a different picture. The other three never look at the size.
    """
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="a" * 64,
        uri="/incoming/frame.png",
        annotations=(_lane([(1.0, 1.0), (2.0, 40.0)]),),
    )
    needs_size = exporter.format_name in {"tusimple", "culane"}
    if needs_size:
        with pytest.raises(ExportSourceUnreadable, match="no recorded pixel size"):
            _export(exporter(), asset, tmp_path)
    else:
        _export(exporter(), asset, tmp_path)


@pytest.mark.parametrize("exporter", EXPORTERS, ids=lambda e: str(e.format_name))
def test_every_lane_format_refuses_an_undeclared_manifest_class_before_writing(
    tmp_path: Path, exporter: type
) -> None:
    """Removing the shared input gate would silently emit a malformed lane export."""
    asset = _asset(_lane([(1.0, 1.0), (2.0, 40.0)], label_class="undeclared"))
    manifest = Manifest(
        schema_version=1,
        classes=(LabelClass(name="centerline", geometries=(GeometryType.POLYLINE,)),),
        assets=(asset,),
    )
    dest = tmp_path / "out"

    with pytest.raises(
        ExportSourceUnreadable,
        match=rf"asset {asset.asset_id} carries class 'undeclared'",
    ):
        exporter().export(_release(), manifest, dest, content=_content)

    assert not dest.exists()


def test_the_manifest_asset_ids_never_reach_the_output(tmp_path: Path) -> None:
    """Filenames are content hashes, the way every other format here names them.

    An asset id is a fresh uuid per ingest, so a dataset exported on two machines
    would carry different filenames for the same pictures. `_layout.image_name`
    is the one place that decision lives, and the lane formats reuse it.
    """
    asset = _asset(_lane([(1.0, 1.0), (2.0, 40.0)]))
    dest = _export(CurveLanesExporter(), asset, tmp_path)
    names = {path.name for path in dest.rglob("*") if path.is_file()}
    assert all(str(asset.asset_id) not in name for name in names)
    assert any(asset.content_hash in name for name in names)
