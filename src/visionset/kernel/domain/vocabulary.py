"""Vocabularies the wire may grow, and the promise that says so.

A closed vocabulary is the default here and stays it. :class:`~visionset.kernel.domain.
inference.Precision` argues that case in full: a small set the kernel decides the
meaning of, which grows only by a deliberate change, and where free text "was not
neutrality but a gap".

A few vocabularies are different, and the difference is their *shape*. ``allowed_actions``
and ``capabilities`` are lists a client filters, never answers it switches on, so a member
an older client never compiled against is inert to it. For those, refusing the whole
response — which is what a generated client does with an enum member it does not
recognise — turns an additive release into a broken page, for exactly the reason an added
*field* is tolerated instead.

Marking one is a promise, and only the side that emits values can make it, which is why it
lives here and travels in the OpenAPI document rather than in the client's generator. It
changes what the schema *documents* and nothing about validation: an unknown member in a
request is still refused, and the marker is gated on the vocabulary never being reachable
from one.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import GetJsonSchemaHandler
from pydantic.json_schema import JsonSchemaValue
from pydantic_core import CoreSchema

#: The JSON Schema extension that carries the promise.
OPEN_MARKER = "x-visionset-open"


class OpenVocabulary(StrEnum):
    """A ``StrEnum`` whose schema declares that a compatible release may add a member."""

    @classmethod
    def __get_pydantic_json_schema__(
        cls, core_schema: CoreSchema, handler: GetJsonSchemaHandler
    ) -> JsonSchemaValue:
        schema = handler(core_schema)
        schema[OPEN_MARKER] = True
        return schema
