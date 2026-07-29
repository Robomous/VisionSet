"""The Python half of the annotator's wire gate.

`tests/fixtures/wire_annotations.json` is a committed artifact, and the only
thing that carries the geometry contract across the language boundary: the
`frontend` CI job installs no Python and reads what is in the repository.

So it needs two independent links, the shape `openapi.json` and its generated
client already have. This module is the first — the fixture is the
application's own output. The second is
`frontend/annotator/src/core/wire.test.ts`, which proves the TypeScript mirror
parses what this file contains.

Duplicating the regeneration in a test rather than leaving it to CI is
deliberate, for `test_the_committed_openapi_matches_the_application`'s reason:
this one fails during `uv run pytest`, in the command a contributor was already
running, instead of ten minutes later on a push.
"""

import json
from pathlib import Path
from typing import Any

from scripts.export_wire_fixtures import OUTPUT_PATH, build_fixture

from visionset.kernel.domain import IMPLEMENTED_GEOMETRIES, GeometryType

REPO_ROOT = Path(__file__).resolve().parents[2]


def committed() -> dict[str, Any]:
    payload: dict[str, Any] = json.loads((REPO_ROOT / OUTPUT_PATH).read_text())
    return payload


def test_the_committed_fixture_matches_the_application() -> None:
    assert committed() == build_fixture(), (
        "tests/fixtures/wire_annotations.json is stale — run "
        "`uv run python scripts/export_wire_fixtures.py` and commit the result."
    )


def test_the_fixture_names_every_geometry_the_domain_can_address() -> None:
    """The vocabulary, all eight — what a LabelClass may declare.

    The TypeScript side asserts its own `GEOMETRY_TYPES` equals this list, so a
    member added to the enum reaches the annotator as a failing test rather than
    as a payload it silently cannot describe.
    """
    assert committed()["geometry_types"] == sorted(g.value for g in GeometryType)


def test_the_fixture_names_exactly_the_geometries_an_annotation_can_carry() -> None:
    """The three with a model, told apart from the five that are roadmap.

    That distinction is the whole reason the annotator declares two lists: it is
    what lets `parseGeometry` refuse `polyline` as "not yet" rather than as a
    typo, and it is the answer #48 inherits about the polyline specs.
    """
    assert committed()["implemented_geometry_types"] == sorted(
        g.value for g in IMPLEMENTED_GEOMETRIES
    )


def test_every_carryable_geometry_appears_in_an_annotation() -> None:
    """Otherwise the fixture goes stale in silence when a fourth variant lands.

    A new geometry would widen `implemented_geometry_types` and leave the
    annotations untouched, so the TypeScript parser would never be handed one —
    the gate would stay green over a variant nothing had tried to parse.
    """
    payload = committed()
    carried = {a["geometry"]["type"] for a in payload["annotations"]}
    assert carried == set(payload["implemented_geometry_types"])


def test_a_polygon_point_is_a_pair_and_not_an_object() -> None:
    """The drift this whole gate exists for, pinned on the Python side too.

    The TypeScript mirror said `{x, y}` and the wire has always said `[x, y]`.
    Asserting it here as well means the fixture cannot quietly acquire the shape
    the annotator was wrong about.
    """
    polygons = [
        a["geometry"] for a in committed()["annotations"] if a["geometry"]["type"] == "polygon"
    ]
    assert polygons, "no polygon in the fixture"
    for polygon in polygons:
        for point in polygon["points"]:
            assert isinstance(point, list)
            assert len(point) == 2
            assert all(isinstance(coordinate, float) for coordinate in point)
