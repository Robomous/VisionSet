# usage: from visionset.kernel.domain import Token, generate_secret, hash_secret
"""API tokens: the credential a surface presents, and the record we keep of it.

A :class:`Token` is what the workspace stores; the secret it stands for is shown
to an operator exactly once, at creation, and is never recoverable afterwards.
The two travel together only in :class:`IssuedToken`, which is a return value and
is never persisted.

**Only the hash is stored, and the hash is SHA-256 rather than a password KDF.**
That looks like the wrong call until the input is named. A KDF's entire job is to
make *low-entropy, human-chosen* input expensive to guess; the input here is 256
bits from :func:`secrets.token_urlsafe`, where there is no dictionary and no
guessing budget that terminates. Two further reasons make it the right call
rather than merely a defensible one: verification runs on **every request** and
compares the presentation against every token the workspace holds, so an argon2
at 100 ms would cost N x 100 ms *per request* — the opposite cost model to a login
form, where the check runs once and rate limiting bounds it. And ``hashlib`` is
stdlib, where argon2-cffi or bcrypt is a dependency taken on for no gain.

The accepted consequence, stated rather than hidden: the digest is unsalted and
deterministic, so two identical secrets hash identically. That requires drawing
the same 256-bit value twice, and it is precisely the property that lets
verification be a cheap digest comparison instead of N key derivations.

**The mint and the check must agree on one spelling of the hash.**
:func:`hash_secret` lives here, in the domain, for the same reason
``canonical_path`` does: ``TokenService`` mints with it and the stored-token
``AuthProvider`` verifies with it, and two spellings would produce a credential
that can never authenticate — a bug that looks like a bad password.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from datetime import UTC, datetime
from typing import Final
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator

SECRET_PREFIX: Final = "vst_"
"""What every issued secret starts with.

A visible marker, not a security measure: it lets an operator recognise a
VisionSet token in a config file, and lets a secret scanner match one shape
instead of guessing at every high-entropy string.
"""

SECRET_BYTES: Final = 32
"""How much randomness a secret carries — 256 bits, the reason sha256 suffices."""

_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")


def generate_secret() -> str:
    """A fresh token secret, prefixed and unguessable.

    ``secrets.token_urlsafe`` rather than ``uuid4``: a UUID is 122 bits with a
    documented layout, and it is a name for a thing rather than a thing kept
    hidden. Nothing in the stored form depends on this spelling — a token
    issued by an older build keeps working, because only the digest is kept.
    """
    return f"{SECRET_PREFIX}{secrets.token_urlsafe(SECRET_BYTES)}"


def hash_secret(secret: str) -> str:
    """The stored form of a secret: lowercase hex SHA-256 of its UTF-8 bytes.

    Deterministic and unsalted, for the reason the module docstring gives. The
    whole presented string is hashed, prefix included — the prefix is part of
    what the operator was handed, so trimming it here would mean accepting a
    secret the operator never saw.
    """
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


class Token(BaseModel):
    """A named API credential belonging to one workspace.

    Not frozen, unlike ``Release``: revocation edits this row, and the store
    writes an edit as a whole-row replace fed by ``model_copy(update=...)``.
    Immutability is a claim ``Release`` earns by being an artifact; a credential
    has a lifecycle.

    **Revocation is a timestamp, and ``revoked`` is derived from it.** The same
    doctrine that keeps a schema's "active" version a computed maximum rather
    than a stored column: a bool answers "is it dead?" and nothing else, so
    "when did we burn it?" would need a second column to ask. ``NULL`` here is
    the ordinary state of a token nobody has revoked, exactly as
    ``Asset.thumbnail_hash``'s NULL is the ordinary state of an asset nobody has
    rendered.

    ``revoked_at`` is written once and never rewritten, the rule
    ``Source.registered_at`` follows, which is what makes a repeated revoke a
    no-op rather than a rewrite of when the credential actually died.

    The plaintext is **not** here and cannot be recovered from what is. That is
    the point of the entity: a workspace that leaks its metadata store leaks the
    names and lifetimes of its credentials, not the credentials.
    """

    id: UUID = Field(default_factory=uuid4)
    workspace_id: UUID
    name: str
    #: SHA-256 of the issued secret. See :func:`hash_secret`.
    secret_hash: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    #: When this credential was burned, or ``None`` while it still works.
    revoked_at: datetime | None = None

    @property
    def revoked(self) -> bool:
        """Whether this token has been revoked. Derived, never stored."""
        return self.revoked_at is not None

    @field_validator("secret_hash")
    @classmethod
    def _is_sha256_hex(cls, value: str) -> str:
        """Refuse anything that is not a digest, so a plaintext cannot land here.

        The failure this catches is not a typo: it is a caller that assigned the
        secret to the wrong field, which would store the credential in clear and
        still verify correctly against nothing.
        """
        if not _SHA256_HEX.fullmatch(value):
            raise ValueError("secret_hash must be 64 lowercase hex chars (SHA-256)")
        return value

    @field_validator("created_at", "revoked_at")
    @classmethod
    def _is_timezone_aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("token timestamps must be timezone-aware (UTC)")
        return None if value is None else value.astimezone(UTC)


class IssuedToken(BaseModel):
    """What ``TokenService.create`` hands back: the record, and the one showing.

    Frozen and never persisted — there is no mapper for it and no table behind
    it. It exists so that "the secret is shown exactly once" is a shape in the
    type system rather than a sentence in a docstring: the only object that ever
    holds a plaintext is the return value of the one method that mints one.

    ``secret`` carries ``repr=False``, which is load-bearing rather than tidy. A
    traceback rendering local variables, a stray ``print``, a log line
    interpolating the model — each of those is a credential in a file somebody
    forgot about. ``issued.secret`` still reads it; nothing prints it by
    accident.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    token: Token
    secret: str = Field(repr=False)
