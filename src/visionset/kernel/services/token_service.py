# usage: from visionset.kernel.services import TokenService
"""API tokens: the one door to a credential that reaches this workspace.

Issuance and revocation are **use cases**, so they live in a service rather than
on the ``AuthProvider`` port. The port stays one method — ``verify(token)`` —
because that is the seam all three surfaces depend on, and widening it would
oblige every future provider (an OIDC one, say) to implement minting it has no
business doing. Verification reads what this service writes; nothing else does.

**A secret is shown exactly once.** :meth:`TokenService.create` returns an
:class:`IssuedToken` carrying the plaintext, and the workspace keeps only its
digest. There is no method that reads a secret back, and adding one would be a
different product: the remedy for a lost token is a new token.

**Revocation is one-way, and it is guarded.** There is deliberately no
``unrevoke``: reinstating a secret an operator decided to burn is worse than
issuing a fresh one, because the reason for burning it — that somebody else has
a copy — does not expire. So :meth:`revoke` takes ``confirm=`` on the standing
rule for destructive operations, and it is destructive in the sense that
matters: every client holding that secret stops working at the next request.

**There is no ``delete``, and no ``rename``.** A token row is the record that a
credential once existed and when it died; deleting it would erase that, and
revocation is already the terminal state. Renaming rewrites an audit label for no
invariant. The row *is* the log, which is also why this service publishes no
domain event: an auth trail that a subscriber can silently drop — the bus is
in-process, at-most-once and non-persistent — is worse than none, and
``created_at``/``revoked_at`` are durable where a published event is not.

Composition follows the rule in ``docs/content/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and reaches the ports through
it. It never names an adapter.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from visionset.kernel.domain import (
    IssuedToken,
    Token,
    generate_secret,
    hash_secret,
    normalize_name,
)
from visionset.kernel.errors import (
    ConfirmationRequired,
    ConstraintViolated,
    TokenNameTaken,
    TokenNotFound,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.workspace_service import WorkspaceService

#: SQLite's own wording when ``uq_token_workspace_name`` refuses a write. The
#: adapter hands the message through verbatim, and it is the only way to tell a
#: name collision apart from any other constraint — see ``_as_name_collision``.
_NAME_INDEX_MESSAGE = "token.workspace_id, token.name"


class TokenService:
    """Mint, read and revoke the API tokens of one workspace."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace

    # --- reading -----------------------------------------------------------

    def get(self, token_id: UUID) -> Token:
        """The token with that id. Never its secret.

        Raises:
            TokenNotFound: no such token in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_token(uow, token_id)

    def get_by_name(self, name: str) -> Token:
        """The token an operator would name, resolved case-insensitively.

        Raises:
            InvalidName: the name is blank once stripped.
            TokenNotFound: no token in this workspace holds that name.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_token_named(uow, name)

    # --- writing -----------------------------------------------------------

    def create(self, name: str) -> IssuedToken:
        """Mint a credential, and hand back its plaintext for the only time.

        The returned :class:`IssuedToken` is the one object in the system that
        ever holds the secret; what is stored is a digest of it. A caller that
        loses the plaintext has lost the credential, and the remedy is to create
        another and revoke this one.

        Raises:
            InvalidName: the name is blank once stripped.
            TokenNameTaken: another token in this workspace holds that name.
        """
        secret = generate_secret()
        try:
            with self._workspace.unit_of_work() as uow:
                resolved = self._require_name_free(uow, name)
                token = uow.tokens.add(
                    Token(
                        workspace_id=self._workspace.workspace_id,
                        name=resolved,
                        secret_hash=hash_secret(secret),
                    )
                )
        except ConstraintViolated as exc:
            raise self._as_name_collision(exc, name) from exc
        return IssuedToken(token=token, secret=secret)

    def revoke(self, token_id: UUID, *, confirm: bool = False) -> Token:
        """Burn a credential. Every client holding its secret stops working.

        Revoking a token that is already revoked is a **no-op** that returns it
        unchanged, ``revoked_at`` untouched — the idempotency ``JobService.mark``
        follows, and what makes a retried command safe. Rewriting the timestamp
        would move the moment the credential actually died.

        Existence is checked before ``confirm`` is considered, so an unknown id
        is a ``TokenNotFound`` with or without the flag.

        Raises:
            TokenNotFound: no such token in this workspace.
            ConfirmationRequired: ``confirm`` was not ``True``.
        """
        with self._workspace.unit_of_work() as uow:
            token = self.require_token(uow, token_id)
            if token.revoked:
                return token
            if not confirm:
                raise ConfirmationRequired(
                    f"revoking token {token.name!r} immediately breaks every client holding "
                    f"its secret, and cannot be undone; pass confirm=True to proceed"
                )
            return uow.tokens.update(token.model_copy(update={"revoked_at": datetime.now(UTC)}))

    # --- lookups shared by the operations above ----------------------------

    def require_token(self, uow: UnitOfWork, token_id: UUID) -> Token:
        """The token, or refuse because this workspace does not have it.

        Public, and taking a ``uow``, for the reason ``JobService.require_job``
        is: a caller resolving a token inside its own transaction must not have
        to spell the scope rule a second time.
        """
        token = uow.tokens.get(token_id)
        if token is None or token.workspace_id != self._workspace.workspace_id:
            raise TokenNotFound(
                f"no token {token_id} in workspace {self._workspace.workspace.name!r}"
            )
        return token

    def require_token_named(self, uow: UnitOfWork, name: str) -> Token:
        """The token holding that name, compared the way the index compares.

        Unicode case folding here, ASCII ``COLLATE NOCASE`` in the index: the
        service is where the full normalized string is in hand, so it is the
        stricter of the two. Uniqueness makes "the" token well defined.
        """
        wanted = normalize_name(name, what="token").casefold()
        for token in uow.tokens.list(self._workspace.workspace_id):
            if token.name.casefold() == wanted:
                return token
        raise TokenNotFound(
            f"no token named {name!r} in workspace {self._workspace.workspace.name!r}"
        )

    def _require_name_free(self, uow: UnitOfWork, name: str) -> str:
        """The normalized name, or refuse it because this workspace already has it.

        Two layers, and neither is redundant: ``uq_token_workspace_name`` is the
        guarantee and this is the error message. Private because ``create`` is
        its only caller — there is no ``rename``, so it needs no ``exclude=``.

        Raises:
            InvalidName: the name is blank once stripped.
            TokenNameTaken: another token in this workspace holds it.
        """
        normalized = normalize_name(name, what="token")
        wanted = normalized.casefold()
        for token in uow.tokens.list(self._workspace.workspace_id):
            if token.name.casefold() == wanted:
                raise TokenNameTaken(f"a token named {token.name!r} already exists")
        return normalized

    def _as_name_collision(
        self, exc: ConstraintViolated, name: str
    ) -> TokenNameTaken | ConstraintViolated:
        """Re-raise the name index's complaint in the vocabulary callers expect.

        Two processes can both pass ``_require_name_free`` and then race to
        insert; the loser is refused by the unique index, one layer below where
        the pre-check runs. The violation ends its transaction, so this can only
        happen outside the ``with`` block — see ``ConstraintViolated``. Any other
        constraint is not this service's to reinterpret and travels on unchanged.
        """
        if _NAME_INDEX_MESSAGE in str(exc):
            return TokenNameTaken(f"a token named {name!r} already exists")
        return exc

    # ``list`` shadows the builtin for every annotation below it, so it is last.
    def list(self) -> list[Token]:
        """Every token in this workspace, revoked ones included, in mint order.

        Revoked tokens stay in the listing because the row is the audit record:
        an operator asking "what did we ever issue, and what happened to it?"
        gets a worse answer from a list that quietly forgets.
        """
        with self._workspace.unit_of_work() as uow:
            return uow.tokens.list(self._workspace.workspace_id)
