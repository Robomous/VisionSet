# usage: from visionset.jobs import JobRunner, REGISTRY
"""Background job handlers, the registry that names them, and the dispatcher.

**A sibling of ``visionset.formats`` and ``visionset.wire``, and it is here for
the same kind of reason each of those is.** A handler may need a format plugin —
the export one resolves an ``Exporter`` — and import-linter forbids
``visionset.kernel`` from importing ``visionset.formats``. So the code that runs
queued work cannot live in the kernel, and it must not live in a delivery package
either: a worker process that imported ``visionset.server`` would, under
``spawn``, re-execute the module-level ``app = create_app()`` and build a second
application inside a worker. One package above the kernel and beside the other
two is the only place left, and the import-linter contracts say so out loud.

**Importing this package is what populates the registry.** A job type is known
because a module named it, so every handler module is imported here — that is
the whole mechanism, and it is why ``known_types()`` is empty in a process that
only imported ``visionset.jobs.registry``.

**And it is why the weight-download handler reaches its work through
``visionset.inference`` rather than importing torch.** This line runs in the API
process at startup and in every worker at spawn; a handler module that imported
the optional runtime at the top would make two gigabytes of CUDA wheels a
condition of starting a server that may never run a model.

The kernel still owns the vocabulary: ``JobQueue`` and ``ProgressReporter`` are
ports, ``BackgroundJob`` is a domain model, and ``SqliteJobQueue`` is a kernel
adapter. What lives here is *what the work is* and *where it runs*.
"""

from visionset.jobs import export, ingest, weights
from visionset.jobs.registry import (
    REGISTRY,
    HandlerRef,
    JobHandler,
    known_types,
    load,
    register,
    resolve,
)
from visionset.jobs.runner import DEFAULT_POLL_INTERVAL_S, DEFAULT_WORKERS, JobRunner

__all__ = [
    "DEFAULT_POLL_INTERVAL_S",
    "DEFAULT_WORKERS",
    "REGISTRY",
    "HandlerRef",
    "JobHandler",
    "JobRunner",
    "export",
    "ingest",
    "weights",
    "known_types",
    "load",
    "register",
    "resolve",
]
