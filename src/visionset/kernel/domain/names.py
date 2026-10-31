# usage: from visionset.kernel.domain import normalize_name
"""The one rule for turning typed text into a stored name.

Every named entity in the domain — a project, a batch — answers "is this the
same name?" the same way, so the rule lives once. Uniqueness is a separate
question and belongs to whoever owns the scope it is unique within.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Final

from visionset.kernel.errors import InvalidName

#: The common ceiling on a filename, and the wire's own ``WIRE_TEXT_MAX_LENGTH``.
NAME_MAX_LENGTH: Final = 255
#: A tag can become a path component in an export, so it is held to a portable slug.
RELEASE_TAG_MAX_LENGTH: Final = 128
_RELEASE_TAG: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]*")
#: Control characters and line breaks split a row of every listing that prints the name.
_FORBIDDEN_CATEGORIES: Final = frozenset({"Cc", "Zl", "Zp"})


def normalize_name(value: str, *, what: str, lookup: bool = False) -> str:
    """The canonical stored form: NFC, outer whitespace stripped, else as typed.

    NFC matters concretely: macOS filesystems hand out decomposed strings, so a
    name typed in Finder and the same name typed in a terminal are different byte
    sequences that must not become two entities. Internal whitespace is left
    alone — collapsing it would rewrite the user's input for no invariant.

    ``what`` names the kind of thing being named, so the error reads in the
    caller's vocabulary rather than in this module's.

    ``lookup=True`` is for resolving a typed name against stored ones: it skips
    the write-time rules, so a name stored before they existed stays reachable.

    Raises:
        InvalidName: the name is blank once stripped, or — unless ``lookup`` —
            longer than :data:`NAME_MAX_LENGTH` or holding a control character.
    """
    normalized = unicodedata.normalize("NFC", value).strip()
    if not normalized:
        raise InvalidName(f"a {what} name must contain at least one non-blank character")
    if lookup:
        return normalized
    if len(normalized) > NAME_MAX_LENGTH:
        raise InvalidName(
            f"a {what} name must be at most {NAME_MAX_LENGTH} characters, not {len(normalized)}"
        )
    if any(unicodedata.category(char) in _FORBIDDEN_CATEGORIES for char in normalized):
        raise InvalidName(f"a {what} name must not contain control characters or line breaks")
    return normalized


def derived_name(value: str, *, what: str) -> str:
    """A name the kernel derives rather than one a caller typed, made storable.

    A batch named after its source can inherit a source name stored before the
    write-time rules; refusing it would refuse an ingest nobody named anything
    in, so control characters become spaces and the result is cut to length.

    Raises:
        InvalidName: nothing but blanks is left.
    """
    cleaned = "".join(
        " " if unicodedata.category(char) in _FORBIDDEN_CATEGORIES else char
        for char in unicodedata.normalize("NFC", value)
    )
    return normalize_name(cleaned.strip()[:NAME_MAX_LENGTH], what=what)


def normalize_release_tag(value: str, *, lookup: bool = False) -> str:
    """A release tag: :func:`normalize_name`'s form, held to a portable slug on write.

    Case is kept and compared exactly — a tag is an identifier, not a label.

    Raises:
        InvalidName: the tag is blank once stripped, or — unless ``lookup`` — is
            longer than :data:`RELEASE_TAG_MAX_LENGTH` or not a slug.
    """
    normalized = normalize_name(value, what="release tag", lookup=True)
    if lookup:
        return normalized
    if len(normalized) > RELEASE_TAG_MAX_LENGTH:
        raise InvalidName(
            f"a release tag must be at most {RELEASE_TAG_MAX_LENGTH} characters, "
            f"not {len(normalized)}"
        )
    if not _RELEASE_TAG.fullmatch(normalized):
        raise InvalidName(
            "a release tag must start with a letter or digit and hold only letters, "
            "digits, '.', '_', '+' and '-'"
        )
    return normalized
