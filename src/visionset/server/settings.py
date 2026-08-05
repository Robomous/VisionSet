# usage: from visionset.server.settings import settings
"""The repository's first settings object, and it is deliberately three fields.

**Why there was none until now.** Configuration here has been four bare
``os.environ`` reads — the workspace, the session mode, the MCP destructive gate —
and each is read once, at a place that already had a reason to be reading the
environment. A settings class would have been ceremony around four strings.

What changed is that the executor has knobs whose *defaults* carry an argument.
"One worker" is not a number somebody picked; it is a claim about a single-writer
store, and a claim needs somewhere to be written down beside the value it
justifies. That is what this file is for.

**Server-side only.** The kernel's executor takes these as plain constructor
arguments, so nothing below the delivery layer reads an environment variable —
the rule that keeps a service testable without ``monkeypatch.setenv``. Nothing
here is a CLI flag either: these are knobs for an operator tuning a deployment,
not features somebody chooses per run, and ``visionset ui`` already has more flags
than it wants.

**The existing four reads stay where they are.** Migrating them is a change to
four shipped surfaces for no behaviour, and it would put ``VISIONSET_WORKSPACE``
— which the CLI *writes* on the server's behalf — behind an object the CLI cannot
import. Whoever adds the fifth knob decides whether it has earned a move.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from visionset.jobs import DEFAULT_POLL_INTERVAL_S, DEFAULT_WORKERS
from visionset.kernel.adapters.sqlite_progress_reporter import DEFAULT_MIN_INTERVAL_S


class JobSettings(BaseSettings):
    """How the embedded executor is tuned, from ``VISIONSET_``-prefixed variables."""

    model_config = SettingsConfigDict(env_prefix="VISIONSET_", extra="ignore")

    job_workers: int = Field(
        default=DEFAULT_WORKERS,
        ge=1,
        description=(
            "How many worker processes run jobs. One by default, and that is a "
            "property of the store rather than a conservative guess: SQLite has a "
            "single writer and a run writes progress as it goes. Raising it is "
            "supported and the contention degrades to WorkspaceBusy, which is a "
            "503 with Retry-After."
        ),
    )
    job_poll_interval_s: float = Field(
        default=DEFAULT_POLL_INTERVAL_S,
        gt=0,
        description=(
            "How long the dispatcher sleeps when it finds nothing to claim. An "
            "enqueue wakes it immediately, so this only governs the case nobody "
            "is watching — an orphan re-queued at startup, or a wake-up that "
            "raced a claim."
        ),
    )
    job_progress_min_interval_s: float = Field(
        default=DEFAULT_MIN_INTERVAL_S,
        ge=0,
        description=(
            "How often a running job may touch its row. Zero writes every report, "
            "which is what the ingest service does on its own row and is safe at "
            "one worker; the default bounds the writes by the run's duration "
            "instead of by its item count."
        ),
    )


@lru_cache(maxsize=1)
def job_settings() -> JobSettings:
    """The settings this process is running with.

    Cached, because reading the environment repeatedly cannot give a different
    answer within one process and pydantic-settings does real work to parse it.

    A **function** rather than a module-level instance, and that is the test seam
    ``static_root`` already established: a constant would freeze the answer at
    import, where ``scripts/export_openapi.py`` imports this module in an
    environment nobody configured and no test could reach it.
    ``job_settings.cache_clear()`` is what a test calls after ``monkeypatch.setenv``.
    """
    return JobSettings()
