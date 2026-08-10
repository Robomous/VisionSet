"""The `AuthProvider` port: what verification promises, and how it is composed.

Both halves live here, on `test_events.py`'s precedent that a port's own test
file owns the composition-point wiring for it — the alternative scatters "is this
injectable?" across whichever service happened to need it first.
"""

from collections.abc import Iterator
from pathlib import Path
from uuid import UUID

import pytest

from visionset.kernel import ConfirmationRequired, WorkspaceCorrupt
from visionset.kernel.adapters import SqliteMetadataStore, StoredTokenAuthProvider
from visionset.kernel.domain import hash_secret
from visionset.kernel.ports import AuthProvider, MetadataStore
from visionset.kernel.services import TokenService, WorkspaceService


class Fixture:
    """A workspace, its token service, and the provider that guards it."""

    def __init__(self, tmp_path: Path, name: str = "ws") -> None:
        self.workspace = WorkspaceService.init(tmp_path / name)
        self.tokens = TokenService(self.workspace)

    @property
    def auth(self) -> AuthProvider:
        return self.workspace.auth_provider

    def close(self) -> None:
        self.workspace.close()


@pytest.fixture()
def fixture(tmp_path: Path) -> Iterator[Fixture]:
    made = Fixture(tmp_path)
    yield made
    made.close()


# --- what verification answers ---------------------------------------------


def test_a_freshly_issued_secret_verifies(fixture: Fixture) -> None:
    issued = fixture.tokens.create("ci")
    assert fixture.auth.verify(issued.secret) is True


def test_an_unknown_string_does_not_verify(fixture: Fixture) -> None:
    fixture.tokens.create("ci")
    assert fixture.auth.verify("vst_not-a-real-token") is False


def test_an_empty_string_does_not_verify(fixture: Fixture) -> None:
    assert fixture.auth.verify("") is False


def test_a_workspace_with_no_tokens_verifies_nothing(fixture: Fixture) -> None:
    assert fixture.auth.verify("vst_anything") is False


def test_the_stored_hash_is_not_itself_a_credential(fixture: Fixture) -> None:
    """The obvious escalation from a leaked metadata store, closed by hashing.

    Presenting the digest gets it hashed again, which matches nothing.
    """
    issued = fixture.tokens.create("ci")
    assert fixture.auth.verify(issued.token.secret_hash) is False


def test_a_secret_is_matched_exactly(fixture: Fixture) -> None:
    """No trimming and no case folding: a credential is bytes, not a name."""
    issued = fixture.tokens.create("ci")
    assert fixture.auth.verify(f" {issued.secret} ") is False
    assert fixture.auth.verify(issued.secret.upper()) is False


def test_one_workspaces_token_does_not_open_another(tmp_path: Path) -> None:
    """Scoping is by ``workspace_id``, not by "the store holds one workspace"."""
    first = Fixture(tmp_path, name="one")
    second = Fixture(tmp_path, name="two")
    issued = first.tokens.create("ci")

    assert first.auth.verify(issued.secret) is True
    assert second.auth.verify(issued.secret) is False

    first.close()
    second.close()


def test_several_tokens_coexist_and_each_verifies(fixture: Fixture) -> None:
    first = fixture.tokens.create("one")
    second = fixture.tokens.create("two")
    assert fixture.auth.verify(first.secret) is True
    assert fixture.auth.verify(second.secret) is True


# --- revocation is immediate -----------------------------------------------


def test_a_revoked_token_stops_verifying_in_the_same_process(fixture: Fixture) -> None:
    """The acceptance criterion, and the reason nothing may be cached.

    No reopen, no restart: the same provider instance answers ``True`` and then
    ``False`` across one ``revoke`` call.
    """
    issued = fixture.tokens.create("ci")
    assert fixture.auth.verify(issued.secret) is True

    fixture.tokens.revoke(issued.token.id, confirm=True)

    assert fixture.auth.verify(issued.secret) is False


def test_revoking_one_token_leaves_the_others_working(fixture: Fixture) -> None:
    doomed = fixture.tokens.create("old")
    kept = fixture.tokens.create("new")
    fixture.tokens.revoke(doomed.token.id, confirm=True)
    assert fixture.auth.verify(doomed.secret) is False
    assert fixture.auth.verify(kept.secret) is True


def test_an_unconfirmed_revoke_leaves_the_token_working(fixture: Fixture) -> None:
    issued = fixture.tokens.create("ci")
    with pytest.raises(ConfirmationRequired):
        fixture.tokens.revoke(issued.token.id)
    assert fixture.auth.verify(issued.secret) is True


# --- an outage is not a bad credential --------------------------------------


def test_an_unreadable_store_raises_rather_than_refusing(tmp_path: Path) -> None:
    """Reporting an outage as a bad token sends an operator hunting the wrong bug.

    ``db_path`` is a *directory*, which SQLite answers with ``SQLITE_CANTOPEN`` —
    The portable way to force a non-lock ``OperationalError``, which the
    adapter translates to ``WorkspaceCorrupt``.
    """
    broken = tmp_path / "not-a-file.db"
    broken.mkdir()
    provider = StoredTokenAuthProvider(SqliteMetadataStore(broken), UUID(int=0))
    with pytest.raises(WorkspaceCorrupt):
        provider.verify("vst_anything")


# --- composition ------------------------------------------------------------


def test_a_workspace_composes_the_stored_token_provider_by_default(fixture: Fixture) -> None:
    assert isinstance(fixture.auth, StoredTokenAuthProvider)
    assert isinstance(fixture.auth, AuthProvider)


class _StubProvider:
    """Records what the factory was handed, and accepts exactly one token."""

    def __init__(self, metadata_store: MetadataStore, workspace_id: UUID) -> None:
        self.metadata_store = metadata_store
        self.workspace_id = workspace_id

    def verify(self, token: str) -> bool:
        return token == "let-me-in"


def test_init_honours_an_injected_auth_provider(tmp_path: Path) -> None:
    workspace = WorkspaceService.init(tmp_path / "ws", auth_provider_factory=_StubProvider)
    assert workspace.auth_provider.verify("let-me-in") is True
    assert workspace.auth_provider.verify("nope") is False
    workspace.close()


def test_open_honours_an_injected_auth_provider(tmp_path: Path) -> None:
    WorkspaceService.init(tmp_path / "ws").close()
    workspace = WorkspaceService.open(tmp_path / "ws", auth_provider_factory=_StubProvider)
    assert workspace.auth_provider.verify("let-me-in") is True
    workspace.close()


@pytest.mark.parametrize("through", ["init", "open"])
def test_the_factory_receives_the_store_and_this_workspaces_id(
    tmp_path: Path, through: str
) -> None:
    """The two arguments are what make the provider scoped rather than global."""
    if through == "init":
        workspace = WorkspaceService.init(tmp_path / "ws", auth_provider_factory=_StubProvider)
    else:
        WorkspaceService.init(tmp_path / "ws").close()
        workspace = WorkspaceService.open(tmp_path / "ws", auth_provider_factory=_StubProvider)

    provider = workspace.auth_provider
    assert isinstance(provider, _StubProvider)
    assert provider.metadata_store is workspace.metadata_store
    assert provider.workspace_id == workspace.workspace_id
    workspace.close()


def test_two_workspaces_get_their_own_providers(tmp_path: Path) -> None:
    first = WorkspaceService.init(tmp_path / "one")
    second = WorkspaceService.init(tmp_path / "two")
    assert first.auth_provider is not second.auth_provider
    first.close()
    second.close()


def test_a_token_survives_a_reopen(tmp_path: Path) -> None:
    """The whole point of persisting: the credential outlives the process."""
    workspace = WorkspaceService.init(tmp_path / "ws")
    issued = TokenService(workspace).create("ci")
    workspace.close()

    reopened = WorkspaceService.open(tmp_path / "ws")
    assert reopened.auth_provider.verify(issued.secret) is True
    assert TokenService(reopened).get(issued.token.id).secret_hash == hash_secret(issued.secret)
    reopened.close()
