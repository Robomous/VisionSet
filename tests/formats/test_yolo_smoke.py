"""Does the tool this format exists for actually load what we wrote?

Everything in ``test_yolo.py`` is this repository checking its own arithmetic
against its own expectations. That is worth having and it cannot answer the one
question that matters: **ultralytics finds label files by string-substituting
``/images/`` for ``/labels/`` in an image path, resolves ``path`` against its own
datasets directory rather than the yaml's, and requires both a ``train`` and a
``val`` key** — three contracts nothing in this codebase can restate without
eventually being wrong about one of them.

So this loads a real export with the real library and asserts it found the images,
found the labels, and read the classes in the order the schema declared them.

**Skips locally, fails in CI**, the rule every optional-binary check here follows: a
silently skipped smoke test looks exactly like a passing one. CI installs the
``yolo`` dependency group and sets ``VISIONSET_REQUIRE_ULTRALYTICS=1``, so a
broken install goes red rather than quietly shrinking the suite.

**This module deliberately imports nothing from ``tests.``, and that is not
style.** The ``ultralytics`` wheel ships a top-level ``tests`` package — with an
``__init__.py`` and a ``conftest.py`` of its own — which installs into
site-packages and **shadows this repository's namespace-package ``tests/``**. A
regular package wins over a namespace portion wherever it is found on the path,
so no ordering fixes it: in an environment holding ultralytics, ``import
tests.formats`` resolves ultralytics' ``tests`` and raises. That is why the CI job
runs *this file* rather than the suite, why the ``yolo`` group is not in ``dev``,
and why the fixture below is thirty lines of duplication rather than an import.
Do not "clean it up".
"""

from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID

import pytest
from PIL import Image

from visionset.formats.yolo import DATA_FILENAME, YoloDetectionExporter
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    GeometryType,
    LabelClass,
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

#: The same three classes ``test_yolo.py`` uses, in the same authored order.
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

from ultralytics.data.utils import check_det_dataset, img2label_paths  # noqa: E402


def _export(tmp_path: Path) -> Path:
    """A four-image release with a split and a box on each, written out as YOLO.

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
        for asset in batches.assets(batch_id):
            AnnotationService(workspace).add(job.id, [_box(asset.id)])
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
        releases.export(release.id, YoloDetectionExporter(), out, allow_lossy=True)
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


@pytest.fixture()
def exported(tmp_path: Path) -> Path:
    return _export(tmp_path)


def test_ultralytics_loads_the_export_and_finds_every_fold(exported: Path) -> None:
    """`check_det_dataset` is what a training run does before it starts.

    It resolves `path`, requires `train` and `val`, checks the validation images
    exist and normalizes `names` — which is the set of mistakes a format plugin
    makes and its own tests cannot see.
    """
    loaded = check_det_dataset(str(exported / DATA_FILENAME), autodownload=False)

    assert loaded["nc"] == len(CLASSES)
    # Read back as a mapping keyed by index, so this asserts the *order* the
    # schema declared and not merely the set of names.
    assert [loaded["names"][index] for index in range(len(CLASSES))] == [
        declared.name for declared in CLASSES
    ]
    for fold in ("train", "val", "test"):
        resolved = Path(str(loaded[fold]))
        assert resolved.is_dir(), fold
        assert any(resolved.iterdir()), fold


def test_the_export_resolves_from_its_own_directory_and_not_the_process_s(
    exported: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Which is what the absent `path:` key buys, and the reason it is absent.

    Ultralytics resolves a relative `path` against its datasets directory or the
    working directory of whatever loads the file, so the obvious `path: .` breaks
    the moment an export is copied to a training machine. Loading from somewhere
    else entirely is the only way to assert that it does not.
    """
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)

    loaded = check_det_dataset(str(exported / DATA_FILENAME), autodownload=False)

    assert Path(str(loaded["train"])).is_relative_to(exported)


def test_the_labels_are_where_ultralytics_looks_for_them(exported: Path) -> None:
    """The `/images/` → `/labels/` substitution, asserted rather than assumed.

    It is a string replacement on the resolved image path, not a configured
    location: `IMAGES_DIRNAME` and `LABELS_DIRNAME` are load-bearing, and getting
    either wrong produces a dataset that loads with zero labels and no error.
    """
    loaded = check_det_dataset(str(exported / DATA_FILENAME), autodownload=False)
    images = sorted(Path(str(loaded["train"])).iterdir())
    assert images

    for label in img2label_paths([str(path) for path in images]):
        assert Path(label).is_file(), label
