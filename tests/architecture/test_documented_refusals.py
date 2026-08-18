"""A published enumeration of refusals is never short of what the route can raise.

## The gap this closes

A route's docstring is published: FastAPI copies it verbatim into ``openapi.json``
and ``frontend/ui-core/src/generated/api.ts`` carries it from there. When such a
docstring enumerates the refusals a caller can receive, nothing held that
enumeration against the errors the route can actually raise — so a paragraph
naming two of ``suggest_region``'s three 500s was published, and told a client
author to handle fewer failures than exist, in the document that exists to say
exactly that. A person reading the paragraph caught it. Nothing in the suite
disagreed with either version, and the drift gates cannot: they hold the
artifacts against the source, and the source was what was wrong.

## What is proved

A route puts a status **in play** by naming one of that status's error codes, or
by writing the status in prose. For every status in play, every error the route
can reach whose status is that one must appear in the docstring *as a code*.

The status printed beside a code is deliberately **not** checked. ``AssetNotInJob``
is a 404 in ``ERROR_RULES`` and ``annotations.py`` documents it as a 422, because
that route overrides the status and keeps the code and says so beside the
override. Checking the pairing would report a correct docstring; requiring only
that the code appear does not.

## What is not proved, and why it is still worth having

This is a **lower bound**. Reachability comes from the ``Raises:`` blocks of the
callables a route calls, so a helper carrying no block contributes nothing and
the gate cannot see past it. Two things keep that from making the gate vacuous:
a route in play that reaches no documented raiser at all is a failure here rather
than a silent pass, and the two helpers that were blind when this was written —
``visionset.inference.require`` and ``background_jobs._require`` — were given
blocks in the same change.

It speaks only the vocabulary of ``ERROR_RULES``. A raw ``HTTPException``, which
``errors.py`` renders under the status's own name, is outside it — the artifact
route's 404-when-the-file-is-gone is prose this file cannot check.
"""

from __future__ import annotations

import inspect
import re
from typing import Final

from visionset.server.errors import ERROR_RULES

#: ``code -> status`` and ``class name -> code``, both from the one table, so a
#: new error is in this gate's vocabulary the moment it has a rule.
STATUS_BY_CODE: Final[dict[str, int]] = {rule.code: rule.status for rule in ERROR_RULES.values()}
CODE_BY_CLASS: Final[dict[str, str]] = {
    cls.__name__: rule.code for cls, rule in ERROR_RULES.items()
}
STATUSES: Final[frozenset[int]] = frozenset(STATUS_BY_CODE.values())

_RAISES_HEADING: Final = re.compile(r"^Raises:\s*$", re.MULTILINE)
_RAISES_ENTRY: Final = re.compile(r"^\s+([A-Z][A-Za-z0-9_]*):")
_CODE_TOKEN: Final = re.compile(r"\b[A-Z][A-Z0-9_]{3,}\b")
_STATUS_TOKEN: Final = re.compile(r"\b([45]\d\d)\b")


def declared_raises(target: object) -> frozenset[str] | None:
    """The error classes a callable's ``Raises:`` block names.

    ``None`` rather than an empty set when there is no block at all: "declares
    nothing" and "declares that it raises nothing" are different claims, and only
    the second one may be trusted.
    """
    doc = inspect.getdoc(target) or ""
    heading = _RAISES_HEADING.search(doc)
    if heading is None:
        return None
    names: set[str] = set()
    for line in doc[heading.end() :].splitlines():
        if line.strip() and not line.startswith(" "):
            break  # dedented to column zero: the next section of the docstring
        entry = _RAISES_ENTRY.match(line)
        if entry is not None:
            names.add(entry.group(1))
    return frozenset(names)


def named_codes(doc: str) -> frozenset[str]:
    """The error codes a docstring names."""
    return frozenset(token for token in _CODE_TOKEN.findall(doc) if token in STATUS_BY_CODE)


def named_statuses(doc: str) -> frozenset[int]:
    """The statuses a docstring puts in play — written in prose, or via a code."""
    prose = {int(found) for found in _STATUS_TOKEN.findall(doc)} & STATUSES
    return frozenset(prose | {STATUS_BY_CODE[code] for code in named_codes(doc)})


def missing_codes(doc: str, reachable: frozenset[str]) -> frozenset[str]:
    """Reachable codes at a status this docstring put in play, and did not name."""
    statuses = named_statuses(doc)
    if not statuses:
        return frozenset()
    at_stake = {code for code in reachable if STATUS_BY_CODE[code] in statuses}
    return frozenset(at_stake - named_codes(doc))


def test_declared_raises_reads_a_block_and_stops_at_the_next_section() -> None:
    def documented() -> None:
        """One line.

        Raises:
            ProjectNotFound: no such project.
            AssetNotFound: no such asset in that project,
                on a continued line that names no class.

        Returns:
            SchemaNotFound: not a raise, and must not be read as one.
        """

    assert declared_raises(documented) == frozenset({"ProjectNotFound", "AssetNotFound"})


def test_declared_raises_separates_no_block_from_an_empty_one() -> None:
    def undocumented() -> None:
        """Says nothing about failure."""

    assert declared_raises(undocumented) is None


def test_named_statuses_counts_prose_and_codes_alike() -> None:
    assert named_statuses("a point off the asset is 422") == frozenset({422})
    assert named_statuses("409 `SCHEMA_VERSION_CONFLICT`") == frozenset({409})
    assert named_statuses("no failure here, and 200 is not a refusal") == frozenset()


def test_missing_codes_reports_a_status_enumerated_short() -> None:
    doc = "500 `INFERENCE_CONNECTION_NOT_RUNNABLE` and 500 `INFERENCE_OUT_OF_MEMORY`."
    reachable = frozenset(
        {
            "INFERENCE_CONNECTION_NOT_RUNNABLE",
            "INFERENCE_OUT_OF_MEMORY",
            "LOCAL_INFERENCE_UNAVAILABLE",
        }
    )
    assert missing_codes(doc, reachable) == frozenset({"LOCAL_INFERENCE_UNAVAILABLE"})


def test_missing_codes_ignores_statuses_the_docstring_never_put_in_play() -> None:
    doc = "409 `INFERENCE_CONNECTION_NOT_SET_UP` and nothing else."
    reachable = frozenset({"INFERENCE_CONNECTION_NOT_SET_UP", "INFERENCE_OUT_OF_MEMORY"})
    assert missing_codes(doc, reachable) == frozenset()


def test_missing_codes_does_not_check_the_status_printed_beside_a_code() -> None:
    # `annotations.py` documents `ASSET_NOT_IN_JOB` as a 422 it overrides to,
    # while `ERROR_RULES` calls it a 404. Naming the code is what this asks for.
    doc = "422 `ASSET_NOT_IN_JOB`."
    assert missing_codes(doc, frozenset({"ASSET_NOT_IN_JOB"})) == frozenset()
