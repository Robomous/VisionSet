"""Does the tool this format exists for actually load what we wrote?

Everything in ``test_yolo.py`` is this repository checking its own arithmetic
against its own expectations. That is worth having and it cannot answer the one
question that matters: **ultralytics finds label files by string-substituting
``/images/`` for ``/labels/`` in an image path, resolves ``path`` against the
yaml's own directory, and refuses a normalized coordinate outside ``[0, 1]``** —
three contracts nothing in this codebase can restate without eventually being
wrong about one of them.

So this loads a real export with the real library and asserts it found the images,
found the labels, and read the classes in the order the schema declared them.

**Skips locally, fails in CI**, the ffmpeg rule from #22 and for its reason: a
silently skipped smoke test looks exactly like a passing one. CI installs the
``yolo`` dependency group and sets ``VISIONSET_REQUIRE_ULTRALYTICS=1``, so a
broken install goes red rather than quietly shrinking the suite. It is a separate
job and a separate dependency group because ultralytics brings torch, and putting
two gigabytes in front of ``uv sync`` for every contributor is a cost this one
test does not justify.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from tests.formats.test_yolo import CLASSES, Fixture, _box

from visionset.formats.yolo import DATA_FILENAME
from visionset.kernel.domain import SplitRecipe

ULTRALYTICS_REQUIRED_ENV = "VISIONSET_REQUIRE_ULTRALYTICS"

ULTRALYTICS_MISSING_HINT = (
    "ultralytics is not installed; run `uv sync --group yolo` to include it. "
    "It brings torch, so it is not in the default dev group."
)


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

from ultralytics.data.utils import check_det_dataset  # noqa: E402


@pytest.fixture()
def exported(tmp_path: Path) -> Path:
    """A four-image release with a split and one box, written out as YOLO."""
    fixture = Fixture(tmp_path, images=4)
    fixture.label({index: [_box(x=8, y=12, width=16, height=24)] for index in range(4)})
    release_id = fixture.publish(split=SplitRecipe(train=0.5, val=0.25, test=0.25, seed=3))
    out = fixture.export(release_id, tmp_path / "out")
    fixture.close()
    return out


def test_ultralytics_loads_the_export_and_finds_every_image(exported: Path) -> None:
    """`check_det_dataset` is what a training run does before it starts.

    It resolves `path`, globs each fold, pairs every image with its label file and
    raises if a fold is empty or a coordinate is out of range — which is exactly
    the set of mistakes a format plugin makes and its own tests cannot see.
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


def test_the_labels_are_where_ultralytics_looks_for_them(exported: Path) -> None:
    """The `/images/` → `/labels/` substitution, asserted rather than assumed.

    It is a string replacement on the resolved image path, not a configured
    location: `IMAGES_DIRNAME` and `LABELS_DIRNAME` are load-bearing, and getting
    either wrong produces a dataset that loads with zero labels and no error.
    """
    from ultralytics.data.utils import img2label_paths

    loaded = check_det_dataset(str(exported / DATA_FILENAME), autodownload=False)
    images = sorted(Path(str(loaded["train"])).iterdir())
    assert images

    for label in img2label_paths([str(path) for path in images]):
        assert Path(label).is_file(), label
