# usage: from visionset.kernel.domain import normalize_name
"""The one rule for turning typed text into a stored name.

Every named entity in the domain — a project, a batch — answers "is this the
same name?" the same way, so the rule lives once. Uniqueness is a separate
question and belongs to whoever owns the scope it is unique within.
"""

from __future__ import annotations

import unicodedata

from visionset.kernel.errors import InvalidName


def normalize_name(value: str, *, what: str) -> str:
    """The canonical stored form: NFC, outer whitespace stripped, else as typed.

    NFC matters concretely: macOS filesystems hand out decomposed strings, so a
    name typed in Finder and the same name typed in a terminal are different byte
    sequences that must not become two entities. Internal whitespace is left
    alone — collapsing it would rewrite the user's input for no invariant.

    ``what`` names the kind of thing being named, so the error reads in the
    caller's vocabulary rather than in this module's.

    Raises:
        InvalidName: the name is blank once stripped.
    """
    normalized = unicodedata.normalize("NFC", value).strip()
    if not normalized:
        raise InvalidName(f"a {what} name must contain at least one non-blank character")
    return normalized
