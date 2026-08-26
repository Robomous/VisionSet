"""The export payload carries a recipe by value, never by name."""

from __future__ import annotations

from uuid import uuid4

from visionset.jobs.export import payload_for
from visionset.kernel.domain import AugmentOp, AugmentStep, RecipeSpec, ResizeStep, ResizeStrategy

SPEC = RecipeSpec(
    target="yolo11",
    steps=(
        ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=640, height=640),
        AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.3),
    ),
    variants_per_asset=2,
)


def test_the_payload_snapshots_the_spec_beside_its_name() -> None:
    payload = payload_for(
        uuid4(), "ultralytics", target="yolo11", allow_lossy=True, recipe=("r", SPEC)
    )

    assert payload["recipe"] == {"name": "r", "spec": SPEC.model_dump(mode="json")}
    assert RecipeSpec.model_validate(payload["recipe"]["spec"]) == SPEC  # type: ignore[index]


def test_no_recipe_is_carried_as_null() -> None:
    payload = payload_for(uuid4(), "ultralytics", target=None, allow_lossy=False)
    assert payload["recipe"] is None
