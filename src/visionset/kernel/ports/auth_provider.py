# usage: from visionset.kernel.ports import AuthProvider
"""Token verification: the seam every delivery surface authenticates through."""

from typing import Protocol, runtime_checkable


@runtime_checkable
class AuthProvider(Protocol):
    """Token verification. Delivery layers (server/CLI/MCP) depend on this port.

    One method, deliberately. Minting and revoking credentials are *use cases*
    and live in ``TokenService``; a port that grew a ``create`` would oblige
    every future provider — one backed by OIDC, say — to implement issuance it
    has no business doing. What a surface needs is the yes-or-no, and that is
    all this promises.

    Three obligations an implementation owes, none of which the signature can
    express:

    - **``False`` means "this credential does not authenticate", and nothing
      more.** Unknown, malformed, expired and revoked are one answer, so that a
      caller cannot turn the distinction into an oracle for which secrets exist.
    - **A failure to *decide* raises; it never answers ``False``.** An
      unreachable or damaged store is an outage, and reporting an outage as a bad
      credential sends the operator hunting for the wrong thing.
    - **A revocation takes effect immediately.** Caching a positive verdict turns
      "revoked, therefore refused" into "refused eventually", which is the one
      promise a revocation has to keep.
    """

    def verify(self, token: str) -> bool: ...
