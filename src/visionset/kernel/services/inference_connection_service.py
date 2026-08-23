# usage: from visionset.kernel.services import InferenceConnectionService
"""Model connections: the one door to where this workspace may run inference.

Creating, reading, editing and removing the rows every predictor is instantiated
from — and saying whether one may be asked to fetch its weights, and recording
that they arrived.

**Nothing here predicts, downloads, or reaches a network**, and that stays true
of the download: :meth:`~InferenceConnectionService.require_downloadable` decides
whether fetching is something to do, ``visionset.inference`` does the fetching,
and :meth:`~InferenceConnectionService.record_weights_ready` writes down that it
worked. This service knows the configuration and its legality; the
``ModelProvider`` port knows the protocol; resolving one into the
other is the composition root's job outside the kernel. So the kernel never
imports torch, transformers, or an HTTP client, and a connection can be
configured on a machine that could not possibly run it.

**Deleting is a hard delete, and it takes nothing with it.** An annotation records
the model that produced it by copying its identity onto the label when it is
written, so provenance survives the configuration it came from. That
denormalisation is what lets this be an ordinary delete instead of a lifecycle:
there is no row anywhere holding a key to this one.

Composition follows ``docs/content/workspaces.md``: this service takes an open
:class:`WorkspaceService` and nothing else, and reaches the ports through it.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from uuid import UUID

from pydantic import ValidationError

from visionset.kernel.domain import (
    CONNECTION_JOB_KEY,
    INTEGRITY_CHECK_JOB_TYPE,
    LIVE_JOB_STATES,
    WEIGHT_DOWNLOAD_JOB_TYPE,
    WEIGHT_HOLDING_TYPES,
    BackgroundJob,
    ConnectionAction,
    ConnectionJob,
    ConnectionJobs,
    ConnectionSetupState,
    ConnectionType,
    InferenceConnection,
    IntegrityCheck,
    ModelOrigin,
    WeightDownload,
    connection_actions,
    normalize_name,
)
from visionset.kernel.errors import (
    ConstraintViolated,
    InferenceConnectionInvalid,
    InferenceConnectionModelFixed,
    InferenceConnectionNameTaken,
    InferenceConnectionNotCheckable,
    InferenceConnectionNotDownloadable,
    InferenceConnectionNotFound,
    InferenceConnectionNotTestable,
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

    def connection_jobs(self) -> ConnectionJobs:
        """The latest download and the latest integrity check for every connection.

        **The answer that makes a run observable by somebody who did not start
        it.** Either job outlives the request that launched it and the page that
        asked, so the only way a screen can show one it has no job id for — a
        reload, a second tab, a colleague's browser, a run started from the
        terminal — is for the connections it lists to carry it. A client holding a
        job id in component state loses the run to the first navigation, which is
        how a running download came to render as *Not set up* and a running check
        as though nothing were happening.

        **The latest rather than only the live one**, because the two questions a
        reader has are *is something running* and *what happened last time*, and
        dropping a run the moment it settles answers the first while making the
        second unanswerable — a check that failed while nobody was looking would
        leave a connection at ``not_set_up`` with no sentence saying why.
        The queue answers newest-first, so the first job seen for a connection is
        that connection's.

        **One queue read for both kinds and every connection**, because the caller
        is a listing that polls: a read per kind, or worse per row, would put that
        cost on the screen's own interval. ``JobQueue.list`` narrows by type in the
        query and this splits what comes back.

        A job whose payload does not name a connection is skipped rather than
        raised over. It cannot be a run this method is about, and a listing of
        connections is the wrong place to discover a malformed row.
        """
        jobs = self._workspace.job_queue.list(
            types={WEIGHT_DOWNLOAD_JOB_TYPE, INTEGRITY_CHECK_JOB_TYPE}
        )
        return ConnectionJobs(
            downloads=_newest_by_connection(jobs, WeightDownload),
            checks=_newest_by_connection(jobs, IntegrityCheck),
        )

    def live_job(self, connection_id: UUID, *, job_type: str) -> BackgroundJob | None:
        """That kind of work already under way against this connection, if any.

        **What a surface asks so that a second request joins a run instead of
        forking one.** Both operations over a connection's weights are long — a
        transfer of gigabytes, or a re-read of all of them — and both are
        idempotent, so a second request for a kind already in flight has nothing
        to add: it either duplicates the bytes or, where more than one worker
        runs, overlaps the first over a single cache. Handing back the live run
        answers the caller with the thing it actually wanted to watch.

        **Best-effort, and the caller must not read it as a lock.** Nothing
        brackets this read and the enqueue that follows it, so two requests
        arriving together can both see nothing live and both queue. That is the
        ordinary case removed — a double-click, a second tab, a command entered
        twice — not a race won. A guarantee would need the queue to claim at
        enqueue, which is a cost every job type would pay for one screen's
        benefit.

        **It sees jobs and nothing else, which is the honest limit.** Of the
        three surfaces that fetch and check weights, only the HTTP one queues:
        the CLI and the MCP tools both run the operation inline and write no row
        at all (``visionset.cli.inference``, ``visionset.mcp.inference``), each
        because it has no dispatcher to hand the work to. A download started from
        either is invisible here and always will be. That is why this coalesces
        rather than refuses: a refusal built on this answer would bind one
        surface out of three while claiming an exclusivity none of them could
        rely on.

        ``job_type`` is passed rather than derived from an action, because the
        caller is the surface that already knows which handler it is about to
        enqueue — and a mapping from action to job type would be a second
        encoding of what ``visionset.jobs`` registers.

        Newest first, as :meth:`JobQueue.list` answers, so a connection with two
        live rows — which the paragraph above admits is possible — hands back the
        one somebody most recently asked for.
        """
        for job in self._workspace.job_queue.list(states=LIVE_JOB_STATES, types={job_type}):
            if job.payload.get(CONNECTION_JOB_KEY) == str(connection_id):
                return job
        return None

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
        provider_id: str | None = None,
        credential_env: str | None = None,
        origin: ModelOrigin | None = None,
    ) -> InferenceConnection:
        """Configure a connection. Nothing is fetched and nothing is contacted.

        The initial setup state is derived from the kind rather than accepted
        from the caller, because it is a fact about what the kind needs: a
        ``local`` connection is born ``not_set_up`` because its weights are not
        here yet, and an ``http`` one is born ``ready`` because there is nothing
        to set up locally at all. Whether it has *declared* what it answers is a
        separate fact, carried by ``model_family`` and written by
        ``test_endpoint``. Whether that endpoint *answers* is a different
        question with a fresh answer every time it is asked — see
        ``ConnectionSetupState``.

        Raises:
            InvalidName: the name is blank once stripped.
            InferenceConnectionNameTaken: another connection holds that name.
            InferenceConnectionInvalid: the parameters do not match the kind, or
                the device or precision is outside what this build offers.

        ``origin`` absent means the one the kind implies (``default_origin``);
        a caller that knows better — a registry, a path that brings its own
        weights — states it.

        ``provider_id`` is taken as given and never checked against what is
        installed: which drivers this process found is
        ``visionset.inference``'s to say and the kernel may not import it. A
        connection naming a driver nobody has is created, and refused when
        something tries to run it — which is the same treatment a model id
        pointing at nothing gets, and for the same reason.
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
                        provider_id=provider_id,
                        credential_env=credential_env or None,
                        origin=origin,
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
        provider_id: str | None = None,
        credential_env: str | None = None,
    ) -> InferenceConnection:
        """Edit a connection in place. Every argument is optional; ``None`` means
        *leave this alone*.

        ``credential_env`` is the one field a person removes as readily as sets,
        and ``None`` already means *leave this alone* — so the empty string
        clears it, being the one shape a form with an emptied input can send.

        Pointing a connection at a different model or revision, where it is
        still allowed, **forgets what kind of model it was**: that answer was
        read out of the previous reference's config and nothing has read the
        new one. A field that arrives holding the value it already had is not
        a move.

        Pointing an ``http`` connection at a different endpoint forgets what the
        previous one declared, for the same reason; asking the new one is the
        remedy and is already among its actions.

        The kind is deliberately not editable. Changing ``local`` to ``http``
        would empty every parameter the row carries and keep only its name, which
        is a new connection wearing an old id — and an id that already travelled
        onto labels as provenance should not start meaning something else.

        **A set-up connection's model is fixed.** Moving the reference is legal
        only while ``update_model`` is declared — a ``local`` connection whose
        weights have not arrived — and refused otherwise, through the same
        declaration a client renders: once the weights are here the connection
        *is* those weights, and a different model is a new connection. The
        name, the device and the precision are edited freely in every state.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
            InvalidName: a supplied name is blank once stripped.
            InferenceConnectionNameTaken: another connection holds that name.
            InferenceConnectionInvalid: the result would not match the kind, or
                the device or precision is outside what this build offers.
            InferenceConnectionModelFixed: the model or revision would change on
                a connection that does not declare ``update_model``.
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
                    ("provider_id", provider_id),
                ):
                    if value is not None:
                        changes[field] = value
                if credential_env is not None:
                    changes["credential_env"] = credential_env or None
                # A moved reference is legal only where `update_model` is
                # declared — the row holds nothing committed to the model it
                # names — and the refusal comes through that same declaration.
                # Where it is legal, everything the row had learned from the
                # previous model goes: the family, read out of a config nothing
                # has read for the new one, and the recorded driver with it.
                #
                # Compared rather than merely supplied, because the only client
                # there is sends the whole shape on every edit: a rename arrives
                # carrying the model id it already had, and reading that as a
                # move would refuse a rename on every set-up connection.
                if any(
                    field in changes and changes[field] != getattr(current, field)
                    for field in ("model_id", "model_revision")
                ):
                    if ConnectionAction.UPDATE_MODEL not in connection_actions(
                        current.setup_state, connection_type=current.connection_type
                    ):
                        raise InferenceConnectionModelFixed(_why_model_fixed(current))
                    changes["model_family"] = None
                    # The recorded driver goes with it, on the same reasoning one
                    # step over: it was recorded for the model this row used to
                    # name, and the driver that serves the new one is a different
                    # question. Unless this edit supplied one — a re-pin from one
                    # offered checkpoint to another carries the id of whoever
                    # offers the new one, and that answer is newer than this rule.
                    if provider_id is None:
                        changes["provider_id"] = None
                    if current.connection_type in WEIGHT_HOLDING_TYPES:
                        changes["setup_state"] = ConnectionSetupState.NOT_SET_UP
                # The endpoint is the http row's model: what the old one declared
                # says nothing about the new one. The driver stays — it still
                # speaks the contract, whoever is on the other end.
                if "endpoint_url" in changes and changes["endpoint_url"] != current.endpoint_url:
                    changes["model_family"] = None
                # Rebuilt rather than mutated, so the cross-field rule runs on the
                # result: ``model_copy`` does not validate, which is the whole
                # reason ``Source`` had to turn on ``validate_assignment``.
                return uow.inference_connections.update(_built(**(current.model_dump() | changes)))
        except ConstraintViolated as exc:
            raise self._as_name_collision(exc, name or "") from exc

    def require_downloadable(self, connection_id: UUID) -> InferenceConnection:
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

        **A ``ready`` connection passes, and there is no flag relaxing that.**
        Two callers legitimately arrive there: ``sweep_orphans`` re-enqueues an
        idempotent orphan whose previous attempt may have finished, and somebody
        asks a set-up connection to check its own weights. Both are the same call
        doing the same idempotent work, so the gate table says so — a parameter
        that relaxes a rule is worse than a rule drawn correctly.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
            InferenceConnectionNotDownloadable: it is a kind with no weights of
                its own.
        """
        with self._workspace.unit_of_work() as uow:
            connection = self.require_connection(uow, connection_id)
        if ConnectionAction.DOWNLOAD_WEIGHTS in connection_actions(
            connection.setup_state, connection_type=connection.connection_type
        ):
            return connection
        raise InferenceConnectionNotDownloadable(_why_not_downloadable(connection))

    def record_weights_ready(
        self,
        connection_id: UUID,
        *,
        model_family: str | None = None,
        provider_id: str | None = None,
    ) -> InferenceConnection:
        """Mark the weights present. Called **after** they are, never before.

        The one edge in this entity's short life, and it is written last on
        purpose: a download that fails partway has changed nothing here, so a
        reader never sees a connection claiming a runtime it does not have. That
        is the whole of "never a half-ready state" — not a guard, an ordering.

        **Idempotent, and it has to be.** The download job is registered
        idempotent, so a crash after this commit and before the row settled means
        a retry arrives at a connection that is already ``ready``; answering that
        with a refusal would fail a job whose work is done. Recording something
        already true returns it unchanged — and *unchanged* is now decided by
        comparing the fields rather than by the state alone, because a re-run
        over an already-``ready`` connection is exactly how a row that predates
        ``model_family`` gets one.

        ``model_family`` is the second thing the caller has learned, and it can
        only be learned here. What model type a connection points at is written
        in the model's own downloaded config, so the first moment it is knowable
        without reaching a network is the moment the download finishes — and the
        caller that just finished one is holding the answer. ``None`` means *I
        did not find out*, which leaves whatever the row already had; the empty
        string means *I looked and it declared nothing*, which is a finding and
        is recorded as one.

        ``provider_id`` arrives the same way and for a narrower reason: a
        connection created against an offered checkpoint already recorded one, so
        this is how a row that recorded *none* acquires one — the download had to
        resolve a driver to fetch anything, and the one it actually used is a
        better answer than deriving it again on every later read. ``None`` leaves
        whatever the row already had, which is what a re-run over an
        already-recorded connection passes.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
        """
        return self._record_ready(connection_id, model_family=model_family, provider_id=provider_id)

    def record_endpoint_answer(
        self, connection_id: UUID, *, model_family: str, provider_id: str
    ) -> InferenceConnection:
        """Record what an ``http`` connection's endpoint said it answers.

        ``record_weights_ready``'s twin for the kind with no weights: the family
        is the capability the endpoint declared, recorded verbatim by the caller
        that asked it, and the provider is the driver that asked. Idempotent the
        same way — re-asking an endpoint that says the same thing is not an
        edit. Writes ``ready`` unconditionally; it is the caller's job — ``ask_endpoint``
        does it via ``require_endpoint_testable`` — to have already refused a
        connection this action is not legal for.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
        """
        return self._record_ready(connection_id, model_family=model_family, provider_id=provider_id)

    def _record_ready(
        self, connection_id: UUID, *, model_family: str | None, provider_id: str | None
    ) -> InferenceConnection:
        with self._workspace.unit_of_work() as uow:
            current = self.require_connection(uow, connection_id)
            changes: dict[str, object] = {"setup_state": ConnectionSetupState.READY}
            if model_family is not None:
                changes["model_family"] = model_family
            if provider_id is not None:
                changes["provider_id"] = provider_id
            if all(getattr(current, field) == value for field, value in changes.items()):
                return current
            return uow.inference_connections.update(
                _built(**(current.model_dump() | changes | {"updated_at": datetime.now(UTC)}))
            )

    def require_checkable(self, connection_id: UUID) -> InferenceConnection:
        """The connection, if there is a snapshot on disk to re-read.

        ``require_downloadable``'s sibling, and the same construction for the
        same reason: derived from ``connection_actions`` rather than from a
        second reading of the tables, so ``allowed_actions`` and this refusal
        cannot disagree about when integrity may be checked.

        The one difference is that this gate is **narrow in state** where that
        one is total. A connection at ``not_set_up`` is refused, because a check
        that re-reads a snapshot has nothing to read before one exists — and
        answering "intact" over an empty cache would be the false verdict this
        whole feature exists to make impossible.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
            InferenceConnectionNotCheckable: it has no weights of its own, or
                they are not here yet.
        """
        with self._workspace.unit_of_work() as uow:
            connection = self.require_connection(uow, connection_id)
        if ConnectionAction.CHECK_INTEGRITY in connection_actions(
            connection.setup_state, connection_type=connection.connection_type
        ):
            return connection
        raise InferenceConnectionNotCheckable(_why_not_checkable(connection))

    def require_endpoint_testable(self, connection_id: UUID) -> InferenceConnection:
        """The connection, if it has an endpoint to ask.

        ``require_checkable``'s construction, derived from ``connection_actions``
        rather than from a second reading of the tables, so ``allowed_actions``
        and this refusal cannot disagree about which kind may be asked.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
            InferenceConnectionNotTestable: its model runs here; there is no
                endpoint.
        """
        with self._workspace.unit_of_work() as uow:
            connection = self.require_connection(uow, connection_id)
        if ConnectionAction.TEST_ENDPOINT in connection_actions(
            connection.setup_state, connection_type=connection.connection_type
        ):
            return connection
        raise InferenceConnectionNotTestable(
            f"connection {connection.name!r} is a {connection.connection_type.value} connection; "
            "its model runs here, so there is no endpoint to ask"
        )

    def record_weights_missing(self, connection_id: UUID) -> InferenceConnection:
        """Mark the weights gone. Called **after** they are, never before.

        The other edge, and the mirror of ``record_weights_ready`` in every
        respect that matters. An integrity check that found damage purges the
        bad blobs and then calls this, in that order: a cache hit is returned
        unread, so a connection sent back to ``not_set_up`` while the corrupt
        bytes were still on disk would be repaired by a download that re-served
        them and arrive back at ``ready`` carrying the same damage. Purging
        first is what makes ``download_weights`` the genuine remedy.

        **Never-half-ready is preserved, and it is the same ordering argument.**
        There are two states and this writes one of them; there is no moment at
        which a reader finds a third. What a crash between the purge and this
        write leaves is a ``ready`` connection missing a file — which is an
        *incomplete* snapshot, exactly the condition ``download_weights``
        already exists to repair, and it is the safe side of the window to fail
        on. See ``visionset.inference.integrity`` for why the other ordering is
        not available.

        **Idempotent**, for ``record_weights_ready``'s reason one state over: the
        check job is registered idempotent, so a retry can arrive at a
        connection a previous attempt already sent back.

        Deliberately narrow, and it takes no reason. What the row records is
        that the weights are not usable; *why* is the job's error, where a
        sentence naming the damaged files can be read and where it does not
        outlive the remedy.

        Raises:
            InferenceConnectionNotFound: no such connection in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            current = self.require_connection(uow, connection_id)
            if current.setup_state is ConnectionSetupState.NOT_SET_UP:
                return current
            return uow.inference_connections.update(
                _built(
                    **(
                        current.model_dump()
                        | {
                            "setup_state": ConnectionSetupState.NOT_SET_UP,
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
                    f"an inference connection named {connection.name!r} already exists"
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
                f"an inference connection named {name!r} already exists"
            )
        return exc

    # ``list`` shadows the builtin for every annotation below it, so it is last.
    def list(self) -> list[InferenceConnection]:
        """Every connection in this workspace, in the order they were made."""
        with self._workspace.unit_of_work() as uow:
            return uow.inference_connections.list()


def _newest_by_connection[J: ConnectionJob](
    jobs: Iterable[BackgroundJob], kind: type[J]
) -> dict[UUID, J]:
    """That kind's most recent job per connection, out of a newest-first list.

    Generic over the kind rather than written twice, because the two differ only
    in which counts they name: ``ConnectionJob.of`` refuses a row of the wrong
    type, so passing the whole list twice is also the filter. Two passes over a
    handful of rows already in memory, against one query.
    """
    latest: dict[UUID, J] = {}
    for job in jobs:
        try:
            found = kind.of(job)
        except ValueError:
            continue
        latest.setdefault(found.connection_id, found)
    return latest


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


def _why_model_fixed(connection: InferenceConnection) -> str:
    """The refusal for a moved reference, in a sentence somebody can act on."""
    if connection.connection_type in WEIGHT_HOLDING_TYPES:
        return (
            f"Connection {connection.name!r} is set up with "
            f"{connection.model_id} @ {connection.model_revision}; its model cannot be "
            "changed once the weights are here. Add a new connection for a different "
            "model; the name, device and precision of this one can still be edited."
        )
    return (
        f"Connection {connection.name!r} names {connection.model_id} @ "
        f"{connection.model_revision}, and an endpoint's model is fixed at creation. "
        "Add a new connection for a different model; the name, endpoint and "
        "credential variable of this one can still be edited."
    )


def _why_not_downloadable(connection: InferenceConnection) -> str:
    """The one remaining refusal, in a sentence somebody can act on.

    ``download_weights`` is legal at ``ready``, where it verifies rather than
    refuses, so the only refusal left is a fact about the kind and never about
    where a connection has got to — which is why the sentence names the kind.
    """
    return (
        f"connection {connection.name!r} is an {connection.connection_type.value} connection; "
        "its model runs elsewhere, so there are no weights here to fetch"
    )


def _why_not_checkable(connection: InferenceConnection) -> str:
    """Why there is nothing to re-read, in a sentence somebody can act on.

    Two ways to arrive, unlike ``_why_not_downloadable``'s one, and they want
    different sentences because they want different remedies: an ``http``
    connection will never have files here and the answer is to stop asking,
    while a ``local`` one at ``not_set_up`` is a download away from being
    checkable and the sentence names that download.
    """
    if connection.connection_type is not ConnectionType.LOCAL:
        return (
            f"connection {connection.name!r} is an {connection.connection_type.value} "
            "connection; its model runs elsewhere, so there are no files here to check"
        )
    return (
        f"connection {connection.name!r} has no weights on this machine yet, so there is "
        "nothing to check; download them first"
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
