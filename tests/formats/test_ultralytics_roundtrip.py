"""Does the trainer this dialect exists for load what we wrote?

Everything in ``test_ultralytics.py`` is this repository checking its own
arithmetic against its own expectations. That cannot answer the one question
that matters: ultralytics finds label files by string-substituting ``/images/``
for ``/labels/`` in an image path, resolves ``path`` on its own terms, requires
both a ``train`` and a ``val`` key, and reads a classify dataset off a
directory tree — contracts nothing in this codebase can restate without
eventually being wrong about one of them.

So this exports one fixture release per derived task — detect, segment,
classify — loads each with the real library, and asserts the class map and the
label counts it found are the manifest's. No weights, no training.

**Skips locally, fails in CI**, the rule every optional-binary check here follows:
a silently skipped round trip looks exactly like a passing one. CI installs the
``yolo`` dependency group and sets ``VISIONSET_REQUIRE_ULTRALYTICS=1``.

**This module deliberately imports nothing from ``tests.``, and that is not
style.** The ``ultralytics`` wheel ships a top-level ``tests`` package — with an
``__init__.py`` and a ``conftest.py`` of its own — which installs into
site-packages and **shadows this repository's namespace-package ``tests/``**. A
regular package wins over a namespace portion wherever it is found on the path,
so no ordering fixes it: in an environment holding ultralytics, ``import
tests.formats`` resolves ultralytics' ``tests`` and raises. That is why the CI job
runs *this file* rather than the suite, why the ``yolo`` group is not in ``dev``,
and why the fixture below is duplication rather than an import. Do not "clean it
up".

**``path: .`` resolves against the loading process's working directory.**
``check_det_dataset`` keeps a relative ``path`` as it is when it exists, and
``.`` always exists, so the split paths resolve from wherever the loader runs.
Every load below therefore runs from the export directory, which is the
contract this descriptor asks of a trainer.
"""

from __future__ import annotations

import os
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from uuid import UUID

import pytest
from PIL import Image

from visionset.formats.ultralytics import DATA_FILENAME, UltralyticsExporter
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    ClassificationGeometry,
    GeometryType,
    LabelClass,
    Manifest,
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

ULTRALYTICS_REQUIRED_ENV = "VISIONSET_REQUIRE_ULTRALYTICS"

ULTRALYTICS_MISSING_HINT = (
    "ultralytics is not installed; run `uv sync --group yolo` to include it. "
    "It brings torch, and its wheel shadows this repository's `tests` package, "
    "so it is deliberately not in the default dev group."
)

#: The same three classes ``test_ultralytics.py`` uses, in the same authored order.
#:
#: Duplicated rather than imported — see the module docstring. The order is the
#: point: this asserts ultralytics reads back the schema's order and not the
#: alphabet's.
CLASSES = (
    LabelClass(name="sign", geometries=(GeometryType.BBOX,)),
    LabelClass(name="lane", geometries=(GeometryType.POLYGON,)),
    LabelClass(name="weather", geometries=(GeometryType.CLASSIFICATION_TAG,)),
)

IMAGE_SIZE = (64, 48)

Drawing = Callable[[int, UUID], list[Annotation]]


def require_ultralytics() -> None:
    """Skip locally, fail in CI — the ``require_ffmpeg`` rule, one subsystem over."""
    try:
        import ultralytics  # noqa: F401
    except ImportError:
        if os.environ.get(ULTRALYTICS_REQUIRED_ENV) == "1":
            raise RuntimeError(
                f"{ULTRALYTICS_MISSING_HINT} "
                f"({ULTRALYTICS_REQUIRED_ENV}=1 is set, so a missing library is an "
                f"error, not a skip.)"
            ) from None
        pytest.skip(ULTRALYTICS_MISSING_HINT, allow_module_level=True)


require_ultralytics()

from ultralytics.data.utils import (  # noqa: E402
    check_cls_dataset,
    check_det_dataset,
    img2label_paths,
)


def _export(tmp_path: Path, drawing: Drawing) -> tuple[Path, Manifest]:
    """A four-image release with a split, labelled by ``drawing``, written out.

    Built through the real services rather than from a hand-made ``Manifest``,
    because what is under test includes the class order and the folds, and both
    are properties of what the kernel froze.
    """
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
        for position, asset in enumerate(batches.assets(batch_id)):
            AnnotationService(workspace).add(job.id, drawing(position, asset.id))
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
        releases.export(release.id, UltralyticsExporter(), out, allow_lossy=True)
        return out, releases.manifest(release.id)
    finally:
        workspace.close()


def _annotation(asset_id: UUID, label_class: str, geometry: object) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class=label_class,
        schema_version=1,
        geometry=geometry,  # type: ignore[arg-type]
        provenance="human",
    )


def _boxes(position: int, asset_id: UUID) -> list[Annotation]:
    return [_annotation(asset_id, "sign", BboxGeometry(x=8.0, y=12.0, width=16.0, height=24.0))]


def _boxes_and_polygons(position: int, asset_id: UUID) -> list[Annotation]:
    lane = PolygonGeometry(points=[(8.0, 12.0), (24.0, 12.0), (16.0, 36.0)])
    return [*_boxes(position, asset_id), _annotation(asset_id, "lane", lane)]


def _tags(position: int, asset_id: UUID) -> list[Annotation]:
    return [_annotation(asset_id, "weather", ClassificationGeometry())]


def _manifest_counts(manifest: Manifest, *kinds: type) -> Counter[str]:
    return Counter(
        annotation.label_class
        for asset in manifest.assets
        for annotation in asset.annotations
        if isinstance(annotation.geometry, kinds)
    )


def _label_counts(loaded: dict[str, object]) -> Counter[str]:
    """Every label row under every fold, by the class name ultralytics maps its index to."""
    names = loaded["names"]
    assert isinstance(names, dict)
    found: Counter[str] = Counter()
    for fold in ("train", "val", "test"):
        images = sorted(Path(str(loaded[fold])).iterdir())
        for label in img2label_paths([str(path) for path in images]):
            assert Path(label).is_file(), label
            for line in Path(label).read_text(encoding="utf-8").splitlines():
                if line.strip():
                    found[names[int(line.split()[0])]] += 1
    return found


# --- detect and segment --------------------------------------------------------


@pytest.mark.parametrize(
    ("drawing", "columns"),
    [(_boxes, {5}), (_boxes_and_polygons, {7, 9})],
    ids=["detect", "segment"],
)
def test_ultralytics_loads_the_export_and_reads_back_the_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, drawing: Drawing, columns: set[int]
) -> None:
    """``check_det_dataset`` is what a training run does before it starts.

    It resolves ``path``, requires ``train`` and ``val``, checks the validation
    images exist and normalizes ``names`` — the set of mistakes a format plugin
    makes and its own tests cannot see. The class map is asserted by index, so
    this is the schema's *order* and not merely the set of names; the label
    counts are read off the files the trainer would read.
    """
    exported, manifest = _export(tmp_path, drawing)
    monkeypatch.chdir(exported)

    loaded = check_det_dataset(DATA_FILENAME, autodownload=False)

    assert loaded["nc"] == len(CLASSES)
    assert [loaded["names"][index] for index in range(len(CLASSES))] == [
        declared.name for declared in CLASSES
    ]
    for fold in ("train", "val", "test"):
        resolved = Path(str(loaded[fold]))
        assert resolved.is_dir(), fold
        assert any(resolved.iterdir()), fold

    assert _label_counts(loaded) == _manifest_counts(manifest, BboxGeometry, PolygonGeometry)
    widths = {
        len(line.split())
        for fold in ("train", "val", "test")
        for label in img2label_paths([str(p) for p in Path(str(loaded[fold])).iterdir()])
        for line in Path(label).read_text(encoding="utf-8").splitlines()
        if line.strip()
    }
    assert widths == columns


# --- classify ------------------------------------------------------------------


def test_ultralytics_reads_the_class_tree_a_tags_only_release_becomes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``check_cls_dataset`` reads a directory, never a yaml.

    The class list comes off the ``train`` subdirectories, which the tree
    names alphabetically — so the *set* of classes is asserted against the
    schema's tag-capable classes, and the count of images under each against
    the manifest's tags.
    """
    exported, manifest = _export(tmp_path, _tags)
    monkeypatch.chdir(exported)

    loaded = check_cls_dataset(exported)

    tag_capable = {
        declared.name
        for declared in CLASSES
        if GeometryType.CLASSIFICATION_TAG in declared.geometries
    }
    assert set(loaded["names"].values()) == tag_capable
    assert loaded["nc"] == len(tag_capable)
    written: Counter[str] = Counter()
    for fold in ("train", "val", "test"):
        for class_dir in Path(str(loaded[fold])).iterdir():
            written[class_dir.name] += sum(1 for _ in class_dir.iterdir())
    assert written == _manifest_counts(manifest, ClassificationGeometry)
