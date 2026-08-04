# usage: from visionset.kernel.domain import require_move, require_state
"""The one way to ask this domain whether an operation's state precondition holds.

Three state machines live in this domain — ``BATCH_TRANSITIONS``,
``JOB_TRANSITIONS`` / ``ASSET_PROGRESS_TRANSITIONS``, and ``INGEST_TRANSITIONS``
— and "is this move in the table" is the same question for all of them. It is
asked here rather than once per service, so a refusal reads the same way
whichever machine produced it and no service can quietly grow a chain of guards
that disagrees with its own table.

Two questions, not one, because the domain asks two. :func:`require_move` asks
whether a *move* is in a table; :func:`require_state` asks whether the resource
is in a named set of states an operation needs — which is a real question here,
because some operations change no state at all and so appear in no table's row.
Re-pinning a batch's schema is the example: it moves the pin, not the batch. Both
funnel to the same error for the same reason — a caller cannot usefully tell the
two apart, and ``InvalidTransition``'s docstring already promises that the legal
answers are data rather than a hand-written guard.

Domain rather than services, on ``normalize_name``'s terms: a rule every service
consults, expressed against domain values, raising a domain error.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum

from visionset.kernel.errors import InvalidTransition


def require_move[S: StrEnum](
    transitions: Mapping[S, frozenset[S]], current: S, to: S, subject: str
) -> None:
    """Consult a transition table, and refuse in its own vocabulary.

    Generic over every machine rather than written once per service: ``subject``
    is what lets the refusal name a batch by its name and a run by its id while
    the sentence itself stays one sentence.

    Raises:
        InvalidTransition: ``to`` is not in the table's entry for ``current``.
    """
    if to in transitions[current]:
        return
    legal = ", ".join(sorted(state.value for state in transitions[current])) or "nothing"
    raise InvalidTransition(
        f"{subject} is {current.value!r} and cannot become {to.value!r}; "
        f"from here it can only become {legal}"
    )


def require_state[S: StrEnum](
    allowed: frozenset[S], current: S, subject: str, *, refusal: str
) -> None:
    """Consult a named set of states, and refuse in its own vocabulary.

    The sibling of :func:`require_move`, for the operations that need the
    resource to be *somewhere* rather than to *go* somewhere. A hand-written
    ``if state not in SOME_SET: raise`` inside a service is the same drift risk a
    hand-written chain of transition guards is — it is one more place the answer
    lives — so the set is declared beside its machine and asked about here.

    ``refusal`` says what the caller cannot have, phrased as a consequence, so
    the sentence reads as one sentence: *batch 'frames' is 'completed', so its
    schema pin cannot move; that is only legal from approved, in_annotation.*

    Only for sets whose refusal is ``InvalidTransition``. A set guarding a
    different error — ``EDITABLE_STATES`` behind ``BatchNotEditable``,
    ``PROMOTABLE_STATES`` behind ``BatchNotComplete`` — is consulted directly by
    the service that owns that wording, because the error is the point of the
    distinction and folding it in here would erase it.

    Raises:
        InvalidTransition: ``current`` is not in ``allowed``.
    """
    if current in allowed:
        return
    legal = ", ".join(sorted(state.value for state in allowed)) or "nothing"
    raise InvalidTransition(
        f"{subject} is {current.value!r}, so {refusal}; that is only legal from {legal}"
    )
