"""The OpenLane 2D importer: per-vertex visibility, the losses it reports, and the round trip."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.cli._flow import ok, project, run, workspace
from tests.fixtures.media import write_image
from tests.formats.test_ultralytics import Fixture

from visionset.formats.lanes import OpenLane2dExporter, OpenLane2dImporter
from visionset.formats.lanes._core import declare_lane_attributes
from visionset.formats.registry import importer, importers
from visionset.kernel import ImportSourceUnreadable
from visionset.kernel.domain import (
    Annotation,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    LabelClass,
    PolylineGeometry,
    VertexVisibility,
)
from visionset.kernel.ports import Importer
from visionset.kernel.services import ImportService, ProjectService, SchemaService, WorkspaceService

OCCLUDED, VISIBLE = VertexVisibility.OCCLUDED, VertexVisibility.VISIBLE


def _lane(**fields: Any) -> dict[str, Any]:
    return {
        "category": 1,
        "visibility": [1, 0, 1],
        "uv": [[1.0, 20.0], [5.0, 12.0], [9.0, 4.0]],
        "attribute": 1,
        "track_id": "lane_0",
        **fields,
    }


def _write(src: Path, lanes: list[dict[str, Any]], **extra: Any) -> Path:
    document = {
        "intrinsic": None,
        "extrinsic": None,
        "file_path": "images/train/a.png",
        "lane_lines": lanes,
        **extra,
    }
    target = src / "labels" / "train" / "a.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document), encoding="utf-8")
    return src


def _losses(src: Path) -> list[tuple[ImportLossKind, str, int]]:
    return [(loss.kind, loss.subject, loss.count) for loss in OpenLane2dImporter().read(src).losses]


def test_the_importer_is_discovered_under_the_exporter_s_name() -> None:
    found = importers()
    assert isinstance(found["openlane-2d"], OpenLane2dImporter)
    assert isinstance(found["openlane-2d"], Importer)
    assert isinstance(importer("openlane-2d"), OpenLane2dImporter)


def test_zero_is_occluded_and_one_is_visible(tmp_path: Path) -> None:
    dataset = OpenLane2dImporter().read(
        _write(
            tmp_path,
            [_lane(visibility=[1, 0, 1]), _lane(track_id="lane_1", visibility=[0, 0, 1.0])],
        )
    )

    (image,) = dataset.images
    assert str(image.path) == "images/train/a.png"
    assert [label.geometry.visibility for label in image.labels] == [  # type: ignore[union-attr]
        (VISIBLE, OCCLUDED, VISIBLE),
        (OCCLUDED, OCCLUDED, VISIBLE),
    ]
    assert dataset.losses == ()


def test_a_lane_with_no_visibility_keeps_none(tmp_path: Path) -> None:
    lane = _lane()
    del lane["visibility"]
    (image,) = OpenLane2dImporter().read(_write(tmp_path, [lane])).images

    assert image.labels[0].geometry == PolylineGeometry(points=[(1, 20), (5, 12), (9, 4)])


@pytest.mark.parametrize("visibility", [[1, 2, 1], [1, 0], [1, 0.5, 1], [True, 0, 1], "101"])
def test_a_visibility_outside_zero_and_one_is_a_geometry_loss_and_the_lane_is_kept(
    tmp_path: Path, visibility: Any
) -> None:
    src = _write(tmp_path, [_lane(visibility=visibility)])
    dataset = OpenLane2dImporter().read(src)

    assert _losses(src) == [(ImportLossKind.GEOMETRY, "white-dash", 1)]
    assert dataset.images[0].labels[0].geometry.visibility is None  # type: ignore[union-attr]


def test_the_category_is_the_class_under_openlane_s_name(tmp_path: Path) -> None:
    lanes = [
        _lane(category=8, attribute=8),
        _lane(category=13, attribute=13, track_id="lane_1"),
        _lane(category=14, attribute=14, track_id="lane_2"),
        _lane(category=0, attribute=0, track_id="lane_3"),
        _lane(category=42, attribute=42, track_id="lane_4"),
    ]
    dataset = OpenLane2dImporter().read(_write(tmp_path, lanes))

    assert [(c.name, c.geometries) for c in dataset.classes] == [
        ("unknown", (GeometryType.POLYLINE,)),
        ("yellow-solid", (GeometryType.POLYLINE,)),
        ("road_edge", (GeometryType.POLYLINE,)),
        ("category-42", (GeometryType.POLYLINE,)),
    ]
    assert [label.class_name for label in dataset.images[0].labels] == [
        "yellow-solid",
        "road_edge",
        "road_edge",
        "unknown",
        "category-42",
    ]
    assert dataset.losses == ()


def test_what_the_domain_cannot_hold_is_reported_by_kind(tmp_path: Path) -> None:
    lanes = [
        _lane(xyz=[[1, 2, 3], [4, 5, 6], [7, 8, 9]]),
        _lane(track_id=7),
        _lane(track_id="lane_2", attribute=5),
    ]
    src = _write(tmp_path, lanes, intrinsic=[[1, 0, 0], [0, 1, 0], [0, 0, 1]])

    assert sorted(_losses(src)) == sorted(
        [
            (ImportLossKind.GEOMETRY, "white-dash", 1),
            (ImportLossKind.ATTRIBUTE, "white-dash", 1),
            (ImportLossKind.ATTRIBUTE, "white-dash", 1),
            (ImportLossKind.ATTRIBUTE, "intrinsic", 1),
        ]
    )
    assert len(OpenLane2dImporter().read(src).images[0].labels) == 3


@pytest.mark.parametrize(
    ("lane", "reason"),
    [
        (_lane(uv=[[1, 2]], visibility=[1]), "two or more"),
        (_lane(uv=[[1, 2], [1, 2]], visibility=[1, 1]), "same point"),
        (_lane(uv=[[1, 2], ["x", 3]], visibility=[1, 1]), "two or more"),
        (_lane(category="1"), "not an integer"),
    ],
)
def test_a_malformed_lane_is_a_label_loss(
    tmp_path: Path, lane: dict[str, Any], reason: str
) -> None:
    dataset = OpenLane2dImporter().read(_write(tmp_path, [lane]))

    (loss,) = dataset.losses
    assert loss.kind is ImportLossKind.LABEL
    assert reason in loss.reason
    assert dataset.images[0].labels == ()


def test_upstream_column_major_uv_is_refused_not_guessed(tmp_path: Path) -> None:
    lane = _lane(uv=[[1, 5, 9], [20, 12, 4]])
    with pytest.raises(ImportSourceUnreadable, match="column-major"):
        OpenLane2dImporter().read(_write(tmp_path, [lane]))


@pytest.mark.parametrize(
    "file_path", ["../escape.png", "/etc/passwd", "a/../../b.png", "C:/x.png", 3]
)
def test_an_image_path_leaving_the_source_refuses_the_whole_import(
    tmp_path: Path, file_path: Any
) -> None:
    with pytest.raises(ImportSourceUnreadable):
        OpenLane2dImporter().read(_write(tmp_path, [], file_path=file_path))


def test_a_label_file_linked_from_outside_the_source_is_refused(tmp_path: Path) -> None:
    outside = _write(tmp_path / "outside", [_lane()])
    src = tmp_path / "src"
    (src / "labels").mkdir(parents=True)
    (src / "labels" / "a.json").symlink_to(outside / "labels" / "train" / "a.json")

    with pytest.raises(ImportSourceUnreadable, match="outside the source"):
        OpenLane2dImporter().read(src)


@pytest.mark.parametrize(
    ("content", "match"),
    [
        (None, "no labels/"),
        ("", "no JSON"),
        ("{not json", "not readable JSON"),
        ("[]", "not an OpenLane document"),
        ('{"file_path": "a.png", "lane_lines": [{"uv": [[NaN, 1], [2, 3]]}]}', "non-finite"),
        ('{"file_path": "a.png", "lane_lines": {}}', "not a list"),
        ('{"lane_lines": []}', "no file_path"),
    ],
)
def test_an_unreadable_source_is_refused(tmp_path: Path, content: str | None, match: str) -> None:
    if content is not None:
        (tmp_path / "labels").mkdir()
    if content:
        (tmp_path / "labels" / "a.json").write_text(content, encoding="utf-8")

    with pytest.raises(ImportSourceUnreadable, match=match):
        OpenLane2dImporter().read(tmp_path)


def test_a_source_that_is_not_a_directory_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ImportSourceUnreadable, match="not a directory"):
        OpenLane2dImporter().read(tmp_path / "missing")


def test_two_label_files_naming_one_image_are_refused(tmp_path: Path) -> None:
    _write(tmp_path, [])
    (tmp_path / "labels" / "b.json").write_text(
        json.dumps({"file_path": "images/train/a.png", "lane_lines": []}), encoding="utf-8"
    )
    with pytest.raises(ImportSourceUnreadable, match="more than one label file"):
        OpenLane2dImporter().read(tmp_path)


# --- the round trip -----------------------------------------------------------

LANE_CLASSES = (
    LabelClass(name="road_edge", geometries=(GeometryType.POLYLINE,)),
    LabelClass(
        name="white-dash", geometries=(GeometryType.POLYLINE,), attributes=declare_lane_attributes()
    ),
)


def _polyline(
    label_class: str,
    points: list[tuple[float, float]],
    visibility: tuple[VertexVisibility, ...] | None,
    **attributes: str,
) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=label_class,
        schema_version=1,
        geometry=PolylineGeometry(points=points, visibility=visibility),
        attributes=attributes,
        provenance="human",
    )


def _content(workspace: WorkspaceService, project_id: Any) -> dict[str, Counter[tuple[str, str]]]:
    with workspace.unit_of_work() as uow:
        return {
            asset.content_hash: Counter(
                (label.label_class, label.geometry.model_dump_json())
                for label in uow.annotations.list(asset.id)
            )
            for asset in uow.assets.list(project_id)
        }


def test_an_openlane_export_with_occluded_vertices_imports_back_without_loss(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path / "origin", classes=LANE_CLASSES)
    fixture.label(
        {
            0: [
                _polyline(
                    "road_edge",
                    [(2.0, 40.0), (10.5, 20.25), (20.0, 4.0)],
                    (VISIBLE, OCCLUDED, VISIBLE),
                ),
                _polyline(
                    "white-dash",
                    [(30.0, 44.0), (32.0, 30.0), (34.0, 16.0), (36.0, 2.0)],
                    (OCCLUDED, OCCLUDED, VISIBLE, VISIBLE),
                    style="dashed",
                    color="white",
                ),
            ],
            1: [_polyline("road_edge", [(60.0, 47.0), (50.0, 1.0)], (VISIBLE, VISIBLE))],
        }
    )
    exported = tmp_path / "exported"
    fixture.releases.export(fixture.publish(), OpenLane2dExporter(), exported, allow_lossy=True)
    original = _content(fixture.workspace, fixture.project.id)
    fixture.close()

    workspace = WorkspaceService.init(tmp_path / "copy")
    project_ = ProjectService(workspace).create("copy")
    imports = ImportService(workspace)
    plan = imports.inspect(project_.id, OpenLane2dImporter(), exported)
    run_ = imports.commit(project_.id, OpenLane2dImporter(), exported, consent=ImportConsent())

    assert plan.losses == ()
    assert run_.losses == ()
    assert _content(workspace, project_.id) == original
    (schema,) = SchemaService(workspace).list_versions(project_.id)
    assert [c.name for c in schema.classes] == ["white-dash", "road_edge"]
    workspace.close()


# --- the CLI ------------------------------------------------------------------


def _source(root: Path, *, lossy: bool = False) -> Path:
    write_image(root / "images" / "train" / "a.png", size=(32, 24))
    return _write(root, [_lane(xyz=[[0, 0, 0]] * 3)] if lossy else [_lane()])


def test_visionset_import_reads_openlane_and_a_dry_run_reports_the_loss(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = project(root)

    dry = run(
        root,
        "import",
        "openlane-2d",
        str(_source(tmp_path / "lossy", lossy=True)),
        "--project",
        name,
        "--dry-run",
        "--json",
    )
    assert dry.exit_code == 1, dry.output
    assert json.loads(dry.stdout)["loss_kinds"] == ["geometry"]

    ok(root, "import", "openlane-2d", str(_source(tmp_path / "src")), "--project", name)
    with WorkspaceService.open(root) as service:
        found = ProjectService(service).resolve(name)
        with service.unit_of_work() as uow:
            (asset,) = uow.assets.list(found.id)
            (label,) = uow.annotations.list(asset.id)
    assert label.provenance == "import"
    assert label.geometry.visibility == (VISIBLE, OCCLUDED, VISIBLE)  # type: ignore[union-attr]


# --- defects found in review ----------------------------------------------------


def test_json_nested_too_deep_to_parse_is_refused(tmp_path: Path) -> None:
    (tmp_path / "labels").mkdir()
    (tmp_path / "labels" / "a.json").write_text("[" * 100000 + "]" * 100000, encoding="utf-8")

    with pytest.raises(ImportSourceUnreadable, match="not readable JSON|not an OpenLane document"):
        OpenLane2dImporter().read(tmp_path)


@pytest.mark.parametrize("inside", [True, False])
def test_a_symlinked_directory_under_labels_is_refused(tmp_path: Path, inside: bool) -> None:
    src = _write(tmp_path / "src", [_lane()])
    target = _write(tmp_path / "elsewhere", [_lane()]) if not inside else src / "labels" / "train"
    linked = target / "labels" / "train" if not inside else target
    (src / "labels" / "more").symlink_to(linked, target_is_directory=True)

    with pytest.raises(ImportSourceUnreadable, match="symbolic link"):
        OpenLane2dImporter().read(src)


def test_a_symlinked_labels_directory_is_refused(tmp_path: Path) -> None:
    outside = _write(tmp_path / "outside", [_lane()])
    src = tmp_path / "src"
    src.mkdir()
    (src / "labels").symlink_to(outside / "labels", target_is_directory=True)

    with pytest.raises(ImportSourceUnreadable, match="symbolic link"):
        OpenLane2dImporter().read(src)


@pytest.mark.parametrize(
    ("category", "attribute"),
    [(1, 0), (1, True), (1, 2.0), (0, False), (2, 5)],
)
def test_a_lane_attribute_other_than_the_exporter_s_echo_is_an_attribute_loss(
    tmp_path: Path, category: int, attribute: Any
) -> None:
    src = _write(tmp_path, [_lane(category=category, attribute=attribute)])

    assert [(kind, count) for kind, _, count in _losses(src)] == [(ImportLossKind.ATTRIBUTE, 1)]


def test_the_lane_attribute_is_carried_as_its_position_role(tmp_path: Path) -> None:
    lanes = [
        _lane(attribute=4),
        _lane(category=8, attribute=1, track_id="lane_1"),
        _lane(category=8, attribute=8, track_id="lane_2"),
        _lane(category=2, attribute=2, track_id="lane_3"),
        _lane(category=2, attribute=2, track_id=None),
        _lane(category=3, attribute=3, track_id=None),
    ]
    dataset = OpenLane2dImporter().read(_write(tmp_path, lanes))

    assert [label.attributes for label in dataset.images[0].labels] == [
        {"position_role": "adjacent_right"},
        {"position_role": "adjacent_left"},
        {},
        {},
        {"position_role": "ego_left"},
        {"position_role": "ego_right"},
    ]
    (position,) = (one for one in declare_lane_attributes() if one.name == "position_role")
    assert [(one.name, one.attributes) for one in dataset.classes] == [
        ("white-dash", (position,)),
        ("white-solid", (position,)),
        ("double-white-dash", (position,)),
        ("yellow-solid", (position,)),
    ]
    assert dataset.losses == ()


@pytest.mark.parametrize("category", [0, 1, 13])
def test_the_exporter_s_attribute_echo_is_not_a_loss(tmp_path: Path, category: int) -> None:
    echo = _lane(category=category, attribute=category, track_id="lane_0")
    assert _losses(_write(tmp_path, [echo])) == []


@pytest.mark.parametrize("track_id", [None, 7, "lane_1"])
def test_an_attribute_equal_to_the_category_without_the_exporter_s_marker_is_read(
    tmp_path: Path, track_id: object
) -> None:
    dataset = OpenLane2dImporter().read(
        _write(tmp_path, [_lane(category=13, attribute=13, track_id=track_id)])
    )
    assert ("road_edge", "a lane attribute other than 1 to 4 is not imported") in {
        (loss.subject, loss.reason) for loss in dataset.losses
    }
