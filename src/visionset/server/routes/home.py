# usage: from visionset.server.routes import home
"""The workspace's front page, composed server-side.

One route, and the composition is the point of it. The page it answers asks four
questions at once — what is here, what is waiting, where do I carry on, what
happened — and every one of them spans projects. Answered as separate resources
this would be a request per project per question, with the browser doing the
joining and the page rendering in pieces as they landed.

Not nested under anything, and not a resource. A summary is not a thing anybody
can fetch a second one of, address by id, or change; it is a **projection**,
recomputed on every call. That is why it takes no path parameters, declares no
``allowed_actions``, and has no sibling verbs: there is nothing here to act on,
only rows pointing at resources that declare their own capabilities.

The workspace is the one the server was started against, so it is not in the
path either. ``/home`` names the page rather than a noun in the domain, which is
the one place this API does that, and it is deliberate — the alternative spellings
(``/summary``, ``/workspace``) name either the projection's shape or an object
whose real identity is the file the server was opened on.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from visionset.kernel.services import SummaryService
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.models import HomeOut

router = protected_router(prefix="/home", tags=["home"])


@router.get("")
def get_home(workspace: WorkspaceDep) -> HomeOut:
    """Everything the workspace's front page shows, in one response.

    `totals` counts the whole workspace. `projects` is a short shortcut into the
    project list, not a copy of it, and `activity` is capped — both have a screen
    that owns them in full.

    `resume` is the batch to carry on with, **derived on every call and never
    stored**. Read its `kind` first: `annotate` means `next_asset_id` is a frame
    nobody has labeled, `review` means it is one awaiting a reviewer, and `open`
    means the batch is settled throughout and `next_asset_id` is null — open its
    gallery rather than the editor. The three are in priority order, decided
    here, and a client renders what it is told rather than working it out again.
    `resume` itself is null when no batch is open for annotation.

    Batches are ranked by when somebody last worked them. Ones nobody has worked
    since that became recordable rank last, ordered among themselves by how far
    through they are — which is every batch in a workspace created before the
    stamp existed, since it was added without a backfill.

    `attention` carries batches with frames awaiting review, and background jobs
    that failed or are still running. A job row has no `project_id`: a job names
    an ingest run or a release, never a project.

    An empty workspace answers zeros, nulls and empty lists. That is the
    first-run state, and `totals.projects` is how a client recognises it.
    """
    return HomeOut.of(SummaryService(workspace).summary())
