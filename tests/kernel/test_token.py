"""The token domain: a secret that is unguessable, a hash that is one-way.

Nothing here touches a store or a service. What is under test is the pair of
functions the mint and the check both call, and the invariants the model refuses
to be built without — chiefly that a plaintext cannot end up in ``secret_hash``.
"""

from datetime import UTC, datetime, timedelta, timezone
from uuid import uuid4

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import (
    SECRET_PREFIX,
    IssuedToken,
    Token,
    generate_secret,
    hash_secret,
)


def _token(**overrides: object) -> Token:
    fields: dict[str, object] = {
        "workspace_id": uuid4(),
        "name": "ci",
        "secret_hash": hash_secret("vst_whatever"),
    }
    return Token.model_validate(fields | overrides)


# --- secrets ---------------------------------------------------------------


def test_a_generated_secret_carries_the_prefix() -> None:
    assert generate_secret().startswith(SECRET_PREFIX)


def test_generated_secrets_do_not_repeat() -> None:
    """Not a randomness test — a wiring test.

    A generator that returned a constant, or seeded itself per call, would pass
    every other test in this file and hand every workspace the same credential.
    """
    assert len({generate_secret() for _ in range(1000)}) == 1000


def test_a_generated_secret_is_long_enough_to_be_unguessable() -> None:
    """256 bits is the premise the whole "sha256 rather than a KDF" argument rests on."""
    body = generate_secret().removeprefix(SECRET_PREFIX)
    assert len(body) >= 40  # 32 urlsafe-base64 bytes render as 43 characters


# --- hashing ---------------------------------------------------------------


def test_the_hash_is_lowercase_hex_of_the_right_length() -> None:
    digest = hash_secret("vst_abc")
    assert len(digest) == 64
    assert digest == digest.lower()
    assert set(digest) <= set("0123456789abcdef")


def test_the_hash_is_deterministic() -> None:
    """Unsalted on purpose: the check has only the presentation to work from."""
    assert hash_secret("vst_abc") == hash_secret("vst_abc")


def test_the_hash_is_not_the_secret() -> None:
    secret = generate_secret()
    assert hash_secret(secret) != secret


def test_different_secrets_hash_differently() -> None:
    assert hash_secret("vst_a") != hash_secret("vst_b")


def test_the_whole_presented_string_is_hashed_prefix_included() -> None:
    """Trimming the prefix here would accept a secret the operator never saw."""
    secret = generate_secret()
    assert hash_secret(secret) != hash_secret(secret.removeprefix(SECRET_PREFIX))


# --- the model -------------------------------------------------------------


def test_a_token_hashes_its_secret_and_stores_nothing_else() -> None:
    secret = generate_secret()
    token = _token(secret_hash=hash_secret(secret))
    assert secret not in token.model_dump_json()


def test_a_plaintext_secret_is_refused_as_a_hash() -> None:
    """The failure this catches is a caller assigning the wrong field.

    Storing the credential in clear would still verify correctly against
    itself — the bug would look exactly like the feature working.
    """
    with pytest.raises(ValidationError, match="64 lowercase hex"):
        _token(secret_hash=generate_secret())


def test_an_uppercase_hash_is_refused() -> None:
    with pytest.raises(ValidationError, match="64 lowercase hex"):
        _token(secret_hash=hash_secret("vst_abc").upper())


def test_a_fresh_token_is_not_revoked() -> None:
    token = _token()
    assert token.revoked_at is None
    assert token.revoked is False


def test_revoked_is_derived_from_the_timestamp() -> None:
    """No stored bool to disagree with the timestamp."""
    revoked = _token(revoked_at=datetime.now(UTC))
    assert revoked.revoked is True
    assert "revoked" not in revoked.model_dump()


def test_timestamps_must_be_timezone_aware() -> None:
    naive = datetime(2026, 7, 27, 8, 0)
    with pytest.raises(ValidationError, match="timezone-aware"):
        _token(created_at=naive)
    with pytest.raises(ValidationError, match="timezone-aware"):
        _token(revoked_at=naive)


def test_timestamps_are_normalized_to_utc() -> None:
    elsewhere = datetime(2026, 7, 27, 8, 0, tzinfo=timezone(timedelta(hours=5)))
    token = _token(created_at=elsewhere)
    assert token.created_at.tzinfo is UTC
    assert token.created_at == elsewhere


# --- the one showing -------------------------------------------------------


def test_an_issued_token_carries_the_plaintext_and_the_record() -> None:
    secret = generate_secret()
    issued = IssuedToken(token=_token(secret_hash=hash_secret(secret)), secret=secret)
    assert issued.secret == secret
    assert hash_secret(issued.secret) == issued.token.secret_hash


def test_the_plaintext_is_not_in_the_repr() -> None:
    """``repr=False`` is load-bearing: a traceback renders locals.

    Anything that prints the object by accident — a log line, a pytest failure
    report, a debugger frame — must not put the credential in a file.
    """
    secret = generate_secret()
    issued = IssuedToken(token=_token(secret_hash=hash_secret(secret)), secret=secret)
    assert secret not in repr(issued)


def test_an_issued_token_is_frozen() -> None:
    secret = generate_secret()
    issued = IssuedToken(token=_token(secret_hash=hash_secret(secret)), secret=secret)
    with pytest.raises(ValidationError):
        issued.secret = "vst_other"  # type: ignore[misc]
