"""Export kernel-produced payloads to tests/fixtures/wire_annotations.json.

The committed fixture is how the TypeScript annotator proves its hand-written
mirror of the wire contract still matches this one. It cannot read the Python
models, and `frontend/annotator` must not depend on `@visionset/ui-core` to
reach the generated client — that package carries `openapi-fetch` as a runtime
dependency, and the annotator's contract is "no HTTP, no fetching". So the
contract travels as bytes, the way `openapi.json` already does.

Two gates, sharing no toolchain, exactly like the spec and its client:
`tests/server/test_wire_fixtures.py` keeps this file matching the application;
`frontend/annotator/src/core/wire.test.ts` keeps the TypeScript matching this
file. The frontend CI job installs no Python and reads only what is committed.

It carries **the three inputs an annotator document is built from** — an asset, a
schema and the annotations on that asset — rather than annotations alone, because
the document takes a schema as typed input and a hand-written TypeScript schema
fixture would be the second spelling this whole arrangement exists to prevent.
The filename stays `wire_annotations.json`: renaming a committed artifact for
tidiness would churn three paths for nothing.

Usage: uv run python scripts/export_wire_fixtures.py
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, get_args
from uuid import NAMESPACE_URL, UUID, uuid5

REPO_ROOT = Path(__file__).resolve().parent.parent

# The samples live in `tests/` and stay there — they are test fixtures, not part
# of the distribution — so reaching them from a script needs the repo root on the
# path. Under pytest `pythonpath = ["."]` has already put it there.
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tests.fixtures.samples import ANNOTATION, ASSET, GEOMETRIES, SCHEMA_VERSION  # noqa: E402

from visionset.kernel.domain import (  # noqa: E402
    IMPLEMENTED_GEOMETRIES,
    Annotation,
    AnnotationSchema,
    Attribute,
    GeometryType,
    LabelClass,
    SchemaProvenance,
)
from visionset.server.models import AnnotationOut, AssetOut, SchemaVersionOut  # noqa: E402

OUTPUT_PATH = "tests/fixtures/wire_annotations.json"

# `Annotation.id` defaults to `uuid4()` and `samples.ASSET.id` is one too, so
# reusing them verbatim would make this file different on every run and the
# drift gate would fail for a reason nobody chose. Derived rather than typed out,
# so "these are fixed deliberately" is structural.
_ASSET_ID = uuid5(NAMESPACE_URL, "visionset/wire-fixture/asset")
_PROJECT_ID = uuid5(NAMESPACE_URL, "visionset/wire-fixture/project")
_SOURCE_ID = uuid5(NAMESPACE_URL, "visionset/wire-fixture/source")


def _annotation_id(name: str) -> UUID:
    return uuid5(NAMESPACE_URL, f"visionset/wire-fixture/annotation/{name}")


def _schema() -> AnnotationSchema:
    """One class per carryable geometry, and every optional field in both states.

    ``samples.SCHEMA_VERSION``'s single class is fully populated — a colour and a
    ``select`` attribute carrying options and a default — so it proves the
    populated half. The other two exist for the empty half: a mirror where
    ``color`` is never null and ``attributes`` is never empty leaves those
    branches unparsed, which is the same gap the "bare" annotation below closes.

    One class per geometry is not decoration either: an annotator picks a class
    and gets a geometry, so each tool needs one to draw with.

    ``description``, ``created_at`` and ``provenance`` are populated rather than
    left null for the reason the classes are: a fixture carrying ``null`` in a
    nullable field proves the mirror can parse ``null`` and nothing else. The null
    half is covered by ``wire.test.ts``, which is where a hand-written payload
    belongs. The moment is a fixed literal, never ``now()`` — this file is
    committed and diffed, so a clock in it would make every regeneration a change.
    """
    populated = SCHEMA_VERSION.classes[0]
    # Two geometries, so the mirror's parser is exercised on a real set rather
    # than on a list that happens to hold one — a reader dropping everything
    # after the first element would pass against a singleton everywhere.
    assert populated.geometries == (GeometryType.BBOX, GeometryType.POLYGON), (
        "the sample class is the multi-geometry one"
    )
    return AnnotationSchema(
        project_id=_PROJECT_ID,
        version=SCHEMA_VERSION.version,
        description="the fixture's contract: one class per carryable geometry",
        created_at=datetime(2026, 8, 2, 12, 34, 56, 789012, tzinfo=UTC),
        provenance=SchemaProvenance.CURATED,
        classes=(
            populated,
            # No colour, no attributes. A renderer must choose its own colour for
            # this one, and the parser must accept the keys being absent.
            LabelClass(name="lane", geometries=(GeometryType.POLYGON,)),
            # A geometry a class can declare with no drawing tool behind it is a
            # fact about the annotator rather than about the wire — so it appears
            # here exactly like the other three.
            LabelClass(name="centerline", geometries=(GeometryType.POLYLINE,), color="#eb5a47"),
            # An attribute with every optional at its default: not required, no
            # options, no default. `select` is the only kind that may carry
            # options, so this is the other side of `populated`'s attribute.
            LabelClass(
                name="weather",
                geometries=(GeometryType.CLASSIFICATION_TAG,),
                color="#00ff00",
                attributes=(Attribute(name="note", kind="string"),),
            ),
        ),
    )


def build_fixture() -> dict[str, Any]:
    """The payload, as a pure function of the models. Imported by the gate."""
    annotations = [
        # One per implemented geometry: four components on the wire, and a
        # mirror that dropped `points` would still round-trip through the bbox.
        Annotation(
            id=_annotation_id(geometry.type.value),
            asset_id=_ASSET_ID,
            label_class=ANNOTATION.label_class,
            schema_version=ANNOTATION.schema_version,
            geometry=geometry,
            attributes=dict(ANNOTATION.attributes),
            provenance=ANNOTATION.provenance,
            model_ref=ANNOTATION.model_ref,
            confidence=ANNOTATION.confidence,
        )
        for geometry in GEOMETRIES
    ]
    # And one with every nullable field null and no attributes, so the mirror's
    # `string | null` and its empty-object case are both exercised. A fixture
    # where nothing is ever null leaves half of each optional field unproven.
    annotations.append(
        Annotation(
            id=_annotation_id("bare"),
            asset_id=_ASSET_ID,
            label_class=ANNOTATION.label_class,
            schema_version=1,
            geometry=GEOMETRIES[0],
            attributes={},
            provenance="human",
            model_ref=None,
            confidence=None,
        )
    )
    # `samples.ASSET` carries three `uuid4()`s, so they are pinned to derived ones
    # for the reason `_ASSET_ID` exists. Everything else — the dimensions the
    # annotator needs, the format, the frame provenance — is the sample's.
    asset = ASSET.model_copy(
        update={"id": _ASSET_ID, "project_id": _PROJECT_ID, "source_id": _SOURCE_ID}
    )
    return {
        # Built through the server's wire models, not `visionset.wire`: the
        # annotator talks HTTP, and these are what `openapi.json` is generated
        # from, so this fixture and the generated client cannot disagree about a
        # field name.
        "annotations": [AnnotationOut.of(a).model_dump(mode="json") for a in annotations],
        "asset": AssetOut.of(asset).model_dump(mode="json"),
        "schema": SchemaVersionOut.of(_schema()).model_dump(mode="json"),
        # The four `Attribute.kind` values, read off the model rather than typed
        # out — the `geometry_types` bargain, so a fifth kind reaches the
        # annotator as a failing test instead of as a payload it cannot describe.
        "attribute_kinds": sorted(get_args(Attribute.model_fields["kind"].annotation)),
        "geometry_types": sorted(g.value for g in GeometryType),
        "implemented_geometry_types": sorted(g.value for g in IMPLEMENTED_GEOMETRIES),
    }


def main() -> None:
    out = REPO_ROOT / OUTPUT_PATH
    out.write_text(json.dumps(build_fixture(), indent=2, sort_keys=True) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
