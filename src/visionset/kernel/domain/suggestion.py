# usage: from visionset.kernel.domain import Detail, suggest_parameters
"""How a model's mask becomes a shape, said out loud so a client can offer it.

A segmenter answers a click with a grid of booleans, and turning that grid into a
polygon or a box is a chain of choices: which blobs to keep, whether to close the
holes inside them, how much of the traced outline survives. Most of those choices
are made once, with a fixed default, by the pipeline — and one of them is worth
putting in front of the person looking at the proposal. This module is the
vocabulary for the one.

**The names are this domain's, not an imaging library's.** ``detail`` is a
question about the shape somebody is going to edit; ``epsilon`` is a parameter of
one algorithm that happens to answer it. Naming the parameter after the algorithm
would publish an implementation as a contract and make a second implementation a
breaking change.

**Applicability is declared, never derived.** ``detail`` is about an outline, so
it means nothing for a class that stores a box; a client that worked that out for
itself would be the hand-mirrored table ``capabilities.py`` exists to prevent, and
it would drift the first time a parameter changed hands. So
:data:`PARAMETER_APPLIES_TO` states it once and :func:`suggest_parameters` is the
only reader.

**Two settings were here and are not.** Closing the gaps in a mask and dropping
its noise specks are still done, at fixed defaults that live beside the pipeline
in ``visionset.inference.masks``. They stopped being askable because on an
ordinary single clean piece every position of either gave the same shape, so they
read as controls wired to nothing (#557). Their value is in the default rather
than in the choice; they come back as parameters if a real need for the choice
appears.

Pure, and in the domain rather than beside the code that computes the pipeline,
on ``capabilities.py``'s terms: a question about domain values, answered from a
domain table, with no I/O. What the members *numerically* mean is a property of
the simplification algorithm and lives beside it, the way ``ModelCapability``
lives here and the family-to-capability mapping is declared by each driver that
satisfies it.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Final

from visionset.kernel.domain.schema import GeometryType


# Three steps rather than a number, on ``Precision``'s test: the set is small,
# somebody choosing between them is choosing how much work a shape will be to
# edit rather than tuning a tolerance, and a free scalar on the wire would be a
# knob whose useful range only the implementation knows.
#
# Declaration order is display order, and it is coarsest-first so that `[` and
# `]` move the same direction as the list reads.
#
# The reasoning lives here rather than in the docstring because FastAPI copies a
# docstring verbatim into `openapi.json` as the schema's `description`, where an
# internal rationale is noise and RST markup renders as literal backticks.
class Detail(StrEnum):
    """How much of an outline survives simplification. Order is display order."""

    #: Fewest vertices — a shape to nudge into place rather than to trust.
    COARSE = "coarse"
    #: The middle setting, and the one every suggestion used before there was a choice.
    BALANCED = "balanced"
    #: Most vertices — follows the mask closely, and costs more to edit by hand.
    FINE = "fine"


# One member per parameter, and the table below owes every one of them a row.
class SuggestParameter(StrEnum):
    """A setting that shapes a suggestion. Order is display order."""

    DETAIL = "detail"


DEFAULT_DETAIL: Final = Detail.BALANCED
"""What a caller that says nothing gets, and what every suggestion got before."""


PARAMETER_APPLIES_TO: Final[Mapping[SuggestParameter, frozenset[GeometryType]]] = {
    SuggestParameter.DETAIL: frozenset({GeometryType.POLYGON}),
}
"""Which geometries each parameter has any effect on.

``detail`` is about an *outline*: it decides how many vertices that outline keeps.
A box has no outline to spend a vertex budget on, so offering it for a box class
would be offering a control that does nothing. A box class therefore declares no
parameters at all, and a client shows it no adjustments — which is a rendering
rule the client reads rather than one it works out (#557).

**A parameter missing from this mapping is a test failure, not a default.**
``test_every_parameter_declares_the_geometries_it_applies_to`` sweeps
``SuggestParameter`` against these keys, so a second parameter arrives with its
applicability stated or it does not arrive. The alternative — treating an absent
row as "applies to everything" — is the one that ships a control nobody can use
and nobody notices.
"""


def suggest_parameters(geometry: GeometryType) -> tuple[SuggestParameter, ...]:
    """The parameters worth offering for a suggestion in that kind, in display order.

    The only reader of :data:`PARAMETER_APPLIES_TO`, so that a surface deciding
    what to render never re-derives the rule. A geometry no parameter applies to
    answers empty, which is honest rather than exceptional: it is how a box class
    is told there is nothing here to adjust, and a class that holds no shape gets
    no suggestion to adjust in the first place.
    """
    return tuple(
        parameter for parameter in SuggestParameter if geometry in PARAMETER_APPLIES_TO[parameter]
    )
