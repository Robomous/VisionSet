#!/usr/bin/env python3
"""The vision document's success metric, executable: video to a YOLO dataset.

*Install VisionSet, point it at a clip, draw fifty boxes, and hand a trainer a
dataset — in under half an hour.* That sentence is what the whole build is for,
and this is it as a program: one project, one video, fifty bounding boxes over
the frames it yielded, one release, one YOLO export that ``ultralytics`` agrees
is a dataset.

It is also **M6's gate**. The CI job installs the built wheel into an empty
virtual environment and runs this file — nothing from the repository is on the
path, so what is exercised is what a user gets from ``pip``. A run that reaches
the end proves the wheel, the entry points, the plugin discovery, the media
toolchain and every service in the cycle at once.

**Every stage is timed and named**, which is the point of :func:`stage` rather
than a bare sequence of calls: a failure here has to say *which step* of the
promised half hour broke, because "the flow is broken" is not something anybody
can act on. The elapsed total is asserted against
:data:`WALL_CLOCK_CEILING_SECONDS` as a **friction canary** — not a performance
test. It is minutes wide on purpose. The claim is thirty minutes of a person's
attention; if a machine doing the same work unattended needs ten, the claim is
already gone.

The annotation step is scripted, obviously: a program cannot look at a picture.
What it exercises is everything around the looking — the batch that must be
approved before a label may be written, the job that owns the assets, the schema
version each annotation is judged against, and the progress that promotion reads.

Run it:

    python examples/thirty_minute_flow.py [destination]

It needs **ffmpeg** on the PATH, because it makes its own clip rather than
committing one. ``ultralytics`` is optional: without it the export is still
written and checked structurally, and the final assertion says it was skipped.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from visionset import __version__
from visionset.formats.registry import exporter
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

#: The ceiling the whole flow must finish under, in seconds.
#:
#: **A friction canary, not a benchmark.** The promise is thirty minutes of a
#: person's attention; a machine doing the same work with the looking removed
#: should be nowhere near that, so ten minutes is loose enough that a shared CI
#: runner under load never trips it and tight enough that something structurally
#: slow — a decode moved inside a transaction, an N+1 read over every annotation
#: — cannot hide. #49's rule applies: assert a wall clock only where the number
#: is a *shape* rather than a measurement.
WALL_CLOCK_CEILING_SECONDS = 600.0

#: Ten seconds at 5 fps: fifty frames, one box each.
CLIP_SECONDS = 10
CLIP_FPS = 30
CLIP_SIZE = (320, 240)
EXTRACTION_FPS = 5.0

#: The number in the promise, and it is a real constraint rather than a round
#: figure: fifty is what the extraction above yields, so every frame gets exactly
#: one box and the count is a property of the run rather than a slice of it.
BOX_COUNT = 50

CLASSES: tuple[LabelClass, ...] = (
    LabelClass(name="vehicle", geometry=GeometryType.BBOX, color="#eb5a47"),
    LabelClass(name="sign", geometry=GeometryType.BBOX, color="#2a9d8f"),
)

SPLIT = SplitRecipe(train=0.7, val=0.15, test=0.15, seed=42)

FORMAT_NAME = "yolo"

ULTRALYTICS_REQUIRED_ENV = "VISIONSET_REQUIRE_ULTRALYTICS"

FFMPEG_MISSING = (
    "ffmpeg is not on PATH, and this flow decomposes a video.\n"
    "Install it with `brew install ffmpeg` (macOS) or "
    "`sudo apt-get install ffmpeg` (Debian/Ubuntu), then run this again."
)


@dataclass(frozen=True)
class Summary:
    """What the run produced, for a reader and for the smoke test alike."""

    version: str
    project_id: UUID
    asset_count: int
    box_count: int
    release_tag: str
    manifest_hash: str
    export_directory: Path
    label_files: int
    labelled_boxes: int
    classes_in_data_yaml: tuple[str, ...]
    loaded_by_ultralytics: bool
    seconds: float
    stages: tuple[tuple[str, float], ...]


_TIMINGS: list[tuple[str, float]] = []


@contextmanager
def stage(name: str) -> Iterator[None]:
    """Announce a step, time it, and name it if it fails.

    The naming is the deliverable. An exception out of a fifteen-step flow is
    otherwise a traceback into whichever service happened to raise, and the
    question a reader has — *which part of the promise broke?* — is answered by
    reading the code rather than the output.
    """
    print(f"==> {name}", flush=True)
    started = time.monotonic()
    try:
        yield
    except BaseException as exc:
        elapsed = time.monotonic() - started
        print(f"!!! FAILED at stage {name!r} after {elapsed:.1f}s: {exc}", file=sys.stderr)
        raise
    elapsed = time.monotonic() - started
    _TIMINGS.append((name, elapsed))
    print(f"    ok ({elapsed:.1f}s)", flush=True)


def write_clip(path: Path) -> Path:
    """Ten seconds of ``testsrc``, generated rather than committed.

    The flags are ``tests/fixtures/media.write_video``'s, duplicated on purpose:
    an example may shell out to ffmpeg and may never import the test fixtures,
    which answer a missing binary with ``pytest.skip`` — meaningless in a script.

    **The size matters.** Below roughly 96x72 the pattern's per-frame movement
    falls under what the scaler and encoder resolve, consecutive frames come out
    byte-identical, and content addressing deduplicates them — so a ten-second
    clip yields fewer assets than extraction slots and the feature working reads
    as a shortfall. 320x240 clears that floor comfortably.
    """
    width, height = CLIP_SIZE
    path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg",
        "-nostdin",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", f"testsrc=size={width}x{height}:rate={CLIP_FPS}:duration={CLIP_SECONDS}",
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-g", str(CLIP_FPS),
        "-movflags", "+faststart",
        "-fflags", "+bitexact",
        "-flags:v", "+bitexact",
        "-y", str(path),
    ]  # fmt: skip
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"ffmpeg could not generate {path.name}:\n{result.stderr}")
    return path


def _box(asset_id: UUID, index: int) -> Annotation:
    """One plausible box, positioned so no two are identical.

    Alternating classes, because a dataset with one class exercises neither the
    class index nor the report that names classes.
    """
    return Annotation(
        asset_id=asset_id,
        label_class=CLASSES[index % len(CLASSES)].name,
        schema_version=1,
        geometry=BboxGeometry(
            x=10.0 + (index % 7) * 8,
            y=12.0 + (index % 5) * 9,
            width=48.0,
            height=36.0,
        ),
        provenance="human",
    )


def main(dest: Path) -> Summary:
    """Drive an empty directory to a YOLO dataset, and report what happened."""
    if shutil.which("ffmpeg") is None:
        # Before anything is written, so a machine without the binary leaves no
        # half-made workspace behind.
        raise SystemExit(FFMPEG_MISSING)

    _TIMINGS.clear()
    started = time.monotonic()
    print(f"VisionSet {__version__} — the thirty-minute flow", flush=True)

    with WorkspaceService.init(dest / "workspace", name="thirty-minute-flow") as workspace:
        projects = ProjectService(workspace)
        schemas = SchemaService(workspace)
        sources = SourceService(workspace)
        ingest = IngestService(workspace)
        batches = BatchService(workspace)
        jobs = JobService(workspace)
        annotations = AnnotationService(workspace)
        datasets = DatasetService(workspace)
        releases = ReleaseService(workspace)

        with stage("create the project and its labeling contract"):
            project = projects.create("dashcam", description="The thirty-minute flow")
            schemas.create_version(project.id, CLASSES)

        with stage("generate a ten-second clip"):
            clip = write_clip(dest / "clips" / "road.mp4")

        with stage("register the clip as a source"):
            source = sources.register_video(project.id, clip, extraction_fps=EXTRACTION_FPS)

        with stage("ingest: decode, hash, store, and fill a batch"):
            run = ingest.ingest(source.id, batch_name="road-5fps")
            if run.failed:
                raise SystemExit(f"{run.failed} file(s) failed to ingest: {run.failures}")
            batch_id = run.batch_id
            if batch_id is None:
                raise SystemExit("the ingest produced no batch")

        with stage("approve the batch, pinning the schema version"):
            batches.approve(batch_id)
            (job,) = batches.jobs(batch_id)
            batches.start(batch_id)
            jobs.start(job.id)

        assets = batches.assets(batch_id)
        with stage(f"draw {BOX_COUNT} boxes"):
            if len(assets) < BOX_COUNT:
                raise SystemExit(
                    f"the clip yielded {len(assets)} assets, which is fewer than the "
                    f"{BOX_COUNT} boxes this flow draws one apiece"
                )
            for index, asset in enumerate(assets[:BOX_COUNT]):
                annotations.add(job.id, [_box(asset.id, index)])
            for asset in assets[BOX_COUNT:]:
                jobs.mark(job.id, asset.id, "skipped")

        with stage("complete the job and the batch"):
            jobs.complete(job.id)
            batches.complete(batch_id)

        with stage("promote the batch into the dataset"):
            datasets.promote(batch_id)

        with stage("publish a release with a 70/15/15 split"):
            release = releases.publish(projects.get_dataset(project.id).id, "v1.0", split=SPLIT)

        with stage("verify the release re-hashes clean"):
            report = releases.verify(release.id)
            if not report.ok:
                raise SystemExit(f"the release does not verify: {report}")

        with stage(f"check what {FORMAT_NAME} would drop"):
            plugin = exporter(FORMAT_NAME)
            compatibility = releases.check_export(release.id, plugin)
            print(
                f"    {FORMAT_NAME}: compatible={compatibility.compatible}, "
                f"lossy={compatibility.format_is_lossy}, "
                f"excluded={compatibility.excluded_annotations}",
                flush=True,
            )

        with stage(f"export as {FORMAT_NAME}"):
            # `allow_lossy` because YOLO is unconditionally lossy: a label row is
            # five numbers, so attributes, confidence and provenance never
            # survive whatever a release holds. The check above is what turns
            # that flag from a shrug into a decision.
            result = releases.export(release.id, plugin, dest / "export", allow_lossy=True)

        export = result.directory
        manifest_hash = release.manifest_hash
        project_id = project.id

    with stage("read the dataset back"):
        labels = sorted((export / "labels").rglob("*.txt"))
        rows = sum(len(path.read_text().split("\n")) - 1 for path in labels)
        names = _class_names(export / "data.yaml")
        if rows != BOX_COUNT:
            raise SystemExit(f"the export holds {rows} boxes, not {BOX_COUNT}")

    with stage("load it with ultralytics"):
        loaded = _ultralytics_loads(export)

    seconds = time.monotonic() - started
    with stage("check the wall clock"):
        if seconds > WALL_CLOCK_CEILING_SECONDS:
            raise SystemExit(
                f"the flow took {seconds:.0f}s, over the {WALL_CLOCK_CEILING_SECONDS:.0f}s "
                f"ceiling — something got structurally slower, not merely busier"
            )

    return Summary(
        version=__version__,
        project_id=project_id,
        asset_count=len(assets),
        box_count=BOX_COUNT,
        release_tag="v1.0",
        manifest_hash=manifest_hash,
        export_directory=export,
        label_files=len(labels),
        labelled_boxes=rows,
        classes_in_data_yaml=names,
        loaded_by_ultralytics=loaded,
        seconds=seconds,
        stages=tuple(_TIMINGS),
    )


def _class_names(data_yaml: Path) -> tuple[str, ...]:
    """The ``names:`` block, read without a YAML library.

    The document is this build's own and its shape is pinned by
    ``tests/formats/test_yolo.py``; parsing it with a dependency the wheel does
    not have would make this script need one.
    """
    found: list[str] = []
    inside = False
    for line in data_yaml.read_text(encoding="utf-8").splitlines():
        if line.startswith("names:"):
            inside = True
            continue
        if inside and line.startswith("  "):
            found.append(line.split(":", 1)[1].strip().strip('"'))
        elif inside:
            break
    return tuple(found)


def _ultralytics_loads(export: Path) -> bool:
    """Ask the trainer whether this is a dataset, if the trainer is here.

    Optional so the script runs on a machine without two gigabytes of torch, and
    **not optional in CI**, where ``VISIONSET_REQUIRE_ULTRALYTICS=1`` turns the
    skip into a failure — the ffmpeg rule from #22. The whole point of the flow
    is that somebody else can train on what came out.
    """
    try:
        from ultralytics.data.utils import check_det_dataset
    except ImportError:
        if os.environ.get(ULTRALYTICS_REQUIRED_ENV) == "1":
            raise SystemExit(
                f"ultralytics is not installed and {ULTRALYTICS_REQUIRED_ENV}=1 is set, "
                f"so the dataset went unchecked by the tool it exists for."
            ) from None
        print("    ultralytics is not installed — the load check was skipped", flush=True)
        return False

    loaded = check_det_dataset(str(export / "data.yaml"), autodownload=False)
    for fold in ("train", "val"):
        resolved = Path(str(loaded[fold]))
        if not resolved.is_dir() or not any(resolved.iterdir()):
            raise SystemExit(f"ultralytics resolved {fold} to {resolved}, which holds nothing")
    print(f"    ultralytics loaded {loaded['nc']} classes across three folds", flush=True)
    return True


def _clear_previous_run(dest: Path) -> None:
    """Make a repeated run of the script work, without deleting anything else.

    Named directories only. ``init`` refuses a non-empty workspace, which is the
    behaviour worth keeping rather than working around.
    """
    for name in ("workspace", "clips", "export"):
        shutil.rmtree(dest / name, ignore_errors=True)


if __name__ == "__main__":
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("thirty-minute-flow")
    destination.mkdir(parents=True, exist_ok=True)
    _clear_previous_run(destination)
    summary = main(destination)
    print()
    print(f"done in {summary.seconds:.1f}s")
    print(f"  {summary.asset_count} frames, {summary.labelled_boxes} boxes")
    print(f"  release {summary.release_tag} ({summary.manifest_hash[:12]}…)")
    print(f"  dataset at {summary.export_directory}")
