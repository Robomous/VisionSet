"""`InferenceConnection` and its service: the configuration auto-labeling runs on.

Three things are asserted here that nothing else in the suite can see:

- the **type-conditional rule**, which is the whole reason two kinds share one
  aggregate — each carries its own parameters and refuses the other's;
- the **workspace scoping**, which is a claim about the table rather than about a
  value, so it is asserted against the mapping and the columns; and
- that **nothing in this layer reaches a model**, which is a property of the
  import graph and is the boundary this slice exists to establish.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from visionset.kernel import (
    InferenceConnectionInvalid,
    InferenceConnectionNameTaken,
    InferenceConnectionNotFound,
    InvalidName,
)
from visionset.kernel.adapters import _mappers as m
from visionset.kernel.adapters import _tables as t
from visionset.kernel.domain import (
    ConnectionSetupState,
    ConnectionType,
    InferenceConnection,
)
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

LOCAL = dict(
    connection_type=ConnectionType.LOCAL,
    model_id="some/model",
    model_revision="abc123",
    device="cpu",
    precision="fp16",
)

HTTP = dict(
    connection_type=ConnectionType.HTTP,
    model_id="some/model",
    model_revision="abc123",
    endpoint_url="https://example.invalid/predict",
)


@pytest.fixture()
def connections(tmp_path: Path):  # noqa: ANN201 - a fixture handing back two objects
    workspace = WorkspaceService.init(tmp_path / "ws", name="inference")
    yield InferenceConnectionService(workspace)
    workspace.close()


# --- the type-conditional rule ------------------------------------------------


def test_a_local_connection_needs_its_local_parameters() -> None:
    for missing in ("device", "precision"):
        parameters = dict(LOCAL)
        del parameters[missing]
        with pytest.raises(ValidationError, match=f"local connection needs {missing}"):
            InferenceConnection(name="x", **parameters)


def test_an_http_connection_needs_its_endpoint() -> None:
    parameters = dict(HTTP)
    del parameters["endpoint_url"]
    with pytest.raises(ValidationError, match="http connection needs endpoint_url"):
        InferenceConnection(name="x", **parameters)


def test_each_kind_refuses_the_others_parameters() -> None:
    """The half a "required field" rule usually forgets, and the one that rots.

    A local connection carrying an `endpoint_url` is the shape that makes a later
    reader ask which field the adapter should believe.
    """
    with pytest.raises(ValidationError, match="local connection cannot carry endpoint_url"):
        InferenceConnection(name="x", **LOCAL, endpoint_url="https://example.invalid")
    with pytest.raises(ValidationError, match="http connection cannot carry device"):
        InferenceConnection(name="x", **HTTP, device="cpu")


def test_a_blank_name_or_model_reference_is_refused() -> None:
    for field in ("name", "model_id", "model_revision"):
        parameters = dict(LOCAL) | {"name": "x"}
        parameters[field] = "   "
        with pytest.raises(ValidationError, match="non-blank"):
            InferenceConnection(**parameters)


def test_an_edit_that_would_break_the_kind_is_refused(connections) -> None:  # noqa: ANN001
    """`update` rebuilds the model rather than mutating it, so the rule runs.

    `model_copy(update=…)` does not validate — this is the test that would catch
    an `update` written that way, because clearing a local parameter would sail
    straight through it.
    """
    made = connections.create("local", **LOCAL)
    with pytest.raises(
        InferenceConnectionInvalid, match="local connection cannot carry endpoint_url"
    ):
        connections.update(made.id, endpoint_url="https://example.invalid")


def test_the_service_refuses_in_the_kernels_own_vocabulary(connections) -> None:  # noqa: ANN001
    """No pydantic `ValidationError` escapes a service call.

    `ReleaseService._read_manifest` states the rule this pins: nothing from
    outside the kernel's vocabulary leaves the kernel. It matters at the wire,
    where an untranslated `ValidationError` is a 500 on a request whose only
    fault is a bad payload — which is exactly how this was caught.
    """
    with pytest.raises(InferenceConnectionInvalid) as refusal:
        connections.create(
            "x", connection_type=ConnectionType.LOCAL, model_id="m", model_revision="r"
        )
    assert not isinstance(refusal.value, ValidationError)
    # The domain's own sentence, without pydantic's frame around it.
    assert str(refusal.value) == "a local connection needs device"


# --- workspace scoping --------------------------------------------------------


def test_a_connection_is_workspace_scoped_and_carries_no_parent_key() -> None:
    """The scoping claim, asserted where it actually lives.

    Workspace scoping here is the *absence* of a parent column, not a value in
    one: a connection belongs to the workspace, and the workspace is the file the
    row lives in. This fails if somebody gives the row a `project_id` — or any
    other foreign key — which would silently turn `list()` from "every
    connection" into "every connection with a null parent".
    """
    columns = {column.name for column in t.InferenceConnectionRow.__table__.columns}
    assert "project_id" not in columns
    assert not t.InferenceConnectionRow.__table__.foreign_keys
    assert m.INFERENCE_CONNECTIONS.parent_column is None


def test_listing_answers_with_every_connection_in_the_workspace(connections) -> None:  # noqa: ANN001
    connections.create("one", **LOCAL)
    connections.create("two", **HTTP)
    assert [one.name for one in connections.list()] == ["one", "two"]


# --- names --------------------------------------------------------------------


def test_a_name_is_taken_case_insensitively(connections) -> None:  # noqa: ANN001
    connections.create("Local", **LOCAL)
    with pytest.raises(InferenceConnectionNameTaken):
        connections.create("local", **HTTP)


def test_a_blank_name_is_an_invalid_name_not_a_collision(connections) -> None:  # noqa: ANN001
    with pytest.raises(InvalidName):
        connections.create("   ", **LOCAL)


def test_renaming_a_connection_to_its_own_name_is_allowed(connections) -> None:  # noqa: ANN001
    """The `exclude=` case, which `TokenService` never needed because it cannot rename."""
    made = connections.create("local", **LOCAL)
    assert connections.update(made.id, name="local").name == "local"


def test_a_connection_resolves_by_name_case_insensitively(connections) -> None:  # noqa: ANN001
    made = connections.create("Local", **LOCAL)
    assert connections.get_by_name("lOcAl").id == made.id


# --- setup state --------------------------------------------------------------


def test_the_kind_decides_the_state_a_connection_is_born_in(connections) -> None:  # noqa: ANN001
    """Local weights are absent until fetched; an endpoint has nothing to set up."""
    assert connections.create("l", **LOCAL).setup_state is ConnectionSetupState.NOT_SET_UP
    assert connections.create("h", **HTTP).setup_state is ConnectionSetupState.READY


def test_creating_a_connection_does_not_move_the_setup_state_a_caller_asks_for(
    connections,  # noqa: ANN001
) -> None:
    """A caller cannot declare weights present that were never fetched.

    `ConnectionCreate` has no `setup_state` field and the service takes no such
    argument; this pins the consequence rather than the shape, so a later slice
    that adds the parameter has to decide to.
    """
    assert connections.create("l", **LOCAL).setup_state is ConnectionSetupState.NOT_SET_UP


# --- deleting -----------------------------------------------------------------


def test_deleting_a_connection_removes_only_that_row(connections) -> None:  # noqa: ANN001
    made = connections.create("one", **LOCAL)
    connections.create("two", **HTTP)
    connections.delete(made.id)
    assert [one.name for one in connections.list()] == ["two"]
    with pytest.raises(InferenceConnectionNotFound):
        connections.get(made.id)


def test_deleting_an_unknown_connection_is_refused(connections) -> None:  # noqa: ANN001
    made = connections.create("one", **LOCAL)
    connections.delete(made.id)
    with pytest.raises(InferenceConnectionNotFound):
        connections.delete(made.id)


# --- the boundary this slice exists to draw -----------------------------------


def test_configuring_a_connection_reaches_no_model_runtime() -> None:
    """Nothing in this layer imports an inference stack, and nothing may.

    The kernel knows the configuration; the `ModelProvider` port knows the
    protocol; resolving one into the other is the composition root's job outside
    the kernel (`cf. #418`). Asserted as an import-graph fact because that is
    what "creating a connection downloads nothing" actually rests on — a mocked
    call would prove only that this test did not download anything.
    """
    import ast
    import sys

    from visionset.kernel.services import inference_connection_service as module

    tree = ast.parse(Path(module.__file__).read_text())
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            imported.add(node.module.split(".")[0])

    runtimes = {"torch", "transformers", "huggingface_hub", "httpx", "requests", "urllib"}
    assert not imported & runtimes
    # And nothing it *did* import dragged one in behind it. Importing this
    # module is what a caller does before creating a connection, so this is the
    # "creating a connection downloads nothing" claim at its narrowest.
    assert not {"torch", "transformers", "huggingface_hub"} & set(sys.modules)
