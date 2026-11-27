"""MOTChallenge out: one sequence per source a released track observes.

Each source becomes ``<source-id>/``, holding ``seqinfo.ini``, every frame the
release holds of it as ``img1/<frame:06d><ext>``, observed or not, and
``gt/gt.txt`` with ``gt/labels.txt``, the layout the importer reads back. Frame
``n`` is the occurrence at position ``n - 1``, so only a position the release
holds no frame for is a gap in ``img1``, and ``seqLength`` runs to the last
written position. A video source, and every source of a manifest older than
version 9, is not listed, so only its observed frames are written. ``frameRate``
is the last written position over its timestamp; timing that was not uniform
keeps its frame numbers and loses its spacing. Timing the source never recorded
is refused, and so is timing all at the first frame.

A row is one observation of a box: ``frame``, the track's id, the box, ``conf``
``1`` for a label with no confidence and the confidence otherwise, the class's
1-based index in the release's schema, which ``labels.txt`` lists, and
visibility ``-1``. A track whose imported id is a positive integer keeps it;
any other track is numbered after the largest such id in its sequence, so no
two tracks of a sequence share one and none crosses into another sequence.

The format holds nothing a track does not observe: the kernel reports every
untracked label dropped, through ``tracked_only``. ``lossy`` besides, because
attributes, provenance, a confidence of exactly 0 or 1 and a source's name have
nowhere to go. The split recipe is not applied: a sequence is not cut across
folds, and augmented variants observe no track.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Final
from uuid import UUID

from visionset.formats._layout import dimensions_of, held_frames, image_suffix, write_image_as
from visionset.formats._targets import self_target
from visionset.formats.mot.reader import (
    FRAME_DIGITS,
    GT_DIRNAME,
    GT_FILENAME,
    LABELS_FILENAME,
    SEQINFO_FILENAME,
    SEQINFO_SECTION,
)
from visionset.kernel.domain import (
    BboxGeometry,
    GeometryType,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    ManifestTrack,
    Release,
    SplitAssignment,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

IMAGES_DIRNAME: Final = "img1"
_RATE_DECIMALS: Final = 6


class MotExporter:
    """Writes a release's tracked boxes as MOTChallenge sequences."""

    format_name = "mot"

    lossy = True

    supported_geometries = frozenset({GeometryType.BBOX})

    degraded_geometries: frozenset[GeometryType] = frozenset()

    supported_modalities = frozenset({"image"})

    #: Read by ``_compatibility``: a label no track observes is reported dropped.
    tracked_only = True

    targets = self_target("mot", frozenset({GeometryType.BBOX}))

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
        class_ids = {one.name: index for index, one in enumerate(manifest.classes, 1)}
        by_source: dict[UUID, list[ManifestTrack]] = {}
        for track in manifest.tracks:
            by_source.setdefault(track.source_id, []).append(track)
        planned = [
            plan
            for source_id, tracks in by_source.items()
            if (plan := _plan(source_id, tracks, drawn, class_ids, manifest, content)) is not None
        ]
        for name, frames, rows, seqinfo in planned:
            into = dest / name
            for position, asset in sorted(frames.items()):
                write_image_as(
                    asset, into / IMAGES_DIRNAME, f"{position + 1:0{FRAME_DIGITS}d}", content
                )
            (into / GT_DIRNAME).mkdir(parents=True, exist_ok=True)
            (into / GT_DIRNAME / GT_FILENAME).write_text(
                "".join(f"{row}\n" for _, _, row in sorted(rows)), encoding="utf-8"
            )
            (into / GT_DIRNAME / LABELS_FILENAME).write_text(
                "".join(f"{one.name}\n" for one in manifest.classes), encoding="utf-8"
            )
            (into / SEQINFO_FILENAME).write_text(seqinfo, encoding="utf-8")


def _plan(
    source_id: UUID,
    tracks: list[ManifestTrack],
    drawn: Mapping[UUID, tuple[ManifestAsset, ManifestAnnotation]],
    class_ids: Mapping[str, int],
    manifest: Manifest,
    content: ContentReader,
) -> tuple[str, dict[int, ManifestAsset], list[tuple[int, int, str]], str] | None:
    """One sequence's frames, rows and seqinfo.ini; every refusal is raised before any write."""
    name = str(source_id)
    identities = _identities(tracks)
    frames = held_frames(manifest, source_id)
    timing: list[tuple[int, float | None]] = [
        (one.position, one.timestamp)
        for source in manifest.sources
        if source.source_id == source_id
        for one in source.occurrences
    ]
    rows: list[tuple[int, int, str]] = []
    for track in tracks:
        for observation in track.observations:
            asset, annotation = drawn[observation.annotation_id]
            box = annotation.geometry
            if not isinstance(box, BboxGeometry):
                continue
            held = frames.setdefault(observation.position, asset)
            if held.asset_id != asset.asset_id:
                raise ExportSourceUnreadable(
                    f"sequence {name}: position {observation.position} is observed on assets "
                    f"{held.asset_id} and {asset.asset_id}"
                )
            timing.append((observation.position, observation.timestamp))
            frame = observation.position + 1
            identity = identities[track.id]
            rows.append((frame, identity, _row(frame, identity, annotation, box, class_ids)))
    if not rows:
        return None
    sizes = {dimensions_of(asset) for asset in frames.values()}
    if len(sizes) > 1:
        listed = ", ".join(f"{width}x{height}" for width, height in sorted(sizes))
        raise ExportSourceUnreadable(
            f"sequence {name} holds frames of {len(sizes)} sizes ({listed}); a MOT sequence has one"
        )
    ((width, height),) = sizes
    rate = _frame_rate(name, timing)
    suffixes = {image_suffix(asset, content) for asset in frames.values()}
    if len(suffixes) > 1:
        raise ExportSourceUnreadable(
            f"sequence {name} holds frames of {len(suffixes)} image types "
            f"({', '.join(sorted(suffixes))}); a MOT sequence has one imExt"
        )
    (suffix,) = suffixes
    seqinfo = (
        f"[{SEQINFO_SECTION}]\n"
        f"name={name}\n"
        f"imDir={IMAGES_DIRNAME}\n"
        f"frameRate={rate}\n"
        f"seqLength={max(frames) + 1}\n"
        f"imWidth={width}\n"
        f"imHeight={height}\n"
        f"imExt={suffix}\n"
    )
    return name, frames, rows, seqinfo


def _identities(tracks: Iterable[ManifestTrack]) -> dict[UUID, int]:
    """Each track's MOT id: its imported id when that is a positive integer, else the next free."""
    kept: dict[UUID, int] = {}
    others: list[UUID] = []
    for track in tracks:
        external = track.external_id
        if external is not None and external.isascii() and external.isdigit():
            value = int(external)
            if value > 0 and str(value) == external:
                kept[track.id] = value
                continue
        others.append(track.id)
    following = max(kept.values(), default=0)
    for offset, track_id in enumerate(others, 1):
        kept[track_id] = following + offset
    return kept


def _row(
    frame: int,
    identity: int,
    annotation: ManifestAnnotation,
    box: BboxGeometry,
    class_ids: Mapping[str, int],
) -> str:
    class_id = class_ids.get(annotation.label_class)
    if class_id is None:
        raise ExportSourceUnreadable(
            f"annotation {annotation.id} is of class {annotation.label_class!r}, "
            "which the release's schema does not declare"
        )
    confidence = "1" if annotation.confidence is None else _number(annotation.confidence)
    coordinates = ",".join(_number(value) for value in (box.x, box.y, box.width, box.height))
    return f"{frame},{identity},{coordinates},{confidence},{class_id},-1"


def _frame_rate(name: str, timing: list[tuple[int, float | None]]) -> str:
    unknown = sorted({position for position, timestamp in timing if timestamp is None})
    if unknown:
        raise ExportSourceUnreadable(
            f"sequence {name}: the timing of frame {unknown[0] + 1} is unknown, because its "
            "source recorded none, so seqinfo.ini cannot give a frameRate"
        )
    position, timestamp = max(
        (
            (position, timestamp)
            for position, timestamp in timing
            if timestamp is not None and timestamp > 0
        ),
        default=(0, 0.0),
    )
    rate = round(position / timestamp, _RATE_DECIMALS) if timestamp > 0 else 0.0
    if rate <= 0:
        raise ExportSourceUnreadable(
            f"sequence {name}: no frame after its first has a nonzero timestamp, "
            "so its frame rate cannot be derived"
        )
    return _number(rate)


def _number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else repr(float(value))
