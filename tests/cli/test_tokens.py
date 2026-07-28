"""``visionset token create/list/revoke``, including what it must never print.

Two of these carry the issue's acceptance criteria and are marked where they sit:
a token minted here authenticates against a server built by the real
``create_app()``, and a listing never shows a secret or a digest.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.server._probe import PROBE_PATH, workspace_app
from typer.testing import CliRunner

from visionset.cli.main import app
from visionset.kernel.domain import SECRET_PREFIX, Token
from visionset.kernel.services import WORKSPACE_ENV_VAR, TokenService, WorkspaceService

runner = CliRunner()


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def workspace_root(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    WorkspaceService.init(root).close()
    return root


def _stored(root: Path) -> list[Token]:
    workspace = WorkspaceService.open(root)
    tokens = TokenService(workspace).list()
    workspace.close()
    return tokens


def _create(root: Path, name: str) -> str:
    """Mint through the CLI and return the secret it printed."""
    result = runner.invoke(app, ["token", "create", "--name", name, "-w", str(root)])
    assert result.exit_code == 0, result.output
    return result.stdout.strip()


def _rows(output: str) -> list[list[str]]:
    return [line.split() for line in output.splitlines()]


# --- create -------------------------------------------------------------------


def test_create_prints_the_secret_alone_on_stdout(workspace_root: Path) -> None:
    """``TOKEN=$(visionset token create --name ci)`` has to be exactly the secret."""
    result = runner.invoke(app, ["token", "create", "--name", "ci", "-w", str(workspace_root)])

    assert result.exit_code == 0, result.output
    assert result.stdout.strip().startswith(SECRET_PREFIX)
    assert len(result.stdout.strip().splitlines()) == 1


def test_create_warns_on_stderr_that_the_secret_is_shown_once(workspace_root: Path) -> None:
    """On stderr so the warning survives the redirection that most needs it."""
    result = runner.invoke(app, ["token", "create", "--name", "ci", "-w", str(workspace_root)])

    assert "shown once" in result.stderr
    assert "ci" in result.stderr


def test_create_stores_a_token_the_workspace_can_list(workspace_root: Path) -> None:
    secret = _create(workspace_root, "ci")

    stored = _stored(workspace_root)
    assert [token.name for token in stored] == ["ci"]
    assert secret not in stored[0].secret_hash


def test_a_token_created_by_the_cli_authenticates_against_a_running_server(
    workspace_root: Path,
) -> None:
    """The acceptance criterion: the CLI writes what the server reads."""
    secret = _create(workspace_root, "ci")

    with TestClient(workspace_app(workspace_root)) as client:
        response = client.get(PROBE_PATH, headers={"Authorization": f"Bearer {secret}"})

    assert response.status_code == 200


def test_creating_a_second_token_with_the_same_name_is_refused_with_a_readable_message(
    workspace_root: Path,
) -> None:
    _create(workspace_root, "ci")

    result = runner.invoke(app, ["token", "create", "--name", "CI", "-w", str(workspace_root)])

    assert result.exit_code == 1
    assert "already exists" in result.stderr
    assert result.stdout == ""
    assert len(_stored(workspace_root)) == 1


def test_creating_a_token_with_a_blank_name_is_refused(workspace_root: Path) -> None:
    result = runner.invoke(app, ["token", "create", "--name", "   ", "-w", str(workspace_root)])

    assert result.exit_code == 1
    assert result.stdout == ""
    assert _stored(workspace_root) == []


def test_create_without_a_name_is_a_usage_error(workspace_root: Path) -> None:
    """Click's refusal, at Click's exit code — not a domain error dressed as one."""
    result = runner.invoke(app, ["token", "create", "-w", str(workspace_root)])

    assert result.exit_code == 2


# --- list ---------------------------------------------------------------------


def test_list_shows_every_token_with_its_created_and_revoked_columns(
    workspace_root: Path,
) -> None:
    _create(workspace_root, "ci")
    _create(workspace_root, "laptop")

    result = runner.invoke(app, ["token", "list", "-w", str(workspace_root)])

    assert result.exit_code == 0, result.output
    rows = _rows(result.stdout)
    assert rows[0] == ["NAME", "CREATED", "REVOKED"]
    assert [row[0] for row in rows[1:]] == ["ci", "laptop"]


def test_list_never_prints_a_secret_or_its_hash(workspace_root: Path) -> None:
    """The acceptance criterion, asserted against both streams.

    The digest is not the secret, but it verifies a guess offline — a listing
    that prints one teaches a habit that ends badly.
    """
    secrets = [_create(workspace_root, name) for name in ("ci", "laptop")]
    digests = [token.secret_hash for token in _stored(workspace_root)]

    result = runner.invoke(app, ["token", "list", "-w", str(workspace_root)])

    assert result.exit_code == 0, result.output
    for hidden in (*secrets, *digests):
        assert hidden not in result.stdout
        assert hidden not in result.stderr


def test_list_on_a_workspace_with_no_tokens_prints_only_a_header(
    workspace_root: Path,
) -> None:
    """The header prints either way, so ``| tail -n +2`` is stable."""
    result = runner.invoke(app, ["token", "list", "-w", str(workspace_root)])

    assert result.exit_code == 0, result.output
    assert _rows(result.stdout) == [["NAME", "CREATED", "REVOKED"]]
    assert "No tokens" in result.stderr


def test_list_shows_a_live_token_with_no_revocation_time(workspace_root: Path) -> None:
    _create(workspace_root, "ci")

    result = runner.invoke(app, ["token", "list", "-w", str(workspace_root)])

    assert _rows(result.stdout)[1][2] == "-"


def test_list_shows_a_revoked_token_with_the_moment_it_died(workspace_root: Path) -> None:
    _create(workspace_root, "ci")
    runner.invoke(app, ["token", "revoke", "ci", "--yes", "-w", str(workspace_root)])

    result = runner.invoke(app, ["token", "list", "-w", str(workspace_root)])

    revoked = _rows(result.stdout)[1][2]
    assert revoked.endswith("Z")
    assert revoked != "-"


# --- revoke -------------------------------------------------------------------


def test_revoke_asks_before_burning_a_credential(workspace_root: Path) -> None:
    _create(workspace_root, "ci")

    result = runner.invoke(app, ["token", "revoke", "ci", "-w", str(workspace_root)], input="n\n")

    assert result.exit_code != 0
    assert _stored(workspace_root)[0].revoked is False


def test_revoke_with_yes_burns_the_credential_without_asking(workspace_root: Path) -> None:
    """No ``input=``: a prompt here would abort on EOF and fail this test."""
    _create(workspace_root, "ci")

    result = runner.invoke(app, ["token", "revoke", "ci", "--yes", "-w", str(workspace_root)])

    assert result.exit_code == 0, result.output
    assert _stored(workspace_root)[0].revoked is True


def test_a_revoked_token_no_longer_authenticates(workspace_root: Path) -> None:
    secret = _create(workspace_root, "ci")
    runner.invoke(app, ["token", "revoke", "ci", "--yes", "-w", str(workspace_root)])

    with TestClient(workspace_app(workspace_root)) as client:
        response = client.get(PROBE_PATH, headers={"Authorization": f"Bearer {secret}"})

    assert response.status_code == 401


def test_revoke_resolves_a_name_case_insensitively(workspace_root: Path) -> None:
    """Token names are unique case-insensitively, so one spelling is enough."""
    _create(workspace_root, "ci")

    result = runner.invoke(app, ["token", "revoke", "CI", "--yes", "-w", str(workspace_root)])

    assert result.exit_code == 0, result.output
    assert "'ci'" in result.stderr, "the matched name is printed, not the typed one"
    assert _stored(workspace_root)[0].revoked is True


def test_revoking_an_unknown_name_exits_one_with_a_readable_message(
    workspace_root: Path,
) -> None:
    result = runner.invoke(app, ["token", "revoke", "ghost", "--yes", "-w", str(workspace_root)])

    assert result.exit_code == 1
    assert "no token named" in result.stderr


def test_revoking_an_already_revoked_token_succeeds_and_says_so(workspace_root: Path) -> None:
    """A retried ``token revoke ci`` has to be safe, and must not prompt."""
    _create(workspace_root, "ci")
    runner.invoke(app, ["token", "revoke", "ci", "--yes", "-w", str(workspace_root)])
    died = _stored(workspace_root)[0].revoked_at

    result = runner.invoke(app, ["token", "revoke", "ci", "-w", str(workspace_root)])

    assert result.exit_code == 0, result.output
    assert "already revoked" in result.stderr
    assert _stored(workspace_root)[0].revoked_at == died


# --- exit codes ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("label", "argv"),
    [
        ("create", ["token", "create", "--name", "fresh"]),
        ("list", ["token", "list"]),
        ("revoke", ["token", "revoke", "ci", "--yes"]),
    ],
)
def test_every_token_command_exits_zero_when_it_succeeds(
    workspace_root: Path, label: str, argv: list[str]
) -> None:
    _create(workspace_root, "ci")

    result = runner.invoke(app, [*argv, "-w", str(workspace_root)])

    assert result.exit_code == 0, f"{label}: {result.output}"
