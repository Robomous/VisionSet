# usage: from visionset.formats.cvat.video import CvatVideoExporter, CvatVideoImporter
"""CVAT for video 1.1: tracks of per-frame shapes over one task's frames.

**In.** Every ``annotations.xml`` under the source is one task, an ordered image
sequence named by its ``<meta>/<task>/<name>``, or by its directory when it has
none. Its ``<size>`` is the frame count. CVAT numbers frames in the source
video, from ``<start_frame>`` every ``step`` of a ``step=<n>`` ``<frame_filter>``;
the ``k``-th is position ``k`` and is ``images/frame_<frame:06d><ext>`` beside the
document, and every frame shares one ``<ext>``. A frame the task counts but the directory does not
hold is listed anyway, so its position stays a gap. CVAT records no frame
timing, so every frame's timestamp is unknown (``None``, not ``0``) and its order
lives in its position.

Each ``<track id>`` becomes a track of that sequence whose external id is the
decimal ``id``. Each shape in it at ``outside="0"`` becomes the track's
observation at its ``frame``; ``outside="1"`` marks the object absent, so that
frame is a gap and nothing is written. Interpolation is not expanded: a shape
marked ``keyframe="0"`` (CVAT's interpolated frame) is imported as an ordinary
label and the mark is an ``attribute`` loss, and the frames CVAT would
interpolate between two stored shapes, or carry from a track's last stored shape
to the task's end, are counted as one. A track of a shape the domain has no
geometry for is a ``label`` loss per stored shape; shape fields and attribute
values are reported as for :mod:`visionset.formats.cvat.images`. A ``<tag
frame>`` becomes an untracked classification tag on that frame. A document holding
``<image>`` elements is CVAT for images and is refused here.

**Out.** One task per source a released track observes, as ``<source-id>/``
holding ``annotations.xml`` and every frame the release holds of that source,
observed or not, as ``images/frame_<position:06d><ext>``, the layout the
importer reads back. Only a position the release holds no frame for is a gap.
``<size>`` runs to the last held position. A track whose imported id is a
non-negative integer keeps it; any other is numbered after the largest such id
in its sequence. Each observation is a shape at ``keyframe="1" outside="0"``,
and a track that does not continue to the next frame gets an ``outside="1"``
keyframe there, so CVAT does not carry it across a gap or to the task's end. A
track's observations must share one shape type, as a CVAT track's do. Nothing a
track does not observe is written (``tracked_only``); ``lossy`` besides, for
confidence, per-vertex visibility and the model behind a label.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Final
from uuid import UUID
from xml.etree import ElementTree

from pydantic import ValidationError

from visionset.formats._layout import dimensions_of, held_frames, image_suffix, write_image_as
from visionset.formats._reading import IMAGE_SUFFIXES, REPEATED_TAG, contained, relative
from visionset.formats._targets import self_target
from visionset.formats.cvat._document import (
    DOCUMENT_FILENAME,
    IMAGES_DIRNAME,
    SHAPES,
    SOURCES,
    Document,
    Losses,
    Meta,
    documents,
    extras,
    flag,
    geometry,
    imported_classes,
    integer,
    label_of,
    meta,
    new_document,
    parse,
    require_writable,
    save,
    write_meta,
    write_shape,
)
from visionset.kernel.domain import (
    ClassificationGeometry,
    GeometryType,
    ImportedDataset,
    ImportedFrame,
    ImportedImage,
    ImportedLabel,
    ImportedSequence,
    ImportLoss,
    ImportLossKind,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    ManifestTrack,
    Release,
    SplitAssignment,
)
from visionset.kernel.errors import ExportSourceUnreadable, ImportSourceUnreadable
from visionset.kernel.ports import ContentReader

FORMAT_NAME: Final = "cvat-video"
FRAME_DIGITS: Final = 6

_LABEL: Final = "CVAT for video"
_STEP: Final = re.compile(r"step=(\d{1,9})", re.ASCII)
_FRAME: Final = re.compile(r"frame_(\d{6,9})(\.[A-Za-z0-9]+)", re.ASCII)
_TRACK_FIELDS: Final = frozenset({"frame", "outside", "keyframe"})
_INTERPOLATED: Final = (
    "keyframe=0 marks a frame CVAT interpolated; it is imported as an ordinary label "
    "and the mark is not kept"
)
_NOT_EXPANDED: Final = (
    "frames CVAT interpolates between stored shapes, or carries to the task's end, are not expanded"
)
_TRACK_GROUP: Final = "a track's group_id is not carried; the track is kept"
_TRACK_READ: Final = frozenset({"id", "label", "source", "group_id"})
#: A bound on a task's frame count, so a document cannot ask for unbounded memory.
MAX_FRAMES: Final = 1_000_000
_SUPPORTED: Final = frozenset({GeometryType.BBOX, GeometryType.POLYGON, GeometryType.POLYLINE})


@dataclass(frozen=True)
class _Task:
    name: str
    size: int
    width: int | None
    height: int | None
    start: int = 0
    step: int = 1

    def frame_of(self, position: int) -> int:
        return self.start + position * self.step

    def position_of(self, frame: int) -> int | None:
        offset = frame - self.start
        if offset < 0 or offset % self.step or offset // self.step >= self.size:
            return None
        return offset // self.step

    def frames(self) -> str:
        last = self.frame_of(self.size - 1)
        every = f" every {self.step}" if self.step != 1 else ""
        return f"the task's {self.size} frames ({self.start} to {last}{every})"


class CvatVideoImporter:
    """Reads CVAT for video 1.1 task exports, each an image sequence whose tracks are tracks."""

    format_name = FORMAT_NAME

    def read(self, src: Path) -> ImportedDataset:
        root = src.resolve()
        images: list[ImportedImage] = []
        sequences: list[ImportedSequence] = []
        declared: list[Meta] = []
        used: dict[str, set[GeometryType]] = {}
        losses: Losses = Counter()
        named: dict[str, str] = {}
        for path in documents(src, _LABEL):
            where = relative(src, path)
            document = parse(path, where)
            labels = meta(document)
            declared.append(labels)
            task = _task(document, labels, path.parent, src)
            earlier = named.setdefault(task.name, where)
            if earlier != where:
                raise ImportSourceUnreadable(
                    f"{where} and {earlier} both name the sequence {task.name!r}"
                )
            frames = _frame_paths(src, root, path.parent, task)
            drawn = _labels(document, labels, task, used, losses)
            for position, frame in enumerate(frames):
                images.append(
                    ImportedImage(
                        path=frame,
                        width=task.width,
                        height=task.height,
                        labels=tuple(drawn.get(position, ())),
                    )
                )
            try:
                sequences.append(
                    ImportedSequence(
                        name=task.name,
                        frames=tuple(ImportedFrame(path=frame, timestamp=None) for frame in frames),
                    )
                )
            except ValidationError as exc:
                message = str(exc.errors()[0]["msg"]).removeprefix("Value error, ")
                raise ImportSourceUnreadable(f"{where}: {message}") from None
        try:
            return ImportedDataset(
                classes=tuple(imported_classes(declared, used, losses)),
                images=tuple(images),
                losses=tuple(
                    ImportLoss(kind=kind, subject=subject, count=count, reason=reason)
                    for (kind, subject, reason), count in losses.items()
                ),
                sequences=tuple(sequences),
            )
        except ValidationError as exc:
            raise ImportSourceUnreadable(f"the {_LABEL} dataset is inconsistent: {exc}") from None


def _task(document: Document, labels: Meta, directory: Path, src: Path) -> _Task:
    task = labels.task
    if task is None:
        raise document.refuse(document.root, "the <meta> has no <task> or <job>")
    size_text = (task.findtext("size") or "").strip()
    if not size_text.isascii() or not size_text.isdigit() or int(size_text) < 1:
        raise document.refuse(task, f"the task's <size> is {size_text!r}, not a frame count")
    if int(size_text) > MAX_FRAMES:
        raise document.refuse(
            task, f"the task's <size> is {size_text}, more than the {MAX_FRAMES} frames read"
        )
    name = (task.findtext("name") or "").strip()
    if not name:
        name = directory.relative_to(src).as_posix() if directory != src else src.name
    width = height = None
    original = task.find("original_size")
    if original is not None:
        values = [(original.findtext(key) or "").strip() for key in ("width", "height")]
        if not all(value.isascii() and value.isdigit() and int(value) > 0 for value in values):
            raise document.refuse(original, "the <original_size> is not two positive integers")
        width, height = (int(value) for value in values)
    start_text = (task.findtext("start_frame") or "0").strip()
    if not start_text.isascii() or not start_text.isdigit():
        raise document.refuse(task, f"the task's <start_frame> is {start_text!r}, not a frame")
    if task.tag == "job" and int(start_text) != 0:
        raise document.refuse(
            task,
            "a job export starting past frame 0 is not read: export the task instead",
        )
    step = 1
    frame_filter = (task.findtext("frame_filter") or "").strip()
    if frame_filter:
        found = _STEP.fullmatch(frame_filter)
        if found is None or int(found.group(1)) < 1:
            raise document.refuse(
                task, f"the task's <frame_filter> is {frame_filter!r}, not step=<n>"
            )
        step = int(found.group(1))
    return _Task(
        name=name,
        size=int(size_text),
        width=width,
        height=height,
        start=int(start_text),
        step=step,
    )


def _frame_paths(src: Path, root: Path, directory: Path, task: _Task) -> list[PurePosixPath]:
    frames_dir = directory / IMAGES_DIRNAME
    where = relative(src, directory / DOCUMENT_FILENAME)
    if not frames_dir.is_dir():
        raise ImportSourceUnreadable(f"{where}: there is no {IMAGES_DIRNAME}/ beside it")
    suffixes: set[str] = set()
    for entry in frames_dir.iterdir():
        found = _FRAME.fullmatch(entry.name)
        if found is None or found.group(2).lower() not in IMAGE_SUFFIXES:
            continue
        if found.group(1) != f"{int(found.group(1)):0{FRAME_DIGITS}d}":
            continue
        contained(src, root, entry)
        if task.position_of(int(found.group(1))) is None:
            raise ImportSourceUnreadable(f"{relative(src, entry)} is not one of {task.frames()}")
        suffixes.add(found.group(2))
    if not suffixes:
        raise ImportSourceUnreadable(f"{where}: {IMAGES_DIRNAME}/ holds no frame_<n:06d> picture")
    if len(suffixes) > 1:
        raise ImportSourceUnreadable(
            f"{where}: the frames under {IMAGES_DIRNAME}/ are of {len(suffixes)} types "
            f"({', '.join(sorted(suffixes))}); a task's frames share one"
        )
    (suffix,) = suffixes
    base = PurePosixPath(relative(src, frames_dir))
    return [base / f"frame_{task.frame_of(n):0{FRAME_DIGITS}d}{suffix}" for n in range(task.size)]


def _labels(
    document: Document,
    declared: Meta,
    task: _Task,
    used: dict[str, set[GeometryType]],
    losses: Losses,
) -> dict[int, list[ImportedLabel]]:
    by_frame: dict[int, list[ImportedLabel]] = {}
    tracks: set[int] = set()
    tagged: set[tuple[int, str]] = set()
    for element in document.root:
        if element.tag in ("version", "meta"):
            continue
        if element.tag == "image":
            raise document.refuse(
                element, "an <image> belongs to CVAT for images 1.1, which cvat-images reads"
            )
        if element.tag == "tag":
            class_name = label_of(document, element, declared, losses)
            frame = _frame(document, element, task)
            if class_name is None:
                continue
            if (frame, class_name) in tagged:
                losses[(ImportLossKind.LABEL, class_name, REPEATED_TAG)] += 1
                continue
            extras(document, element, losses, class_name, _TRACK_FIELDS)
            tagged.add((frame, class_name))
            used.setdefault(class_name, set()).add(GeometryType.CLASSIFICATION_TAG)
            by_frame.setdefault(frame, []).append(
                ImportedLabel(class_name=class_name, geometry=ClassificationGeometry())
            )
            continue
        if element.tag != "track":
            raise document.refuse(element, f"<{element.tag}> is not a CVAT track element")
        identity = integer(document, element, "id")
        if identity in tracks:
            raise document.refuse(element, f"track id {identity} is given twice")
        tracks.add(identity)
        class_name = label_of(document, element, declared, losses)
        if class_name is None:
            continue
        if element.get("group_id") not in (None, "", "0"):
            losses[(ImportLossKind.ATTRIBUTE, class_name, _TRACK_GROUP)] += 1
        for field in sorted(set(element.keys()) - _TRACK_READ):
            reason = f"the track's {field[:40]} field is not imported; the track is kept"
            losses[(ImportLossKind.ATTRIBUTE, class_name, reason)] += 1
        for frame, label in _track(document, element, class_name, task, losses):
            used.setdefault(class_name, set()).add(GeometryType(label.geometry.type))
            by_frame.setdefault(frame, []).append(label.model_copy(update={"track": str(identity)}))
    return by_frame


def _frame(document: Document, element: ElementTree.Element, task: _Task) -> int:
    """The position of the shape's ``frame``, which CVAT counts in the source's own frames."""
    frame = integer(document, element, "frame")
    position = task.position_of(frame)
    if position is None:
        raise document.refuse(element, f"frame {frame} is not one of {task.frames()}")
    return position


def _track(
    document: Document,
    element: ElementTree.Element,
    class_name: str,
    task: _Task,
    losses: Losses,
) -> Iterable[tuple[int, ImportedLabel]]:
    kinds = {shape.tag for shape in element}
    unknown = sorted(kinds - SHAPES)
    if unknown:
        child = next(shape for shape in element if shape.tag == unknown[0])
        raise document.refuse(child, f"<{child.tag}> is not a CVAT shape")
    if len(kinds) > 1:
        raise document.refuse(
            element, f"the track mixes {', '.join(sorted(kinds))}; a CVAT track holds one shape"
        )
    stored: dict[int, tuple[ElementTree.Element, bool]] = {}
    for shape in element:
        frame = _frame(document, shape, task)
        if frame in stored:
            raise document.refuse(
                shape, f"the track has two shapes at frame {task.frame_of(frame)}"
            )
        stored[frame] = (shape, flag(document, shape, "outside", "0"))
    present: list[tuple[int, ImportedLabel]] = []
    ordered = sorted(stored.items())
    for index, (frame, (shape, outside)) in enumerate(ordered):
        if outside:
            continue
        drawn = geometry(document, shape, losses, class_name)
        if drawn is None:
            continue
        following = ordered[index + 1][0] if index + 1 < len(ordered) else task.size
        if following - frame > 1:
            losses[(ImportLossKind.ATTRIBUTE, class_name, _NOT_EXPANDED)] += following - frame - 1
        extras(document, shape, losses, class_name, _TRACK_FIELDS)
        if not flag(document, shape, "keyframe", "1"):
            losses[(ImportLossKind.ATTRIBUTE, class_name, _INTERPOLATED)] += 1
        present.append((frame, ImportedLabel(class_name=class_name, geometry=drawn)))
    return present


class CvatVideoExporter:
    """Writes each tracked source of a release as a CVAT for video 1.1 task."""

    format_name = FORMAT_NAME

    lossy = True

    supported_geometries = _SUPPORTED

    degraded_geometries: frozenset[GeometryType] = frozenset()

    supported_modalities = frozenset({"image"})

    #: Read by ``_compatibility``: a label no track observes is reported dropped.
    tracked_only = True

    targets = self_target(FORMAT_NAME, _SUPPORTED)

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
        assignment: SplitAssignment | None,
    ) -> None:
        drawn = {
            annotation.id: (asset, annotation)
            for asset in manifest.assets
            for annotation in asset.annotations
        }
        by_source: dict[UUID, list[ManifestTrack]] = {}
        for track in manifest.tracks:
            by_source.setdefault(track.source_id, []).append(track)
        planned = [
            plan
            for source_id, tracks in by_source.items()
            if (plan := _plan(source_id, tracks, drawn, manifest, content)) is not None
        ]
        for name, root, frames in planned:
            for position, asset in sorted(frames.items()):
                write_image_as(
                    asset,
                    dest / name / IMAGES_DIRNAME,
                    f"frame_{position:0{FRAME_DIGITS}d}",
                    content,
                )
            save(root, dest / name / DOCUMENT_FILENAME)


def _plan(
    source_id: UUID,
    tracks: list[ManifestTrack],
    drawn: Mapping[UUID, tuple[ManifestAsset, ManifestAnnotation]],
    manifest: Manifest,
    content: ContentReader,
) -> tuple[str, ElementTree.Element, dict[int, ManifestAsset]] | None:
    """One task's document and frames, every refusal raised before anything is written."""
    name = str(source_id)
    frames = held_frames(manifest, source_id)
    written: list[tuple[ManifestTrack, list[tuple[int, ManifestAnnotation]]]] = []
    for track in tracks:
        shapes = []
        for observation in track.observations:
            asset, annotation = drawn[observation.annotation_id]
            if GeometryType(annotation.geometry.type) not in _SUPPORTED:
                continue
            held = frames.setdefault(observation.position, asset)
            if held.asset_id != asset.asset_id:
                raise ExportSourceUnreadable(
                    f"sequence {name}: position {observation.position} is observed on assets "
                    f"{held.asset_id} and {asset.asset_id}"
                )
            shapes.append((observation.position, annotation))
        kinds = {annotation.geometry.type for _, annotation in shapes}
        if len(kinds) > 1:
            raise ExportSourceUnreadable(
                f"track {track.id} observes {', '.join(sorted(kinds))}; "
                "a CVAT track holds one shape type"
            )
        if shapes:
            written.append((track, shapes))
    if not written:
        return None
    sizes = {dimensions_of(asset) for asset in frames.values()}
    if len(sizes) > 1:
        listed = ", ".join(f"{width}x{height}" for width, height in sorted(sizes))
        raise ExportSourceUnreadable(
            f"sequence {name} holds frames of {len(sizes)} sizes ({listed}); a CVAT task has one"
        )
    suffixes = {image_suffix(asset, content) for asset in frames.values()}
    if len(suffixes) > 1:
        raise ExportSourceUnreadable(
            f"sequence {name} holds frames of {len(suffixes)} image types "
            f"({', '.join(sorted(suffixes))}); a CVAT task's frames share one"
        )
    size = max(frames) + 1
    root = new_document()
    write_meta(
        root,
        name=name,
        size=size,
        mode="interpolation",
        classes=manifest.classes,
        original_size=next(iter(sizes)),
        mutable=True,
    )
    identities = _identities(track for track, _ in written)
    for track, shapes in sorted(written, key=lambda item: identities[item[0].id]):
        first = shapes[0][1]
        element = ElementTree.SubElement(
            root,
            "track",
            {
                "id": str(identities[track.id]),
                "label": track.label_class,
                "source": SOURCES[first.provenance],
            },
        )
        observed = {position for position, _ in shapes}
        for position, annotation in shapes:
            fields = {"frame": str(position), "keyframe": "1", "outside": "0"}
            write_shape(element, annotation, fields)
            after = position + 1
            if after < size and after not in observed:
                write_shape(
                    element,
                    annotation,
                    {"frame": str(after), "keyframe": "1", "outside": "1"},
                    with_attributes=False,
                )
    require_writable(root)
    return name, root, frames


def _identities(tracks: Iterable[ManifestTrack]) -> dict[UUID, int]:
    """Each track's CVAT id: its imported id when a non-negative integer, else the next free."""
    kept: dict[UUID, int] = {}
    taken: set[int] = set()
    others: list[UUID] = []
    for track in tracks:
        external = track.external_id
        if external is not None and external.isascii() and external.isdigit():
            value = int(external)
            if str(value) == external and value not in taken:
                kept[track.id] = value
                taken.add(value)
                continue
        others.append(track.id)
    following = max(taken, default=-1)
    for offset, track_id in enumerate(others, 1):
        kept[track_id] = following + offset
    return kept


__all__ = ["CvatVideoExporter", "CvatVideoImporter"]
