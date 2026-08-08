"""Every registered handler must be reachable in a worker that imported nothing.

The one test in this file that earns its keep more than the rest is
`test_every_registered_handler_pickles_and_resolves`: a `HandlerRef` is a string
precisely so it can cross into a `spawn`ed interpreter, and the failure it
prevents — a typo'd import path — is otherwise discovered by a worker whose
traceback names neither the job nor its caller.
"""

from __future__ import annotations

import pickle

import pytest

from visionset.jobs import REGISTRY, HandlerRef, known_types, load, register, resolve
from visionset.kernel.errors import UnknownJobType

#: What `visionset.jobs` itself registers, as opposed to what a test module has.
SHIPPED = {"ingest.resume", "export.release", "inference.download_weights"}


def shipped_refs() -> list[HandlerRef]:
    """Only the handlers this package ships.

    The registry is one module-level dict, so a test module that registers its
    own handler — `test_dispatcher.py` does, because a handler is resolved by import
    string and cannot be a closure — is in it too. Filtering by where the code
    lives is what keeps these assertions about the product rather than about
    whatever else the suite has imported.
    """
    return [ref for ref in REGISTRY.values() if ref.func.startswith("visionset.jobs.")]


def test_importing_the_package_registers_both_shipped_types() -> None:
    """The registry is populated by import, which is the one thing to remember."""
    assert {ref.type for ref in shipped_refs()} == SHIPPED
    assert known_types() >= SHIPPED


def test_every_registered_handler_pickles_and_resolves() -> None:
    """A ref crosses a process boundary and is resolved on the far side.

    Both halves are checked because they fail differently: an unpicklable ref
    dies at submit, and a ref naming code that is not there dies inside a worker.
    """
    for ref in REGISTRY.values():
        assert pickle.loads(pickle.dumps(ref)) == ref
        assert callable(load(ref))


def test_every_shipped_handler_is_idempotent_and_says_so() -> None:
    """All of today's are, and each had to argue it — see their modules.

    Not a rule for all time: a handler that is not idempotent declares `False`
    and is never retried automatically. This pins what today's three claim, so
    adding a fourth is a deliberate answer rather than a default nobody read.
    """
    assert all(ref.idempotent for ref in shipped_refs())


def test_a_ref_names_a_module_and_an_attribute() -> None:
    with pytest.raises(UnknownJobType, match="module:attribute"):
        load(HandlerRef(type="x", func="visionset.jobs.export"))


def test_a_ref_naming_a_missing_module_is_refused_as_an_unknown_type() -> None:
    """`ImportError` and `AttributeError` are the same thing to a dispatcher."""
    with pytest.raises(UnknownJobType, match="will not import"):
        load(HandlerRef(type="x", func="visionset.jobs.nope:run"))


def test_a_ref_naming_something_that_is_not_callable_is_refused() -> None:
    with pytest.raises(UnknownJobType, match="nothing callable"):
        load(HandlerRef(type="x", func="visionset.jobs.export:JOB_TYPE"))


def test_resolving_an_unknown_type_names_what_is_registered() -> None:
    """The two causes — a typo, and a module nobody imported — look identical."""
    with pytest.raises(UnknownJobType) as raised:
        resolve("export.releases")

    assert "export.release" in str(raised.value)


def test_registering_a_duplicate_type_is_refused_rather_than_ignored() -> None:
    """FastMCP logs and discards a duplicate tool; that is the wrong call here.

    Two modules claiming one type means one of them will never run, and nothing
    would say which.
    """
    with pytest.raises(ValueError, match="already registered"):
        register(HandlerRef(type="export.release", func="somewhere.else:run"))


def test_registering_the_same_ref_twice_is_allowed() -> None:
    """Because a module can be imported twice and must not explode the second time."""
    existing = REGISTRY["export.release"]

    assert register(existing) == existing
