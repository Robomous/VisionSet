"""``visionset export`` and ``visionset format list``.

The only installed exporter is ``dummy``, and it **writes nothing** — so
``file_count: 0`` here is the honest report of an export that ran, not evidence
of one that failed. The counts are taken by walking the destination afterwards,
which is what makes them checkable at all.

The lossy gate is exercised against an exporter registered for the test through
``importlib.metadata``, because no installed one declares itself lossy — and a
gate nothing ever trips is a gate nobody has tested.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from uuid import UUID

import pytest
from tests.cli._flow import (
    jobs_of,
    ok,
    payload,
    published_release,
    run,
    started_batch,
    workspace,
)
from typer.testing import CliRunner

from visionset.cli.main import app
from visionset.formats import registry
from visionset.kernel.domain import (
    Annotation,
    BboxGeometry,
    GeometryType,
    Manifest,
    Release,
)
from visionset.kernel.ports import ContentReader
from visionset.kernel.services import (
    EXPORT_REPORT_FILENAME,
    WORKSPACE_ENV_VAR,
    AnnotationService,
    JobService,
    WorkspaceService,
)


class LossyExporter:
    """A format that cannot carry everything a release holds. Writes one file."""

    format_name = "lossy-sample"
    lossy = True

    #: Everything, so the refusal under test is the *flag's* and not the report's
    #: — #65 made consent required when either says so, and a double declaring a
    #: narrower set would make this test pass for the other reason.
    supported_geometries = frozenset(GeometryType)
    degraded_geometries: frozenset[GeometryType] = frozenset()
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        (dest / "labels.txt").write_text(f"{len(manifest.assets)}\n", encoding="utf-8")


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return workspace(tmp_path)


@pytest.fixture()
def lossy(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Add a lossy exporter to what the registry finds, for one test.

    The registry itself is not stubbed — ``exporters()`` still scans the entry
    point group — so what is being tested is the command's use of it.
    """
    real = registry.exporters

    def with_lossy() -> dict[str, object]:
        return {**real(), LossyExporter.format_name: LossyExporter()}

    monkeypatch.setattr(registry, "exporters", with_lossy)
    yield


# --- format list -------------------------------------------------------------


def test_format_list_names_the_installed_exporters() -> None:
    # No ``--workspace``: this command opens nothing, so ``_flow.ok`` (which
    # always appends the flag) cannot be used and the runner is called directly.
    result = CliRunner().invoke(app, ["format", "list"])
    assert result.exit_code == 0, result.output
    rows = result.stdout.splitlines()
    assert rows[0].split() == ["NAME", "LOSSY"]
    # Sorted by name, so `coco` leads and `yolo` closes.
    assert [row.split() for row in rows[1:]] == [
        ["coco", "no"],
        ["dummy", "no"],
        ["voc", "yes"],
        ["yolo", "yes"],
    ]


def test_format_list_needs_no_workspace_at_all(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Plugins are a fact about the process, not about any dataset — and you ask
    # what is available *before* choosing a ``--format``.
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(app, ["format", "list"])
    assert result.exit_code == 0, result.output
    assert "dummy" in result.stdout


def test_format_list_json_is_the_envelope() -> None:
    result = CliRunner().invoke(app, ["format", "list", "--json"])
    assert result.exit_code == 0, result.output
    # #65 gave a format its capability declaration, so the row carries what it can
    # express as well as whether it loses anything. `dummy` writes nothing, so it
    # claims everything — declaring less would make the report describe a loss
    # that never happens.
    assert json.loads(result.stdout)["items"] == [
        {
            # #63. Lossless: boxes and polygons are native, and everything COCO
            # has no field for rides in a `visionset` object per annotation.
            "name": "coco",
            "lossy": False,
            "geometries": ["bbox", "polygon"],
            "degraded_geometries": [],
            "modalities": ["image"],
        },
        {
            "name": "dummy",
            "lossy": False,
            "geometries": [
                "bbox",
                "classification_tag",
                "cuboid_3d",
                "keypoints",
                "mask",
                "polygon",
                "polyline",
                "polyline_3d",
            ],
            "degraded_geometries": [],
            "modalities": ["image", "point_cloud", "video"],
        },
        {
            # #64. Lossy for a different reason from `yolo`'s: a VOC `<object>`
            # has a fixed set of children its consumers index by tag name, so
            # there is nowhere to put an attribute or a confidence.
            "name": "voc",
            "lossy": True,
            "geometries": ["bbox"],
            "degraded_geometries": ["polygon"],
            "modalities": ["image"],
        },
        {
            "name": "yolo",
            "lossy": True,
            # #62, the first format here that writes anything. Lossy because a
            # label row is five numbers: attributes, confidence and provenance
            # never survive, whatever a release happens to hold.
            "geometries": ["bbox"],
            "degraded_geometries": ["polygon"],
            "modalities": ["image"],
        },
    ]


# --- export ------------------------------------------------------------------


def test_export_writes_into_the_directory_it_was_given(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    out = tmp_path / "out"
    document = payload(
        root, "export", "-p", name, "--release", "v1.0", "--format", "dummy", "--out", str(out)
    )
    assert document["directory"] == str(out)
    assert out.is_dir()


def test_the_dummy_exporter_reports_zero_files_and_that_is_correct(
    root: Path, tmp_path: Path
) -> None:
    name = published_release(root, tmp_path)
    document = payload(
        root,
        "export",
        "-p",
        name,
        "--release",
        "v1.0",
        "--format",
        "dummy",
        "--out",
        str(tmp_path / "out"),
    )
    # Still zero, and #65 is why that took work: the compatibility report is
    # written into the directory too, so it is excluded from the walk on both
    # sides — not counted when it is written, and skipped when an earlier run
    # left one behind.
    assert document["file_count"] == 0
    assert document["total_bytes"] == 0
    assert document["format"] == "dummy"
    assert document["directory"] == str(tmp_path / "out")
    # And the report rides on the result, for the caller that never sees the bytes.
    assert document["compatibility"]["compatible"] is True
    assert document["compatibility"]["excluded_annotations"] == 0


def test_an_unknown_format_exits_one_naming_what_is_installed(root: Path, tmp_path: Path) -> None:
    # ``registry.pick`` refuses with a ``VisionSetError`` listing the installed
    # set; a dict lookup would raise ``KeyError`` and print a traceback.
    name = published_release(root, tmp_path)
    result = run(
        root,
        "export",
        "-p",
        name,
        "--release",
        "v1.0",
        "--format",
        "not-a-format",
        "--out",
        str(tmp_path),
    )
    assert result.exit_code == 1, result.output
    assert "dummy" in result.stderr


def test_an_unknown_release_tag_exits_one(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    result = run(
        root, "export", "-p", name, "--release", "v9.9", "--format", "dummy", "--out", str(tmp_path)
    )
    assert result.exit_code == 1, result.output


def test_out_pointing_at_a_file_exits_two(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    occupied = tmp_path / "already-a-file"
    occupied.write_text("mine", encoding="utf-8")
    result = run(
        root,
        "export",
        "-p",
        name,
        "--release",
        "v1.0",
        "--format",
        "dummy",
        "--out",
        str(occupied),
    )
    assert result.exit_code == 2, result.output


# --- the lossy gate ----------------------------------------------------------


def test_a_lossy_format_exits_one_until_the_flag(root: Path, tmp_path: Path, lossy: None) -> None:
    # A third gate word, never folded into ``--yes``: this guards emitting an
    # incomplete *copy* of something that stays intact.
    name = published_release(root, tmp_path)
    out = tmp_path / "out"
    argv = [
        "export",
        "-p",
        name,
        "--release",
        "v1.0",
        "--format",
        "lossy-sample",
        "--out",
        str(out),
    ]
    refused = run(root, *argv)
    assert refused.exit_code == 1, refused.output
    assert not out.exists()

    document = payload(root, *argv, "--allow-lossy")
    assert document["file_count"] == 1
    assert (out / "labels.txt").is_file()


class BoxesOnlyExporter:
    """Lossless by its own declaration, and unable to write the geometry in play.

    The pair #65 exists for. `lossy` is false, so the refusal below is about what
    the release holds and not about anything the format said about itself.
    """

    format_name = "boxes-only"
    lossy = False

    supported_geometries = frozenset({GeometryType.CLASSIFICATION_TAG})
    degraded_geometries: frozenset[GeometryType] = frozenset()
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        (dest / "tags.txt").write_text("nothing to write\n", encoding="utf-8")


@pytest.fixture()
def boxes_only(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    real = registry.exporters

    def with_it() -> dict[str, object]:
        return {**real(), BoxesOnlyExporter.format_name: BoxesOnlyExporter()}

    monkeypatch.setattr(registry, "exporters", with_it)
    yield


def _labeled_release(root: Path, tmp_path: Path, tag: str = "v1.0") -> tuple[str, Path]:
    """A release that actually holds labels, which the CLI alone cannot produce.

    ``visionset job mark --progress annotated`` records that somebody labeled an
    asset while the CLI writes no labels — the wart ``docs/jobs.md`` states out
    loud — so every release built purely through this surface carries
    ``annotation_count: 0``, and a report over it is compatible with *any* format
    however narrow. Writing one box through the kernel is what gives #65's
    refusal something to exclude.
    """
    name, batch = started_batch(root, tmp_path)
    workspace = WorkspaceService.open(root)
    try:
        jobs = JobService(workspace)
        annotations = AnnotationService(workspace)
        for identifier in jobs_of(root, batch):
            job_id = UUID(identifier)
            jobs.start(job_id)
            for asset in jobs.next_pending(job_id, 100):
                annotations.add(
                    job_id,
                    [
                        Annotation(
                            asset_id=asset.id,
                            label_class="sign",
                            schema_version=1,
                            geometry=BboxGeometry(x=1.0, y=2.0, width=8.0, height=6.0),
                            provenance="human",
                        )
                    ],
                )
            jobs.complete(job_id)
    finally:
        workspace.close()
    ok(root, "batch", "complete", batch)
    ok(root, "batch", "promote", batch)
    ok(root, "release", "publish", "--tag", tag, "--project", name)
    return name, tmp_path / "out"


def test_a_lossless_format_that_would_drop_a_class_is_refused_too(
    root: Path, tmp_path: Path, boxes_only: None
) -> None:
    name, out = _labeled_release(root, tmp_path)

    refused = run(
        root,
        "export",
        "-p",
        name,
        "--release",
        "v1.0",
        "--format",
        "boxes-only",
        "--out",
        str(out),
    )

    assert refused.exit_code == 1, refused.output
    assert not out.exists()


def test_the_excluded_classes_are_named_on_stderr_so_stdout_stays_the_path(
    root: Path, tmp_path: Path, boxes_only: None
) -> None:
    """`visionset export ... | xargs` still gets exactly the directory."""
    name, out = _labeled_release(root, tmp_path)

    result = run(
        root,
        "export",
        "-p",
        name,
        "--release",
        "v1.0",
        "--format",
        "boxes-only",
        "--out",
        str(out),
        "--allow-lossy",
    )

    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == str(out)
    assert "Not carried by boxes-only" in result.stderr
    assert EXPORT_REPORT_FILENAME in result.stderr
    assert (out / EXPORT_REPORT_FILENAME).is_file()
