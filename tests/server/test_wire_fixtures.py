"""The Python half of the annotator's wire gate.

`tests/fixtures/wire_annotations.json` is a committed artifact, and the only
thing that carries the wire contract across the language boundary: the
`frontend` CI job installs no Python and reads what is in the repository. Since
it carries the three inputs an annotator document is built from — an asset, a
schema and the annotations on that asset — not annotations alone.

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
from typing import Any, get_args

from scripts.export_wire_fixtures import OUTPUT_PATH, build_fixture

from visionset.kernel.domain import IMPLEMENTED_GEOMETRIES, Attribute, GeometryType

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
    typo, and it is the answer the browser suite inherits about the polyline specs.
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


def test_the_fixture_names_every_attribute_kind_the_domain_accepts() -> None:
    """The other vocabulary the annotator mirrors, on `geometry_types`' terms.

    `Attribute.kind` is a `Literal`, not an enum, and the wire model spells it
    inline — so nothing structural ties the annotator's union to
    it. This is what does.
    """
    assert committed()["attribute_kinds"] == sorted(
        get_args(Attribute.model_fields["kind"].annotation)
    )


def test_the_schema_declares_one_class_per_carryable_geometry() -> None:
    """A class an annotator can actually draw with, for each of the three.

    Without this the schema could drift to bbox-only and the polygon and
    classification tools would each have to invent their own fixture — which is
    how two spellings of a contract start.
    """
    payload = committed()
    declared = {c["geometry"] for c in payload["schema"]["classes"]}
    assert declared == set(payload["implemented_geometry_types"])


def test_the_schema_exercises_both_states_of_every_optional_field() -> None:
    """`color`, `attributes`, `options` and `default` all default on the wire.

    A mirror handed only populated values leaves the null branch of each one
    unparsed, which is the gap the "bare" annotation already closes on the other
    half of this fixture.
    """
    classes = committed()["schema"]["classes"]
    assert {c["color"] is None for c in classes} == {True, False}
    assert {len(c["attributes"]) == 0 for c in classes} == {True, False}
    attributes = [a for c in classes for a in c["attributes"]]
    assert {a["options"] is None for a in attributes} == {True, False}
    assert {a["default"] is None for a in attributes} == {True, False}


def test_the_asset_states_the_frame_its_annotations_are_measured_in() -> None:
    """`AssetOut.width`/`height` are `int | None`, and the annotator needs numbers.

    A pre-pipeline row has no dimensions, so the annotator refuses to build a
    document from one — geometry is in the asset's native pixels and there is no
    frame to be native to. The fixture must therefore carry a *measured* asset,
    or the TypeScript side would only ever exercise that refusal.
    """
    asset = committed()["asset"]
    assert isinstance(asset["width"], int)
    assert isinstance(asset["height"], int)


def test_every_annotation_belongs_to_the_fixture_asset() -> None:
    """The document's own invariant, so the round-trip fixture can satisfy it.

    An annotation whose `asset_id` is not the document's asset is refused by
    `createDocument`; a fixture mixing assets could not be loaded as one document.
    """
    payload = committed()
    assert {a["asset_id"] for a in payload["annotations"]} == {payload["asset"]["id"]}


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
