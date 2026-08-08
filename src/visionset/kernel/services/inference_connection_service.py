# usage: from visionset.kernel.services import InferenceConnectionService
"""Model connections: the one door to where this workspace may run inference.

Creating, reading, editing and removing the rows every predictor is instantiated
from — and, since #418's second slice, saying whether one may be asked to fetch
its weights and recording that they arrived.

**Nothing here predicts, downloads, or reaches a network**, and that stays true
of the download: :meth:`~InferenceConnectionService.require_downloadable` decides
whether fetching is something to do, ``visionset.inference`` does the fetching,
and :meth:`~InferenceConnectionService.record_weights_ready` writes down that it
worked. This service knows the configuration and its legality; the
``ModelProvider`` port (`cf. #418`) knows the protocol; resolving one into the
other is the composition root's job outside the kernel. So the kernel never
imports torch, transformers, or an HTTP client, and a connection can be
configured on a machine that could not possibly run it.

**Deleting is a hard delete, and it takes nothing with it.** An annotation records
the model that produced it by copying its identity onto the label when it is
written (`cf. #417`), so provenance survives the configuration it came from. That
denormalisation is what lets this be an ordinary delete instead of a lifecycle:
there is no row anywhere holding a key to this one.

Composition follows ``docs/workspaces.md``: this service takes an open
:class:`WorkspaceService` and nothing else, and reaches the ports through it.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from pydantic import ValidationError

from visionset.kernel.domain import (
    CONNECTION_KINDS,
    ConnectionAction,
    ConnectionSetupState,
    ConnectionType,
    InferenceConnection,
    connection_actions,
    normalize_name,
)
from visionset.kernel.errors import (
    ConstraintViolated,
    InferenceConnectionInvalid,
    InferenceConnectionNameTaken,
    InferenceConnectionNotDownloadable,
    InferenceConnectionNotFound,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.workspace_service import WorkspaceService

#: SQLite's own wording when ``uq_inference_connection_name`` refuses a write.
#: The adapter hands the message through verbatim, and it is the only way to tell
#: a name collision apart from any other constraint — see ``_as_name_collision``.
_NAME_INDEX_MESSAGE = "inference_connection.name"


class InferenceConnectionService:
    """Configure where this workspace may ask a model to predict."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace

    # --- reading -----------------------------------------------------------

    def get(self, connection_id: UUID) -> InferenceConnection:
        """The connection with that id.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_connection(uow, connection_id)

    def get_by_name(self, name: str) -> InferenceConnection:
        """The connection somebody would name, resolved case-insensitively.

        Raises:
            InvalidName: the name is blank once stripped.
            InferenceConnectionNotFound: no connection here holds that name.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_connection_named(uow, name)

    # --- writing -----------------------------------------------------------

    def create(
        self,
        name: str,
        *,
        connection_type: ConnectionType,
        model_id: str,
        model_revision: str,
        device: str | None = None,
        precision: str | None = None,
        endpoint_url: str | None = None,
    ) -> InferenceConnection:
        """Configure a connection. Nothing is fetched and nothing is contacted.

        The initial setup state is derived from the kind rather than accepted
        from the caller, because it is a fact about what the kind needs: a
        ``local`` connection is born ``not_set_up`` because its weights are not
        here yet, and an ``http`` one is born ``ready`` because there is nothing
        to set up locally at all. Whether that endpoint *answers* is a different
        question with a fresh answer every time it is asked — see
        ``ConnectionSetupState``.

        Raises:
            InvalidName: the name is blank once stripped.
            InferenceConnectionNameTaken: another connection holds that name.
            InferenceConnectionInvalid: the parameters do not match the kind.
        """
        try:
            with self._workspace.unit_of_work() as uow:
                resolved = self._require_name_free(uow, name)
                return uow.inference_connections.add(
                    _built(
                        name=resolved,
                        connection_type=connection_type,
                        model_id=model_id,
                        model_revision=model_revision,
                        device=device,
                        precision=precision,
                        endpoint_url=endpoint_url,
                        setup_state=_born_in(connection_type),
                    )
                )
        except ConstraintViolated as exc:
            raise self._as_name_collision(exc, name) from exc

    def update(
        self,
        connection_id: UUID,
        *,
        name: str | None = None,
        model_id: str | None = None,
        model_revision: str | None = None,
        device: str | None = None,
        precision: str | None = None,
        endpoint_url: str | None = None,
    ) -> InferenceConnection:
        """Edit a connection in place. Every argument is optional; ``None`` means
        *leave this alone*.

        The kind is deliberately not editable. Changing ``local`` to ``http``
        would empty every parameter the row carries and keep only its name, which
        is a new connection wearing an old id — and an id that already travelled
        onto labels as provenance should not start meaning something else.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
            InvalidName: a supplied name is blank once stripped.
            InferenceConnectionNameTaken: another connection holds that name.
            InferenceConnectionInvalid: the result would not match the kind.
        """
        try:
            with self._workspace.unit_of_work() as uow:
                current = self.require_connection(uow, connection_id)
                changes: dict[str, object] = {"updated_at": datetime.now(UTC)}
                if name is not None:
                    changes["name"] = self._require_name_free(uow, name, exclude=connection_id)
                for field, value in (
                    ("model_id", model_id),
                    ("model_revision", model_revision),
                    ("device", device),
                    ("precision", precision),
                    ("endpoint_url", endpoint_url),
                ):
                    if value is not None:
                        changes[field] = value
                # Rebuilt rather than mutated, so the cross-field rule runs on the
                # result: ``model_copy`` does not validate, which is the whole
                # reason ``Source`` had to turn on ``validate_assignment``.
                return uow.inference_connections.update(_built(**(current.model_dump() | changes)))
        except ConstraintViolated as exc:
            raise self._as_name_collision(exc, name or "") from exc

    def require_downloadable(
        self, connection_id: UUID, *, retrying: bool = False
    ) -> InferenceConnection:
        """The connection, if fetching weights for it is something to do.

        The gate every download surface calls before it commits to anything —
        the route before it enqueues, the command before it reaches a network —
        so a refusal arrives as an answer to the request that asked rather than
        as a failed row somebody has to go and read. That is
        ``export_release``'s rule: a refusal a request can make is a refusal the
        request makes, and the worker checks again because *that* one is the
        guarantee.

        Derived from ``connection_actions``, never from a second reading of the
        tables underneath it. That is what makes ``allowed_actions`` and this
        refusal the same answer: a client that saw ``download_weights`` in the
        declaration can call, and one that did not will be told why.

        **``retrying`` is what a re-run of already-accepted work passes**, and it
        is the state half of the gate and only that half. The question this
        answers is normally "may this be *started*?", and a retry was started
        already: ``sweep_orphans`` re-enqueues an idempotent orphan as a new job,
        so a crash between the state flip committing and the row settling
        produces a second run against a connection that is now ``ready``.
        Refusing that would fail a job whose work is done. The **kind** half is
        not relaxed by it — a connection with no weights of its own has none on
        the second attempt either — so this is narrower than a flag that skips
        the gate.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
            InferenceConnectionNotDownloadable: it is already set up, or it is a
                kind with no weights of its own.
        """
        with self._workspace.unit_of_work() as uow:
            connection = self.require_connection(uow, connection_id)
        if ConnectionAction.DOWNLOAD_WEIGHTS in connection_actions(
            connection.setup_state, connection_type=connection.connection_type
        ):
            return connection
        kinds = CONNECTION_KINDS[ConnectionAction.DOWNLOAD_WEIGHTS]
        if retrying and connection.connection_type in kinds:
            return connection
        raise InferenceConnectionNotDownloadable(_why_not_downloadable(connection))

    def record_weights_ready(self, connection_id: UUID) -> InferenceConnection:
        """Mark the weights present. Called **after** they are, never before.

        The one edge in this entity's short life, and it is written last on
        purpose: a download that fails partway has changed nothing here, so a
        reader never sees a connection claiming a runtime it does not have. That
        is the whole of "never a half-ready state" — not a guard, an ordering.

        **Idempotent, and it has to be.** The download job is registered
        idempotent, so a crash after this commit and before the row settled means
        a retry arrives at a connection that is already ``ready``; answering that
        with a refusal would fail a job whose work is done. Recording something
        already true returns it unchanged.

        Deliberately narrow. It takes no state to move *to*, because there is
        only one, and it accepts no other field — the caller is a job handler
        that has just written bytes to a cache, and the only thing it has
        learned is that they are there.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            current = self.require_connection(uow, connection_id)
            if current.setup_state is ConnectionSetupState.READY:
                return current
            return uow.inference_connections.update(
                _built(
                    **(
                        current.model_dump()
                        | {
                            "setup_state": ConnectionSetupState.READY,
                            "updated_at": datetime.now(UTC),
                        }
                    )
                )
            )

    def delete(self, connection_id: UUID) -> None:
        """Remove a connection. Annotations keep their model provenance.

        No ``confirm=`` gate, and the asymmetry with ``ProjectService.delete`` is
        the point: deleting a project destroys work, while deleting a connection
        destroys a form somebody filled in. Nothing references it — provenance is
        copied onto labels at write time — so the blast radius is this row.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            connection = self.require_connection(uow, connection_id)
            uow.inference_connections.delete(connection.id)

    # --- lookups shared by the operations above ----------------------------

    def require_connection(self, uow: UnitOfWork, connection_id: UUID) -> InferenceConnection:
        """The connection, or refuse because this workspace does not have it.

        Public and taking a ``uow`` for ``TokenService.require_token``'s reason:
        a caller resolving one inside its own transaction must not have to spell
        the scope rule a second time.
        """
        connection = uow.inference_connections.get(connection_id)
        if connection is None:
            raise InferenceConnectionNotFound(
                f"no inference connection {connection_id} in workspace "
                f"{self._workspace.workspace.name!r}"
            )
        return connection

    def require_connection_named(self, uow: UnitOfWork, name: str) -> InferenceConnection:
        """The connection holding that name, compared the way the index compares.

        Unicode case folding here, ASCII ``COLLATE NOCASE`` in the index — the
        service is where the normalized string is in hand, so it is the stricter
        of the two.
        """
        wanted = normalize_name(name, what="inference connection").casefold()
        for connection in uow.inference_connections.list():
            if connection.name.casefold() == wanted:
                return connection
        raise InferenceConnectionNotFound(
            f"no inference connection named {name!r} in workspace "
            f"{self._workspace.workspace.name!r}"
        )

    def _require_name_free(self, uow: UnitOfWork, name: str, *, exclude: UUID | None = None) -> str:
        """The normalized name, or refuse it because something else holds it.

        ``exclude`` is what ``TokenService`` has no need of: this entity can be
        renamed, so re-saving a connection under the name it already has must not
        collide with itself.

        Raises:
            InvalidName: the name is blank once stripped.
            InferenceConnectionNameTaken: another connection holds it.
        """
        normalized = normalize_name(name, what="inference connection")
        wanted = normalized.casefold()
        for connection in uow.inference_connections.list():
            if connection.id != exclude and connection.name.casefold() == wanted:
                raise InferenceConnectionNameTaken(
                    f"an inference connection named {connection.name!r} already exists in "
                    f"workspace {self._workspace.workspace.name!r}"
                )
        return normalized

    def _as_name_collision(
        self, exc: ConstraintViolated, name: str
    ) -> InferenceConnectionNameTaken | ConstraintViolated:
        """Re-raise the name index's complaint in the caller's vocabulary.

        Two writers can both pass ``_require_name_free`` and race to insert; the
        loser is refused one layer below the pre-check. Any other constraint is
        not this service's to reinterpret and travels on unchanged.
        """
        if _NAME_INDEX_MESSAGE in str(exc):
            return InferenceConnectionNameTaken(
                f"an inference connection named {name!r} already exists in workspace "
                f"{self._workspace.workspace.name!r}"
            )
        return exc

    # ``list`` shadows the builtin for every annotation below it, so it is last.
    def list(self) -> list[InferenceConnection]:
        """Every connection in this workspace, in the order they were made."""
        with self._workspace.unit_of_work() as uow:
            return uow.inference_connections.list()


def _built(**fields: object) -> InferenceConnection:
    """An ``InferenceConnection``, or the kernel's own word for why not.

    The cross-field rule is a pydantic refusal where it is raised, and letting a
    ``ValidationError`` out of a service would break the rule
    ``ReleaseService._read_manifest`` states: nothing from outside the kernel's
    vocabulary escapes the kernel. Every construction in this module goes through
    here so there is one place that translation happens.
    """
    try:
        return InferenceConnection.model_validate(fields)
    except ValidationError as exc:
        raise InferenceConnectionInvalid(_first_reason(exc)) from exc


def _first_reason(exc: ValidationError) -> str:
    """The sentence the domain wrote, without pydantic's frame around it.

    A caller gets "a local connection needs device", not a rendering of the whole
    error object — the message is what a person reads in a terminal and what a
    405-wide browser toast has room for.
    """
    first = exc.errors()[0]
    return str(first.get("msg", exc)).removeprefix("Value error, ")


def _why_not_downloadable(connection: InferenceConnection) -> str:
    """Which of the two refusals this is, in a sentence somebody can act on.

    The *message* distinguishes them and the code does not, deliberately: a
    client branches on ``INFERENCE_CONNECTION_NOT_DOWNLOADABLE`` to decide
    whether to stop asking, and both readings say stop. Splitting the code would
    publish a distinction no caller behaves differently on.
    """
    if connection.connection_type is not ConnectionType.LOCAL:
        return (
            f"connection {connection.name!r} is an {connection.connection_type.value} connection; "
            "its model runs elsewhere, so there are no weights here to fetch"
        )
    return (
        f"connection {connection.name!r} is already set up; "
        "its weights are present and there is nothing to fetch"
    )


def _born_in(connection_type: ConnectionType) -> ConnectionSetupState:
    """The setup state a new connection of this kind starts in.

    Module level rather than a method because it is a fact about the kind and
    reads as one at the only call site that needs it.
    """
    return (
        ConnectionSetupState.NOT_SET_UP
        if connection_type is ConnectionType.LOCAL
        else ConnectionSetupState.READY
    )
