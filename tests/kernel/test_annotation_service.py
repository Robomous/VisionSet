"""AnnotationService: the one door to a label, and the schema it has to satisfy.

The progress sweep reads `ASSET_PROGRESS_TRANSITIONS` rather than restating it,
so `progress_after_annotating` cannot drift into a move the table forbids.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import text

from visionset.kernel import (
    AnnotationGeometryOutOfBounds,
    AnnotationNotFound,
    AnnotationNotFromModel,
    AssetNotInJob,
    AssetNotWritable,
    BatchNotInAnnotation,
    DisallowedGeometry,
    DuplicateClassificationTag,
    InvalidAnnotation,
    InvalidAttributeValue,
    JobFinished,
    JobNotFound,
    LabelClassNotInSchema,
    MissingRequiredAttribute,
    StaleWrite,
    UnknownAttribute,
)
from visionset.kernel.domain import (
    ASSET_PROGRESS_TRANSITIONS,
    Annotation,
    AnnotationJob,
    Asset,
    AssetProgress,
    Attribute,
    BatchState,
    BboxGeometry,
    ClassificationGeometry,
    GeometryType,
    LabelClass,
    PolygonGeometry,
    progress_after_annotating,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    JobService,
    ProjectService,
    SchemaService,
    WorkspaceService,
)

SIGN = LabelClass(
    name="sign",
    geometries=(GeometryType.BBOX,),
    attributes=(
        Attribute(name="occluded", kind="boolean", required=True),
        Attribute(name="weather", kind="select", options=("dry", "wet")),
    ),
)
LANE = LabelClass(name="lane", geometries=(GeometryType.POLYGON,))
KIOSK = LabelClass(
    name="kiosk",
    geometries=(GeometryType.CLASSIFICATION_TAG,),
    attributes=(
        Attribute(name="operator", kind="string"),
        Attribute(name="height", kind="number"),
        Attribute(name="lit", kind="boolean"),
        Attribute(name="condition", kind="select", options=("new", "worn")),
    ),
)
#: A class the project only learns about in schema version 2.
GHOST = LabelClass(name="ghost", geometries=(GeometryType.BBOX,))

UNANNOTATED = AssetProgress.UNANNOTATED
PRE_LABELED = AssetProgress.PRE_LABELED
ANNOTATED = AssetProgress.ANNOTATED
SKIPPED = AssetProgress.SKIPPED
REVIEW_PENDING = AssetProgress.REVIEW_PENDING
ACCEPTED = AssetProgress.ACCEPTED

#: The shortest legal walk from ``unannotated`` to each state.
_ROUTES: dict[AssetProgress, tuple[AssetProgress, ...]] = {
    UNANNOTATED: (),
    PRE_LABELED: (PRE_LABELED,),
    ANNOTATED: (ANNOTATED,),
    SKIPPED: (SKIPPED,),
    REVIEW_PENDING: (ANNOTATED, REVIEW_PENDING),
    ACCEPTED: (ANNOTATED, REVIEW_PENDING, ACCEPTED),
}

#: The same walks starting from ``annotated``, which is where an asset that
#: already carries labels sits. Only the settled states, because those are the
#: ones ``WRITABLE_PROGRESS`` refuses.
_ONWARD_FROM_ANNOTATED: dict[AssetProgress, tuple[AssetProgress, ...]] = {
    SKIPPED: (SKIPPED,),
    REVIEW_PENDING: (REVIEW_PENDING,),
    ACCEPTED: (REVIEW_PENDING, ACCEPTED),
}


def _box(asset_id: UUID, **overrides: Any) -> Annotation:
    """A valid ``sign``: a bbox carrying the one attribute that class requires."""
    fields: dict[str, Any] = {
        "asset_id": asset_id,
        "label_class": "sign",
        "schema_version": 1,
        "geometry": BboxGeometry(x=1.0, y=2.0, width=30.0, height=40.0),
        "attributes": {"occluded": False},
        "provenance": "human",
    }
    return Annotation(**{**fields, **overrides})


class Fixture:
    """A workspace with one three-asset batch, ready to be approved and worked."""

    def __init__(
        self,
        tmp_path: Path,
        name: str = "ws",
        *,
        assets: int = 3,
        classes: Sequence[LabelClass] = (SIGN, LANE, KIOSK),
        asset_width: int | None = None,
        asset_height: int | None = None,
    ) -> None:
        self.workspace = WorkspaceService.init(tmp_path / name)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.schemas = SchemaService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.project = ProjectService(self.workspace).create(f"{name}-project")
        self.schemas.create_version(self.project.id, list(classes))
        self.asset_width = asset_width
        self.asset_height = asset_height
        self.assets = [self._asset(f"{name}-{index}") for index in range(assets)]
        self.batch = self.batches.create(self.project.id, "first", self.assets)

    def _asset(self, seed: str) -> UUID:
        content_hash = self.workspace.blob_store.put(BytesIO(seed.encode()))
        with self.workspace.unit_of_work() as uow:
            return uow.assets.add(
                Asset(
                    project_id=self.project.id,
                    content_hash=content_hash,
                    uri=f"/tmp/{seed}.png",
                    width=self.asset_width,
                    height=self.asset_height,
                )
            ).id

    def approved(self) -> AnnotationJob:
        """Approve the batch into one job, and stop there — nobody opened it."""
        self.batches.approve(self.batch.id)
        return self.batches.jobs(self.batch.id)[0]

    def working(self) -> AnnotationJob:
        """Approve, open the batch, and start its one job: annotation can happen."""
        job = self.approved()
        self.batches.start(self.batch.id)
        self.jobs.start(job.id)
        return self.jobs.get(job.id)

    def close_the_batch(self, job: AnnotationJob) -> None:
        """Settle every asset, finish the job, and complete the batch."""
        for asset_id in self.assets:
            self.jobs.mark(job.id, asset_id, ANNOTATED)
        self.jobs.complete(job.id)
        self.batches.complete(self.batch.id)

    def asset_in(self, job: AnnotationJob, progress: AssetProgress, index: int = 0) -> UUID:
        """One asset, walked to ``progress`` through JobService's real moves."""
        asset_id = self.assets[index]
        for step in _ROUTES[progress]:
            self.jobs.mark(job.id, asset_id, step)
        return asset_id

    def settle(self, job: AnnotationJob, asset_id: UUID, progress: AssetProgress) -> None:
        """Walk an asset that already carries labels onward to a settled state."""
        for step in _ONWARD_FROM_ANNOTATED[progress]:
            self.jobs.mark(job.id, asset_id, step)

    def progress_of(self, job: AnnotationJob, asset_id: UUID) -> AssetProgress:
        return self.jobs.get(job.id).progress[asset_id]

    def close(self) -> None:
        self.workspace.close()


# --- reading ------------------------------------------------------------------


def test_an_annotation_comes_back_as_it_went_in(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    assert fixture.annotations.get(stored.id) == stored
    fixture.close()


def test_for_asset_lists_the_annotations_of_that_asset_alone(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    mine = fixture.annotations.add(job.id, [_box(fixture.assets[0]), _box(fixture.assets[0])])
    fixture.annotations.add(job.id, [_box(fixture.assets[1])])

    assert fixture.annotations.for_asset(job.id, fixture.assets[0]) == mine
    fixture.close()


def test_an_asset_nobody_has_labeled_yet_reads_as_empty(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    assert fixture.annotations.for_asset(job.id, fixture.assets[0]) == []
    fixture.close()


def test_reading_is_not_gated_on_the_batch_being_open(tmp_path: Path) -> None:
    """A label outlives the work that produced it; only writes need an open batch."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])
    fixture.close_the_batch(job)
    assert fixture.batches.get(fixture.batch.id).state is BatchState.COMPLETED

    assert fixture.annotations.get(stored.id) == stored
    assert fixture.annotations.for_asset(job.id, fixture.assets[0]) == [stored]
    fixture.close()


def test_an_unknown_job_or_asset_is_refused_on_read(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    with pytest.raises(JobNotFound):
        fixture.annotations.for_asset(uuid4(), fixture.assets[0])
    with pytest.raises(AssetNotInJob, match="fixed"):
        fixture.annotations.for_asset(job.id, uuid4())
    fixture.close()


# --- schema violations are a hard reject --------------------------------------


@pytest.mark.parametrize(
    ("overrides", "error", "match"),
    [
        pytest.param(
            {"label_class": "unicorn"},
            LabelClassNotInSchema,
            "not in schema version 1",
            id="class-not-in-the-version",
        ),
        pytest.param(
            {"label_class": "lane", "attributes": {}},
            DisallowedGeometry,
            "accepts polygon .* carries a bbox",
            id="geometry-the-class-did-not-declare",
        ),
        pytest.param(
            {"attributes": {}},
            MissingRequiredAttribute,
            "requires attribute 'occluded'",
            id="required-attribute-missing",
        ),
        pytest.param(
            {"attributes": {"occluded": False, "colour": "red"}},
            UnknownAttribute,
            "does not declare 'colour'",
            id="attribute-the-class-does-not-declare",
        ),
        pytest.param(
            {"attributes": {"occluded": "yes"}},
            InvalidAttributeValue,
            "is a boolean but got str",
            id="value-of-the-wrong-type",
        ),
        pytest.param(
            {"attributes": {"occluded": True, "weather": "foggy"}},
            InvalidAttributeValue,
            "'foggy' is not one of its options",
            id="select-value-outside-its-options",
        ),
    ],
)
def test_an_annotation_the_pinned_version_rejects_is_not_stored(
    tmp_path: Path, overrides: dict[str, Any], error: type[InvalidAnnotation], match: str
) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]

    with pytest.raises(error, match=match):
        fixture.annotations.add(job.id, [_box(asset_id, **overrides)])
    # one base for the family, so a surface answers 422 without naming five classes
    with pytest.raises(InvalidAnnotation):
        fixture.annotations.add(job.id, [_box(asset_id, **overrides)])

    assert fixture.annotations.for_asset(job.id, asset_id) == []
    assert fixture.progress_of(job, asset_id) is UNANNOTATED
    fixture.close()


def test_the_geometry_rule_is_per_class_not_the_versions_union(tmp_path: Path) -> None:
    """The version allows polygons — but not under a class that accepts only bboxes."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    assert fixture.schemas.allowed_geometries(fixture.project.id) >= {
        GeometryType.BBOX,
        GeometryType.POLYGON,
    }

    with pytest.raises(DisallowedGeometry, match="accepts bbox .* carries a polygon"):
        fixture.annotations.add(
            job.id,
            [
                _box(
                    fixture.assets[0],
                    geometry=PolygonGeometry(points=[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]),
                )
            ],
        )
    fixture.close()


def test_add_refuses_a_box_wholly_outside_a_measured_asset(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, asset_width=100, asset_height=80)
    job = fixture.working()

    with pytest.raises(AnnotationGeometryOutOfBounds) as raised:
        fixture.annotations.add(
            job.id,
            [_box(fixture.assets[0], geometry=BboxGeometry(x=101, y=20, width=5, height=5))],
        )

    assert raised.value.index == 0
    assert fixture.annotations.for_asset(job.id, fixture.assets[0]) == []
    assert fixture.progress_of(job, fixture.assets[0]) is UNANNOTATED
    fixture.close()


def test_add_accepts_a_box_partially_overlapping_a_measured_asset(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, asset_width=100, asset_height=80)
    job = fixture.working()

    stored = fixture.annotations.add(
        job.id,
        [_box(fixture.assets[0], geometry=BboxGeometry(x=99, y=20, width=5, height=5))],
    )

    assert len(stored) == 1
    fixture.close()


def test_add_accepts_a_box_outside_an_unmeasured_asset(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()

    stored = fixture.annotations.add(
        job.id,
        [_box(fixture.assets[0], geometry=BboxGeometry(x=101, y=20, width=5, height=5))],
    )

    assert len(stored) == 1
    fixture.close()


def test_add_rolls_back_when_its_second_box_is_outside_a_measured_asset(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, asset_width=100, asset_height=80)
    job = fixture.working()

    with pytest.raises(AnnotationGeometryOutOfBounds) as raised:
        fixture.annotations.add(
            job.id,
            [
                _box(fixture.assets[0]),
                _box(fixture.assets[1], geometry=BboxGeometry(x=101, y=20, width=5, height=5)),
            ],
        )

    assert raised.value.index == 1
    for asset_id in fixture.assets[:2]:
        assert fixture.annotations.for_asset(job.id, asset_id) == []
        assert fixture.progress_of(job, asset_id) is UNANNOTATED
    fixture.close()


def test_update_refuses_replacement_geometry_outside_the_stored_asset(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, asset_width=100, asset_height=80)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    with pytest.raises(AnnotationGeometryOutOfBounds) as raised:
        fixture.annotations.update(
            job.id,
            [stored.model_copy(update={"geometry": BboxGeometry(x=101, y=20, width=5, height=5)})],
        )

    assert raised.value.index == 0
    assert fixture.annotations.get(stored.id) == stored
    fixture.close()


def test_enter_unreviewed_refuses_a_model_box_outside_a_measured_asset(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, asset_width=100, asset_height=80)
    job = fixture.working()

    with pytest.raises(AnnotationGeometryOutOfBounds) as raised:
        fixture.annotations.enter_unreviewed(
            job.id,
            [
                _box(
                    fixture.assets[0],
                    geometry=BboxGeometry(x=101, y=20, width=5, height=5),
                    provenance="model",
                    model_ref="model-v1",
                )
            ],
        )

    assert raised.value.index == 0
    assert fixture.annotations.for_asset(job.id, fixture.assets[0]) == []
    assert fixture.progress_of(job, fixture.assets[0]) is UNANNOTATED
    fixture.close()


#: One class, two shapes. The whole point of #584: a sign photographed close up is
#: worth outlining and one at the end of the street is worth boxing, and they are
#: the same class.
BOTH = LabelClass(
    name="sign",
    geometries=(GeometryType.BBOX, GeometryType.POLYGON),
    attributes=(Attribute(name="occluded", kind="boolean", required=True),),
)


def test_a_class_accepting_two_geometries_accepts_either_of_them(tmp_path: Path) -> None:
    """Both, in one call, under one class — which is the feature.

    Written as one `add` rather than two so the all-or-nothing write is exercised
    too: a gate that admitted the box and refused the polygon would store neither
    and this would fail on the count rather than on the refusal.
    """
    fixture = Fixture(tmp_path, classes=(BOTH,))
    job = fixture.working()

    stored = fixture.annotations.add(
        job.id,
        [
            _box(fixture.assets[0]),
            _box(
                fixture.assets[0],
                geometry=PolygonGeometry(points=[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]),
            ),
        ],
    )

    assert [one.geometry.type for one in stored] == [GeometryType.BBOX, GeometryType.POLYGON]
    fixture.close()


def test_a_class_accepting_two_geometries_still_refuses_a_third(tmp_path: Path) -> None:
    """Membership, not "anything goes" — the half a widened gate loses silently."""
    fixture = Fixture(tmp_path, classes=(BOTH,))
    job = fixture.working()

    with pytest.raises(DisallowedGeometry, match="accepts bbox, polygon"):
        fixture.annotations.add(
            job.id,
            [_box(fixture.assets[0], geometry=ClassificationGeometry(), attributes={})],
        )
    assert fixture.annotations.for_asset(job.id, fixture.assets[0]) == []
    fixture.close()


def test_an_optional_attribute_may_simply_be_absent(tmp_path: Path) -> None:
    """`required` and `default` are independent — nothing is filled in for you."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    assert stored.attributes == {"occluded": False}
    fixture.close()


def test_a_class_with_no_attributes_takes_none(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    lane = Annotation(
        asset_id=fixture.assets[0],
        label_class="lane",
        schema_version=1,
        geometry=PolygonGeometry(points=[(0.0, 0.0), (4.0, 0.0), (4.0, 4.0)]),
        provenance="human",
    )
    (stored,) = fixture.annotations.add(job.id, [lane])

    assert stored.attributes == {}
    fixture.close()


def test_an_annotation_naming_an_asset_outside_the_job_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    with pytest.raises(AssetNotInJob, match="fixed"):
        fixture.annotations.add(job.id, [_box(uuid4())])
    fixture.close()


# --- provenance is the model's own rule, never the service's ------------------


def test_a_model_annotation_without_a_model_ref_cannot_be_built() -> None:
    """It never reaches a service, which is why there is no `InvalidProvenance`."""
    with pytest.raises(ValidationError, match="model_ref"):
        _box(uuid4(), provenance="model")

    assert _box(uuid4(), provenance="model", model_ref="yolo@3").model_ref == "yolo@3"


@pytest.mark.parametrize("confidence", [-0.1, 1.5])
def test_a_confidence_outside_the_unit_interval_cannot_be_built(confidence: float) -> None:
    with pytest.raises(ValidationError):
        _box(uuid4(), confidence=confidence)


# --- identity: the id is the annotation's, the version is the batch's ---------


def test_the_id_is_generated_server_side_and_echoed_back(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    proposed = _box(fixture.assets[0])
    (stored,) = fixture.annotations.add(job.id, [proposed])

    assert stored.id == proposed.id
    assert fixture.annotations.get(stored.id).id == stored.id
    fixture.close()


def test_the_stored_version_is_the_batch_pin_not_the_projects_active_one(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    # **A narrowing version, and it has to be**: an additive one now moves this
    # batch's pin onto it (#381), so the divergence this test is about would not
    # exist. Dropping `kiosk` while adding `ghost` is destructive, so the pin stays
    # where it was and the two versions genuinely differ — which is the only state
    # in which "the pin judges, not the active version" is a claim at all.
    fixture.schemas.create_version(fixture.project.id, [SIGN, LANE, GHOST], allow_destructive=True)
    assert fixture.schemas.get_active(fixture.project.id).version == 2
    assert fixture.batches.get(fixture.batch.id).schema_version == 1

    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0], schema_version=99)])
    assert stored.schema_version == 1
    assert fixture.annotations.get(stored.id).schema_version == 1

    # and the pin is what judges, too: a class only version 2 knows is refused
    with pytest.raises(LabelClassNotInSchema, match="version 1"):
        fixture.annotations.add(
            job.id, [_box(fixture.assets[1], label_class="ghost", attributes={})]
        )
    fixture.close()


def test_update_addresses_by_uuid_and_keeps_the_stored_asset(tmp_path: Path) -> None:
    """Moving a label to another asset is a delete and an add, never an edit."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    (replaced,) = fixture.annotations.update(
        job.id,
        [
            _box(
                fixture.assets[1],  # ignored: the stored asset wins
                id=stored.id,
                geometry=BboxGeometry(x=9.0, y=9.0, width=1.0, height=1.0),
                attributes={"occluded": True},
            )
        ],
    )

    assert replaced.id == stored.id
    assert replaced.asset_id == fixture.assets[0]
    assert replaced.attributes == {"occluded": True}
    assert fixture.annotations.for_asset(job.id, fixture.assets[1]) == []
    assert fixture.annotations.for_asset(job.id, fixture.assets[0]) == [replaced]
    fixture.close()


def test_an_update_the_version_rejects_leaves_the_stored_one_alone(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    with pytest.raises(InvalidAttributeValue):
        fixture.annotations.update(
            job.id, [_box(fixture.assets[0], id=stored.id, attributes={"occluded": 3.0})]
        )
    assert fixture.annotations.get(stored.id) == stored
    fixture.close()


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_an_id_that_is_not_stored_is_refused(tmp_path: Path, operation: str) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    stranger = uuid4()

    with pytest.raises(AnnotationNotFound, match="no annotation"):
        if operation == "update":
            fixture.annotations.update(job.id, [_box(fixture.assets[0], id=stranger)])
        else:
            fixture.annotations.delete(job.id, [stranger])
    fixture.close()


def test_an_annotation_from_another_workspace_reads_as_missing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    stranger = Fixture(tmp_path, "two")
    theirs_job = stranger.working()
    (theirs,) = stranger.annotations.add(theirs_job.id, [_box(stranger.assets[0])])

    with pytest.raises(AnnotationNotFound):
        fixture.annotations.get(theirs.id)
    fixture.close()
    stranger.close()


# --- progress follows the annotations, and only for three of its states ------


@pytest.mark.parametrize("has_annotations", [True, False], ids=["with", "without"])
@pytest.mark.parametrize("current", list(AssetProgress), ids=lambda s: f"from-{s.value}")
def test_every_move_annotating_can_make_is_one_the_table_allows(
    current: AssetProgress, has_annotations: bool
) -> None:
    """Read against `ASSET_PROGRESS_TRANSITIONS`, so the rule cannot drift from it."""
    target = progress_after_annotating(current, has_annotations=has_annotations)
    if target is None:
        return
    assert target in ASSET_PROGRESS_TRANSITIONS[current]


def test_annotations_only_ever_move_the_states_they_are_evidence_of() -> None:
    """The other three are people's decisions, and stay with `JobService.mark`."""
    moved = {
        current
        for current in AssetProgress
        for has in (True, False)
        if progress_after_annotating(current, has_annotations=has) is not None
    }
    assert moved == {UNANNOTATED, ANNOTATED, PRE_LABELED}


def test_the_first_annotation_moves_the_asset_to_annotated(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    assert fixture.progress_of(job, fixture.assets[0]) is UNANNOTATED

    fixture.annotations.add(job.id, [_box(fixture.assets[0])])
    assert fixture.progress_of(job, fixture.assets[0]) is ANNOTATED
    fixture.close()


def test_deleting_the_last_annotation_moves_it_back(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    assert fixture.annotations.delete(job.id, [stored.id]) == 1
    assert fixture.progress_of(job, fixture.assets[0]) is UNANNOTATED
    fixture.close()


def test_deleting_one_of_two_leaves_the_asset_annotated(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    first, _second = fixture.annotations.add(
        job.id, [_box(fixture.assets[0]), _box(fixture.assets[0])]
    )

    fixture.annotations.delete(job.id, [first.id])
    assert fixture.progress_of(job, fixture.assets[0]) is ANNOTATED
    fixture.close()


def test_deleting_the_same_id_twice_in_one_call_is_one_deletion(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    assert fixture.annotations.delete(job.id, [stored.id, stored.id]) == 1
    fixture.close()


def test_updating_an_annotation_does_not_disturb_progress(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    fixture.annotations.update(
        job.id, [_box(fixture.assets[0], id=stored.id, attributes={"occluded": True})]
    )
    assert fixture.progress_of(job, fixture.assets[0]) is ANNOTATED
    fixture.close()


@pytest.mark.parametrize("decided", [SKIPPED, REVIEW_PENDING, ACCEPTED], ids=lambda s: str(s.value))
def test_a_decision_somebody_made_is_not_overwritten_by_a_label(
    tmp_path: Path, decided: AssetProgress
) -> None:
    """Skipping, submitting and accepting are people's calls, not consequences.

    The refusal is how that is held. Storing the label and leaving the progress
    alone was the older answer, and it was worse than it looked: nothing said the
    write had gone nowhere, and for ``skipped`` the labels were dropped again at
    promotion because ``PROMOTABLE_PROGRESS`` leaves that state out.
    """
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.asset_in(job, decided)

    with pytest.raises(AssetNotWritable) as refused:
        fixture.annotations.add(job.id, [_box(asset_id)])
    assert decided.value in str(refused.value)

    assert fixture.progress_of(job, asset_id) is decided
    assert fixture.annotations.for_asset(job.id, asset_id) == []
    fixture.close()


@pytest.mark.parametrize("decided", [SKIPPED, REVIEW_PENDING, ACCEPTED], ids=lambda s: str(s.value))
def test_labels_already_on_a_settled_asset_cannot_be_edited_or_removed(
    tmp_path: Path, decided: AssetProgress
) -> None:
    """The gate stands in front of all three writes, not only the one that adds.

    An asset reaches a settled state carrying labels — that is the ordinary way
    into ``review_pending`` and ``accepted`` — so update and delete are the two
    that a caller actually has something to aim at.
    """
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    (stored,) = fixture.annotations.add(job.id, [_box(asset_id)])
    fixture.settle(job, asset_id, decided)

    with pytest.raises(AssetNotWritable):
        fixture.annotations.update(
            job.id, [_box(asset_id, id=stored.id, attributes={"occluded": True})]
        )
    with pytest.raises(AssetNotWritable):
        fixture.annotations.delete(job.id, [stored.id])

    assert [a.id for a in fixture.annotations.for_asset(job.id, asset_id)] == [stored.id]
    fixture.close()


def test_taking_a_skip_back_makes_the_asset_writable_again(tmp_path: Path) -> None:
    """The refusal names a state, and the transition table is how a caller leaves it.

    ``skipped -> unannotated`` is the take-it-back edge, and it is the whole
    remedy for the one settled state that has one. ``accepted`` has no exit, which
    is why correcting that needs a new batch rather than a progress move.
    """
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.asset_in(job, SKIPPED)

    fixture.jobs.mark(job.id, asset_id, UNANNOTATED)
    (stored,) = fixture.annotations.add(job.id, [_box(asset_id)])

    assert fixture.progress_of(job, asset_id) is ANNOTATED
    assert [a.id for a in fixture.annotations.for_asset(job.id, asset_id)] == [stored.id]
    fixture.close()


def test_progress_keeps_the_stored_order_when_annotations_move_it(tmp_path: Path) -> None:
    """The dict is rewritten one key at a time, so `position` — and paging — hold."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    fixture.annotations.add(job.id, [_box(fixture.assets[1])])

    assert list(fixture.jobs.get(job.id).progress) == fixture.assets
    assert [a.id for a in fixture.jobs.next_pending(job.id, 9)] == [
        fixture.assets[0],
        fixture.assets[2],
    ]
    fixture.close()


# --- work only happens inside an open batch -----------------------------------


@pytest.mark.parametrize("closed", [False, True], ids=["approved-not-opened", "completed"])
def test_no_annotation_is_written_outside_an_open_batch(tmp_path: Path, closed: bool) -> None:
    fixture = Fixture(tmp_path)
    if closed:
        job = fixture.working()
        (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])
        fixture.close_the_batch(job)
    else:
        job = fixture.approved()
        stored = _box(fixture.assets[0])

    with pytest.raises(BatchNotInAnnotation, match="nobody opened"):
        fixture.annotations.add(job.id, [_box(fixture.assets[0])])
    with pytest.raises(BatchNotInAnnotation):
        fixture.annotations.update(job.id, [_box(fixture.assets[0], id=stored.id)])
    with pytest.raises(BatchNotInAnnotation):
        fixture.annotations.delete(job.id, [stored.id])
    fixture.close()


def test_the_batch_gate_fires_before_the_payload_is_looked_at(tmp_path: Path) -> None:
    """A write into a closed batch is a bug whether or not the payload is also wrong."""
    fixture = Fixture(tmp_path)
    job = fixture.approved()

    with pytest.raises(BatchNotInAnnotation):
        fixture.annotations.add(job.id, [_box(fixture.assets[0], label_class="unicorn")])
    with pytest.raises(BatchNotInAnnotation):
        fixture.annotations.delete(job.id, [uuid4()])
    fixture.close()


def test_no_annotation_is_written_into_a_finished_job(tmp_path: Path) -> None:
    """The gate the batch gate above cannot stand in for.

    `JobService.complete` does not complete the batch — `BatchService` derives
    that separately — so the ordinary state of a finished job is inside a batch
    that is still `in_annotation`. `require_open_batch` passes there, the asset's
    progress is `annotated` and therefore writable, and every one of these three
    calls used to be accepted: labels landing in work whose own record already
    said it was over, where nobody would look for them.
    """
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])
    for asset_id in fixture.assets:
        fixture.jobs.mark(job.id, asset_id, ANNOTATED)
    fixture.jobs.complete(job.id)
    assert fixture.batches.get(fixture.batch.id).state is BatchState.IN_ANNOTATION

    with pytest.raises(JobFinished, match="does not re-open"):
        fixture.annotations.add(job.id, [_box(fixture.assets[0])])
    with pytest.raises(JobFinished):
        fixture.annotations.update(job.id, [_box(fixture.assets[0], id=stored.id)])
    with pytest.raises(JobFinished):
        fixture.annotations.delete(job.id, [stored.id])

    # Nothing moved: the box that was there is still there, unchanged.
    assert [a.id for a in fixture.annotations.for_asset(job.id, fixture.assets[0])] == [stored.id]
    fixture.close()


def test_a_finished_job_still_reads_back_its_own_labels(tmp_path: Path) -> None:
    """Reading is not writing, and the read-only workspace depends on it.

    `_require_writable` is called by the three writes and never by `for_asset`,
    for exactly this reason — and the new job gate keeps that division: a viewer
    over finished work has to be able to show the work.
    """
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])
    for asset_id in fixture.assets:
        fixture.jobs.mark(job.id, asset_id, ANNOTATED)
    fixture.jobs.complete(job.id)

    assert [a.id for a in fixture.annotations.for_asset(job.id, fixture.assets[0])] == [stored.id]
    fixture.close()


# --- all or nothing -----------------------------------------------------------


def test_one_bad_annotation_stores_none_of_them(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()

    with pytest.raises(MissingRequiredAttribute):
        fixture.annotations.add(
            job.id,
            [_box(fixture.assets[0]), _box(fixture.assets[1], attributes={})],
        )

    assert fixture.annotations.for_asset(job.id, fixture.assets[0]) == []
    assert fixture.progress_of(job, fixture.assets[0]) is UNANNOTATED
    fixture.close()


def test_one_unknown_id_deletes_none_of_them(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    with pytest.raises(AnnotationNotFound):
        fixture.annotations.delete(job.id, [stored.id, uuid4()])

    assert fixture.annotations.for_asset(job.id, fixture.assets[0]) == [stored]
    assert fixture.progress_of(job, fixture.assets[0]) is ANNOTATED
    fixture.close()


# --- which one was at fault ---------------------------------------------------


def test_a_refusal_names_the_position_of_the_annotation_that_caused_it(tmp_path: Path) -> None:
    """Nothing was written, so the position is the only handle on the culprit."""
    fixture = Fixture(tmp_path)
    job = fixture.working()

    with pytest.raises(MissingRequiredAttribute) as refusal:
        fixture.annotations.add(
            job.id,
            [
                _box(fixture.assets[0]),
                _box(fixture.assets[1]),
                _box(fixture.assets[2], attributes={}),
            ],
        )

    assert refusal.value.index == 2
    fixture.close()


def test_the_position_is_the_callers_own_on_update(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    first, second = fixture.annotations.add(
        job.id, [_box(fixture.assets[0]), _box(fixture.assets[1])]
    )

    with pytest.raises(LabelClassNotInSchema) as refusal:
        fixture.annotations.update(
            job.id,
            [
                first.model_copy(update={"attributes": {"occluded": True}}),
                second.model_copy(update={"label_class": "ghost"}),
            ],
        )

    assert refusal.value.index == 1
    fixture.close()


def test_a_repeated_id_does_not_shift_the_position_a_deletion_blames(tmp_path: Path) -> None:
    """``[a, a, b]`` deduplicates to two, but ``b`` is still the caller's index 2."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])
    stranger = uuid4()

    with pytest.raises(AnnotationNotFound) as refusal:
        fixture.annotations.delete(job.id, [stored.id, stored.id, stranger])

    assert refusal.value.index == 2
    fixture.close()


def test_a_refusal_that_is_about_no_particular_item_has_no_position(tmp_path: Path) -> None:
    """The batch gate refuses the call, not one annotation in it."""
    fixture = Fixture(tmp_path)
    job = fixture.approved()

    with pytest.raises(BatchNotInAnnotation) as refusal:
        fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    assert refusal.value.index is None
    fixture.close()


# --- attribute values round-trip through the store ----------------------------


def test_every_attribute_kind_survives_a_close_and_a_reopen(tmp_path: Path) -> None:
    """Read back from a genuinely re-opened file, not from an in-memory copy."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    values: dict[str, Any] = {
        "operator": "city",
        "height": 2.5,
        "lit": True,
        "condition": "worn",
    }
    (stored,) = fixture.annotations.add(
        job.id,
        [
            Annotation(
                asset_id=fixture.assets[0],
                label_class="kiosk",
                schema_version=1,
                geometry=ClassificationGeometry(),
                attributes=values,
                provenance="human",
            )
        ],
    )
    root = fixture.workspace.root
    fixture.close()

    reopened = WorkspaceService.open(root)
    again = AnnotationService(reopened).get(stored.id)
    assert again.attributes == values
    assert again.geometry == ClassificationGeometry()
    reopened.close()


def test_a_row_written_without_attributes_reads_as_none_recorded(tmp_path: Path) -> None:
    """What migration 5 does to the annotations that were already on disk.

    Their column arrives by `ALTER TABLE`, and its `server_default` is what makes
    them mean "no values recorded" rather than break on the next read.
    """
    fixture = Fixture(tmp_path)
    fixture.working()
    legacy = uuid4()

    store = fixture.workspace.metadata_store
    with store.engine.begin() as connection:  # type: ignore[attr-defined]
        connection.execute(
            text(
                "insert into annotation (id, asset_id, label_class, schema_version, "
                "geometry, provenance) "
                "values (:id, :asset, 'lane', 1, :geometry, 'import')"
            ),
            {
                "id": legacy.hex,
                "asset": fixture.assets[0].hex,
                "geometry": '{"type": "polygon", "points": [[0, 0], [4, 0], [4, 4]]}',
            },
        )

    assert fixture.annotations.get(legacy).attributes == {}
    fixture.close()


# --- the loop closes ----------------------------------------------------------


def test_annotating_every_asset_carries_the_batch_to_completed(tmp_path: Path) -> None:
    """The M1 exit criterion in miniature: no `mark`, and nothing reaches past a service."""
    fixture = Fixture(tmp_path)
    job = fixture.working()

    for asset in fixture.jobs.next_pending(job.id, 99):
        fixture.annotations.add(job.id, [_box(asset.id)])

    assert fixture.jobs.job_progress(job.id)[ANNOTATED] == len(fixture.assets)
    assert fixture.jobs.complete(job.id).state.value == "completed"
    assert fixture.batches.complete(fixture.batch.id).state is BatchState.COMPLETED
    fixture.close()


# --- one tag per (asset, class) -----------------------------------------------


def _tag(asset_id: UUID, **overrides: Any) -> Annotation:
    """A valid ``kiosk``: the schema's one classification-tag class."""
    fields: dict[str, Any] = {
        "asset_id": asset_id,
        "label_class": "kiosk",
        "schema_version": 1,
        "geometry": ClassificationGeometry(),
        "provenance": "human",
    }
    return Annotation(**{**fields, **overrides})


def test_a_second_tag_of_the_same_class_on_one_asset_is_refused(tmp_path: Path) -> None:
    """A ``ClassificationGeometry`` has zero fields, so the second tag is the
    same statement made twice — not a second fact the way two boxes are."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    fixture.annotations.add(job.id, [_tag(asset_id)])

    with pytest.raises(DuplicateClassificationTag):
        fixture.annotations.add(job.id, [_tag(asset_id)])
    fixture.close()


def test_the_duplicate_is_caught_within_one_call_too(tmp_path: Path) -> None:
    """``add`` is all-or-nothing, so without the running set the index would refuse
    at commit time — where the ``index`` a caller is told about cannot be
    reconstructed."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]

    with pytest.raises(DuplicateClassificationTag) as refusal:
        fixture.annotations.add(job.id, [_tag(asset_id), _tag(asset_id)])
    # Blamed on the *second* position, which is the one that could not be honoured.
    assert refusal.value.index == 1
    # And nothing was written, because the call is one transaction.
    assert fixture.annotations.for_asset(job.id, asset_id) == []
    fixture.close()


def test_the_same_class_on_a_different_asset_is_a_different_statement(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    stored = fixture.annotations.add(job.id, [_tag(fixture.assets[0]), _tag(fixture.assets[1])])
    assert len(stored) == 2
    fixture.close()


def test_two_boxes_under_one_class_are_still_the_normal_case(tmp_path: Path) -> None:
    """Which is exactly why the index is partial rather than a rule about the
    table: a bbox carries coordinates, so two of them are two facts."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    stored = fixture.annotations.add(
        job.id,
        [
            _box(asset_id),
            _box(asset_id, geometry=BboxGeometry(x=90.0, y=90.0, width=5.0, height=5.0)),
        ],
    )
    assert len(stored) == 2
    fixture.close()


def test_an_update_may_leave_a_tag_exactly_where_it_is(tmp_path: Path) -> None:
    """The row being replaced is itself one of the stored ones, so judging a
    replacement against a set that still contains it would refuse every no-op."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (tag,) = fixture.annotations.add(job.id, [_tag(fixture.assets[0])])

    (same,) = fixture.annotations.update(job.id, [tag])
    assert same.label_class == "kiosk"
    fixture.close()


def test_an_update_cannot_collide_with_a_tag_already_there(tmp_path: Path) -> None:
    """Two classes, one asset, and a replacement that would make them one."""
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(
        fixture.project.id,
        [
            SIGN,
            LANE,
            KIOSK,
            LabelClass(name="booth", geometries=(GeometryType.CLASSIFICATION_TAG,)),
        ],
    )
    job = fixture.working()
    asset_id = fixture.assets[0]
    stored = fixture.annotations.add(job.id, [_tag(asset_id), _tag(asset_id, label_class="booth")])

    with pytest.raises(DuplicateClassificationTag):
        fixture.annotations.update(job.id, [stored[1].model_copy(update={"label_class": "kiosk"})])
    fixture.close()


# --- which round produced this label (audit G3) -------------------------------


def test_a_stored_annotation_records_the_job_it_was_written_in(tmp_path: Path) -> None:
    """The whole point of the column: a label knows which round produced it.

    An annotation hangs off its ``asset_id`` and nothing else, so before this the
    batch id travelled only on a transient event — and "which round of work made
    this box" had no answer anywhere once the event was gone.
    """
    fixture = Fixture(tmp_path)
    job = fixture.working()

    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    assert stored.job_id == job.id


def test_the_caller_cannot_claim_a_different_job(tmp_path: Path) -> None:
    """Stamped like ``schema_version``, and for the same reason.

    The service knows which round this is; the caller does not get to say
    otherwise. A field a client could set and never observe is a lie in the API.
    """
    fixture = Fixture(tmp_path)
    job = fixture.working()

    (stored,) = fixture.annotations.add(
        job.id, [_box(fixture.assets[0]).model_copy(update={"job_id": uuid4()})]
    )

    assert stored.job_id == job.id


def test_replacing_a_label_records_the_round_that_replaced_it(tmp_path: Path) -> None:
    """``job_id`` and ``asset_id`` go opposite ways on an update, on purpose.

    ``asset_id`` is preserved from the stored annotation, because moving a label
    to another asset is a delete and an add rather than an edit. ``job_id`` is
    stamped with the job doing the replacing, because it answers *which round
    produced the label as it now stands* — and a replacement is a thing this
    round produced. Preserving it would make the field mean "first written in",
    which goes stale the moment a correction round edits.
    """
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    (replaced,) = fixture.annotations.update(
        job.id, [stored.model_copy(update={"job_id": None, "label_class": SIGN.name})]
    )

    assert replaced.job_id == job.id
    assert replaced.asset_id == stored.asset_id


def test_it_survives_a_round_trip_through_the_store(tmp_path: Path) -> None:
    # The column is not a foreign key — `annotation` could not be rebuilt to give
    # it one — so nothing but this checks that it is written and read back.
    fixture = Fixture(tmp_path)
    job = fixture.working()
    (stored,) = fixture.annotations.add(job.id, [_box(fixture.assets[0])])

    (read_back,) = fixture.annotations.for_asset(job.id, stored.asset_id)

    assert read_back.job_id == job.id


def _prediction(asset_id: UUID, **overrides: Any) -> Annotation:
    """A valid ``sign`` a model produced: model provenance, ref and score."""
    fields: dict[str, Any] = {
        "provenance": "model",
        "model_ref": "acme/detector@abc123",
        "confidence": 0.62,
    }
    return _box(asset_id, **{**fields, **overrides})


def test_unreviewed_labels_land_pre_labeled_and_stay_editable(tmp_path: Path) -> None:
    """The labels and the move are one write, so neither can be seen alone."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]

    (stored,) = fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)])

    assert stored.provenance == "model"
    assert stored.model_ref == "acme/detector@abc123"
    assert fixture.progress_of(job, asset_id) is AssetProgress.PRE_LABELED
    # The point of the whole change: a person can correct it with no move first.
    fixture.annotations.add(job.id, [_box(asset_id)])
    assert fixture.progress_of(job, asset_id) is AssetProgress.ANNOTATED
    fixture.close()


def test_a_pre_labeled_asset_is_not_a_second_run_s_target(tmp_path: Path) -> None:
    """`enter_unreviewed` still only ever writes onto untouched assets."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)])

    with pytest.raises(AssetNotWritable):
        fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)])
    fixture.close()


def test_a_failure_inside_the_call_leaves_neither_labels_nor_a_move(tmp_path: Path) -> None:
    """The crash window the composition would have: labels at ``annotated``.

    Provoked at the last possible moment — the progress write — so the labels are
    already in the session when it fails. Both must roll back, or the asset is
    left carrying unreviewed labels at a state that claims somebody wrote them.
    """
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    service = AnnotationService(fixture.workspace)

    def explode(*_: Any, **__: Any) -> None:
        raise RuntimeError("the worker died here")

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr("visionset.kernel.services.annotation_service._refresh_progress", explode)
        with pytest.raises(RuntimeError):
            service.enter_unreviewed(job.id, [_prediction(asset_id)])

    assert fixture.annotations.for_asset(job.id, asset_id) == []
    assert fixture.progress_of(job, asset_id) is AssetProgress.UNANNOTATED
    fixture.close()


def test_an_asset_that_is_not_unannotated_is_refused(tmp_path: Path) -> None:
    """Only untouched assets: a person's work is never overwritten."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    fixture.annotations.add(job.id, [_box(asset_id)])
    assert fixture.progress_of(job, asset_id) is AssetProgress.ANNOTATED

    with pytest.raises(AssetNotWritable):
        fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)])

    assert len(fixture.annotations.for_asset(job.id, asset_id)) == 1
    fixture.close()


def test_a_skipped_and_restored_asset_keeps_its_labels_and_is_refused(tmp_path: Path) -> None:
    """``annotated -> skipped -> unannotated`` deletes no labels, so progress
    alone lies about the asset being untouched. A model must not land beside a
    person's boxes just because the marker cycled back to ``unannotated``."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    (human,) = fixture.annotations.add(job.id, [_box(asset_id)])
    fixture.jobs.mark(job.id, asset_id, AssetProgress.SKIPPED)
    fixture.jobs.mark(job.id, asset_id, AssetProgress.UNANNOTATED)
    assert fixture.progress_of(job, asset_id) is AssetProgress.UNANNOTATED

    with pytest.raises(AssetNotWritable):
        fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)])

    assert fixture.annotations.for_asset(job.id, asset_id) == [human]
    assert fixture.progress_of(job, asset_id) is AssetProgress.UNANNOTATED
    fixture.close()


def test_a_human_annotation_cannot_use_this_door(tmp_path: Path) -> None:
    """This path is not a general bypass of the write gate."""
    fixture = Fixture(tmp_path)
    job = fixture.working()

    with pytest.raises(AnnotationNotFromModel):
        fixture.annotations.enter_unreviewed(job.id, [_box(fixture.assets[0])])

    assert fixture.progress_of(job, fixture.assets[0]) is AssetProgress.UNANNOTATED
    fixture.close()


def test_one_bad_prediction_stores_none_of_them(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]

    with pytest.raises(LabelClassNotInSchema):
        fixture.annotations.enter_unreviewed(
            job.id,
            [_prediction(asset_id), _prediction(asset_id, label_class="ghost")],
        )

    assert fixture.annotations.for_asset(job.id, asset_id) == []
    assert fixture.progress_of(job, asset_id) is AssetProgress.UNANNOTATED
    fixture.close()


def test_an_asset_moved_underneath_the_call_is_refused_and_nothing_is_written(
    tmp_path: Path,
) -> None:
    """An asset that moved before this call ran is refused, and no label survives.

    Either error is correct and which one arrives depends on where the move
    landed: the gate sees it if it was already stored, the guard on
    ``set_asset_progress`` sees it if it lands mid-call. The guard's own race has
    its coverage in ``tests/kernel/test_concurrency.py``; what matters here is
    that a refusal leaves nothing behind.
    """
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    stale = fixture.jobs.get(job.id)
    fixture.jobs.mark(job.id, asset_id, AssetProgress.SKIPPED)

    with pytest.raises((StaleWrite, AssetNotWritable)):
        AnnotationService(fixture.workspace).enter_unreviewed(stale.id, [_prediction(asset_id)])

    assert fixture.annotations.for_asset(job.id, asset_id) == []
    fixture.close()


def test_a_replacing_write_supersedes_a_models_labels_and_stays_pre_labeled(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    (first,) = fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)])

    (second,) = fixture.annotations.enter_unreviewed(
        job.id, [_prediction(asset_id, confidence=0.41)], replacing={asset_id}
    )

    remaining = fixture.annotations.for_asset(job.id, asset_id)
    assert [a.id for a in remaining] == [second.id]
    assert first.id not in {a.id for a in remaining}
    assert fixture.progress_of(job, asset_id) is AssetProgress.PRE_LABELED
    fixture.close()


def test_a_replacing_write_that_lands_nothing_returns_the_frame_to_unannotated(
    tmp_path: Path,
) -> None:
    """The model no longer finds anything here: the stale guess goes, and the
    frame reads as untouched — which is what it now is."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)])

    assert fixture.annotations.enter_unreviewed(job.id, [], replacing={asset_id}) == []

    assert fixture.annotations.for_asset(job.id, asset_id) == []
    assert fixture.progress_of(job, asset_id) is AssetProgress.UNANNOTATED
    fixture.close()


@pytest.mark.parametrize(
    "take_over",
    [
        pytest.param(lambda f, job, a: f.annotations.add(job.id, [_box(a)]), id="edited"),
        pytest.param(
            lambda f, job, a: f.jobs.mark(job.id, a, AssetProgress.ANNOTATED), id="confirmed"
        ),
        pytest.param(lambda f, job, a: f.jobs.mark(job.id, a, AssetProgress.SKIPPED), id="skipped"),
    ],
)
def test_a_replacing_write_refuses_a_frame_a_person_took_over(
    tmp_path: Path, take_over: Callable[[Fixture, AnnotationJob, UUID], object]
) -> None:
    """Confirming, editing and skipping are judgments; a model's re-run never undoes one."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)])
    take_over(fixture, job, asset_id)
    before = fixture.annotations.for_asset(job.id, asset_id)

    with pytest.raises(AssetNotWritable):
        fixture.annotations.enter_unreviewed(
            job.id, [_prediction(asset_id, confidence=0.41)], replacing={asset_id}
        )
    assert fixture.annotations.for_asset(job.id, asset_id) == before
    fixture.close()


def test_a_replacing_write_refuses_an_untouched_frame_nothing_was_written_on(
    tmp_path: Path,
) -> None:
    """``replacing`` names frames a model already labeled; an untouched frame is
    entered through the ordinary path, never through the replacing one."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]

    with pytest.raises(AssetNotWritable):
        fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)], replacing={asset_id})
    fixture.close()


def test_a_replacing_write_refuses_an_asset_outside_the_job(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    with pytest.raises(AssetNotInJob):
        fixture.annotations.enter_unreviewed(job.id, [], replacing={uuid4()})
    fixture.close()


def test_a_replacing_write_still_admits_only_a_models_labels(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)])

    with pytest.raises(AnnotationNotFromModel):
        fixture.annotations.enter_unreviewed(job.id, [_box(asset_id)], replacing={asset_id})
    assert len(fixture.annotations.for_asset(job.id, asset_id)) == 1
    fixture.close()


def test_a_refusal_inside_a_replacing_write_leaves_the_old_labels_in_place(tmp_path: Path) -> None:
    """Labels out and labels in are one transaction: a frame never holds half of two rounds."""
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    (old,) = fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)])

    with pytest.raises(InvalidAnnotation):
        fixture.annotations.enter_unreviewed(
            job.id,
            [_prediction(asset_id), _prediction(asset_id, label_class="no-such-class")],
            replacing={asset_id},
        )

    assert [a.id for a in fixture.annotations.for_asset(job.id, asset_id)] == [old.id]
    assert fixture.progress_of(job, asset_id) is AssetProgress.PRE_LABELED
    fixture.close()


def test_a_replacing_write_and_a_fresh_entry_can_share_one_call(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    first, second = fixture.assets[0], fixture.assets[1]
    fixture.annotations.enter_unreviewed(job.id, [_prediction(first)])

    stored = fixture.annotations.enter_unreviewed(
        job.id, [_prediction(first, confidence=0.5), _prediction(second)], replacing={first}
    )

    assert len(stored) == 2
    assert fixture.progress_of(job, first) is AssetProgress.PRE_LABELED
    assert fixture.progress_of(job, second) is AssetProgress.PRE_LABELED
    fixture.close()


def test_a_person_can_still_take_over_a_frame_a_model_replaced(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    job = fixture.working()
    asset_id = fixture.assets[0]
    fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)])
    fixture.annotations.enter_unreviewed(job.id, [_prediction(asset_id)], replacing={asset_id})

    fixture.annotations.add(job.id, [_box(asset_id)])

    assert fixture.progress_of(job, asset_id) is AssetProgress.ANNOTATED
    fixture.close()
