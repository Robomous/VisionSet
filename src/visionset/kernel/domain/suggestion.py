# usage: from visionset.kernel.domain import DEFAULT_TOLERANCE, suggest_parameters
"""How a model's mask becomes a shape, said out loud so a client can offer it.

A segmenter answers a click with a grid of booleans, and turning that grid into a
polygon or a box is a chain of choices: which blobs to keep, whether to close the
holes inside them, how closely the outline follows the mask. Most of those choices
are made once, with a fixed default, by the pipeline — and one of them is worth
putting in front of the person looking at the proposal. This module is the
vocabulary for the one.

**The setting is a distance in the asset's own pixels.** The polygon stays within
that distance of the mask's outline, so the number means the same thing on a thing
eight pixels across and a thing eight hundred across, and a person reading it knows
what they will get before they move it.

**Applicability is declared, never derived.** ``tolerance`` is about an outline, so
it means nothing for a class that stores a box; a client that worked that out for
itself would be the hand-mirrored table ``capabilities.py`` exists to prevent, and
it would drift the first time a parameter changed hands. So
:data:`PARAMETER_APPLIES_TO` states it once and :func:`suggest_parameters` is the
only reader.

**Two settings were here and are not.** Closing the gaps in a mask and dropping
its noise specks are still done, at fixed defaults that live beside the pipeline
in ``visionset.inference.masks``. They stopped being askable because on an
ordinary single clean piece every position of either gave the same shape, so they
read as controls wired to nothing. Their value is in the default rather than
in the choice; they come back as parameters if a real need for the choice appears.

Pure, and in the domain rather than beside the code that computes the pipeline,
on ``capabilities.py``'s terms: a question about domain values, answered from a
domain table, with no I/O.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final

from visionset.kernel.domain.schema import GeometryType
from visionset.kernel.domain.vocabulary import OpenVocabulary


# One member per parameter, and the table below owes every one of them a row.
class SuggestParameter(OpenVocabulary):
    """A setting that shapes a suggestion. Order is display order."""

    TOLERANCE = "tolerance"


DEFAULT_TOLERANCE: Final = 1.0
"""What a caller that says nothing gets: an outline within one pixel of the mask."""

MINIMUM_TOLERANCE: Final = 0.25
"""The finest setting, and the floor the canonical contour is reduced at.

A quarter of a pixel is finer than anything a mask of integer pixels can express
once its outline has been smoothed; below it the vertex count grows for nothing.
"""

MAXIMUM_TOLERANCE: Final = 16.0
"""The coarsest setting. Past sixteen pixels an outline stops describing the object."""


PARAMETER_APPLIES_TO: Final[Mapping[SuggestParameter, frozenset[GeometryType]]] = {
    SuggestParameter.TOLERANCE: frozenset({GeometryType.POLYGON}),
}
"""Which geometries each parameter has any effect on.

``tolerance`` is about an *outline*: it decides how closely that outline follows
the mask. A box has no outline, so offering it for a box class would be offering
a control that does nothing. A box class therefore declares no parameters at all,
and a client shows it no adjustments — which is a rendering rule the client reads
rather than one it works out.

**A parameter missing from this mapping is a test failure, not a default.**
``test_every_parameter_declares_the_geometries_it_applies_to`` sweeps
``SuggestParameter`` against these keys, so a second parameter arrives with its
applicability stated or it does not arrive.
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
