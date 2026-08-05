"""The one test that uses a real `spawn` pool. Everything else drives a double.

**Why exactly one.** `spawn` starts a fresh interpreter that imports the world;
paying that per assertion would make this the slowest module in the suite for no
extra coverage, because what the other tests are about — claiming, settling,
announcing — is the same code either way. What only a real pool can prove is the
part the double replaces: that a `HandlerRef`, a `Path`, a `UUID` and a JSON dict
actually cross a process boundary, that the child can import and run the handler
it names, and that a domain refusal raised over there comes back as an `error` on
the row over here.

**Why it is a *failing* export.** The handler resolves a release that does not
exist, so the worker raises `ReleaseNotFound` — which exercises the whole path
(spawn → import → open the workspace → run → raise → future → settle) while
needing no ingested media, no schema and no release. A successful export would
add fixtures and prove nothing more about the boundary.

**The trap this module was written around**, found while building it: under
`spawn`, the child re-executes the parent's `__main__`. Run the same code from
`python -c` or a heredoc and the child dies with
`FileNotFoundError: '<stdin>'` — reported as `BrokenProcessPool`, which reads
like a bug in the pool. pytest's `__main__` is a real module, so it is fine here;
a *script* that spawns needs an `if __name__ == "__main__":` guard.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from visionset.jobs import JobRunner
from visionset.jobs.export import JOB_TYPE, payload_for
from visionset.kernel.domain import (
    BackgroundJobFailed,
    BackgroundJobSpec,
    BackgroundJobState,
)
from visionset.kernel.services import WorkspaceService

#: Generous: a spawned interpreter imports pydantic, SQLAlchemy and Pillow before
#: it runs a line of ours, and CI runners are shared. A deadlock still fails
#: rather than hangs.
SETTLE_TIMEOUT_S = 120.0


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws")
    yield made
    made.close()


def test_a_job_crosses_into_a_spawned_worker_and_reports_back(
    workspace: WorkspaceService,
) -> None:
    announced: list[BackgroundJobFailed] = []
    workspace.event_bus.subscribe(BackgroundJobFailed, announced.append)

    job = workspace.job_queue.enqueue(
        BackgroundJobSpec(
            type=JOB_TYPE,
            payload=payload_for(uuid4(), "dummy", allow_lossy=False),
            idempotent=True,
        )
    )

    runner = JobRunner(
        workspace.job_queue,
        workspace.root,
        event_bus=workspace.event_bus,
        workers=1,
        poll_interval_s=0.1,
    )
    runner.start()
    try:
        runner.wake()
        deadline = time.monotonic() + SETTLE_TIMEOUT_S
        while time.monotonic() < deadline:
            stored = workspace.job_queue.get(job.id)
            assert stored is not None
            if stored.settled:
                break
            # A poll rather than an Event, and it is the one place in this suite
            # that is right: the thing being waited for is in another *process*,
            # so there is no primitive both ends share.
            time.sleep(0.05)
    finally:
        runner.stop(timeout=SETTLE_TIMEOUT_S)

    stored = workspace.job_queue.get(job.id)
    assert stored is not None
    assert stored.state is BackgroundJobState.FAILED, stored
    # The domain's own sentence, raised in a worker and written on the row here.
    assert "no release" in (stored.error or "")
    # Claimed exactly once, by the dispatcher, and stamped.
    assert stored.attempt == 1
    assert stored.worker == "dispatcher"
    assert stored.started_at is not None

    assert [one.job_id for one in announced] == [job.id]
