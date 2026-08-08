# usage: from visionset.kernel.domain import InferenceConnection
"""Where inference runs: one row per model connection somebody configured.

VisionSet ships no model and fetches nothing on its own. Everything that predicts
predicts against a connection created here, which is what makes "nothing arrives
at install time" a property of the design rather than a line in a README.

**Two kinds, one aggregate.** A ``local`` connection names weights this machine
runs; an ``http`` one names an endpoint that answers this project's own inference
contract. They differ only in the parameters they carry, so they are one model
with a discriminator and a cross-field rule, on ``Source``'s terms — not two
tables, because every caller wants *the connections*, and a listing that has to
read two tables to answer that is a listing that will drift.

**The model reference is a pair, and it is not an annotation's ``model_ref``.**
:attr:`InferenceConnection.model_id` and :attr:`~InferenceConnection.model_revision`
say which weights this connection is configured for. An annotation's ``model_ref``
(``domain/annotation.py``) is a string copied onto a label when it is written,
denormalised on purpose so that deleting a connection never breaks provenance.
The two meet only when an adapter writes the second from the first. Two
vocabularies, one word — worth saying out loud, because this area already has
another pair like it (`cf. #421`).

**No workspace column**, on ``JobRow``'s terms rather than ``TokenRow``'s: one
workspace is one SQLite file, so a connection is workspace-scoped by living in
that file at all, and its name is unique within the workspace without a column
saying which workspace that is.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Final
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ConnectionType(StrEnum):
    """Where a connection's model runs.

    A ``StrEnum`` rather than a plain ``str`` on ``SourceKind``'s test: nothing
    outside this build writes the value, the kernel branches on it, and the set
    grows only by a deliberate kernel change — a hosted connection type arriving
    later is exactly that change.
    """

    LOCAL = "local"
    HTTP = "http"


class ConnectionSetupState(StrEnum):
    """Whether a connection is ready to be asked for a prediction.

    ``not_set_up`` means something local is still missing — weights that were
    never fetched. It is the state a ``local`` connection is born in, and the one
    a successful weight download clears, as its **last** step: a run that fails
    partway leaves the row exactly where it was, so there is no third state
    meaning "half fetched" and no window in which a caller could read one.

    Deliberately **not** a reachability answer. Whether an endpoint responds is a
    question with a fresh answer every time it is asked, so it belongs to a test
    call and its result, never to a stored row that would start lying the moment
    the network moved.
    """

    NOT_SET_UP = "not_set_up"
    READY = "ready"


EVERY_CONNECTION_TYPE: Final[frozenset[ConnectionType]] = frozenset(ConnectionType)
"""The kinds that refuse nothing — the type half of an unconditional capability.

The companion of :data:`EVERY_SETUP_STATE`, and it exists for the same reason:
``update`` and ``delete`` are legal for both kinds, and ``CONNECTION_KINDS`` says
so by naming this set rather than by spelling the members out a second time.
"""


EVERY_SETUP_STATE: Final[frozenset[ConnectionSetupState]] = frozenset(ConnectionSetupState)
"""The setup states that refuse nothing — which today is all of them.

Named, and derived from the enum rather than spelled out, because it is what
``CONNECTION_GATES`` reads: ``update`` and ``delete`` are legal in every state a
connection can be in, and the way to say that without a hand-mirror is to say it
once, here, where a later slice that narrows either action narrows it for the
declaration and the service in the same edit.

A set that is total today is not a set that is pointless: the alternative is
``connection_actions`` returning a hardcoded list, which is precisely the second
encoding ``capabilities`` exists to prevent.
"""


class DownloadSize(BaseModel):
    """What fetching a model's weights would cost, before anybody fetches them.

    The answer to the question a setup form has to ask on somebody's behalf: the
    decision recorded on #418 is that VisionSet downloads nothing on its own, and
    a person can only make that decision if the size is on screen **before** they
    confirm. So this is read separately from the download and ahead of it.

    **A pair, not a connection.** It is keyed on a model id and a revision rather
    than on an :class:`InferenceConnection`, because the moment it is needed is
    the moment before a connection exists — the form is being filled in. A
    connection that already exists is the same pair, asked the same way.

    **Every file, because the download fetches every file.** ``total_bytes`` is
    the whole revision rather than the weights alone: what gets fetched is a
    snapshot, so a number counting only ``.safetensors`` would be a smaller
    number than the thing it claims to describe. A repository publishing both a
    ``.bin`` and a ``.safetensors`` copy of the same tensors is therefore
    reported at the sum of the two, which is what will actually land on the disk.

    Not persisted anywhere. A size is a fact about a published revision, so it is
    the same answer on every machine and there is nothing about it worth storing
    in a workspace.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    model_id: str
    model_revision: str
    #: A revision whose size could not be established is a refusal, never a zero
    #: here: a form showing "0 B" would be inviting somebody to confirm a download
    #: it knows nothing about. The bound admits zero because the type should not
    #: encode a lookup's policy, not because anything answers with it.
    total_bytes: int = Field(ge=0)
    file_count: int = Field(ge=0)


class InferenceConnection(BaseModel):
    """One configured place a model can be asked to predict.

    Not frozen, for ``BackgroundJob``'s reason: it is a row whose purpose is to be
    edited. Its service builds the next version by **revalidating** rather than by
    ``model_copy(update=…)``, which most of this domain uses — that skips
    validation, and the cross-field rule below is the whole point of this model.

    Field order mirrors the row's column order, the convention this package keeps
    because SQLite appends an ``ALTER``-added column and a reader comparing the
    two should not have to hunt.
    """

    id: UUID = Field(default_factory=uuid4)
    name: str
    connection_type: ConnectionType
    #: Which weights, in the vocabulary of wherever they come from. Opaque to the
    #: kernel: validating that a model id exists means reaching the network, which
    #: is the adapter's business and not a domain invariant.
    model_id: str
    #: Pinned, and required rather than defaulted to a moving pointer. "Which
    #: model produced this label" is unanswerable if the answer is a name that
    #: means something different next month.
    model_revision: str
    #: ``local`` only. Free text — ``cuda``, ``cuda:1``, ``cpu`` — because what is
    #: addressable is a property of the machine at run time, not of this domain.
    device: str | None = None
    #: ``local`` only. Free text — ``fp16``, ``fp32`` — for the same reason.
    precision: str | None = None
    #: ``http`` only.
    endpoint_url: str | None = None
    setup_state: ConnectionSetupState = ConnectionSetupState.NOT_SET_UP
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    #: The first ``updated_at`` in this domain, and it earns the exception: every
    #: other aggregate here is either append-only or carries named lifecycle
    #: stamps, while this one is a configuration row a person edits in place and
    #: then wants to see the age of. Equal to ``created_at`` until something
    #: changes it, never null — "never edited" is honestly expressed as "last
    #: changed when it was made".
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("name", "model_id", "model_revision")
    @classmethod
    def _is_not_blank(cls, value: str, info: object) -> str:
        field = getattr(info, "field_name", "value")
        if not value.strip():
            raise ValueError(f"{field} must contain at least one non-blank character")
        return value

    @field_validator("created_at", "updated_at")
    @classmethod
    def _is_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("connection timestamps must be timezone-aware (UTC)")
        return value.astimezone(UTC)

    @model_validator(mode="after")
    def _parameters_match_the_type(self) -> InferenceConnection:
        """Each kind carries its own parameters and none of the other's.

        Both halves are enforced, not just the required one. A ``local``
        connection holding an ``endpoint_url`` is the shape that makes a later
        reader ask which field the adapter should believe, and ``Source`` pays
        for the same rule with ``validate_assignment``.
        """
        local = self.connection_type is ConnectionType.LOCAL
        required = ("device", "precision") if local else ("endpoint_url",)
        forbidden = ("endpoint_url",) if local else ("device", "precision")
        for field in required:
            value = getattr(self, field)
            if value is None or not value.strip():
                raise ValueError(f"a {self.connection_type.value} connection needs {field}")
        for field in forbidden:
            if getattr(self, field) is not None:
                raise ValueError(f"a {self.connection_type.value} connection cannot carry {field}")
        return self
