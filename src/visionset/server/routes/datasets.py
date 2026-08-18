# usage: from visionset.server.routes import datasets
"""The dataset: a project's curated trunk, and the log of everything done to it.

Two routers, the ``sources.py`` split. The collection route is singular —
``GET /projects/{project_id}/dataset`` — because the relation is 1:1: a project
has exactly one dataset, created in the same transaction as the project itself.
It is a *discovery* route rather than a listing, and it is how a client that
holds a project id gets the dataset id every route below wants.

**Promotion is not here.** It hangs off the batch, in ``batches.py``, because
``DatasetService.promote`` takes a batch id and derives the dataset from it —
that handler's own comment carries the argument.

**Removal is a 204 whether or not it changed anything.** ``remove_asset``
answers ``False`` for an asset that was not a member, and that is not a 404: the
caller asked for the asset to be out of the trunk, and it is. Nothing is
destroyed either — the asset, its annotations and its blob all stay, and the
change log keeps the prior state on the record — which is why this is the one
delete in the API with no ``confirm`` gate.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import Response, status

from visionset.kernel.services import DatasetService, ProjectService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import documented
from visionset.server.models import (
    AssetOut,
    AssetPage,
    DatasetChangeOut,
    DatasetChangePage,
    DatasetOut,
    DatasetStatsOut,
    LimitQuery,
    OffsetQuery,
    window,
)

project_router = protected_router(prefix="/projects/{project_id}/dataset", tags=["datasets"])
router = protected_router(prefix="/datasets", tags=["datasets"])


@project_router.get("", responses=documented(404))
def get_project_dataset(workspace: WorkspaceDep, project_id: UUID) -> DatasetOut:
    """The project's dataset.

    Singular, and there is never a second one: the dataset is created with the
    project and its name moves with it. This is the route that turns a project id
    into the dataset id everything under `/datasets` needs.
    """
    return DatasetOut.of(ProjectService(workspace).get_dataset(project_id))


@router.get("/{dataset_id}", responses=documented(404))
def get_dataset(workspace: WorkspaceDep, dataset_id: UUID) -> DatasetOut:
    """The dataset with that id."""
    return DatasetOut.of(DatasetService(workspace).get(dataset_id))


@router.get("/{dataset_id}/stats", responses=documented(404))
def dataset_stats(workspace: WorkspaceDep, dataset_id: UUID) -> DatasetStatsOut:
    """What the trunk currently holds, counted overall and per label class.

    Counted on every call rather than cached, so it always describes the trunk as
    it stands. `classes` lists only classes that appear at least once — which
    classes *exist* is a property of the schema, and `GET
    /projects/{project_id}/schema` is where to read that.

    Per class you get both numbers because they answer different questions: a
    thousand `sign` boxes over a thousand images and the same thousand over ten
    are the same `annotations` and a very different dataset.

    `asset_count` minus `annotated_asset_count` is how many members carry no
    labels at all, which is legitimate — unlabeled images are training data, and
    only a release of *zero* assets is refused.
    """
    return DatasetStatsOut.of(DatasetService(workspace).stats(dataset_id))


@router.get("/{dataset_id}/assets", responses=documented(404))
def list_dataset_assets(
    workspace: WorkspaceDep,
    dataset_id: UUID,
    limit: LimitQuery = None,
    offset: OffsetQuery = 0,
) -> AssetPage:
    """Everything in the trunk, in the order it was promoted.

    Paged, and the second route in the API that is — the trunk accumulates every
    batch a project ever completed, so it is the other collection that can hold
    fifty thousand items. `total` is the size of the whole trunk and not of the
    page; an offset past the end is an empty list and a 200, never a 404. The
    404 is the dataset itself: an unknown one is `DATASET_NOT_FOUND`.

    Order is the stored insertion order, so reading twice gives the same sequence
    and promoting a new batch appends rather than reshuffles.
    """
    found = DatasetService(workspace).assets(dataset_id)
    items = [AssetOut.of(asset) for asset in window(found, limit=limit, offset=offset)]
    return AssetPage(items=items, total=len(found))


@router.delete(
    "/{dataset_id}/assets/{asset_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=documented(404),
)
def remove_dataset_asset(workspace: WorkspaceDep, dataset_id: UUID, asset_id: UUID) -> Response:
    """Take one asset out of the trunk.

    Curation, not deletion: the asset, its annotations and its bytes all stay
    exactly where they were, and only the membership row goes. That is why there
    is no `confirm` gate here — there is nothing to destroy.

    204 whether or not the asset was a member. An id that was never in the trunk
    leaves it in the state the caller asked for, and reporting that as a 404
    would make a retry of a successful request look like a failure. The change
    log records only the calls that actually changed something. The dataset is
    the one thing that has to exist: an unknown one is 404 `DATASET_NOT_FOUND`.

    Not permanent, either: re-promoting the batch the asset came from puts it
    back, because the trunk keeps no memory of removals.
    """
    DatasetService(workspace).remove_asset(dataset_id, asset_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{dataset_id}/changes", responses=documented(404))
def list_dataset_changes(workspace: WorkspaceDep, dataset_id: UUID) -> DatasetChangePage:
    """The trunk's append-only mutation log, oldest entry first.

    Every line is a change somebody can point at: a promote that added nothing
    writes no entry, and neither does removing an asset that was not there.
    Entries are never updated or deleted.

    `subject_ids` is shaped by the operation — for `promote` it is the batch
    followed by the assets it contributed, and for `remove_asset` it is the one
    asset. `operation` is an open string rather than an enum, so an entry written
    by a later VisionSet naming an operation this build has not heard of is still
    readable.
    """
    found = DatasetService(workspace).changes(dataset_id)
    return DatasetChangePage(
        items=[DatasetChangeOut.of(change) for change in found], total=len(found)
    )
