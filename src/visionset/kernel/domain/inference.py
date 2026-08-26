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
from collections.abc import Set as AbstractSet
from datetime import UTC, datetime
from enum import StrEnum
from typing import ClassVar, Final, Self
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator, model_validator

from visionset.kernel.domain.job import BackgroundJob, BackgroundJobState
from visionset.kernel.domain.schema import GeometryType
from visionset.kernel.domain.vocabulary import OpenVocabulary


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
# values a build can serve is a fact about which drivers are installed, and the
# kernel has no view of that. Each driver declares its own families and the
# capability each one takes.
#
# The reasoning is a comment because this enum is *published*: FastAPI copies a
# docstring verbatim into `openapi.json`, where RST markup ships as literal
# backticks and internal rationale ships as API documentation. The docstring is
# the sentence a client should read, on `ConnectionAction`'s terms.
class ModelOrigin(StrEnum):
    """Where a connection's weights come from — who published them, not who runs them.

    A different axis from ``ConnectionType`` (where the model *runs*) and from
    ``provider_id`` (which *driver* runs it): a hub checkpoint served locally and
    the same checkpoint behind somebody's endpoint share an origin and nothing
    else. Closed, on ``ConnectionType``'s test: a caller states it on creation,
    so a client must be able to enumerate what it may send, and the set grows
    only by a deliberate kernel change — the next origin is exactly that change.
    """

    #: A checkpoint fetched from the public hub, curated or typed by hand.
    HUGGINGFACE = "huggingface"
    #: The user's own — an endpoint they stood up, or weights they brought.
    CUSTOM = "custom"
    #: A model from the Robomous registry.
    ROBOMOUS = "robomous"


def default_origin(connection_type: ConnectionType) -> ModelOrigin:
    """The origin a kind implies when nobody states one.

    The only local path this build has fetches from the hub, and an ``http``
    endpoint is, until something says otherwise, somebody's own. Stated once so
    the service and the migration that backfills old rows cannot disagree.
    """
    return (
        ModelOrigin.HUGGINGFACE if connection_type is ConnectionType.LOCAL else ModelOrigin.CUSTOM
    )


class ModelCapability(OpenVocabulary):
    """What a connection's model can be asked for: the kind of prompt it takes."""

    #: Give me the thing under these points.
    POINT_SUGGEST = "point_suggest"
    #: Find everything these words name.
    TEXT_DETECT = "text_detect"


class ServedFamily(BaseModel):
    """What a driver declares about one family: what it takes, and the shapes it answers in.

    Prompt kind and output geometry are independent axes — a model that takes
    words may answer with boxes or with masks — and a declaration carrying only
    the first left every consumer to assume the second. ``produces`` is declared
    over ``GeometryType``, every name the domain can address, so a class is
    askable when it admits any shape the model produces.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    capability: ModelCapability
    produces: frozenset[GeometryType] = Field(min_length=1)


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

MPS: Final = "mps"
"""Apple Silicon's GPU, and there is only ever one of it.

Named for the framework that drives it rather than for the hardware, which is
how the array library spells it and therefore the only spelling an adapter can
hand on unchanged.
"""

OFFERED_DEVICES: Final[tuple[str, ...]] = (CPU, CUDA, MPS)
"""The devices a form offers, in the order it offers them.

Not the whole of what :data:`DEVICE_PATTERN` accepts, and the difference is
deliberate: ``cuda:N`` is an escape for the machine with more than one GPU, which
is a fact about *that* machine and not a choice a form can enumerate. A client
holding a connection whose device is outside this tuple shows it as it is rather
than silently rewriting it to the nearest member.
"""

DEVICE_PATTERN: Final = re.compile(r"^(?:cpu|mps|cuda(?::\d+)?)$")
#: What POSIX lets a shell name a variable. Stricter spellings exist on some
#: platforms; none of them is one a credential is worth refusing over.
_ENV_NAME_PATTERN: Final = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
"""Every device string this build can honestly run on.

A pattern rather than an enum because of the one member that is not a fixed
word. The rule is that a device is here when this build can *honour* it, and
what is not here is as much the point as what is: ``gpu``, ``auto`` and every
typo were accepted before and then quietly fell back to the CPU in full
precision — a connection that names a runtime it never gets. ``mps`` was out for
that same reason and is in now, because the adapters resolve it, run on it, and
condition its precision like any other device rather than degrading it in
silence. The adapters still fall back when a *valid* device turns out to be
absent at run time, which is a fact about the machine at the moment of the call
and belongs there; a device nothing could ever address is a fact about the
configuration and belongs here.
"""


def precisions_for(device: str) -> tuple[Precision, ...]:
    """The precisions that are honoured on that device, in offering order.

    The conditioning rule, stated once, where the validator below and every
    surface that offers a choice can read the same answer. Half precision is
    CUDA-only: both local adapters resolve ``half`` as *this device is CUDA and
    the connection asked for fp16*, so ``cpu`` + ``fp16`` is not a slow run but a
    setting that has no effect at all — and one the row would go on displaying as
    though it did.

    ``mps`` answers the same way ``cpu`` does, and for a reason of its own rather
    than by inheriting the adapters' rule: Metal has no float64 at all and its
    bfloat16 is inconsistent across releases, so full precision is the only
    numeric format that behaves the same on every machine that offers the device.

    Takes the string rather than a member because ``cuda:1`` is a device and not
    an enum, and returns a tuple rather than a set because a caller offering a
    choice needs an order and a caller checking membership does not care.
    """
    return (Precision.FP32,) if device in (CPU, MPS) else (Precision.FP16, Precision.FP32)


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


RETARGETABLE_STATES: Final[frozenset[ConnectionSetupState]] = frozenset(
    {ConnectionSetupState.NOT_SET_UP}
)
"""The setup states in which a connection may still be pointed at a different model.

Before the weights arrive nothing has been committed: the reference is a plan,
and changing the plan costs nobody anything. Once they are here the connection
*is* those weights — labels carry its id as provenance, the family and the
driver were read out of that model's config — and a different model is a new
connection, not an edit to this one. ``update_model`` is declared on this set,
and ``InferenceConnectionService.update`` refuses a moved reference outside it
through the same declaration, so the control a client offers and the answer a
caller gets come from one rule.
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


COMMIT_PATTERN: Final = re.compile(r"^[0-9a-f]{40}$")
"""What a curated revision must be: a whole commit, in lower-case hex.

A branch, a tag and an abbreviated hash are each either movable or ambiguous, and
any of them makes :class:`CuratedModel`'s promise untrue without changing a
character of the entry that made it.
"""


class CuratedModel(BaseModel):
    """One checkpoint a provider offers by name, for a form to put on screen.

    Curation guides and never restricts: any model id remains typeable at any
    revision. Declared by the provider that runs it, so the offered list is a
    property of the installation rather than of this repository.

    **The revision is a commit and never a branch** — :data:`COMMIT_PATTERN` is
    the whole of it. Pinning is what lets the rest of an entry stay true: an
    immutable snapshot has one config, one family and one size.

    **No size.** What a download costs is :class:`DownloadSize`, read live and
    ahead of the confirmation. A copy here is only ever read while somebody is
    still deciding, so nothing would notice it going stale.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    model_id: str
    model_revision: str
    #: The ``model_type`` this checkpoint's config declares, opaque here for
    #: :attr:`InferenceConnection.model_family`'s reason. It must be one the
    #: declaring provider serves; an entry cannot see the provider holding it, so
    #: the conformance suite is where that is checked.
    family: str
    #: One line on what this entry is — neither the size nor the access
    #: requirement, both already on screen beside it.
    #:
    #: **No word whose referent is somewhere else** — "newer", "different",
    #: "other", "improved", "latest": a form groups these by the question a model
    #: answers rather than ranking them, so there is nothing on screen for such a
    #: word to point at. A reader meets one as a comparison whose first half is
    #: missing.
    hint: str
    #: What must be cleared before this can be fetched, and where. Present as a
    #: pair or not at all: either half alone is a requirement a form cannot finish
    #: stating before it offers the download.
    access_note: str | None = None
    access_url: str | None = None

    @field_validator("model_id", "family", "hint")
    @classmethod
    def _is_not_blank(cls, value: str, info: object) -> str:
        field = getattr(info, "field_name", "value")
        if not value.strip():
            raise ValueError(f"{field} must contain at least one non-blank character")
        return value

    @field_validator("model_revision")
    @classmethod
    def _is_a_commit(cls, value: str) -> str:
        """Blankness is covered here rather than above: an empty revision and a
        branch name are the same mistake, so they get one sentence."""
        if not COMMIT_PATTERN.match(value):
            raise ValueError(
                f"model_revision must be a whole 40-character commit hash, not {value!r}; "
                "a branch or a tag moves, so an entry pinned to one would describe "
                "whatever it pointed at last"
            )
        return value

    @model_validator(mode="after")
    def _access_is_stated_whole(self) -> Self:
        if (self.access_note is None) != (self.access_url is None):
            raise ValueError(
                "access_note and access_url are given together or not at all; "
                "either half alone is a requirement a form cannot finish stating"
            )
        return self


WEIGHT_DOWNLOAD_JOB_TYPE: Final = "inference.download_weights"
"""The background job that fetches a local connection's weights."""

INTEGRITY_CHECK_JOB_TYPE: Final = "inference.check_integrity"
"""The background job that re-reads a cached snapshot and judges it."""

CONNECTION_JOB_KEY: Final = "connection_id"
"""Which connection a background job is about, inside its payload.

Shared by both job types above because both are about exactly one connection, and
naming it once is the difference between a lookup that finds a job and one that
runs perfectly while being invisible to everything watching for it.
"""


def connection_job_payload(connection_id: UUID) -> dict[str, JsonValue]:
    """The payload a connection's background job carries. Built here, read here."""
    return {CONNECTION_JOB_KEY: str(connection_id)}


PRE_LABEL_JOB_TYPE: Final = "annotation.pre_label"
"""The background job that asks a text-prompt model to label a batch's untouched assets."""

BATCH_JOB_KEY: Final = "batch_id"
"""Which batch a background job is about, inside its payload."""

ANNOTATION_JOB_KEY: Final = "annotation_job_id"
"""Which annotation job a pre-labeling run is over, inside its payload."""

PRE_LABEL_CONFIDENCE_KEY: Final = "minimum_confidence"
"""The floor a run applies to what the model returns, inside its payload."""

PRE_LABEL_REPLACE_KEY: Final = "replace_model_labels"
"""Whether a run supersedes the model labels on ``pre_labeled`` frames, inside its payload."""

PRE_LABEL_GEOMETRIES_KEY: Final = "geometries"
"""Which of the model's shapes a run writes, inside its payload. ``None`` is every one."""


def pre_label_job_payload(
    job_id: UUID,
    batch_id: UUID,
    connection_id: UUID,
    minimum_confidence: float,
    replace_model_labels: bool = False,
    geometries: AbstractSet[GeometryType] | None = None,
) -> dict[str, JsonValue]:
    """The payload a pre-labeling job carries. Built here, read here.

    Six facts and no more: which annotation job, which batch it is a segment
    of, which connection answers, the floor the run applies, whether it may
    supersede its own earlier labels, and which of the model's shapes it
    writes. The batch is carried beside the job so a batch listing can find
    its runs without a join; the job is the unit the run is over.
    """
    selected: JsonValue = (
        None if geometries is None else [shape.value for shape in sorted(geometries)]
    )
    return {
        ANNOTATION_JOB_KEY: str(job_id),
        BATCH_JOB_KEY: str(batch_id),
        CONNECTION_JOB_KEY: str(connection_id),
        PRE_LABEL_CONFIDENCE_KEY: minimum_confidence,
        PRE_LABEL_REPLACE_KEY: replace_model_labels,
        PRE_LABEL_GEOMETRIES_KEY: selected,
    }


class ConnectionJob(BaseModel):
    """Background work against one connection, read off its job row.

    **Derived, never stored.** A run's whole record is the row the queue keeps,
    and this is that row read as the thing it is about. Persisting a copy on the
    connection would be a second encoding of numbers the job already holds, and it
    would need an owner for the case the two disagree.

    **Why the connection carries this rather than the client remembering a job
    id.** A run outlives the request that started it and outlives the page that
    asked; the only way a screen can show one it did not itself launch — a reload,
    a second tab, a return visit, a run somebody started from the terminal — is
    for the resource it lists to say so. A job id held in a component is lost by
    the first navigation, which is how a running download came to read as *Not set
    up* and a running check as though nothing were happening.

    **It adds no setup state, and must not.** ``ConnectionSetupState`` stays
    two-valued: the connection says whether usable weights are *here*, and this
    says whether something is currently working on them. A third member would
    reopen the window that ordering closes — the state flip is the last statement
    of both operations — and would strand a connection there whenever a worker
    died. A job settles itself, including through ``sweep_orphans``, which settles
    what a dead process left running.

    **Subclasses name the counts and this class does not**, which is the whole of
    why there are two of them rather than one shape with a ``kind``. A job row's
    ``processed`` and ``total`` are an absolute count of whatever unit its handler
    works in — bytes for a transfer, files for a re-read — and a wire field whose
    meaning depended on a sibling field would put that lookup in every client. The
    unit is named exactly where the job type is known: here.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    #: The job type a subclass reads. Not a field: it says which rows this class
    #: can be built from, which is a fact about the class rather than about any
    #: one run.
    JOB_TYPE: ClassVar[str]

    connection_id: UUID
    job_id: UUID
    state: BackgroundJobState
    #: Why it failed, in the sentence the handler wrote. ``None`` unless
    #: :attr:`state` is ``failed``.
    error: str | None = None
    #: That sentence's stable identifier, where the row has one. See
    #: ``BackgroundJob.error_code``.
    error_code: str | None = None

    @classmethod
    def of(cls, job: BackgroundJob) -> Self:
        """That job read as this kind of run.

        One body for both kinds, because the identification is identical and only
        the counts differ: check the type, read the connection out of the payload,
        and let :meth:`_counts` name the unit.

        Raises:
            ValueError: the job is not this kind, or its payload names no
                connection.
        """
        if job.type != cls.JOB_TYPE:
            raise ValueError(f"job {job.id} is a {job.type!r}, not a {cls.JOB_TYPE!r}")
        named = job.payload.get(CONNECTION_JOB_KEY)
        if not isinstance(named, str):
            raise ValueError(f"job {job.id} names no connection")
        return cls(
            connection_id=UUID(named),
            job_id=job.id,
            state=job.state,
            error=job.error,
            error_code=job.error_code,
            **cls._counts(job),
        )

    @classmethod
    def _counts(cls, job: BackgroundJob) -> Mapping[str, int | None]:
        """This kind's progress fields, named for what they count."""
        raise NotImplementedError


def _at_most(done: int, total: int | None) -> int:
    """That count, held under the total it is a fraction of.

    Clamped rather than refused, because the two numbers can come from different
    places — a download's are a disk measurement against a published size — and a
    cosmetic disagreement must not turn a connection listing into a 500. What it
    prevents is the visible failure: a bar that fills past its own end.
    """
    return done if total is None else min(done, total)


class WeightDownload(ConnectionJob):
    """A connection's weight transfer: which job, how far, and how it ended."""

    JOB_TYPE: ClassVar[str] = WEIGHT_DOWNLOAD_JOB_TYPE

    #: Bytes that have arrived. Monotonic per job and never above
    #: :attr:`bytes_total`: a transfer that retries re-reads bytes it already had,
    #: and a bar that moves backwards reads as a bug in the product rather than as
    #: a property of the network.
    bytes_done: int = Field(default=0, ge=0)
    #: The whole revision, or ``None`` where the size could not be read.
    #:
    #: Null is a real answer rather than a failure: sizing reaches the hub
    #: independently of the transfer, so a lookup that fails leaves a download
    #: that can still run — and no bar at all is the honest rendering of a total
    #: nobody knows. It is the rule ``BackgroundJob.total`` already states.
    bytes_total: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _progress_is_within_its_total(self) -> WeightDownload:
        if self.bytes_total is not None and self.bytes_done > self.bytes_total:
            raise ValueError(
                f"a download cannot have fetched {self.bytes_done} bytes of {self.bytes_total}"
            )
        return self

    @classmethod
    def _counts(cls, job: BackgroundJob) -> Mapping[str, int | None]:
        return {"bytes_done": _at_most(job.processed, job.total), "bytes_total": job.total}


class IntegrityCheck(ConnectionJob):
    """A connection's snapshot re-read: which job, how far, and what it found.

    **Files rather than bytes, and the asymmetry with the download is honest.** A
    transfer hands its work to a library that reports nothing a caller can use, so
    its progress is measured off the disk in bytes; a check owns its own loop and
    knows how many files it has before it opens the first one. Each reports the
    unit it actually counts, which is why neither borrows the other's name.

    **What a finished check means is on the connection, not here.** A pass leaves
    the row ``ready`` and a failure has already purged the damaged blobs and stood
    the connection down by the time this says ``failed`` — so the verdict a reader
    acts on is ``setup_state`` plus the action it now declares, and what this adds
    is the sentence saying why. That ordering is
    ``visionset.inference.integrity``'s and nothing here changes it.
    """

    JOB_TYPE: ClassVar[str] = INTEGRITY_CHECK_JOB_TYPE

    #: Files re-read and compared so far.
    files_read: int = Field(default=0, ge=0)
    #: How many the revision names, or ``None`` before the run has read the hub's
    #: listing. Unlike a download's total this is known almost immediately and from
    #: the same metadata the check needs anyway, so the null window is the moment
    #: between claiming the job and the first published digest arriving.
    files_total: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _progress_is_within_its_total(self) -> IntegrityCheck:
        if self.files_total is not None and self.files_read > self.files_total:
            raise ValueError(
                f"a check cannot have read {self.files_read} files of {self.files_total}"
            )
        return self

    @classmethod
    def _counts(cls, job: BackgroundJob) -> Mapping[str, int | None]:
        return {"files_read": _at_most(job.processed, job.total), "files_total": job.total}


class ConnectionJobs(BaseModel):
    """Every connection's latest run of each kind, read from the queue at once.

    A named pair rather than two calls, because the caller is a listing that
    polls: one query answers both questions for every row, and a shape that
    returned only one of them would have the screen ask twice on its own interval.

    Not a wire model and never published. What a client reads is the two fields
    hung off the connection it was already listing; this is how a projection gets
    them without a query per row.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    downloads: Mapping[UUID, WeightDownload] = Field(default_factory=dict)
    checks: Mapping[UUID, IntegrityCheck] = Field(default_factory=dict)


class PreLabelRun(BaseModel):
    """A job's most recent pre-labeling run, read off its queue row.

    ``ConnectionJob``'s model, applied to an annotation job instead of a
    connection: a run outlives the request that launched it and the page that
    asked, so the only way a screen can show one it did not itself launch — a
    reopened dialog, a second tab, a run somebody started from the terminal — is
    for the job it lists to say so. Derived, never stored: persisting a copy
    would be a second encoding of numbers the job row already holds. Not a
    subclass of ``ConnectionJob``, because its identity is an annotation job
    rather than a connection — the shape is shared by imitation, not by
    inheritance.

    **Named for what its handler counts.** ``prelabel.py``'s unit is assets, so
    ``assets_processed``/``assets_total`` are named here rather than borrowing a
    download's or a check's vocabulary — the counts belong where the job type
    is known, on ``ConnectionJob``'s own reasoning.

    **The handler's own outcome, carried rather than re-derived.**
    ``stopped_early``, ``assets_labeled``, ``regions_discarded``,
    ``regions_out_of_bounds`` and ``annotations_replaced`` are read
    straight out of the settled job's ``result`` — the dict ``prelabel.py``'s
    ``run`` returns — because a bare progress count cannot say how a cancelled
    run differs from an untouched batch, nor how many of a model's answers were
    thrown away for naming a class nobody asked for. ``None`` until the job has
    settled with a result: a failed run never reaches the point of building one.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    #: The job type this is read from. Not a field: it is a fact about the
    #: class, on ``ConnectionJob.JOB_TYPE``'s terms.
    JOB_TYPE: ClassVar[str] = PRE_LABEL_JOB_TYPE

    batch_id: UUID
    annotation_job_id: UUID
    job_id: UUID
    state: BackgroundJobState
    #: Assets looked at so far, clamped to :attr:`assets_total` for
    #: :func:`_at_most`'s reason: the two can come from different places and a
    #: cosmetic mismatch must not read as a bar past its own end.
    assets_processed: int = Field(default=0, ge=0)
    #: The whole eligible set, or ``None`` before the run has derived it. Unlike
    #: a download's total this is known almost immediately: the asset set is
    #: computed up front rather than discovered mid-run.
    assets_total: int | None = Field(default=None, ge=0)
    #: Why it failed, in the handler's own sentence. ``None`` unless
    #: :attr:`state` is ``failed``.
    error: str | None = None
    #: That sentence's stable identifier, where the row has one. See
    #: ``BackgroundJob.error_code``.
    error_code: str | None = None
    #: Whether the run stopped before reaching every eligible asset —
    #: cancelled, or an orphan a crash left behind. ``None`` until the job
    #: settles with a result.
    stopped_early: bool | None = None
    #: Assets the run actually wrote a label onto. Narrower than
    #: :attr:`assets_processed`: an asset a person started working on mid-run is
    #: passed over, not labeled. ``None`` until the job settles with a result.
    assets_labeled: int | None = None
    #: Regions the model answered with a class the schema's prompt never asked
    #: for, discarded rather than written. ``None`` until the job settles with a
    #: result.
    regions_discarded: int | None = None
    #: Regions whose mapped geometry had no overlap with a measured asset,
    #: discarded rather than written. ``None`` until the job settles with a
    #: result.
    regions_out_of_bounds: int | None = None
    #: Model labels a replacing run superseded. ``None`` until the job settles
    #: with a result.
    annotations_replaced: int | None = None

    @model_validator(mode="after")
    def _progress_is_within_its_total(self) -> Self:
        if self.assets_total is not None and self.assets_processed > self.assets_total:
            raise ValueError(
                f"a pre-label run cannot have processed {self.assets_processed} of "
                f"{self.assets_total} assets"
            )
        return self

    @classmethod
    def of(cls, job: BackgroundJob) -> Self:
        """That job read as a batch's pre-labeling run.

        ``ConnectionJob.of``'s shape: check the type, read the batch out of the
        payload, and the run's own outcome — where the job has settled with one
        — out of ``result``.

        Raises:
            ValueError: the job is not a pre-labeling run, or its payload names
                no batch or no annotation job.
        """
        if job.type != cls.JOB_TYPE:
            raise ValueError(f"job {job.id} is a {job.type!r}, not a {cls.JOB_TYPE!r}")
        named = job.payload.get(BATCH_JOB_KEY)
        if not isinstance(named, str):
            raise ValueError(f"job {job.id} names no batch")
        named_job = job.payload.get(ANNOTATION_JOB_KEY)
        if not isinstance(named_job, str):
            raise ValueError(f"job {job.id} names no annotation job")
        result = job.result
        stopped_early = result.get("stopped_early")
        assets_labeled = result.get("assets_labeled")
        regions_discarded = result.get("regions_discarded")
        regions_out_of_bounds = result.get("regions_out_of_bounds")
        annotations_replaced = result.get("annotations_replaced")
        return cls(
            batch_id=UUID(named),
            annotation_job_id=UUID(named_job),
            job_id=job.id,
            state=job.state,
            assets_processed=_at_most(job.processed, job.total),
            assets_total=job.total,
            error=job.error,
            error_code=job.error_code,
            stopped_early=stopped_early if isinstance(stopped_early, bool) else None,
            assets_labeled=_result_int(assets_labeled),
            regions_discarded=_result_int(regions_discarded),
            regions_out_of_bounds=(_result_int(regions_out_of_bounds)),
            annotations_replaced=_result_int(annotations_replaced),
        )


def _result_int(value: object) -> int | None:
    """An integer job-result value, without accepting Python's boolean subtype."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


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
    #: **For an ``http`` connection it is the capability the endpoint
    #: declared**, recorded verbatim by ``test_endpoint`` — the same literal
    #: read, from a different declaration.
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
    #: Which installed driver serves this connection — the ``provider_id`` a
    #: driver calls itself by, recorded rather than worked out.
    #:
    #: **It answers a different question from** :attr:`model_family`, and both
    #: are kept. The family is what the downloaded config declares, so it is what
    #: catches a connection pointed at the wrong kind of model, and a driver
    #: serving several families still has to be told which one. This says who
    #: runs it — which is knowable *before* anything is downloaded, and is the
    #: only thing that is when the weights come from somewhere this build does
    #: not fetch from by default, or when there are no weights on this machine at
    #: all.
    #:
    #: ``None`` is legitimate and means nobody recorded one: every row written
    #: before this column existed, and every connection created against a model
    #: nothing in the catalog offers. Resolution falls back to the family for
    #: those, which is what it did for all of them before.
    #:
    #: Opaque to the kernel, and necessarily so — whether a driver of that name
    #: is installed is a fact about ``visionset.inference``'s entry-point scan,
    #: which the kernel is forbidden to reach. A recorded provider that is not
    #: installed is refused where the registry can be seen, not here.
    provider_id: str | None = None
    #: ``http`` only. The **name** of an environment variable whose value is the
    #: credential the endpoint wants — never the credential itself. The workspace
    #: is a plain SQLite file that travels in backups and copies, so a secret
    #: stored in it would be stored wherever the file goes; a name is not a
    #: secret, and the process that speaks to the endpoint reads the value from
    #: its own environment at call time. Validated as a name a shell would
    #: accept, because that is the one thing that is knowable here: whether the
    #: variable is *set* is a fact about the process, and is judged by the driver
    #: when it is about to need it.
    credential_env: str | None = None
    #: Where the weights come from. Filled from the kind when a caller does not
    #: say — see :func:`default_origin` — so no row is ever without one; a row
    #: written before the column existed reads back through the same rule.
    origin: ModelOrigin

    @model_validator(mode="before")
    @classmethod
    def _origin_from_kind(cls, data: object) -> object:
        if isinstance(data, dict) and data.get("origin") is None:
            try:
                kind = ConnectionType(str(data.get("connection_type")))
            except ValueError:
                return data
            return {**data, "origin": default_origin(kind)}
        return data

    @field_validator("name", "model_id", "model_revision")
    @classmethod
    def _is_not_blank(cls, value: str, info: object) -> str:
        field = getattr(info, "field_name", "value")
        if not value.strip():
            raise ValueError(f"{field} must contain at least one non-blank character")
        return value

    @field_validator("provider_id")
    @classmethod
    def _is_not_blank_when_given(cls, value: str | None) -> str | None:
        """Blank is refused where absent is not: they would mean the same thing
        and only one of them says so."""
        if value is not None and not value.strip():
            raise ValueError(
                "provider_id is a driver's own id or nothing at all; "
                "a blank string says the same as no value and hides that it does"
            )
        return value

    @field_validator("credential_env")
    @classmethod
    def _is_a_variable_name(cls, value: str | None) -> str | None:
        if value is not None and not _ENV_NAME_PATTERN.fullmatch(value):
            raise ValueError(
                "credential_env is the name of an environment variable — letters, digits and "
                "underscores, not starting with a digit — or nothing at all"
            )
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
        forbidden = ("endpoint_url", "credential_env") if local else ("device", "precision")
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
