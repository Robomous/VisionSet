# usage: from visionset.jobs.context import workspace_for
"""What a handler is allowed to reach for, on the far side of the process boundary.

A handler is handed a workspace **root**, not a workspace, because measured
against a real workspace neither ``WorkspaceService`` nor the store nor the
SQLAlchemy engine nor any kernel service will pickle — each one transitively holds
an engine whose ``connect`` is a closure. This module is the one line that turns
the path back into the handle.

**One workspace per worker, not one per task.** ``WorkspaceService.open`` runs
``initialize()``, which issues the pragmas, checks the migration ledger *and*
reflects the whole schema to compare it against ``_tables``. That is real work,
and the answer does not change between two jobs in the same process, so the first
task for a given root pays it and the rest of that worker's life does not.

**A handler must not close what it gets back.** The handle outlives the task by
design; closing it would checkpoint and dispose an engine the next task is about
to reopen, turning the cache into a slower way of doing nothing. Release happens
once, at interpreter exit.

**Module-level state, and here it is correct rather than a smell.** A worker
process runs one task at a time and belongs to one pool, so this dict is
process-local by construction — the thing a module-level cache is usually wrong
for, two applications sharing one, cannot happen. The parent's equivalent is
``WorkspaceHandle`` on ``app.state``, and it lives there precisely because two
applications *can* share an interpreter. Two workers cannot.
"""

from __future__ import annotations

import atexit
import logging
import sys
from pathlib import Path
from typing import Final

from visionset.kernel.services import WorkspaceService

_logger: Final = logging.getLogger(__name__)

#: Open workspaces in *this* process, by root. See the module docstring.
_WORKSPACES: Final[dict[Path, WorkspaceService]] = {}


def initialize_worker() -> None:
    """Give a spawned interpreter somewhere to log. Called once per worker.

    ``basicConfig`` here and nowhere else in this repository, and the exception is
    narrow enough to state. The kernel's rule — written on ``InProcessEventBus``,
    which owns its only logger — is that a *library module* must never configure
    the root logger, because that steals a decision from whoever imported it. A
    worker process is not a library module: it is a program entry point in a fresh
    interpreter where nothing has configured anything, and without this every
    ``logger.exception`` in a worker reaches the last-resort handler and is lost.

    stderr, because a spawned child inherits the parent's, so a worker's lines land
    exactly where uvicorn's do.
    """
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)


def workspace_for(root: Path) -> WorkspaceService:
    """This worker's handle on that workspace, opening one the first time.

    Keyed on the path as given rather than on a resolved one: the dispatcher sends
    ``WorkspaceService.root``, which is already absolute and symlink-free, and
    resolving it again is the double-expansion ``resolve_workspace_root`` warns
    about.
    """
    workspace = _WORKSPACES.get(root)
    if workspace is None:
        workspace = WorkspaceService.open(root)
        _WORKSPACES[root] = workspace
    return workspace


def close_workspaces() -> None:
    """Checkpoint and release, so no ``visionset.db-wal`` outlives the worker.

    Best-effort: the interpreter is on its way out and an exception here would
    print over whatever the run was actually doing. A *killed* worker skips this
    entirely, and SQLite recovers the sidecars on the next open — the same bargain
    ``WorkspaceService.close`` already documents.

    Public and separately callable, because a test that exercises the cache in the
    parent process needs a way to put it back.
    """
    for workspace in _WORKSPACES.values():
        try:
            workspace.close()
        except Exception:  # noqa: BLE001 — see the docstring
            _logger.debug("a worker could not close a workspace cleanly")
    _WORKSPACES.clear()


atexit.register(close_workspaces)
