"""`TokenService`: mint once, store a digest, revoke for good.

The assertions that matter most are negative ones — that no read path can
reproduce a secret, and that a plaintext never reaches the store — because a
failure there looks exactly like the feature working.
"""

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from visionset.kernel import (
    ConfirmationRequired,
    ConstraintViolated,
    InvalidName,
    TokenNameTaken,
    TokenNotFound,
)
from visionset.kernel.domain import hash_secret
from visionset.kernel.services import TokenService, WorkspaceService


class Fixture:
    """One workspace and its token service."""

    def __init__(self, tmp_path: Path, name: str = "ws") -> None:
        self.workspace = WorkspaceService.init(tmp_path / name)
        self.tokens = TokenService(self.workspace)

    def close(self) -> None:
        self.workspace.close()


@pytest.fixture()
def fixture(tmp_path: Path) -> Iterator[Fixture]:
    made = Fixture(tmp_path)
    yield made
    made.close()


# --- creation --------------------------------------------------------------


def test_create_returns_the_plaintext_and_stores_only_its_digest(fixture: Fixture) -> None:
    issued = fixture.tokens.create("ci")
    assert issued.secret
    assert issued.token.secret_hash == hash_secret(issued.secret)
    assert issued.token.secret_hash != issued.secret


def test_no_read_path_can_reproduce_the_secret(fixture: Fixture) -> None:
    """The acceptance criterion, asserted against every way back in."""
    issued = fixture.tokens.create("ci")

    by_id = fixture.tokens.get(issued.token.id)
    by_name = fixture.tokens.get_by_name("ci")
    listed = fixture.tokens.list()

    for reachable in (by_id, by_name, *listed):
        assert issued.secret not in reachable.model_dump_json()


def test_a_created_token_belongs_to_this_workspace_and_is_live(fixture: Fixture) -> None:
    issued = fixture.tokens.create("ci")
    assert issued.token.workspace_id == fixture.workspace.workspace_id
    assert issued.token.revoked is False


def test_two_tokens_never_share_a_secret(fixture: Fixture) -> None:
    first = fixture.tokens.create("one")
    second = fixture.tokens.create("two")
    assert first.secret != second.secret
    assert first.token.secret_hash != second.token.secret_hash


def test_a_name_is_normalized_before_it_is_stored(fixture: Fixture) -> None:
    issued = fixture.tokens.create("  ci  ")
    assert issued.token.name == "ci"


def test_a_blank_name_is_refused(fixture: Fixture) -> None:
    with pytest.raises(InvalidName, match="token name"):
        fixture.tokens.create("   ")


def test_a_duplicate_name_is_refused_case_insensitively(fixture: Fixture) -> None:
    fixture.tokens.create("ci")
    with pytest.raises(TokenNameTaken, match="ci"):
        fixture.tokens.create("CI")


def test_a_name_taken_refusal_writes_nothing(fixture: Fixture) -> None:
    fixture.tokens.create("ci")
    with pytest.raises(TokenNameTaken):
        fixture.tokens.create("ci")
    assert len(fixture.tokens.list()) == 1


def test_a_lost_name_race_is_reported_as_a_collision(fixture: Fixture) -> None:
    """The index's complaint, translated into the vocabulary callers expect.

    Exercised directly rather than by racing two writers: the pre-check folds
    Unicode where the index folds ASCII, so it is strictly the stricter of the
    two and nothing single-threaded can slip past it. What is under test is the
    translation itself, which is the part that runs when a *second process*
    passes its own pre-check and loses at commit.
    """
    refusal = ConstraintViolated("UNIQUE constraint failed: token.workspace_id, token.name")
    translated = fixture.tokens._as_name_collision(refusal, "ci")
    assert isinstance(translated, TokenNameTaken)
    assert "ci" in str(translated)


def test_another_constraint_is_not_reinterpreted(fixture: Fixture) -> None:
    """Only the name index's complaint becomes a ``TokenNameTaken``.

    Anything else is not this service's to rename and travels on unchanged.
    """
    refusal = ConstraintViolated("FOREIGN KEY constraint failed")
    assert fixture.tokens._as_name_collision(refusal, "ci") is refusal


# --- reading ---------------------------------------------------------------


def test_get_by_name_folds_case(fixture: Fixture) -> None:
    issued = fixture.tokens.create("ci")
    assert fixture.tokens.get_by_name("CI").id == issued.token.id


def test_an_unknown_id_is_not_found(fixture: Fixture) -> None:
    with pytest.raises(TokenNotFound, match="no token "):
        fixture.tokens.get(uuid4())


def test_an_unknown_name_is_not_found(fixture: Fixture) -> None:
    with pytest.raises(TokenNotFound, match="no token named"):
        fixture.tokens.get_by_name("nothing")


def test_a_token_from_another_workspace_reads_as_missing(tmp_path: Path) -> None:
    """Cross-scope references are *missing*, never forbidden."""
    first = Fixture(tmp_path, name="one")
    second = Fixture(tmp_path, name="two")
    issued = first.tokens.create("ci")

    with pytest.raises(TokenNotFound):
        second.tokens.get(issued.token.id)
    with pytest.raises(TokenNotFound):
        second.tokens.get_by_name("ci")
    assert second.tokens.list() == []

    first.close()
    second.close()


def test_list_is_mint_order_and_keeps_revoked_tokens(fixture: Fixture) -> None:
    first = fixture.tokens.create("one")
    second = fixture.tokens.create("two")
    fixture.tokens.revoke(first.token.id, confirm=True)

    listed = fixture.tokens.list()
    assert [token.id for token in listed] == [first.token.id, second.token.id]
    assert [token.revoked for token in listed] == [True, False]


# --- revocation ------------------------------------------------------------


def test_revoke_requires_confirmation(fixture: Fixture) -> None:
    issued = fixture.tokens.create("ci")
    with pytest.raises(ConfirmationRequired, match="cannot be undone"):
        fixture.tokens.revoke(issued.token.id)
    assert fixture.tokens.get(issued.token.id).revoked is False


def test_revoke_marks_the_token_and_records_when(fixture: Fixture) -> None:
    issued = fixture.tokens.create("ci")
    revoked = fixture.tokens.revoke(issued.token.id, confirm=True)
    assert revoked.revoked is True
    assert revoked.revoked_at is not None
    assert fixture.tokens.get(issued.token.id).revoked_at == revoked.revoked_at


def test_an_unknown_id_is_not_found_with_or_without_confirm(fixture: Fixture) -> None:
    """Existence is checked first, so the flag never changes which error fires."""
    missing = uuid4()
    with pytest.raises(TokenNotFound):
        fixture.tokens.revoke(missing)
    with pytest.raises(TokenNotFound):
        fixture.tokens.revoke(missing, confirm=True)


def test_revoking_twice_is_a_no_op_that_keeps_the_first_timestamp(fixture: Fixture) -> None:
    """A retried command must not move the moment the credential died."""
    issued = fixture.tokens.create("ci")
    first = fixture.tokens.revoke(issued.token.id, confirm=True)
    again = fixture.tokens.revoke(issued.token.id, confirm=True)
    assert again.revoked_at == first.revoked_at


def test_revoking_an_already_revoked_token_needs_no_confirmation(fixture: Fixture) -> None:
    """Nothing is destroyed the second time, so nothing is guarded."""
    issued = fixture.tokens.create("ci")
    fixture.tokens.revoke(issued.token.id, confirm=True)
    assert fixture.tokens.revoke(issued.token.id).revoked is True


def test_revocation_does_not_free_the_name(fixture: Fixture) -> None:
    """The row is the audit record, so the name it holds stays held.

    Deliberate: reusing the name of a burned credential would make a log entry
    ambiguous about which ``ci`` it refers to.
    """
    issued = fixture.tokens.create("ci")
    fixture.tokens.revoke(issued.token.id, confirm=True)
    with pytest.raises(TokenNameTaken):
        fixture.tokens.create("ci")
