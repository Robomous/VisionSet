"""Cutting a batch into jobs.

The property every case here checks is the same one, and it is why the function
exists: the segments are an *exact* partition of the batch. An asset in two jobs
is two annotators labeling it unaware of each other; an asset in no job is a
batch that can never complete.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest

from visionset.kernel import InvalidPartition
from visionset.kernel.domain import BySegments, BySize, Partition, SingleJob, partition_assets


def _ids(count: int) -> list[UUID]:
    return [uuid4() for _ in range(count)]


# --- the shapes each strategy produces ----------------------------------------


def test_a_single_job_takes_the_whole_batch_in_order() -> None:
    assets = _ids(5)
    assert partition_assets(assets, SingleJob()) == (tuple(assets),)


def test_by_size_fills_each_job_before_starting_the_next() -> None:
    assets = _ids(7)
    segments = partition_assets(assets, BySize(size=3))
    assert [len(segment) for segment in segments] == [3, 3, 1]
    assert segments[0] == tuple(assets[:3])


def test_by_size_larger_than_the_batch_is_one_job() -> None:
    assets = _ids(3)
    assert partition_assets(assets, BySize(size=99)) == (tuple(assets),)


def test_by_segments_is_taken_as_written_once_it_checks_out() -> None:
    assets = _ids(4)
    segments = ((assets[0], assets[2]), (assets[1], assets[3]))
    assert partition_assets(assets, BySegments(segments=segments)) == segments


def test_an_empty_batch_yields_no_segments_at_all() -> None:
    """Not one empty segment — a job with no assets is not a job."""
    assert partition_assets([], SingleJob()) == ()
    assert partition_assets([], BySize(size=4)) == ()


def test_a_size_of_zero_or_less_is_not_a_strategy() -> None:
    with pytest.raises(ValueError):
        BySize(size=0)


# --- the property, across every strategy --------------------------------------


def _strategies(assets: list[UUID]) -> list[tuple[str, Partition]]:
    """Every strategy, instantiated against this particular batch."""
    return [
        ("single", SingleJob()),
        ("by_size=1", BySize(size=1)),
        ("by_size=2", BySize(size=2)),
        ("by_size=len", BySize(size=max(len(assets), 1))),
        ("by_size>len", BySize(size=len(assets) + 3)),
        ("by_segments", BySegments(segments=tuple((a,) for a in assets))),
    ]


@pytest.mark.parametrize("count", [1, 2, 3, 5, 8, 13])
def test_every_strategy_produces_an_exact_partition(count: int) -> None:
    assets = _ids(count)
    for name, partition in _strategies(assets):
        segments = partition_assets(assets, partition)
        flattened = [asset for segment in segments for asset in segment]

        assert all(segment for segment in segments), f"{name}: an empty segment"
        assert len(flattened) == len(set(flattened)), f"{name}: an asset is in two segments"
        assert set(flattened) == set(assets), f"{name}: the union is not the batch"
        assert flattened == assets, f"{name}: the batch's own order was not kept"


# --- the faults BySegments can carry ------------------------------------------


def test_a_segment_missing_an_asset_is_refused() -> None:
    assets = _ids(3)
    with pytest.raises(InvalidPartition, match="in no segment") as refused:
        partition_assets(assets, BySegments(segments=((assets[0], assets[1]),)))
    assert str(assets[2]) in str(refused.value)


def test_an_asset_in_two_segments_is_refused() -> None:
    assets = _ids(3)
    segments = ((assets[0], assets[1]), (assets[1], assets[2]))
    with pytest.raises(InvalidPartition, match="more than one segment") as refused:
        partition_assets(assets, BySegments(segments=segments))
    assert str(assets[1]) in str(refused.value)


def test_an_asset_that_is_not_in_the_batch_is_refused() -> None:
    assets = _ids(2)
    stranger = uuid4()
    with pytest.raises(InvalidPartition, match="not in the batch") as refused:
        partition_assets(assets, BySegments(segments=(tuple(assets), (stranger,))))
    assert str(stranger) in str(refused.value)


def test_an_empty_segment_is_refused() -> None:
    assets = _ids(2)
    with pytest.raises(InvalidPartition, match="a segment is empty"):
        partition_assets(assets, BySegments(segments=(tuple(assets), ())))


def test_no_segments_at_all_over_a_non_empty_batch_is_refused() -> None:
    assets = _ids(2)
    with pytest.raises(InvalidPartition, match="in no segment"):
        partition_assets(assets, BySegments(segments=()))


# --- the union is a discriminated one -----------------------------------------


def test_a_strategy_round_trips_through_its_discriminator() -> None:
    """A delivery surface passes one serializable value, not a set of flags."""
    from pydantic import TypeAdapter

    adapter: TypeAdapter[Partition] = TypeAdapter(Partition)
    for original in (SingleJob(), BySize(size=4)):
        assert adapter.validate_python(original.model_dump(mode="json")) == original
