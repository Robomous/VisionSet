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
vocabularies, one word.

**No workspace column**, on ``JobRow``'s terms rather than ``TokenRow``'s: one
workspace is one SQLite file, so a connection is workspace-scoped by living in
that file at all, and its name is unique within the workspace without a column
saying which workspace that is.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import UTC, datetime
from enum import StrEnum
from typing import Final
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator, model_validator

from visionset.kernel.domain.job import BackgroundJob, BackgroundJobState


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


# A vocabulary of its own because neither of the other two answers the question.
# `ConnectionType` says where a model runs and `ConnectionSetupState` says whether
# its weights arrived; both are silent about whether this model answers the
# question a caller is about to put to it. A tool offered without that check is a
# tool that works by being lucky, and the editor shipped exactly that: it picked
# the first `ready` connection, sent point prompts to a text-prompted detector,
# and let the server refuse them one click at a time.
#
# **The prompt, not the answer.** A region comes back either way, so naming the
# output would collapse the two members and lose the only distinction that decides
# whether a request can be made at all.
#
# Declared here and **mapped to model families outside**: which `model_type`
# values a build can serve is a fact about that build's optional runtime, and the
# kernel has no view of one. `visionset.inference.families` owns the mapping,
# beside the family sets it reads.
#
# The reasoning is a comment because this enum is *published*: FastAPI copies a
# docstring verbatim into `openapi.json`, where RST markup ships as literal
# backticks and internal rationale ships as API documentation. The docstring is
# the sentence a client should read, on `ConnectionAction`'s terms.
class ModelCapability(StrEnum):
    """What a connection's model can be asked for: the kind of prompt it takes."""

    #: Give me the thing under these points.
    POINT_SUGGEST = "point_suggest"
    #: Find everything these words name.
    TEXT_DETECT = "text_detect"


class Precision(StrEnum):
    """The numeric precision a local connection asks its weights to be loaded in.

    A closed vocabulary rather than the free text this field started as, on
    ``ConnectionType``'s test: the set is small, the kernel is what decides
    whether a member is usable on a given device, and it grows only by a
    deliberate kernel change — bf16 arriving later is exactly that change.

    Free text here was not neutrality but a gap. ``fp32x`` was accepted and then
    ignored; so was ``fp16`` beside ``cpu``, which the adapters silently drop
    (see :func:`precisions_for`). A field whose wrong values are absorbed rather
    than refused is a field that cannot tell somebody they are configuring a run
    that will not happen.
    """

    FP16 = "fp16"
    FP32 = "fp32"


_PRECISION_ALIASES: Final[Mapping[str, Precision]] = {
    "float16": Precision.FP16,
    "half": Precision.FP16,
    "float32": Precision.FP32,
    "full": Precision.FP32,
}
"""Spellings this build has honoured, mapped onto the vocabulary rather than refused.

``visionset.inference._fp16.HALF_PRECISION_NAMES`` has accepted ``float16`` and
``half`` for as long as the field has existed, so a row already carrying one was
written by somebody following the product rather than by somebody guessing. The
vocabulary closing around it must not make that row unreadable — a value the
domain refuses is refused on the way *out* of the store as well as into it — so
the alias is normalized at the boundary and the closed set is what everything
downstream sees. The full-precision pair is here for symmetry: honouring one
spelling of half and none of full is the kind of asymmetry nobody can remember.

Anything outside this map and the vocabulary is refused, which is the point.
"""


CPU: Final = "cpu"
"""The device every machine has, and the only one that needs no vocabulary escape."""

CUDA: Final = "cuda"
"""The default GPU. A machine with several addresses the rest as ``cuda:1``, ``cuda:2``…"""

OFFERED_DEVICES: Final[tuple[str, ...]] = (CPU, CUDA)
"""The devices a form offers, in the order it offers them.

Not the whole of what :data:`DEVICE_PATTERN` accepts, and the difference is
deliberate: ``cuda:N`` is an escape for the machine with more than one GPU, which
is a fact about *that* machine and not a choice a form can enumerate. A client
holding a connection whose device is outside this tuple shows it as it is rather
than silently rewriting it to the nearest member.
"""

DEVICE_PATTERN: Final = re.compile(r"^(?:cpu|cuda(?::\d+)?)$")
"""Every device string this build can honestly run on.

A pattern rather than an enum because of the one member that is not a fixed
word. What is *not* here is the point: ``gpu``, ``mps``, ``auto`` and every
typo were accepted before and then quietly fell back to the CPU in full
precision — a connection that names a runtime it never gets. The adapters still
fall back when a *valid* device turns out to be absent at run time, which is a
fact about the machine at the moment of the call and belongs there; a device
nothing could ever address is a fact about the configuration and belongs here.
"""


def precisions_for(device: str) -> tuple[Precision, ...]:
    """The precisions that are honoured on that device, in offering order.

    The conditioning rule, stated once, where the validator below and every
    surface that offers a choice can read the same answer. Half precision is
    CUDA-only: both local adapters resolve ``half`` as *this device is CUDA and
    the connection asked for fp16*, so ``cpu`` + ``fp16`` is not a slow run but a
    setting that has no effect at all — and one the row would go on displaying as
    though it did.

    Takes the string rather than a member because ``cuda:1`` is a device and not
    an enum, and returns a tuple rather than a set because a caller offering a
    choice needs an order and a caller checking membership does not care.
    """
    return (Precision.FP32,) if device == CPU else (Precision.FP16, Precision.FP32)


EVERY_CONNECTION_TYPE: Final[frozenset[ConnectionType]] = frozenset(ConnectionType)
"""The kinds that refuse nothing — the type half of an unconditional capability.

The companion of :data:`EVERY_SETUP_STATE`, and it exists for the same reason:
``update`` and ``delete`` are legal for both kinds, and ``CONNECTION_KINDS`` says
so by naming this set rather than by spelling the members out a second time.
"""


WEIGHT_HOLDING_TYPES: Final[frozenset[ConnectionType]] = frozenset({ConnectionType.LOCAL})
"""The kinds that keep weights of their own on this machine.

What both weight actions gate on, and the reason they can share one set: an
``http`` connection has nothing to fetch and therefore nothing to re-read, which
is a fact about what it *is* rather than about where it has got to. Named once
because the fact has two readers: two actions each spelling
``frozenset({ConnectionType.LOCAL})`` would be two places to edit on the day a
third kind arrives with weights.
"""


CHECKABLE_STATES: Final[frozenset[ConnectionSetupState]] = frozenset({ConnectionSetupState.READY})
"""The setup states in which a snapshot is there to be checked.

The one connection gate that is **not** total in state, and the narrowing is
the point rather than an oversight. ``check_integrity`` re-reads the files a
download left behind; a connection at ``not_set_up`` has no snapshot to read, so
the action is not merely pointless there but unanswerable — it would have to
invent a verdict about bytes that were never fetched.

Named here, beside the states it is a subset of, for
:data:`EVERY_SETUP_STATE`'s reason: ``CONNECTION_GATES`` names this set and
``InferenceConnectionService.require_checkable`` reaches the same answer through
``connection_actions``, so there is one encoding of "when is this legal" and a
later widening moves the declaration and the refusal together.
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

    The answer to the question a setup form has to ask on somebody's behalf.
    VisionSet downloads nothing on its own, and a person can only make that
    decision if the size is on screen **before** they confirm — so this is read
    separately from the download and ahead of it.

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


WEIGHT_DOWNLOAD_JOB_TYPE: Final = "inference.download_weights"
"""The background job that fetches a local connection's weights.

**In the domain although the handler is not**, because two sides need the same
word and only one of them may hold it: ``visionset.jobs.weights`` registers the
handler under this type, and :meth:`InferenceConnectionService.downloads` finds a
connection's transfer by it. The kernel is forbidden from importing ``jobs``, so
a constant living there would have to be spelled a second time here — and two
spellings of a job type is a mismatch that surfaces as a download nobody can
observe rather than as an error anybody can see.

The kernel already models background work (``BackgroundJobSpec``, ``JobQueue``);
naming one type of it is that vocabulary used, not widened.
"""

WEIGHT_DOWNLOAD_CONNECTION_KEY: Final = "connection_id"
"""Which connection a weight download is for, inside the job's payload.

Here for the job type's reason, and it is the half that would actually bite: the
handler reads this key and the lookup below matches on it, so a payload written
under one spelling and read under another produces a job that runs correctly and
is invisible to every screen watching for it.
"""


def weight_download_payload(connection_id: UUID) -> dict[str, JsonValue]:
    """The payload a weight download carries. Built here, read here."""
    return {WEIGHT_DOWNLOAD_CONNECTION_KEY: str(connection_id)}


class WeightDownload(BaseModel):
    """A connection's weight transfer: which job, how far, and how it ended.

    **Derived, never stored.** The download's whole record is the background job
    row, and this is that row read as the thing it is about. Persisting a copy on
    the connection would be a second encoding of a number the job already holds,
    and it would need an owner for the case the two disagree.

    **Why the connection carries this rather than the client remembering a job
    id.** A transfer outlives the request that started it and outlives the page
    that asked; the only way a screen can show one it did not itself launch — a
    reload, a second tab, a return visit — is for the resource it lists to say so.
    A job id held in a component is lost by the first navigation, which is exactly
    how a running download came to read as *Not set up*.

    **It does not add a setup state, and must not.** ``ConnectionSetupState``
    stays two-valued: the connection says whether the weights are *here*, and this
    says whether something is currently fetching them. A ``downloading`` member
    would reopen the half-fetched window that ordering closes, and would strand a
    connection there whenever a worker died. A job settles itself — including
    through ``sweep_orphans``, which settles what a dead process left running.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    connection_id: UUID
    job_id: UUID
    state: BackgroundJobState
    #: Bytes that have arrived. Monotonic per job and never above
    #: :attr:`bytes_total`: a transfer that retries re-reads bytes it already had,
    #: and a bar that moves backwards reads as a bug in the product rather than as
    #: a property of the network.
    bytes_done: int = Field(default=0, ge=0)
    #: The whole revision, or ``None`` where the size could not be read.
    #:
    #: Null is a real answer rather than a failure: sizing reaches the hub
    #: independently of the transfer, so a lookup that fails leaves a download
    #: that can still run — and an indeterminate bar is the honest rendering of a
    #: total nobody knows. It is the rule ``BackgroundJob.total`` already states.
    bytes_total: int | None = Field(default=None, ge=0)
    #: Why it failed, in the sentence the handler wrote. ``None`` unless
    #: :attr:`state` is ``failed``.
    error: str | None = None

    @model_validator(mode="after")
    def _progress_is_within_its_total(self) -> WeightDownload:
        if self.bytes_total is not None and self.bytes_done > self.bytes_total:
            raise ValueError(
                f"a download cannot have fetched {self.bytes_done} bytes of {self.bytes_total}"
            )
        return self

    @classmethod
    def of(cls, job: BackgroundJob) -> WeightDownload:
        """That job read as a download, with its counts clamped into shape.

        **This is the one place that knows what the job's counts mean.** A job row
        carries ``processed`` and ``total`` — an absolute count of whatever unit
        the handler works in, which is files for the integrity check and bytes for
        this. Naming them here is what keeps every reader downstream from having
        to know the mapping: a client reads ``bytes_done`` and formats bytes,
        rather than reading ``processed`` and looking up the job type to find out
        what it counted.

        The clamp is applied rather than refused because the input is a row two
        processes wrote: a sampler reports what is on disk while a separately
        measured total is what the form was told, and a snapshot that shares a
        blob between two files legitimately lands slightly under. Refusing there
        would turn a cosmetic disagreement into a connection list that 500s.

        Raises:
            ValueError: the job is not a weight download, or its payload does not
                name a connection.
        """
        if job.type != WEIGHT_DOWNLOAD_JOB_TYPE:
            raise ValueError(f"job {job.id} is a {job.type!r}, not a weight download")
        named = job.payload.get(WEIGHT_DOWNLOAD_CONNECTION_KEY)
        if not isinstance(named, str):
            raise ValueError(f"weight download {job.id} names no connection")
        return cls(
            connection_id=UUID(named),
            job_id=job.id,
            state=job.state,
            bytes_done=job.processed if job.total is None else min(job.processed, job.total),
            bytes_total=job.total,
            error=job.error,
        )


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
    #: ``local`` only. ``cpu``, ``cuda``, or ``cuda:N`` on a machine with more
    #: than one — :data:`DEVICE_PATTERN` is the whole of it. Whether the named
    #: device is *present* is a property of the machine at run time and stays
    #: there; whether it is a device at all is a property of the configuration
    #: and is settled here.
    device: str | None = None
    #: ``local`` only, and conditioned on the device — see :func:`precisions_for`.
    precision: Precision | None = None
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
    #: The ``model_type`` this connection's own downloaded config declares —
    #: recorded when the weights arrive, because that is the first moment it is
    #: knowable without reaching a network. Opaque to the kernel, like
    #: ``model_id``: what a family *means* is
    #: ``visionset.inference.families``' to say.
    #:
    #: **Three states, and the third is the useful one.** ``None`` is *nobody has
    #: looked*, which is where every row written before this column existed
    #: starts. ``""`` is *somebody looked and the config did not say* — the
    #: answer ``family_of`` already gave to an unreadable config, kept rather
    #: than folded into ``None`` so that a look which found nothing is not
    #: repeated on every read. Anything else is the family itself.
    #:
    #: Never derived from the model id. A name is not a declaration, and
    #: matching on one is the guessing this product removed from the resolver.
    model_family: str | None = None

    @field_validator("name", "model_id", "model_revision")
    @classmethod
    def _is_not_blank(cls, value: str, info: object) -> str:
        field = getattr(info, "field_name", "value")
        if not value.strip():
            raise ValueError(f"{field} must contain at least one non-blank character")
        return value

    @field_validator("device", mode="before")
    @classmethod
    def _is_a_device_this_build_can_address(cls, value: object) -> object:
        """Case and surrounding space are forgiven; the vocabulary is not.

        ``before`` because the normalization has to happen for the pattern to
        judge the same string the adapters will read — ``  CUDA `` and ``cuda``
        are one device written two ways, while ``gpu`` is not a device.
        """
        if not isinstance(value, str):
            return value
        device = value.strip().casefold()
        if not DEVICE_PATTERN.match(device):
            raise ValueError(
                f"{value!r} is not a device this build can run on; use "
                f"{', '.join(OFFERED_DEVICES)}, or cuda:N for a second GPU"
            )
        return device

    @field_validator("precision", mode="before")
    @classmethod
    def _is_a_precision_this_build_offers(cls, value: object) -> object:
        """The vocabulary, plus the spellings of it this build already honoured.

        Returns the raw string when it is neither, so that the enum itself
        writes the refusal and there is one sentence listing the members rather
        than two that could disagree.
        """
        if not isinstance(value, str):
            return value
        precision = value.strip().casefold()
        return _PRECISION_ALIASES.get(precision, precision)

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

        The device and the precision are then checked *against each other*,
        which no field validator can do: each is a member of its own vocabulary
        and the pair is what is legal or not. :func:`precisions_for` owns that
        rule, so a surface offering a choice and the kernel refusing one are
        reading the same function rather than two copies of one sentence.
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
        if local:
            assert self.device is not None and self.precision is not None  # the loop above
            offered = precisions_for(self.device)
            if self.precision not in offered:
                raise ValueError(
                    f"{self.precision.value} is not available on {self.device}; "
                    f"{self.device} runs in {', '.join(one.value for one in offered)}"
                )
        return self
