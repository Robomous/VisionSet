# usage: from visionset.kernel.domain import require_move
"""The one way to ask a transition table whether a move is allowed.

Three state machines live in this domain — ``BATCH_TRANSITIONS``,
``JOB_TRANSITIONS`` / ``ASSET_PROGRESS_TRANSITIONS``, and ``INGEST_TRANSITIONS``
— and "is this move in the table" is the same question for all of them. It is
asked here rather than once per service, so a refusal reads the same way
whichever machine produced it and no service can quietly grow a chain of guards
that disagrees with its own table.

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
