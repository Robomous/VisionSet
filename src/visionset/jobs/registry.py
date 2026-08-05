# usage: from visionset.jobs.registry import REGISTRY, resolve
"""Which job types exist, and the import string that runs each one.

**Why this package is not in the kernel.** A handler may need a format plugin —
the export handler resolves an ``Exporter`` through ``visionset.formats.registry``
— and import-linter forbids ``visionset.kernel`` from importing that. The same
wall that makes ``ReleaseService.export`` take an ``Exporter`` *instance* rather
than a format name puts the handlers one package out. So ``visionset.jobs`` is a
sibling of ``visionset.formats`` and ``visionset.wire``: above the kernel, below
the three delivery surfaces, and forbidden from importing any of them.

**Handlers are registered by import string, never by function object, and the
reason is ``spawn``.** A worker process is a fresh interpreter that has imported
nothing; a function object would have to be pickled by reference to a module the
child may not have loaded, and the failure mode is an ``AttributeError`` raised
inside a pool with no job id in the traceback. An import string is a plain
``str`` — it pickles trivially, it is resolved *in the worker* by the one function
below, and a typo in one is caught by a test that imports every ref rather than by
production.

**The registry is populated by import, which is the one thing to remember about
it.** A type is known because something has named it, so a process that never
imported this module's neighbours has an empty registry and refuses everything.
:func:`known_types` is what the surfaces check against, and importing
``visionset.jobs`` is what fills it — see this package's ``__init__``.
"""

from __future__ import annotations

from collections.abc import Callable
from importlib import import_module
from pathlib import Path
from typing import Final, Protocol

from pydantic import BaseModel, ConfigDict, JsonValue

from visionset.kernel.errors import UnknownJobType
from visionset.kernel.ports import ProgressReporter

#: What every handler is, and the whole contract between the executor and the work.
#:
#: Three arguments, and each is what it is because of the process boundary. A
#: **path**, not a ``WorkspaceService``: measured against a real workspace, the
#: service, the store, the SQLAlchemy engine and the auth provider all fail to
#: pickle, because each transitively holds an engine whose ``connect`` is a
#: closure. **Plain JSON data**, not domain models: the payload has already
#: crossed a database column by the time a handler sees it. A **reporter**, not a
#: queue: a handler may say how far it has got and ask whether to stop, and must
#: not be able to settle itself — that authority stays with the dispatcher.
#:
#: The return value is the job's ``result``: small, JSON-shaped, and read by
#: whoever polls. A handler with nothing to say returns ``{}``.
type JobHandler = Callable[[Path, dict[str, JsonValue], ProgressReporter], dict[str, JsonValue]]


class _Handler(Protocol):
    """Structural spelling of :data:`JobHandler`, for :func:`load`'s return cast.

    A ``Protocol`` rather than a ``cast`` to the alias, so that a module attribute
    that is *not* callable fails at the boundary with a message naming the ref
    instead of at the call site with ``'str' object is not callable``.
    """

    def __call__(
        self,
        workspace_root: Path,
        payload: dict[str, JsonValue],
        reporter: ProgressReporter,
        /,
    ) -> dict[str, JsonValue]: ...


class HandlerRef(BaseModel):
    """One job type, and where the code that runs it lives.

    Frozen and trivially picklable — three strings and a boolean — because this
    is what crosses into the worker. ``func`` is ``module:attribute``, the same
    spelling uvicorn takes for an application and ``visionset ui`` already relies
    on, so there is one convention for "name some code without importing it".
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: str
    func: str
    #: Whether running this twice is safe. See ``BackgroundJobSpec.idempotent``;
    #: it is declared here rather than per enqueue because it is a property of
    #: the *handler*, and a caller free to claim otherwise would eventually claim
    #: wrongly.
    idempotent: bool = False


#: Every job type this build can run, by name.
#:
#: A plain dict populated at import rather than an entry-point group, and that is
#: the deliberate difference from ``visionset.formats``. A format is a *plugin*: a
#: third-party distribution registers one and the product must discover it without
#: knowing it exists. A job type is not — it is a piece of this product's own
#: behaviour, its payload shape is an internal contract, and a queue row naming a
#: handler that vanished with an uninstall is a failure nobody could act on.
REGISTRY: Final[dict[str, HandlerRef]] = {}


def register(ref: HandlerRef) -> HandlerRef:
    """Add a handler. Refuses a duplicate type rather than silently replacing one.

    FastMCP logs and discards a duplicate tool registration; that is the wrong
    behaviour here, because two modules claiming one type means one of them is
    never going to run and nothing would say which.
    """
    if ref.type in REGISTRY and REGISTRY[ref.type] != ref:
        raise ValueError(
            f"job type {ref.type!r} is already registered to {REGISTRY[ref.type].func!r}"
        )
    REGISTRY[ref.type] = ref
    return ref


def known_types() -> frozenset[str]:
    """Every type something can run right now."""
    return frozenset(REGISTRY)


def resolve(job_type: str) -> HandlerRef:
    """The ref for a type, or refuse because nothing runs it.

    Raises:
        UnknownJobType: no handler is registered. The message names what *is*
            registered, because the two causes — a typo, and a module nobody
            imported — look identical from the outside and the list tells them
            apart.
    """
    ref = REGISTRY.get(job_type)
    if ref is None:
        known = ", ".join(sorted(REGISTRY)) or "none"
        raise UnknownJobType(
            f"no handler is registered for job type {job_type!r}; registered types: {known}"
        )
    return ref


def load(ref: HandlerRef) -> _Handler:
    """Import ``ref.func`` and return the callable behind it.

    **Called in the worker, not in the process that enqueued.** That is the whole
    reason a ref is a string: resolution happens where the code will run, in an
    interpreter that ``spawn`` started with nothing loaded.

    Raises:
        UnknownJobType: the module or the attribute is not there, or what is
            there is not callable. All three are the same thing to a caller — a
            type that names code this build cannot run — so they answer with one
            error rather than leaking ``ImportError`` and ``AttributeError`` into
            a dispatcher that would have to catch both.
    """
    module_name, _, attribute = ref.func.partition(":")
    if not attribute:
        raise UnknownJobType(f"handler {ref.func!r} is not in 'module:attribute' form")
    try:
        module = import_module(module_name)
    except ImportError as exc:
        raise UnknownJobType(
            f"handler {ref.func!r} names a module that will not import: {exc}"
        ) from exc
    found = getattr(module, attribute, None)
    if not callable(found):
        raise UnknownJobType(f"handler {ref.func!r} names nothing callable")
    return found  # type: ignore[no-any-return]
