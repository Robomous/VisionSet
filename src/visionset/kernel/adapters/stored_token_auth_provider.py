# usage: reached as ``workspace.auth_provider``; named only by WorkspaceService
"""The default ``AuthProvider``: tokens persisted in the workspace itself.

Named for *where the credentials live*, the way ``EnvTokenAuthProvider`` was
named for the environment variable it read. Not ``SqliteAuthProvider``, which
would be a lie: this holds the ``MetadataStore`` **port** and could not reach
SQL if it wanted to. Which store is behind it is ``WorkspaceService``'s business.

It takes the store and a workspace id rather than a ``WorkspaceService`` or a
``TokenService``: ``WorkspaceService`` imports this module, so importing back
would be a runtime cycle.
"""

from __future__ import annotations

import secrets
from uuid import UUID

from visionset.kernel.domain import hash_secret
from visionset.kernel.ports import MetadataStore


class StoredTokenAuthProvider:
    """Verify a bearer token against the workspace's own ``token`` table.

    **Nothing is cached, and that is the design.** ``TokenService.revoke``
    promises a credential stops working immediately; a TTL would downgrade that
    to eventually, which is the one thing a revocation may not do. The cost is a
    read transaction per call, and it is small: WAL readers never block a writer,
    and pysqlite defers ``BEGIN`` to the first *write*, so a read-only unit of
    work takes no lock at all.

    **The lookup is a scan, on purpose.** ``Repository`` has no query-by-column
    and none is added for this — a workspace holds a handful of tokens, and each
    costs one digest comparison. If it ever bites, the sanctioned fix is a method
    on the port, never SQL here, which this class cannot write anyway.
    """

    def __init__(self, metadata_store: MetadataStore, workspace_id: UUID) -> None:
        self._metadata_store = metadata_store
        self._workspace_id = workspace_id

    def verify(self, token: str) -> bool:
        """Whether this string is a live credential of this workspace.

        Unknown, malformed and revoked are one answer, so that the result cannot
        be used to probe which secrets exist. A store that cannot be read raises
        ``WorkspaceBusy`` or ``WorkspaceCorrupt`` rather than answering ``False``:
        an outage is not a bad password.
        """
        if not token:
            return False
        presented = hash_secret(token)
        with self._metadata_store.unit_of_work() as uow:
            # ``list(self._workspace_id)``, never ``list()``. A ``parent_id`` of
            # ``None`` is not an error on a scoped entity — it means every row in
            # the table — so the bare call would be accidentally correct today
            # and a cross-workspace credential leak the day one store holds two.
            stored = uow.tokens.list(self._workspace_id)
        # ``compare_digest`` over ``==``, and the honest claim is narrow: both
        # operands are SHA-256 digests rather than the secret, and the short
        # circuit already leaks position, so this closes no channel of value. It
        # stays because it costs nothing and because comparing a
        # credential-derived value with ``==`` is not the habit to learn here.
        return any(
            secrets.compare_digest(candidate.secret_hash, presented)
            for candidate in stored
            if not candidate.revoked
        )
