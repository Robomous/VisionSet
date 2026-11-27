"""A manifest lists its image-sequence sources, and timing may be unknown (#1199)."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from tests.kernel.test_release_tracks import _asset, _observing

from visionset.kernel.domain import (
    MANIFEST_VERSION,
    MASK_MANIFEST_VERSION,
    OBB_MANIFEST_VERSION,
    SEQUENCED_MANIFEST_VERSION,
    TRACKED_MANIFEST_VERSION,
    ImportedFrame,
    ImportedSequence,
    Manifest,
    ManifestObservation,
    ManifestOccurrence,
    ManifestSource,
    ManifestTrack,
    canonical_bytes,
    manifest_version_for,
    manifest_within,
    sha256_hex,
)

#: Written by the version-7 build, before sources existed.
_VERSION_7 = (
    '{"assets":[{"annotations":[{"attributes":{},"confidence":null,"geometry":{"height":2.0,'
    '"type":"bbox","width":2.0,"x":1.0,"y":1.0},"id":"00000000-0000-0000-0000-000000000002",'
    '"label_class":"car","model_ref":null,"provenance":"human","schema_version":1}],'
    '"asset_id":"00000000-0000-0000-0000-000000000001","content_hash":"'
    + "a"
    * 64
    + '","height":12,"uri":"/clip/1.jpg","width":16}],"classes":[],"manifest_version":7,'
    '"schema_version":1,"tracks":[{"external_id":null,"id":"00000000-0000-0000-0000-000000000003",'
    '"label_class":"car","observations":[{"annotation_id":"00000000-0000-0000-0000-000000000002",'
    '"asset_id":"00000000-0000-0000-0000-000000000001","position":0,"timestamp":0.0}],'
    '"source_id":"00000000-0000-0000-0000-000000000004"}]}'
)


def _occurrence(asset_id: UUID, position: int, timestamp: float | None) -> ManifestOccurrence:
    return ManifestOccurrence(position=position, timestamp=timestamp, asset_id=asset_id)


def test_a_version_7_document_reads_and_hashes_as_it_was_published() -> None:
    assert sha256_hex(_VERSION_7.encode()) == (
        "a35c072ef085ff8add11b23a1168772288656b4b79c586515011879769022b31"
    )
    manifest = Manifest.model_validate_json(_VERSION_7)

    assert manifest.manifest_version == TRACKED_MANIFEST_VERSION
    assert manifest.sources == ()
    assert canonical_bytes(manifest) == _VERSION_7.encode()
    assert manifest_version_for(manifest.assets, manifest.tracks) == TRACKED_MANIFEST_VERSION
    assert SEQUENCED_MANIFEST_VERSION == OBB_MANIFEST_VERSION + 1 == 9
    assert MANIFEST_VERSION == MASK_MANIFEST_VERSION == SEQUENCED_MANIFEST_VERSION + 1


def test_sources_and_unknown_timing_need_version_9() -> None:
    asset = _asset(1, 1)
    listed = ManifestSource(source_id=uuid4(), occurrences=(_occurrence(asset.asset_id, 0, 0.0),))
    untimed = ManifestTrack(
        id=uuid4(),
        source_id=uuid4(),
        label_class="car",
        observations=(_observing(asset, 0, 0).model_copy(update={"timestamp": None}),),
    )
    with pytest.raises(ValidationError, match="need version 9"):
        Manifest(manifest_version=8, schema_version=1, assets=(asset,), sources=(listed,))
    with pytest.raises(ValidationError, match="need version 9"):
        Manifest(manifest_version=7, schema_version=1, assets=(asset,), tracks=(untimed,))
    assert manifest_version_for((asset,), (), (listed,)) == SEQUENCED_MANIFEST_VERSION
    assert manifest_version_for((asset,), (untimed,)) == SEQUENCED_MANIFEST_VERSION
    assert manifest_version_for((asset,)) == 3


def test_null_and_zero_timing_are_distinct_documents() -> None:
    asset = _asset(1, 0)
    source = UUID(int=7)
    unknown, zero = (
        Manifest(
            schema_version=1,
            assets=(asset,),
            sources=(
                ManifestSource(source_id=source, occurrences=(_occurrence(asset.asset_id, 0, t),)),
            ),
        )
        for t in (None, 0.0)
    )
    assert b'"timestamp":null' in canonical_bytes(unknown)
    assert b'"timestamp":0.0' in canonical_bytes(zero)
    assert Manifest.model_validate_json(canonical_bytes(unknown)) == unknown
    assert Manifest.model_validate_json(canonical_bytes(zero)) != unknown


def test_sources_sort_canonically_and_list_a_position_once() -> None:
    a, b = _asset(1, 0), _asset(2, 0)
    first, second = UUID(int=1), UUID(int=2)
    one = Manifest(
        schema_version=1,
        assets=(a, b),
        sources=(
            ManifestSource(
                source_id=second,
                occurrences=(_occurrence(b.asset_id, 3, 0.3), _occurrence(a.asset_id, 0, 0.0)),
            ),
            ManifestSource(source_id=first, occurrences=(_occurrence(a.asset_id, 5, 0.5),)),
        ),
    )
    assert [s.source_id for s in one.sources] == [first, second]
    assert [o.position for o in one.sources[1].occurrences] == [0, 3]
    with pytest.raises(ValidationError, match="at most once"):
        ManifestSource(
            source_id=first,
            occurrences=(_occurrence(a.asset_id, 0, 0.0), _occurrence(b.asset_id, 0, 0.0)),
        )
    with pytest.raises(ValidationError, match="listed at most once"):
        Manifest(schema_version=1, assets=(a, b), sources=(one.sources[0], one.sources[0]))


def test_an_occurrence_names_a_held_asset_and_agrees_with_its_observation() -> None:
    asset, elsewhere = _asset(1, 1), _asset(2, 0)
    source = uuid4()
    with pytest.raises(ValidationError, match="does not hold"):
        Manifest(
            schema_version=1,
            assets=(asset,),
            sources=(
                ManifestSource(
                    source_id=source, occurrences=(_occurrence(elsewhere.asset_id, 0, 0.0),)
                ),
            ),
        )
    track = ManifestTrack(
        id=uuid4(), source_id=source, label_class="car", observations=(_observing(asset, 0, 2),)
    )
    for disagreeing in (
        _occurrence(asset.asset_id, 2, None),
        _occurrence(elsewhere.asset_id, 2, 2.0),
    ):
        with pytest.raises(ValidationError, match="otherwise than the source lists it"):
            Manifest(
                schema_version=1,
                assets=(asset, elsewhere),
                tracks=(track,),
                sources=(ManifestSource(source_id=source, occurrences=(disagreeing,)),),
            )


def test_cutting_a_manifest_cuts_its_sources() -> None:
    kept, lost = _asset(1, 0), _asset(2, 0)
    shared, alone = uuid4(), uuid4()
    manifest = Manifest(
        schema_version=1,
        assets=(kept, lost),
        sources=(
            ManifestSource(
                source_id=shared,
                occurrences=(
                    _occurrence(kept.asset_id, 0, 0.0),
                    _occurrence(lost.asset_id, 1, 0.1),
                ),
            ),
            ManifestSource(source_id=alone, occurrences=(_occurrence(lost.asset_id, 0, 0.0),)),
        ),
    )
    cut = manifest_within(manifest, (kept,))
    assert [(s.source_id, [o.position for o in s.occurrences]) for s in cut.sources] == [
        (shared, [0])
    ]


def test_an_observation_may_carry_unknown_timing_but_never_a_negative_one() -> None:
    asset = _asset(1, 1)
    assert (
        ManifestObservation(
            position=0,
            timestamp=None,
            asset_id=asset.asset_id,
            annotation_id=asset.annotations[0].id,
        ).timestamp
        is None
    )
    with pytest.raises(ValidationError):
        _occurrence(asset.asset_id, 0, -1.0)


def test_a_sequence_is_timed_throughout_or_not_at_all() -> None:
    untimed = ImportedSequence(name="task", frames=(ImportedFrame(path="a.png", timestamp=None),))
    assert untimed.frames[0].timestamp is None
    with pytest.raises(ValidationError, match="times some frames and not others"):
        ImportedSequence(
            name="task",
            frames=(
                ImportedFrame(path="a.png", timestamp=0.0),
                ImportedFrame(path="b.png", timestamp=None),
            ),
        )
