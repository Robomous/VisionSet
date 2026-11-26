"""A release manifest carries the tracks observing what it holds (#1181)."""

from __future__ import annotations

import json
from collections.abc import Iterator, Sequence
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from tests.kernel.test_track_service import Clip, World

from visionset.kernel.domain import (
    GROUPED_MANIFEST_VERSION,
    MANIFEST_VERSION,
    TRACKED_MANIFEST_VERSION,
    AnnotationJob,
    AssetProgress,
    BboxGeometry,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    ManifestObservation,
    ManifestTrack,
    TimeRange,
    canonical_bytes,
    manifest_version_for,
    tracks_within,
)
from visionset.kernel.services import DatasetService, ProjectService, ReleaseService


class Releasing(World):
    def __init__(self, tmp_path: Path) -> None:
        super().__init__(tmp_path)
        self.datasets = DatasetService(self.workspace)
        self.releases = ReleaseService(self.workspace)

    @property
    def dataset_id(self) -> UUID:
        return ProjectService(self.workspace).get_dataset(self.project.id).id

    def settle(self, job: AnnotationJob, batch_id: UUID) -> None:
        for asset_id, progress in self.jobs.get(job.id).progress.items():
            if progress is not AssetProgress.ANNOTATED:
                self.jobs.mark(job.id, asset_id, AssetProgress.ANNOTATED)
        self.jobs.complete(job.id)
        self.batches.complete(batch_id)
        self.datasets.promote(batch_id)

    def publish(self, tag: str) -> Manifest:
        return self.releases.manifest(self.releases.publish(self.dataset_id, tag).id)


@pytest.fixture
def world(tmp_path: Path) -> Iterator[Releasing]:
    made = Releasing(tmp_path)
    yield made
    made.workspace.close()


def _released(world: Releasing, clip: Clip, positions: Sequence[int]) -> ManifestTrack:
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, positions)
    world.settle(job, clip.batch_id)
    (track,) = world.publish("v1").tracks
    assert track.id == detail.track.id
    return track


def test_an_untracked_release_keeps_its_version_and_omits_the_key(world: Releasing) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    world.box(job, clip.at(0).asset_id)
    world.settle(job, clip.batch_id)
    manifest = world.publish("v1")

    assert manifest.tracks == ()
    assert manifest.manifest_version < TRACKED_MANIFEST_VERSION
    assert "tracks" not in json.loads(canonical_bytes(manifest))


def test_a_tracked_release_is_version_7_ordered_by_position(world: Releasing) -> None:
    clip = world.clip()
    track = _released(world, clip, [2, 0, 1])
    manifest = world.releases.manifest(world.releases.list(world.dataset_id)[0].id)

    assert manifest.manifest_version == TRACKED_MANIFEST_VERSION == MANIFEST_VERSION
    assert [o.position for o in track.observations] == [0, 1, 2]
    assert [o.asset_id for o in track.observations] == [o.asset_id for o in clip.occurrences]
    assert (track.source_id, track.label_class, track.external_id) == (clip.source_id, "car", None)


def test_duplicate_content_frames_keep_one_observation_per_position(world: Releasing) -> None:
    clip = world.clip(seeds=(9, 9, 4))
    track = _released(world, clip, [0, 1, 2])

    first, second, _ = track.observations
    assert first.asset_id == second.asset_id
    assert first.annotation_id != second.annotation_id
    assert [o.position for o in track.observations] == [0, 1, 2]


def test_missing_frames_stay_gaps_with_their_timestamps(world: Releasing) -> None:
    clip = world.clip(
        seeds=(0, 1, 5, 6),
        positions=(0, 1, 5, 6),
        duration=10.0,
        ranges=(
            TimeRange(start_seconds=0.0, end_seconds=2.0),
            TimeRange(start_seconds=5.0, end_seconds=7.0),
        ),
    )
    track = _released(world, clip, [6, 0, 5])

    assert [o.position for o in track.observations] == [0, 5, 6]
    assert [o.timestamp for o in track.observations] == [clip.at(p).timestamp for p in (0, 5, 6)]


def test_two_imports_of_one_clip_release_two_tracks(world: Releasing) -> None:
    first, second = world.clip(), world.clip()
    (job,) = world.working(first.batch_id)
    ours = world.observed(job, first, [0, 1])
    theirs = world.tracks.create(second.source_id, "car").track
    box = world.box(job, second.at(1).asset_id)
    world.tracks.observe(job.id, theirs.id, second.at(1).id, box.id)
    world.settle(job, first.batch_id)

    tracks = world.publish("v1").tracks
    assert {t.id for t in tracks} == {ours.track.id, theirs.id}
    assert [str(t.source_id) for t in tracks] == sorted(
        str(s) for s in (first.source_id, second.source_id)
    )
    by_source = {t.source_id: [o.position for o in t.observations] for t in tracks}
    assert by_source == {first.source_id: [0, 1], second.source_id: [1]}


def test_a_pasted_annotation_is_released_untracked(world: Releasing) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0])
    original = world.annotations.get(detail.observations[0].annotation_id)
    pasted = world.annotations.add(
        job.id, [original.model_copy(update={"id": uuid4(), "asset_id": clip.at(1).asset_id})]
    )[0]
    world.settle(job, clip.batch_id)
    manifest = world.publish("v1")

    released = {a.id for asset in manifest.assets for a in asset.annotations}
    assert pasted.id in released
    (track,) = manifest.tracks
    assert [o.annotation_id for o in track.observations] == [original.id]


def test_colliding_external_ids_across_sources_stay_two_tracks(world: Releasing) -> None:
    first, second = world.clip(), world.clip()
    (job,) = world.working(first.batch_id)
    for clip in (first, second):
        track = world.tracks.create(clip.source_id, "car", external_id="t1").track
        box = world.box(job, clip.at(0).asset_id)
        world.tracks.observe(job.id, track.id, clip.at(0).id, box.id)
    world.settle(job, first.batch_id)

    tracks = world.publish("v1").tracks
    assert [t.external_id for t in tracks] == ["t1", "t1"]
    assert len({t.id for t in tracks}) == 2
    assert {t.source_id for t in tracks} == {first.source_id, second.source_id}


def test_a_release_lists_only_the_observations_it_holds(world: Releasing) -> None:
    clip = world.clip(seeds=(0, 1, 2))
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 1, 2])
    world.settle(job, clip.batch_id)
    world.datasets.remove_asset(world.dataset_id, clip.at(1).asset_id)

    (track,) = world.publish("v1").tracks
    assert track.id == detail.track.id
    assert [o.position for o in track.observations] == [0, 2]


def test_a_correction_changes_the_next_release_and_never_the_last(world: Releasing) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    detail = world.observed(job, clip, [0, 2])
    world.settle(job, clip.batch_id)
    before = world.releases.publish(world.dataset_id, "v1")

    correction = world.batches.create_correction(clip.batch_id, "fix", [clip.at(0).asset_id])
    (fix,) = world.working(correction.id)
    world.tracks.unobserve(fix.id, detail.track.id, clip.at(0).id)
    world.settle(fix, correction.id)

    (after,) = world.publish("v2").tracks
    assert [o.position for o in after.observations] == [2]
    (kept,) = world.releases.manifest(before.id).tracks
    assert [o.position for o in kept.observations] == [0, 2]
    assert world.releases.verify(before.id).ok


def test_a_track_with_nothing_released_is_not_listed(world: Releasing) -> None:
    clip = world.clip()
    (job,) = world.working(clip.batch_id)
    world.observed(job, clip, [1])
    world.box(job, clip.at(0).asset_id)
    world.settle(job, clip.batch_id)
    world.datasets.remove_asset(world.dataset_id, clip.at(1).asset_id)

    assert world.publish("v1").tracks == ()


def test_publishing_twice_agrees_byte_for_byte(world: Releasing) -> None:
    clip = world.clip(seeds=(9, 9, 4))
    (job,) = world.working(clip.batch_id)
    world.observed(job, clip, [2, 0, 1])
    world.observed(job, clip, [1])
    world.settle(job, clip.batch_id)

    first = world.releases.publish(world.dataset_id, "v1")
    second = world.releases.publish(world.dataset_id, "v2")
    assert first.manifest_hash == second.manifest_hash


# --- the document itself ------------------------------------------------------


def _asset(seed: int, annotations: int) -> ManifestAsset:
    return ManifestAsset(
        asset_id=uuid4(),
        content_hash=f"{seed:064x}",
        uri=f"/clip/{seed}.jpg",
        width=16,
        height=12,
        annotations=tuple(
            ManifestAnnotation(
                id=uuid4(),
                label_class="car",
                schema_version=1,
                geometry=BboxGeometry(x=1.0, y=1.0, width=2.0, height=2.0),
                provenance="human",
            )
            for _ in range(annotations)
        ),
    )


def _observing(asset: ManifestAsset, index: int, position: int) -> ManifestObservation:
    return ManifestObservation(
        position=position,
        timestamp=float(position),
        asset_id=asset.asset_id,
        annotation_id=asset.annotations[index].id,
    )


def test_canonical_order_is_independent_of_how_the_document_was_built() -> None:
    source = uuid4()
    a, b = _asset(1, 2), _asset(2, 1)
    late = ManifestTrack(
        id=uuid4(),
        source_id=source,
        label_class="car",
        observations=(_observing(b, 0, 4), _observing(a, 1, 3)),
    )
    early = ManifestTrack(
        id=uuid4(), source_id=source, label_class="car", observations=(_observing(a, 0, 0),)
    )
    one = Manifest(schema_version=1, assets=(a, b), tracks=(late, early))
    other = Manifest(
        schema_version=1,
        assets=(b, a),
        tracks=(
            early,
            ManifestTrack(
                id=late.id,
                source_id=source,
                label_class="car",
                observations=tuple(reversed(late.observations)),
            ),
        ),
    )

    assert canonical_bytes(one) == canonical_bytes(other)
    assert [t.id for t in one.tracks] == [early.id, late.id]
    assert [o.position for o in one.tracks[1].observations] == [3, 4]
    assert Manifest.model_validate_json(canonical_bytes(one)) == one


def test_a_version_6_document_reads_unchanged() -> None:
    asset = _asset(1, 1)
    old = Manifest(manifest_version=GROUPED_MANIFEST_VERSION, schema_version=1, assets=(asset,))
    raw = canonical_bytes(old)

    read = Manifest.model_validate_json(raw)
    assert read.manifest_version == GROUPED_MANIFEST_VERSION
    assert canonical_bytes(read) == raw
    assert manifest_version_for(read.assets) < TRACKED_MANIFEST_VERSION


def test_an_older_version_cannot_carry_tracks() -> None:
    asset = _asset(1, 1)
    track = ManifestTrack(
        id=uuid4(), source_id=uuid4(), label_class="car", observations=(_observing(asset, 0, 0),)
    )
    with pytest.raises(ValidationError, match="carries no tracks"):
        Manifest(
            manifest_version=GROUPED_MANIFEST_VERSION,
            schema_version=1,
            assets=(asset,),
            tracks=(track,),
        )
    assert manifest_version_for((asset,), (track,)) == TRACKED_MANIFEST_VERSION


def test_an_observation_must_name_what_the_document_holds() -> None:
    asset, elsewhere = _asset(1, 1), _asset(2, 1)
    stray = ManifestTrack(
        id=uuid4(),
        source_id=uuid4(),
        label_class="car",
        observations=(_observing(elsewhere, 0, 0),),
    )
    with pytest.raises(ValidationError, match="does not hold"):
        Manifest(schema_version=1, assets=(asset,), tracks=(stray,))

    twice = [
        ManifestTrack(
            id=uuid4(),
            source_id=uuid4(),
            label_class="car",
            observations=(_observing(asset, 0, p),),
        )
        for p in (0, 1)
    ]
    with pytest.raises(ValidationError, match="more than once"):
        Manifest(schema_version=1, assets=(asset,), tracks=tuple(twice))


def test_a_track_observes_a_position_once_and_is_never_empty() -> None:
    asset = _asset(1, 2)
    with pytest.raises(ValidationError, match="at most once"):
        ManifestTrack(
            id=uuid4(),
            source_id=uuid4(),
            label_class="car",
            observations=(_observing(asset, 0, 3), _observing(asset, 1, 3)),
        )
    with pytest.raises(ValidationError):
        ManifestTrack(id=uuid4(), source_id=uuid4(), label_class="car", observations=())


def test_an_export_that_loses_annotations_loses_their_observations() -> None:
    kept, lost = _asset(1, 1), _asset(2, 1)
    track = ManifestTrack(
        id=uuid4(),
        source_id=uuid4(),
        label_class="car",
        observations=(_observing(kept, 0, 0), _observing(lost, 0, 1)),
    )
    only_lost = track.model_copy(update={"id": uuid4(), "observations": track.observations[1:]})
    stripped = lost.model_copy(update={"annotations": ()})

    (cut,) = tracks_within((track, only_lost), (kept, stripped))
    assert cut.id == track.id
    assert [o.position for o in cut.observations] == [0]
