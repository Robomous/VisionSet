# usage: from visionset.mcp._autostart import autostarted
"""Taking a job to ``in_progress`` on the first write, so an agent never has to say so.

#109, and the evidence is #36's twelve real agent runs: two of them wrote every
label in a job and then had ``complete_job`` refuse, because writing was gated on
the **batch** being ``in_annotation`` and not on the job, so nothing in the loop
forced a start until the very last call. Both recovered — the kernel's sentence
names the reachable state — but the round trip was wasted, and the description
fix #36 shipped could only warn about the ceremony, not remove it.

#439 has since given writes a job gate too, and it leaves that reasoning intact:
``OPEN_JOB_STATES`` holds ``pending``, so a job nobody started is still a job
that may be written into.

**This is adapter policy, not a domain change.** ``JOB_TRANSITIONS`` is untouched,
``require_move`` is still the funnel, and the move made here is the same
``JobService.start`` the retired ``start_job`` tool called. What changed is who
says it: the annotator page has always started a job when a human opens it, and
this is that behaviour for the surface whose caller is a model. The other two
surfaces keep their explicit start — a CLI's explicitness is its contract, and
REST is what the page drives.

**The start happens before the write, so a refused write can leave a job
started.** That is the annotator page's property too — opening it starts the job
whether or not the human then draws anything — and ``in_progress`` means "somebody
has this open", which is true of an agent whose annotation batch was rejected. The
alternative, writing first and starting after, turns a concurrent start into a
refusal *for a write that already succeeded*, which is worse than a job marked as
being worked on by somebody who is working on it.

Only ``pending`` is moved. A job that is already ``in_progress`` reports no start,
and one that is ``completed`` is left alone for the write's own gate to answer —
``JobFinished``, since #439 — the guard being a state check rather than a
swallowed ``InvalidTransition``, so no refusal anybody wrote is hidden.
"""

from __future__ import annotations

from uuid import UUID

from visionset.kernel.domain import AnnotationJobState
from visionset.kernel.services import JobService, WorkspaceService


def autostarted(workspace: WorkspaceService, job_id: UUID) -> bool:
    """Start the job if it is ``pending``, and say whether that is what happened.

    The boolean is the whole point: it is what every write tool reports back, so
    the move is never an invisible side effect of a call the agent made for
    another reason.

    Raises:
        JobNotFound: no such job in this workspace — the same refusal the write
            itself would have raised a moment later, through the same lookup.
        BatchNotInAnnotation: the job's batch is not open for annotation. Also
            the write's own gate, and worded once in ``JobService``, so a closed
            batch refuses exactly as it did before this ran at all.
    """
    service = JobService(workspace)
    if service.get(job_id).state is not AnnotationJobState.PENDING:
        return False
    service.start(job_id)
    return True
