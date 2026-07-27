# usage: from visionset.kernel.domain import Partition, SingleJob, BySize, BySegments
"""How a batch is cut into the jobs that annotate it.

A partition is **exact**: the segments are pairwise disjoint and their union is
the batch, every asset landing in exactly one job. That is not a nicety. Two jobs
sharing an asset means two annotators labeling it without knowing; an asset in no
job means a batch that can never complete, because completion is derived from
its jobs. Both failures are silent, which is why the invariant is established
here — in one pure function — rather than trusted to each caller.

The strategies are a discriminated union on ``kind``, the same shape as
``Geometry``: a delivery surface passes one serializable value instead of a set
of mutually exclusive keyword arguments it has to police.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from visionset.kernel.errors import InvalidPartition


class SingleJob(BaseModel):
    """One job for the whole batch. The default, and the common case."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["single"] = "single"


class BySize(BaseModel):
    """Jobs of ``size`` assets each; the last one takes the remainder."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["by_size"] = "by_size"
    size: int = Field(gt=0)


class BySegments(BaseModel):
    """Exactly these segments — the caller has already decided the split.

    Checked against the batch rather than taken on trust: see
    :func:`partition_assets`.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["by_segments"] = "by_segments"
    segments: tuple[tuple[UUID, ...], ...]


Partition = Annotated[SingleJob | BySize | BySegments, Field(discriminator="kind")]
"""Every way a batch can be cut into jobs."""


def partition_assets(
    asset_ids: Sequence[UUID], partition: Partition
) -> tuple[tuple[UUID, ...], ...]:
    """Cut ``asset_ids`` into job-sized segments, in the batch's own order.

    The result is always an exact partition of ``asset_ids``. An empty input
    yields no segments at all rather than one empty segment — a job with no
    assets is not a job.

    Raises:
        InvalidPartition: ``BySegments`` did not reproduce the batch exactly.
    """
    if not asset_ids:
        return ()
    match partition:
        case SingleJob():
            return (tuple(asset_ids),)
        case BySize(size=size):
            return tuple(
                tuple(asset_ids[start : start + size]) for start in range(0, len(asset_ids), size)
            )
        case BySegments(segments=segments):
            _require_exact(asset_ids, segments)
            return segments


def _require_exact(asset_ids: Sequence[UUID], segments: Sequence[Sequence[UUID]]) -> None:
    """Refuse segments that are not a partition of the batch, saying which fault.

    A caller who wrote the segments out by hand has a concrete list to fix, so
    each fault is named separately instead of collapsing into one "invalid".
    """
    if any(not segment for segment in segments):
        raise InvalidPartition("a segment is empty; a job with no assets is not a job")

    counted = Counter(asset_id for segment in segments for asset_id in segment)
    if repeated := sorted(str(a) for a, times in counted.items() if times > 1):
        raise InvalidPartition(
            f"these assets appear in more than one segment: {', '.join(repeated)}"
        )

    wanted = set(asset_ids)
    if strangers := sorted(str(a) for a in counted.keys() - wanted):
        raise InvalidPartition(f"these assets are not in the batch: {', '.join(strangers)}")
    if missing := sorted(str(a) for a in wanted - counted.keys()):
        raise InvalidPartition(
            f"these assets are in the batch but in no segment: {', '.join(missing)}"
        )
