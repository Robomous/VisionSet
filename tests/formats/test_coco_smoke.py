"""Does `pycocotools` load what the COCO exporter wrote, and agree with it?

``test_coco.py`` is this repository checking its own document against its own
expectations. What it cannot check is the reference implementation's own view:
**`COCO` indexes by integer id and raises on a category a row names but the file
does not declare, `annToMask` needs a segmentation it can rasterize, and
`COCOeval`'s size buckets come off `area`** — three contracts that decide whether
an export is usable and none of which this codebase can restate safely.

So this loads a real export with `pycocotools` and asserts it found the images,
resolved every category, rasterized a polygon, and read back the same area we
computed.

**Skips locally, fails in CI**, the rule every optional-binary check here follows:
a silently skipped smoke test looks exactly like a passing one.

**This module imports nothing from ``tests.``**, and neither does its YOLO
sibling. It runs in the environment that also holds ``ultralytics``, whose wheel
ships a top-level ``tests`` package — ``__init__.py``, ``conftest.py`` and all —
which shadows this repository's namespace-package ``tests/``. A regular package
beats a namespace portion wherever it is found, so no ordering fixes it. The
fixture below is duplicated on purpose; see ``test_yolo_smoke.py``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import UUID

import pytest
from PIL import Image

from visionset.formats.coco import ANNOTATIONS_DIRNAME, CocoExporter
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    GeometryType,
    LabelClass,
    PolygonGeometry,
    SplitRecipe,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    DatasetService,
    IngestService,
    JobService,
    ProjectService,
    ReleaseService,
    SchemaService,
    SourceService,
    WorkspaceService,
)

PYCOCOTOOLS_REQUIRED_ENV = "VISIONSET_REQUIRE_PYCOCOTOOLS"

PYCOCOTOOLS_MISSING_HINT = (
    "pycocotools is not installed; run `uv sync --group coco` to include it. "
    "It shares a CI job with the `yolo` group, whose wheel shadows this "
    "repository's `tests` package, so neither is in the default dev group."
)

CLASSES = (
    LabelClass(name="sign", geometries=(GeometryType.BBOX,)),
    LabelClass(name="lane", geometries=(GeometryType.POLYGON,)),
    LabelClass(name="weather", geometries=(GeometryType.CLASSIFICATION_TAG,)),
)

IMAGE_SIZE = (64, 48)

#: The polygon every export below carries: a right triangle, 16 by 24.
#:
#: Chosen because its own area (192) and its bounding box's (384) differ by
#: exactly two, so a reader that disagrees with us is unmistakable rather than
#: within rounding.
TRIANGLE = ((8.0, 12.0), (24.0, 12.0), (8.0, 36.0))
TRIANGLE_AREA = 192.0


def require_pycocotools() -> None:
    """Skip locally, fail in CI — the ``require_ffmpeg`` rule, one subsystem over."""
    try:
        import pycocotools  # noqa: F401
    except ImportError:
        if os.environ.get(PYCOCOTOOLS_REQUIRED_ENV) == "1":
            raise RuntimeError(
                f"{PYCOCOTOOLS_MISSING_HINT} "
                f"({PYCOCOTOOLS_REQUIRED_ENV}=1 is set, so a missing library is an "
                f"error, not a skip.)"
            ) from None
        pytest.skip(PYCOCOTOOLS_MISSING_HINT, allow_module_level=True)


require_pycocotools()

from pycocotools.coco import COCO  # noqa: E402


def _export(tmp_path: Path) -> Path:
    """A four-image release carrying a box and a triangle, written out as COCO."""
    root = tmp_path / "ws"
    workspace = WorkspaceService.init(root)
    try:
        projects = ProjectService(workspace)
        project = projects.create("road-signs")
        SchemaService(workspace).create_version(project.id, list(CLASSES))

        incoming = tmp_path / "incoming"
        incoming.mkdir()
        for index in range(4):
            Image.new("RGB", IMAGE_SIZE, (index * 40, 80, 160)).save(
                incoming / f"still-{index}.png"
            )
        source = SourceService(workspace).register_images(project.id, incoming)
        run = IngestService(workspace).ingest(source.id, batch_name="first")
        assert run.failed == 0
        batch_id = run.batch_id
        assert batch_id is not None

        batches = BatchService(workspace)
        jobs = JobService(workspace)
        batches.approve(batch_id)
        (job,) = batches.jobs(batch_id)
        batches.start(batch_id)
        jobs.start(job.id)
        for asset in batches.assets(batch_id):
            AnnotationService(workspace).add(job.id, [_box(asset.id), _triangle(asset.id)])
        jobs.complete(job.id)
        batches.complete(batch_id)
        DatasetService(workspace).promote(batch_id)

        releases = ReleaseService(workspace)
        release = releases.publish(
            projects.get_dataset(project.id).id,
            "v1",
            split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=3),
        )
        out = tmp_path / "out"
        # No `allow_lossy`: `coco` carries everything this release holds, which is
        # the property the format exists for, and asserting it here means the
        # smoke test would fail if that ever stopped being true.
        releases.export(release.id, CocoExporter(), out)
        return out
    finally:
        workspace.close()


def _box(asset_id: UUID) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="sign",
        schema_version=1,
        geometry=BboxGeometry(x=8.0, y=12.0, width=16.0, height=24.0),
        provenance="human",
    )


def _triangle(asset_id: UUID) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="lane",
        schema_version=1,
        geometry=PolygonGeometry(points=list(TRIANGLE)),
        provenance="human",
    )


@pytest.fixture()
def exported(tmp_path: Path) -> Path:
    return _export(tmp_path)


def _loaded(exported: Path, fold: str = "train") -> COCO:
    return COCO(str(exported / ANNOTATIONS_DIRNAME / f"instances_{fold}.json"))


def test_pycocotools_loads_every_fold_and_resolves_every_category(
    exported: Path,
) -> None:
    """`COCO.__init__` builds its indexes eagerly and raises on a malformed file.

    `loadCats` on a category a row names but the file does not declare is a
    `KeyError`, which is what makes "categories come from the frozen schema"
    checkable by somebody other than us.
    """
    for fold in ("train", "val", "test"):
        coco = _loaded(exported, fold)
        assert coco.getImgIds()
        assert [coco.cats[identifier]["name"] for identifier in sorted(coco.cats)] == [
            declared.name for declared in CLASSES
        ]
        for row in coco.loadAnns(coco.getAnnIds()):
            assert coco.loadCats(row["category_id"])


def test_the_image_files_the_document_names_are_the_ones_on_disk(
    exported: Path,
) -> None:
    """`file_name` is a basename resolved against the split's own directory."""
    coco = _loaded(exported)
    on_disk = {path.name for path in (exported / "images" / "train").iterdir()}

    assert {image["file_name"] for image in coco.loadImgs(coco.getImgIds())} == on_disk


def test_a_polygon_rasterizes_and_covers_the_area_we_wrote(exported: Path) -> None:
    """`annToMask` is the reference implementation's own reading of our geometry.

    The mask's pixel count is not exactly the shoelace area — rasterizing a
    triangle rounds at its edges — so this asserts they agree within one row of
    pixels rather than exactly. What it rules out is the failure that matters: a
    segmentation in the wrong order, the wrong units or the wrong nesting produces
    a mask that is empty or the wrong shape entirely.
    """
    coco = _loaded(exported)
    polygons = [row for row in coco.loadAnns(coco.getAnnIds()) if row["segmentation"]]
    assert polygons

    for row in polygons:
        assert row["area"] == TRIANGLE_AREA
        covered = int(coco.annToMask(row).sum())
        assert abs(covered - TRIANGLE_AREA) < 24, covered


def test_a_box_row_survives_having_no_segmentation(exported: Path) -> None:
    """Which is what lets a box say where something is without claiming its shape.

    Asserted through the reference implementation because it is the one that would
    object: an empty `segmentation` is legal COCO, and a reader that indexes it
    unconditionally would say so here.
    """
    coco = _loaded(exported)
    boxes = [row for row in coco.loadAnns(coco.getAnnIds()) if not row["segmentation"]]

    assert boxes
    for row in boxes:
        assert row["bbox"] == [8.0, 12.0, 16.0, 24.0]
        assert row["area"] == 384.0


def test_the_extra_keys_ride_along_without_disturbing_anything(exported: Path) -> None:
    """`pycocotools` copies annotation dicts whole, so the `visionset` object survives.

    That is the whole argument for this format being lossless: a reader that does
    not know the key ignores it, and one that does gets the attributes, the
    confidence and the provenance COCO has no field for.
    """
    coco = _loaded(exported)

    for row in coco.loadAnns(coco.getAnnIds()):
        assert UUID(row["visionset"]["annotation_id"])
        assert row["visionset"]["provenance"] == "human"

    document = json.loads(
        (exported / ANNOTATIONS_DIRNAME / "instances_train.json").read_text(encoding="utf-8")
    )
    assert document["info"]["visionset"]["manifest_hash"]
