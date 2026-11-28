# usage: from visionset.jobs.settings import job_settings, workspace_settings
"""The executor's knobs, and the read-only settings every surface publishes.

**Why the executor has a settings object.** Its knobs have *defaults* that carry
an argument. "One worker" is not a number somebody picked; it is a claim about a
single-writer store, and a claim needs somewhere to be written down beside the
value it justifies.

**Below the surfaces, outside the kernel.** The kernel's executor takes these as
plain constructor arguments, so nothing in the kernel reads an environment
variable — the rule that keeps a service testable without ``monkeypatch.setenv``.
They live here rather than in the server so the CLI and MCP can report them too:
:func:`workspace_settings` is built once and every surface serializes it. Nothing
here is a CLI flag: these are knobs for an operator tuning a deployment.

**The other bare environment reads stay where they are** — the workspace, the
session mode, the MCP destructive gate. Migrating them is a change to shipped
surfaces for no behaviour.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Final

from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from visionset import __version__
from visionset.jobs.runner import DEFAULT_POLL_INTERVAL_S, DEFAULT_WORKERS
from visionset.kernel.adapters.sqlite_progress_reporter import DEFAULT_MIN_INTERVAL_S
from visionset.kernel.domain import ExecutorStatus, ExecutorVariable, WorkspaceSettings
from visionset.tracking import tracking_status

_PREFIX: Final = "VISIONSET_"


class JobSettings(BaseSettings):
    """How the embedded executor is tuned, from ``VISIONSET_``-prefixed variables."""

    model_config = SettingsConfigDict(env_prefix=_PREFIX, extra="ignore")

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


def _variable(field: str) -> str:
    return f"{_PREFIX}{field}".upper()


def executor_status() -> ExecutorStatus:
    """The executor's values here beside their defaults, or which variable is refused.

    ``visionset server`` refuses to start on a refused value, so the values are
    withheld rather than guessed.
    """
    fields = JobSettings.model_fields
    try:
        current = job_settings()
    except ValidationError as exc:
        refused = sorted({_variable(str(error["loc"][0])) for error in exc.errors()})
        return ExecutorStatus(
            variables=tuple(
                ExecutorVariable(name=_variable(name), value=None, default=field.default)
                for name, field in fields.items()
            ),
            problem=(
                f"{', '.join(refused)} is not a valid value, and `visionset server` "
                "does not start until it is."
            ),
        )
    return ExecutorStatus(
        variables=tuple(
            ExecutorVariable(
                name=_variable(name), value=getattr(current, name), default=field.default
            )
            for name, field in fields.items()
        ),
        problem=None,
    )


def workspace_settings() -> WorkspaceSettings:
    """What this process runs with, as REST, the CLI and MCP all publish it."""
    return WorkspaceSettings(
        version=__version__,
        tracking=tracking_status(),
        executor=executor_status(),
    )
