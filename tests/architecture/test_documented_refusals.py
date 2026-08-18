"""A published enumeration of refusals is never short of what the route can raise.

## The gap this closes

A route's docstring is published: FastAPI copies it verbatim into ``openapi.json``
and ``frontend/ui-core/src/generated/api.ts`` carries it from there. When such a
docstring enumerates the refusals a caller can receive, nothing held that
enumeration against the errors the route can actually raise — so a paragraph
naming two of ``suggest_region``'s three 500s was published, and told a client
author to handle fewer failures than exist, in the document that exists to say
exactly that. A person reading the paragraph caught it. Nothing in the suite
disagreed with either version, and the drift gates cannot: they hold the
artifacts against the source, and the source was what was wrong.

## What is proved

A route puts a status **in play** by naming one of that status's error codes, or
by writing the status in prose. For every status in play, every error the route
can reach whose status is that one must appear in the docstring *as a code*.

The status printed beside a code is deliberately **not** checked. ``AssetNotInJob``
is a 404 in ``ERROR_RULES`` and ``annotations.py`` documents it as a 422, because
that route overrides the status and keeps the code and says so beside the
override. Checking the pairing would report a correct docstring; requiring only
that the code appear does not.

## What is not proved, and why it is still worth having

This is a **lower bound**. Reachability comes from the ``Raises:`` blocks of the
callables a route calls, so a helper carrying no block contributes nothing and
the gate cannot see past it. Two things keep that from making the gate vacuous:
a route in play that reaches no documented raiser at all is a failure here rather
than a silent pass, and the two helpers that were blind when this was written —
``visionset.inference.require`` and ``background_jobs._require`` — were given
blocks in the same change.

It speaks only the vocabulary of ``ERROR_RULES``. A raw ``HTTPException``, which
``errors.py`` renders under the status's own name, is outside it — the artifact
route's 404-when-the-file-is-gone is prose this file cannot check.
"""

from __future__ import annotations

import ast
import importlib
import inspect
import re
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Final

from fastapi import APIRouter

from visionset.server import routes as routes_package
from visionset.server.errors import ERROR_RULES

#: ``code -> status`` and ``class name -> code``, both from the one table, so a
#: new error is in this gate's vocabulary the moment it has a rule.
STATUS_BY_CODE: Final[dict[str, int]] = {rule.code: rule.status for rule in ERROR_RULES.values()}
CODE_BY_CLASS: Final[dict[str, str]] = {
    cls.__name__: rule.code for cls, rule in ERROR_RULES.items()
}
STATUSES: Final[frozenset[int]] = frozenset(STATUS_BY_CODE.values())

_RAISES_HEADING: Final = re.compile(r"^Raises:\s*$", re.MULTILINE)
_RAISES_ENTRY: Final = re.compile(r"^\s+([A-Z][A-Za-z0-9_]*):")
_CODE_TOKEN: Final = re.compile(r"\b[A-Z][A-Z0-9_]{3,}\b")
_STATUS_TOKEN: Final = re.compile(r"\b([45]\d\d)\b")


def declared_raises(target: object) -> frozenset[str] | None:
    """The error classes a callable's ``Raises:`` block names.

    ``None`` rather than an empty set when there is no block at all: "declares
    nothing" and "declares that it raises nothing" are different claims, and only
    the second one may be trusted.
    """
    doc = inspect.getdoc(target) or ""
    heading = _RAISES_HEADING.search(doc)
    if heading is None:
        return None
    names: set[str] = set()
    for line in doc[heading.end() :].splitlines():
        if line.strip() and not line.startswith(" "):
            break  # dedented to column zero: the next section of the docstring
        entry = _RAISES_ENTRY.match(line)
        if entry is not None:
            names.add(entry.group(1))
    return frozenset(names)


def named_codes(doc: str) -> frozenset[str]:
    """The error codes a docstring names."""
    return frozenset(token for token in _CODE_TOKEN.findall(doc) if token in STATUS_BY_CODE)


def named_statuses(doc: str) -> frozenset[int]:
    """The statuses a docstring puts in play — written in prose, or via a code."""
    prose = {int(found) for found in _STATUS_TOKEN.findall(doc)} & STATUSES
    return frozenset(prose | {STATUS_BY_CODE[code] for code in named_codes(doc)})


def missing_codes(doc: str, reachable: frozenset[str]) -> frozenset[str]:
    """Reachable codes at a status this docstring put in play, and did not name."""
    statuses = named_statuses(doc)
    if not statuses:
        return frozenset()
    at_stake = {code for code in reachable if STATUS_BY_CODE[code] in statuses}
    return frozenset(at_stake - named_codes(doc))


_HTTP_METHODS: Final[frozenset[str]] = frozenset({"get", "post", "put", "patch", "delete"})


def route_functions() -> Iterator[tuple[ModuleType, ast.FunctionDef]]:
    """Every published route, as its imported module and its parsed definition.

    Both halves are needed and neither substitutes for the other: the module is
    what resolves a name to the object the route really calls, and the tree is
    what says which calls the body makes.
    """
    directory = Path(routes_package.__file__).parent
    for path in sorted(directory.glob("*.py")):
        if path.stem == "__init__":
            continue
        module = importlib.import_module(f"{routes_package.__name__}.{path.stem}")
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and _is_route(node, module):
                yield module, node


def _is_route(node: ast.FunctionDef, module: ModuleType) -> bool:
    """Decorated with a verb on something that is really an ``APIRouter``."""
    for decorator in node.decorator_list:
        func = decorator.func if isinstance(decorator, ast.Call) else decorator
        if (
            isinstance(func, ast.Attribute)
            and func.attr in _HTTP_METHODS
            and isinstance(func.value, ast.Name)
            and isinstance(getattr(module, func.value.id, None), APIRouter)
        ):
            return True
    return False


def reachable_codes(
    module: ModuleType, node: ast.FunctionDef
) -> tuple[frozenset[str], tuple[str, ...]]:
    """The codes a route can answer, and what declared each of them.

    The sources are returned rather than discarded because a route that reached
    nothing is the case this gate has to refuse: an empty tuple means the check
    proved nothing about it, which is not the same as proving it complete.
    """
    classes: set[str] = set()
    sources: list[str] = []
    for call in (child for child in ast.walk(node) if isinstance(child, ast.Call)):
        target, label = _target_of(call.func, module, node)
        if target is None:
            continue
        declared = declared_raises(target)
        if declared is None:
            continue
        classes |= set(declared)
        sources.append(label)
    for statement in (child for child in ast.walk(node) if isinstance(child, ast.Raise)):
        raised = statement.exc
        if (
            isinstance(raised, ast.Call)
            and isinstance(raised.func, ast.Name)
            and raised.func.id in CODE_BY_CLASS
        ):
            classes.add(raised.func.id)
            sources.append(f"raise {raised.func.id}")
    codes = frozenset(CODE_BY_CLASS[name] for name in classes if name in CODE_BY_CLASS)
    return codes, tuple(sources)


def _target_of(
    func: ast.expr, module: ModuleType, route: ast.FunctionDef
) -> tuple[object | None, str]:
    """The object a call names, resolved against the route module's namespace."""
    if isinstance(func, ast.Name):
        return getattr(module, func.id, None), func.id
    if not isinstance(func, ast.Attribute):
        return None, ""
    base = func.value
    if isinstance(base, ast.Call) and isinstance(base.func, ast.Name):
        owner = getattr(module, base.func.id, None)
        label = f"{base.func.id}().{func.attr}"
        return (getattr(owner, func.attr, None) if owner is not None else None), label
    if isinstance(base, ast.Name):
        constructor = _constructed_by(route, base.id)
        owner = getattr(module, constructor, None) if constructor is not None else None
        label = f"{base.id}.{func.attr}"
        return (getattr(owner, func.attr, None) if owner is not None else None), label
    return None, ""


def _constructed_by(route: ast.FunctionDef, variable: str) -> str | None:
    """The class a local was built from — ``ingest = IngestService(workspace)``."""
    for node in ast.walk(route):
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Call):
            continue
        if not isinstance(node.value.func, ast.Name):
            continue
        if any(isinstance(target, ast.Name) and target.id == variable for target in node.targets):
            return node.value.func.id
    return None


def _route(name: str) -> tuple[ModuleType, ast.FunctionDef]:
    for module, node in route_functions():
        if node.name == name:
            return module, node
    raise AssertionError(f"no route function named {name!r}")


#: Routes whose published enumeration is short today, and by what.
#:
#: Every entry is a defect in a published contract. Each is corrected in this same
#: change and its entry deleted with it, and this constant goes with the last one —
#: an exemption left behind is a rule this file would no longer prove. Nothing may
#: be added here.
KNOWN_SHORT: Final[dict[str, frozenset[str]]] = {
    "assets::get_asset": frozenset({"ASSET_NOT_FOUND", "PROJECT_NOT_FOUND"}),
    "assets::get_asset_content": frozenset({"ASSET_NOT_FOUND", "PROJECT_NOT_FOUND"}),
    "assets::get_asset_thumbnail": frozenset({"ASSET_NOT_FOUND", "PROJECT_NOT_FOUND"}),
    "assets::list_asset_batches": frozenset(
        {"ASSET_NOT_FOUND", "BATCH_NOT_FOUND", "PROJECT_NOT_FOUND"}
    ),
    "background_jobs::get_background_job_artifact": frozenset({"BACKGROUND_JOB_NOT_FOUND"}),
    "batches::add_batch_assets": frozenset({"BATCH_NOT_FOUND"}),
    "batches::approve_batch": frozenset({"BATCH_NOT_FOUND"}),
    "batches::complete_batch": frozenset({"INVALID_TRANSITION"}),
    "batches::create_correction_batch": frozenset({"INVALID_TRANSITION"}),
    "batches::list_batch_assets": frozenset({"BATCH_NOT_FOUND"}),
    "datasets::list_dataset_assets": frozenset({"DATASET_NOT_FOUND"}),
    "datasets::remove_dataset_asset": frozenset({"DATASET_NOT_FOUND"}),
    "inference::suggest_region": frozenset(
        {
            "ASSET_NOT_FOUND",
            "INFERENCE_CONNECTION_NOT_FOUND",
            "PROJECT_NOT_FOUND",
            "UNSUPPORTED_PROMPT",
        }
    ),
    "jobs::complete_job": frozenset({"BATCH_NOT_IN_ANNOTATION", "INVALID_TRANSITION"}),
    "jobs::set_asset_progress": frozenset({"BATCH_NOT_IN_ANNOTATION", "STALE_WRITE"}),
    "jobs::start_job": frozenset({"INVALID_TRANSITION"}),
    "releases::export_release": frozenset({"RELEASE_NOT_FOUND"}),
    "releases::get_release_assignment": frozenset({"RELEASE_NOT_FOUND"}),
    "releases::publish_release": frozenset({"DATASET_NOT_FOUND", "UNSERIALIZABLE_MANIFEST"}),
    "schemas::create_schema_version": frozenset({"SCHEMA_VERSION_CONFLICT"}),
    "schemas::get_schema_draft": frozenset({"PROJECT_NOT_FOUND", "SCHEMA_DRAFT_NOT_FOUND"}),
    "schemas::publish_schema_draft": frozenset({"SCHEMA_VERSION_CONFLICT"}),
    "sources::register_image_source": frozenset({"INVALID_NAME"}),
    "sources::register_video_source": frozenset({"CORRUPT_MEDIA", "UNSUPPORTED_MEDIA"}),
    "sources::start_ingest": frozenset({"BATCH_NOT_FOUND", "SOURCE_NOT_FOUND"}),
}


def shortfalls() -> dict[str, frozenset[str]]:
    """Every route whose docstring names a status and enumerates it short."""
    found: dict[str, frozenset[str]] = {}
    for module, node in route_functions():
        missing = missing_codes(ast.get_docstring(node) or "", reachable_codes(module, node)[0])
        if missing:
            found[f"{module.__name__.rsplit('.', 1)[-1]}::{node.name}"] = missing
    return found


def test_no_documented_status_is_enumerated_short() -> None:
    assert shortfalls() == KNOWN_SHORT, (
        "a published docstring names a status and not every refusal it can answer "
        "at that status; name the missing codes, or stop naming the status"
    )


def test_every_route_in_play_reaches_something_that_declares_what_it_raises() -> None:
    """A route this gate cannot see into must not read as one it has cleared."""
    unprovable = sorted(
        f"{module.__name__.rsplit('.', 1)[-1]}::{node.name}"
        for module, node in route_functions()
        if named_statuses(ast.get_docstring(node) or "") and not reachable_codes(module, node)[1]
    )
    assert unprovable == [], (
        "these routes document a refusal but call nothing that declares what it "
        "raises, so nothing here was proved; give the service or helper a Raises: block"
    )


def test_declared_raises_reads_a_block_and_stops_at_the_next_section() -> None:
    def documented() -> None:
        """One line.

        Raises:
            ProjectNotFound: no such project.
            AssetNotFound: no such asset in that project,
                on a continued line that names no class.

        Returns:
            SchemaNotFound: not a raise, and must not be read as one.
        """

    assert declared_raises(documented) == frozenset({"ProjectNotFound", "AssetNotFound"})


def test_declared_raises_separates_no_block_from_an_empty_one() -> None:
    def undocumented() -> None:
        """Says nothing about failure."""

    assert declared_raises(undocumented) is None


def test_named_statuses_counts_prose_and_codes_alike() -> None:
    assert named_statuses("a point off the asset is 422") == frozenset({422})
    assert named_statuses("409 `SCHEMA_VERSION_CONFLICT`") == frozenset({409})
    assert named_statuses("no failure here, and 200 is not a refusal") == frozenset()


def test_missing_codes_reports_a_status_enumerated_short() -> None:
    doc = "500 `INFERENCE_CONNECTION_NOT_RUNNABLE` and 500 `INFERENCE_OUT_OF_MEMORY`."
    reachable = frozenset(
        {
            "INFERENCE_CONNECTION_NOT_RUNNABLE",
            "INFERENCE_OUT_OF_MEMORY",
            "LOCAL_INFERENCE_UNAVAILABLE",
        }
    )
    assert missing_codes(doc, reachable) == frozenset({"LOCAL_INFERENCE_UNAVAILABLE"})


def test_missing_codes_ignores_statuses_the_docstring_never_put_in_play() -> None:
    doc = "409 `INFERENCE_CONNECTION_NOT_SET_UP` and nothing else."
    reachable = frozenset({"INFERENCE_CONNECTION_NOT_SET_UP", "INFERENCE_OUT_OF_MEMORY"})
    assert missing_codes(doc, reachable) == frozenset()


def test_missing_codes_does_not_check_the_status_printed_beside_a_code() -> None:
    # `annotations.py` documents `ASSET_NOT_IN_JOB` as a 422 it overrides to,
    # while `ERROR_RULES` calls it a 404. Naming the code is what this asks for.
    doc = "422 `ASSET_NOT_IN_JOB`."
    assert missing_codes(doc, frozenset({"ASSET_NOT_IN_JOB"})) == frozenset()


def test_route_functions_finds_the_published_routes() -> None:
    names = {node.name for _, node in route_functions()}
    assert "suggest_region" in names
    assert "publish_schema_draft" in names
    # A module-level helper is not a route, however many errors it raises.
    assert "_require" not in names


def test_reachable_codes_resolves_a_re_exported_service_function() -> None:
    # `suggest` is imported into the route module from `visionset.inference`,
    # not from the module that defines it: resolution has to follow the name the
    # route actually uses, which is what `getattr` on the module does.
    codes, sources = reachable_codes(*_route("suggest_region"))
    assert "LOCAL_INFERENCE_UNAVAILABLE" in codes
    assert "UNSUPPORTED_PROMPT" in codes
    assert "suggest" in sources


def test_reachable_codes_resolves_a_service_method_through_a_local() -> None:
    # `ingest = IngestService(workspace)` then `ingest.asset(...)`.
    codes, _sources = reachable_codes(*_route("get_asset_thumbnail"))
    assert "ASSET_NOT_FOUND" in codes
    assert "THUMBNAIL_NOT_CACHED" in codes


def test_reachable_codes_counts_an_error_raised_in_the_route_itself() -> None:
    codes, _sources = reachable_codes(*_route("get_schema_draft"))
    assert "SCHEMA_DRAFT_NOT_FOUND" in codes
