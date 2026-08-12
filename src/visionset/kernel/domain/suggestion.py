# usage: from visionset.kernel.domain import Detail, Fragments, suggest_parameters
"""How a model's mask becomes a shape, said out loud so a client can offer it.

A segmenter answers a click with a grid of booleans, and turning that grid into a
polygon or a box is a chain of choices: which blobs to keep, whether to close the
holes inside them, how much of the traced outline survives. Those choices used to
be made once, invisibly, by whatever ran the model. This module is the vocabulary
for making them askable.

**The names are this domain's, not an imaging library's.** ``detail`` is a
question about the shape somebody is going to edit; ``epsilon`` is a parameter of
one algorithm that happens to answer it. Naming the parameter after the algorithm
would publish an implementation as a contract and make a second implementation a
breaking change.

**Applicability is declared, never derived.** ``detail`` and ``fill_holes`` are
about an outline, so they mean nothing for a class that stores a box; a client
that worked that out for itself would be the hand-mirrored table
``capabilities.py`` exists to prevent, and it would drift the first time a
parameter changed hands. So :data:`PARAMETER_APPLIES_TO` states it once and
:func:`suggest_parameters` is the only reader.

Pure, and in the domain rather than beside the code that computes the pipeline,
on ``capabilities.py``'s terms: a question about domain values, answered from a
domain table, with no I/O. What the members *numerically* mean is a property of
the simplification algorithm and lives beside it, the way ``ModelCapability``
lives here and ``CAPABILITY_BY_FAMILY`` lives with the adapters that satisfy it.
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


# ``ONE`` rather than ``LARGEST``, because the blob it selects is the one the
# prompt points at rather than the biggest one on the frame. That distinction is
# the whole of the gesture: a point-prompted segmenter is asked about a *place*,
# and the blob owning the topmost-leftmost lit pixel is a fact about where
# speckle fell. Naming this ``largest`` would describe a tie-break as though it
# were the rule.
class Fragments(StrEnum):
    """How many of a mask's separate pieces become shapes.

    `one` is the piece your points are on, not the biggest piece on the frame:
    which of them you meant is a question only the prompt can answer. `all`
    proposes every piece big enough to be worth proposing.
    """

    #: The piece the prompt points at, and nothing else.
    ONE = "one"
    #: Every piece big enough to be worth proposing.
    ALL = "all"


# One member per parameter, and the table below owes every one of them a row.
class SuggestParameter(StrEnum):
    """A setting that shapes a suggestion. Order is display order."""

    DETAIL = "detail"
    FILL_HOLES = "fill_holes"
    FRAGMENTS = "fragments"


DEFAULT_DETAIL: Final = Detail.BALANCED
"""What a caller that says nothing gets, and what every suggestion got before."""


DEFAULT_FRAGMENTS: Final = Fragments.ONE
"""One shape per click, which is what a click asks for."""


DEFAULT_FILL_HOLES: Final = 0.002
"""The largest gap closed by default, as a share of the piece's area.

A share rather than a pixel count, so it means the same thing on a thing fifty
pixels across and a thing five hundred across. Two parts in a thousand puts the
reach at about one pixel on an object fifty across, two on one a hundred across
and four on one two hundred across — the scale of the notches and bays a
segmenter leaves along an edge, and well under anything somebody would call a
feature of the shape.

Zero closes nothing, which is a legitimate thing to ask for and not a disabled
feature: a mask of foliage is mostly gaps, and every one of them is real.
"""


PARAMETER_APPLIES_TO: Final[Mapping[SuggestParameter, frozenset[GeometryType]]] = {
    SuggestParameter.DETAIL: frozenset({GeometryType.POLYGON}),
    SuggestParameter.FILL_HOLES: frozenset({GeometryType.POLYGON}),
    SuggestParameter.FRAGMENTS: frozenset({GeometryType.POLYGON, GeometryType.BBOX}),
}
"""Which geometries each parameter has any effect on.

``detail`` and ``fill_holes`` are about an *outline*: one decides how many
vertices it keeps and the other decides whether it detours into every notch
along the way. A box has no outline to spend either on — closing a gap cannot
move an extent outward, and a vertex budget has nothing to buy — so offering
them for a box class would be offering controls that do nothing.

``fragments`` applies to both, because it decides how many shapes there are
before any of them has a kind.

**A parameter missing from this mapping is a test failure, not a default.**
``test_every_parameter_declares_the_geometries_it_applies_to`` sweeps
``SuggestParameter`` against these keys, so a fourth parameter arrives with its
applicability stated or it does not arrive. The alternative — treating an absent
row as "applies to everything" — is the one that ships a control nobody can use
and nobody notices.
"""


def suggest_parameters(geometry: GeometryType) -> tuple[SuggestParameter, ...]:
    """The parameters worth offering for a suggestion in that kind, in display order.

    The only reader of :data:`PARAMETER_APPLIES_TO`, so that a surface deciding
    what to render never re-derives the rule. A geometry no parameter applies to
    answers empty, which is honest rather than exceptional: a class that holds no
    shape gets no suggestion to adjust in the first place.
    """
    return tuple(
        parameter for parameter in SuggestParameter if geometry in PARAMETER_APPLIES_TO[parameter]
    )
