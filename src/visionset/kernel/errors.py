# usage: from visionset.kernel import EntityNotFound, VisionSetError
"""Domain errors raised by the kernel.

Every error the kernel raises derives from ``VisionSetError``, so a delivery
surface can translate the whole family to an HTTP status or an exit code with a
single ``except`` clause. The kernel NEVER raises a framework exception —
``HTTPException`` and friends belong to the boundary, not here.

Persistence and workspace errors live here today; later services add their own
(``ProjectNotFound``, ``InvalidTransition``, ...) as they land.
"""

from __future__ import annotations


class VisionSetError(Exception):
    """Base class for every error the kernel raises."""


class EntityNotFound(VisionSetError):
    """An operation addressed an entity id that is not in the store."""


class EntityAlreadyExists(VisionSetError):
    """An insert collided with an existing primary key."""


class ConstraintViolated(VisionSetError):
    """The store refused a write that broke one of its constraints.

    A foreign key with no parent, or a uniqueness rule the store enforces on the
    services' behalf. The translation happens in the adapter so that no
    SQLAlchemy exception ever escapes the kernel.

    A violation ends the transaction it happened in: SQLAlchemy refuses further
    work on it, so a service cannot catch this and carry on. That is why service
    rules check *before* writing rather than relying on the write to fail.
    """


class NotAWorkspace(VisionSetError):
    """There is no VisionSet workspace at that path.

    Either nothing is there, or the directory holds no metadata store — the
    presence of the database file is what makes a directory a workspace.
    """


class WorkspaceNotEmpty(VisionSetError):
    """``init`` refused to create a workspace over existing content.

    Initializing never writes into a directory that already holds something.
    The safe failure is refusing, not merging.
    """


class WorkspaceAlreadyExists(VisionSetError):
    """``init`` was pointed at a directory that is already a workspace.

    Separate from ``WorkspaceNotEmpty`` because the remedy differs: open it.
    """


class WorkspaceCorrupt(VisionSetError):
    """The workspace layout is present but unusable.

    A metadata store that is not a readable database, that carries no VisionSet
    schema, or that does not hold exactly one workspace row. Distinct from
    ``NotAWorkspace`` (nothing there) and from ``WorkspaceFormatTooNew``
    (readable, merely newer than this build).
    """


class WorkspaceFormatTooNew(VisionSetError):
    """The stored ``format_version`` is newer than this VisionSet understands.

    Migrations only ever run forward, so a workspace written by a later version
    is unreadable rather than silently downgraded.
    """


class InvalidName(VisionSetError):
    """A name was empty, or blank once surrounding whitespace was removed."""


class ProjectNameTaken(VisionSetError):
    """Another project in this workspace already uses that name.

    Names are unique per workspace, ignoring case and surrounding whitespace.
    The rule is enforced twice on purpose — see ``WorkspaceService``.
    """


class ProjectNotFound(VisionSetError):
    """No project with that id lives in this workspace.

    Deliberately not an ``EntityNotFound``: that one means a row was missing
    where the store required one (an ``update`` against a vanished primary key),
    which is a programming error. This one is the ordinary answer to a caller
    naming a project that was never created, or was deleted, or belongs to a
    different workspace — a delivery surface turns it into a 404, not a 500.
    """


class ConfirmationRequired(VisionSetError):
    """A destructive operation was called without ``confirm=True``.

    The guard is a parameter rather than a prompt because the kernel has no
    terminal and no user: every surface — CLI, REST, MCP — asks in its own
    idiom and then passes the answer down. Refusing by default means a caller
    that forgets to ask cannot delete anything by accident.
    """
