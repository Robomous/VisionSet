# usage: from visionset.server.routes import batches
"""Batches: one route today, and it is the one an ingest needs.

An ingest puts what it gathered into a batch, so "what did that run produce?"
is answered here rather than on the job — the batch is where the membership
actually lives, and a second door onto the same rows would be a second thing to
keep in step.

**#29 owns this module from here on**: batch listing, detail with per-state
counts, approval with a partition spec, and paging plus per-asset progress on
the listing below. The envelope is what makes that additive — `total` already
means *matching the query* rather than *in this page*, so `limit` and `offset`
arrive beside it without breaking a client that parsed this shape today. See
``docs/api.md``.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from uuid import UUID

from visionset.kernel.services import BatchService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import AssetOut, AssetPage

router = protected_router(prefix="/batches", tags=["batches"])


@router.get("/{batch_id}/assets", responses=documented(404))
def list_batch_assets(workspace: WorkspaceDep, batch_id: UUID) -> AssetPage:
    """Everything in the batch, in membership order.

    The order is stored, so reading twice gives the same sequence and an ingest
    into an existing batch appends rather than reshuffles. An empty batch is a
    200 with an empty list, never a 404.

    Bytes are not here: an asset is named by its `content_hash` and its
    `thumbnail_hash`, and downloading either is a later capability.
    """
    found = BatchService(workspace).assets(batch_id)
    return AssetPage(items=[AssetOut.of(asset) for asset in found], total=len(found))
