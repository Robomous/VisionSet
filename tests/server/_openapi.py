"""One definition of "an operation", shared by everything that walks the spec.

Two test modules now iterate ``openapi()["paths"]``, and they must agree on what
a path item contains. OpenAPI allows keys there that are *not* operations —
``parameters``, ``summary``, ``$ref``, ``servers`` — so a walk that treats every
key as an operation raises ``KeyError`` on ``operation["responses"]`` rather than
failing with a sentence about the contract. FastAPI emits none of those today;
this module is what keeps that from being load-bearing.
"""

from collections.abc import Iterator
from typing import Any, Final

OPERATION_KEYS: Final = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
)
"""The HTTP methods an OpenAPI path item may key an operation by."""

PUBLIC_OPERATIONS: Final = frozenset({("/health", "get")})
"""Every operation that is allowed to answer without a token.

One entry, and adding a second is a security decision that belongs in a review —
which is the point of writing the exception list here rather than skipping
unauthenticated routes in the walk.
"""

BEARER_SECURITY: Final = [{"HTTPBearer": []}]
"""What FastAPI emits on an operation guarded by ``protected_router()``."""


def operations(spec: dict[str, Any]) -> Iterator[tuple[str, str, dict[str, Any]]]:
    """``(path, method, operation)`` for every documented operation in ``spec``."""
    for path, item in spec["paths"].items():
        for method, operation in item.items():
            if method in OPERATION_KEYS:
                yield path, method, operation


def assert_every_operation_is_protected(spec: dict[str, Any]) -> None:
    """Every documented operation but the public ones requires a bearer token.

    Raises ``AssertionError`` naming the offending operation, so a failure reads
    as "POST /projects declares no bearer security" rather than as a diff of two
    large dictionaries.
    """
    for path, method, operation in operations(spec):
        where = f"{method.upper()} {path}"
        if (path, method) in PUBLIC_OPERATIONS:
            assert "security" not in operation, f"{where} is public but declares security"
            continue
        assert operation.get("security") == BEARER_SECURITY, f"{where} declares no bearer security"
        assert "401" in operation["responses"], f"{where} does not document its 401"
