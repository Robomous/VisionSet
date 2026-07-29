"""``--json`` and the REST API publish the same shape for the same concept.

The two packages may not import each other — import-linter's independence
contract — so nothing enforces the agreement from inside ``src/``. A test can:
``tests/`` is outside the ``visionset`` package, so this module imports both
``visionset.cli._json`` and ``visionset.server.models`` and asserts, per pair:

1. the projection's keys are exactly the wire model's fields;
2. the wire model *validates* the projection — which catches encoding drift a
   key-set comparison cannot see, chiefly a timestamp in the wrong format or a
   UUID handed over as an object;
3. the projection is JSON-serializable with no ``default=``, so a leaf somebody
   forgot to encode is a ``TypeError`` here rather than a silent ``str()``.

Two projections are deliberately ungated, and named at the bottom: the CLI
defines those shapes first because no route publishes them.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import BaseModel
from tests.fixtures.samples import (
    ASSET,
    BATCH,
    COUNTS,
    EXPORT_RESULT,
    INGEST_FAILURE,
    INGEST_JOB,
    JOB,
    PROJECT,
    RELEASE,
    SCHEMA_VERSION,
    SOURCE,
    SPLIT,
    THUMBNAIL_BACKFILL,
    VERIFICATION,
)

from visionset.cli import _json
from visionset.formats._dummy import DummyExporter
from visionset.server import models

# One row per pair: a label, the projected payload, and the wire model it must
# agree with. Built eagerly — every projection runs at import, so a leaf that
# does not encode fails collection rather than one parametrized case.
PAIRS: list[tuple[str, dict[str, Any], type[BaseModel]]] = [
    ("project", _json.project(PROJECT), models.ProjectOut),
    ("schema_version", _json.schema_version(SCHEMA_VERSION), models.SchemaVersionOut),
    ("label_class", _json.label_class(SCHEMA_VERSION.classes[0]), models.LabelClassBody),
    (
        "attribute",
        _json.attribute(SCHEMA_VERSION.classes[0].attributes[0]),
        models.AttributeBody,
    ),
    ("source", _json.source(SOURCE), models.SourceOut),
    ("video_provenance", _json.video_provenance(SOURCE.require_video()), models.VideoProvenanceOut),
    ("ingest_job", _json.ingest_job(INGEST_JOB), models.IngestJobOut),
    ("ingest_failure", _json.ingest_failure(INGEST_FAILURE), models.IngestFailureOut),
    ("asset", _json.asset(ASSET), models.AssetOut),
    ("progress_counts", _json.progress_counts(COUNTS), models.ProgressCounts),
    ("batch", _json.batch(BATCH, COUNTS), models.BatchOut),
    ("job", _json.job(JOB, batch_id=BATCH.id), models.JobOut),
    ("release", _json.release(RELEASE), models.ReleaseOut),
    ("split_recipe", _json.split_recipe(SPLIT), models.SplitRecipeBody),
    (
        "release_verification",
        _json.release_verification(VERIFICATION),
        models.ReleaseVerificationOut,
    ),
    ("export_format", _json.export_format(DummyExporter()), models.FormatOut),
]

IDS = [label for label, _, _ in PAIRS]


# --- parity with the wire models ---------------------------------------------


@pytest.mark.parametrize(("payload", "wire"), [(p, w) for _, p, w in PAIRS], ids=IDS)
def test_the_projection_publishes_exactly_the_fields_the_wire_model_does(
    payload: dict[str, Any], wire: type[BaseModel]
) -> None:
    assert set(payload) == set(wire.model_fields)


@pytest.mark.parametrize(("payload", "wire"), [(p, w) for _, p, w in PAIRS], ids=IDS)
def test_the_wire_model_accepts_the_projection_verbatim(
    payload: dict[str, Any], wire: type[BaseModel]
) -> None:
    # Stronger than key-set parity and one line: it is what proves a UUID left as
    # a string, an enum left as its value, and a timestamp in pydantic's own
    # format rather than the human one the columns use.
    wire.model_validate(payload)


@pytest.mark.parametrize("payload", [p for _, p, _ in PAIRS], ids=IDS)
def test_the_projection_serializes_with_no_default_encoder(payload: dict[str, Any]) -> None:
    json.dumps(payload)


# --- the envelope ------------------------------------------------------------


def test_a_listing_is_an_object_with_items_and_a_total() -> None:
    assert _json.page([{"id": "a"}, {"id": "b"}]) == {
        "items": [{"id": "a"}, {"id": "b"}],
        "total": 2,
    }


def test_an_empty_listing_is_still_an_object() -> None:
    # Never a bare array, and never a 404's moral equivalent: an empty collection
    # is a collection.
    assert _json.page([]) == {"items": [], "total": 0}


# --- the timestamp format the parity gate depends on -------------------------


def test_a_timestamp_keeps_its_microseconds_and_ends_in_z() -> None:
    # Deliberately *not* ``_output.moment``'s format, which stops at seconds. A
    # single shared helper would pass every key-set assertion above and fail the
    # round-trip one.
    when = datetime(2026, 7, 28, 12, 34, 56, 789012, tzinfo=UTC)
    assert _json._moment(when) == "2026-07-28T12:34:56.789012Z"


# --- the two shapes with no wire partner -------------------------------------


@pytest.mark.parametrize(
    "payload",
    [_json.export_result(EXPORT_RESULT), _json.thumbnail_backfill(THUMBNAIL_BACKFILL)],
    ids=["export_result", "thumbnail_backfill"],
)
def test_a_cli_defined_shape_still_serializes(payload: dict[str, Any]) -> None:
    # No route publishes either, so there is nothing to be parity-gated against.
    # What still has to hold is that every leaf is encoded — which is the failure
    # these two would otherwise be free to have.
    json.dumps(payload)
