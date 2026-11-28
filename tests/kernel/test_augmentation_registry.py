"""The augmentation registry: exhaustive, stable, declared, and the steps it refuses."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import (
    AMOUNT,
    AUGMENT_GEOMETRIES,
    AUGMENT_OPERATIONS,
    AugmentOp,
    AugmentOperation,
    AugmentParameter,
    AugmentStep,
    GeometryType,
    ParameterKind,
    RecipeSpec,
    Task,
    augment_operation,
    augment_operations,
    canonical_bytes,
    recipe_hash,
)

#: The registry as it stands, spelled out. A change here is a change to what a
#: stored recipe means, so it is made on purpose or not at all.
EXPECTED: dict[tuple[str, int], dict[str, Any]] = {
    ("hflip", 1): {
        "family": "spatial",
        "semantics": "mirrors",
        "loss": "lossless",
        "modalities": ("image",),
        "tasks": ("detect", "segment", "classify", "obb", "semantic"),
        "drivers": ("pillow",),
        "preview": True,
        "parameters": (("amount", "float", 0.2, 0.0, 0.5, True, True),),
    },
    ("brightness_contrast", 1): {
        "family": "photometric",
        "semantics": "preserves",
        "loss": "lossless",
        "modalities": ("image",),
        "tasks": ("detect", "segment", "classify", "pose", "obb", "semantic"),
        "drivers": ("pillow",),
        "preview": True,
        "parameters": (("amount", "float", 0.2, 0.0, 0.5, True, False),),
    },
    ("rot90", 1): {
        "family": "spatial",
        "semantics": "reorients",
        "loss": "lossless",
        "modalities": ("image",),
        "tasks": ("detect", "segment", "classify", "obb", "semantic"),
        "drivers": ("pillow",),
        "preview": True,
        "parameters": (("amount", "float", 0.2, 0.0, 0.5, True, True),),
    },
}


def _summary(operation: AugmentOperation) -> dict[str, Any]:
    return {
        "family": operation.family.value,
        "semantics": operation.semantics.value,
        "loss": operation.loss.value,
        "modalities": operation.modalities,
        "tasks": tuple(task.value for task in operation.tasks),
        "drivers": operation.drivers,
        "preview": operation.preview,
        "parameters": tuple(
            (
                one.name,
                one.kind.value,
                one.default,
                one.minimum,
                one.maximum,
                one.exclusive_minimum,
                one.inert,
            )
            for one in operation.parameters
        ),
    }


def test_the_registry_is_exactly_the_declared_table() -> None:
    actual = {
        (op.value, version): _summary(one) for (op, version), one in AUGMENT_OPERATIONS.items()
    }
    assert actual == EXPECTED


def test_every_op_has_a_version_one_and_every_entry_names_a_real_op() -> None:
    assert {op for op, _ in AUGMENT_OPERATIONS} == set(AugmentOp)
    assert all((op, 1) in AUGMENT_OPERATIONS for op in AugmentOp)
    for (op, version), operation in AUGMENT_OPERATIONS.items():
        assert (operation.op, operation.version) == (op, version)


def test_the_registry_is_ordered_by_op_declaration_then_version() -> None:
    keys = [(operation.op, operation.version) for operation in augment_operations()]
    assert keys == sorted(keys, key=lambda key: (list(AugmentOp).index(key[0]), key[1]))
    assert keys == list(AUGMENT_OPERATIONS)


def test_geometries_are_read_from_the_one_table_in_declaration_order() -> None:
    for operation in augment_operations():
        assert set(operation.geometries) == AUGMENT_GEOMETRIES[operation.op]
        assert list(operation.geometries) == [
            one for one in GeometryType if one in operation.geometries
        ]
        assert list(operation.tasks) == [one for one in Task if one in operation.tasks]


def test_no_operation_claims_a_task_no_label_can_carry() -> None:
    assert all(Task.DEPTH not in operation.tasks for operation in augment_operations())


def test_an_operation_round_trips_through_its_serialization() -> None:
    for operation in augment_operations():
        assert AugmentOperation.model_validate_json(operation.model_dump_json()) == operation


def _registry_bytes() -> bytes:
    return b"\n".join(canonical_bytes(operation) for operation in augment_operations())


def test_the_serialized_registry_does_not_depend_on_the_process_hash_seed() -> None:
    probe = (
        "import sys; from visionset.kernel.domain import augment_operations, canonical_bytes; "
        "sys.stdout.buffer.write(b'\\n'.join(canonical_bytes(o) for o in augment_operations()))"
    )
    outputs = {
        subprocess.run(
            [sys.executable, "-c", probe],
            capture_output=True,
            check=True,
            env={**os.environ, "PYTHONHASHSEED": seed},
        ).stdout
        for seed in ("1", "2", "3")
    }
    assert outputs == {_registry_bytes()}


def test_the_amount_parameter_is_the_steps_own_field_constraint() -> None:
    field = AugmentStep.model_fields["amount"]
    assert field.default == AMOUNT.default
    assert AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.5).amount == 0.5
    with pytest.raises(ValidationError):
        AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.0)
    with pytest.raises(ValidationError):
        AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.51)


# --- steps the registry refuses -----------------------------------------------


def test_an_unknown_op_is_refused() -> None:
    with pytest.raises(ValidationError, match="op"):
        AugmentStep.model_validate({"op": "mosaic"})


def test_an_unregistered_version_is_refused_and_names_the_registered_ones() -> None:
    with pytest.raises(ValidationError, match=r"hflip has no version 2; registered versions: 1"):
        AugmentStep(op=AugmentOp.HFLIP, version=2)
    with pytest.raises(ValidationError):
        AugmentStep(op=AugmentOp.HFLIP, version=0)
    with pytest.raises(ValueError, match="rot90 has no version 7"):
        augment_operation(AugmentOp.ROT90, 7)


def test_an_undeclared_parameter_is_refused() -> None:
    with pytest.raises(ValidationError, match=r"hflip has no parameter 'sigma'.*accepts none"):
        AugmentStep.model_validate({"op": "hflip", "params": {"sigma": 1.0}})


def test_amount_is_never_a_member_of_params() -> None:
    with pytest.raises(ValidationError, match="amount is the step's own field"):
        AugmentStep.model_validate({"op": "brightness_contrast", "params": {"amount": 0.3}})


SIGMA = AugmentParameter(
    name="sigma",
    kind=ParameterKind.FLOAT,
    default=1.0,
    minimum=0.0,
    maximum=3.0,
    exclusive_minimum=True,
    description="test parameter",
)
COUNT = AugmentParameter(
    name="count", kind=ParameterKind.INT, default=1, minimum=1, maximum=4, description="test"
)
FLAG = AugmentParameter(name="flag", kind=ParameterKind.BOOL, default=False, description="test")
WITH_PARAMS = augment_operation(AugmentOp.BRIGHTNESS_CONTRAST).model_copy(
    update={"parameters": (AMOUNT, COUNT, FLAG, SIGMA)}
)


def test_declared_parameters_are_checked_and_held_in_name_order() -> None:
    checked = WITH_PARAMS.checked_params({"sigma": 2, "flag": True, "count": 3})
    assert list(checked) == ["count", "flag", "sigma"]
    assert checked == {"count": 3, "flag": True, "sigma": 2.0}
    assert isinstance(checked["sigma"], float)


@pytest.mark.parametrize(
    ("params", "reason"),
    [
        ({"sigma": 0.0}, r"must lie in \(0.0, 3.0\]"),
        ({"sigma": 3.5}, r"must lie in \(0.0, 3.0\]"),
        ({"sigma": float("nan")}, "must be finite"),
        ({"sigma": True}, "is a number"),
        ({"sigma": "1"}, "is a number"),
        ({"count": 0}, r"must lie in \[1, 4\]"),
        ({"count": 1.5}, "is a whole number"),
        ({"flag": 1}, "is a boolean"),
        ({"other": 1}, r"no parameter 'other'.*accepts 'count', 'flag', 'sigma'"),
    ],
)
def test_a_declared_parameter_refuses_a_wrong_type_or_range(
    params: dict[str, object], reason: str
) -> None:
    with pytest.raises(ValueError, match=reason):
        WITH_PARAMS.checked_params(params)


# --- legacy serialization -----------------------------------------------------


def test_a_legacy_step_serializes_without_version_or_params() -> None:
    step = AugmentStep(op=AugmentOp.ROT90)
    assert step.model_dump(mode="json") == {"kind": "augment", "op": "rot90", "amount": 0.2}
    explicit = AugmentStep.model_validate({"op": "rot90", "version": 1, "params": {}})
    assert explicit == step
    assert explicit.model_dump(mode="json") == step.model_dump(mode="json")


def test_spelling_the_legacy_version_out_does_not_move_the_hash() -> None:
    bare = RecipeSpec.model_validate(
        {"target": None, "steps": [{"kind": "augment", "op": "hflip"}], "variants_per_asset": 1}
    )
    spelled = RecipeSpec.model_validate(
        {
            "target": None,
            "steps": [{"kind": "augment", "op": "hflip", "version": 1, "params": {}}],
            "variants_per_asset": 1,
        }
    )
    assert recipe_hash(bare) == recipe_hash(spelled)
    assert json.loads(canonical_bytes(spelled))["steps"] == [
        {"amount": 0.2, "kind": "augment", "op": "hflip"}
    ]


def test_a_step_stays_hashable_and_equal_steps_hash_alike() -> None:
    one = AugmentStep(op=AugmentOp.HFLIP)
    assert hash(one) == hash(AugmentStep.model_validate({"op": "hflip", "version": 1}))
    assert len({one, AugmentStep(op=AugmentOp.HFLIP), AugmentStep(op=AugmentOp.ROT90)}) == 2


def test_a_step_validates_params_against_its_registered_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(AUGMENT_OPERATIONS, (AugmentOp.BRIGHTNESS_CONTRAST, 1), WITH_PARAMS)  # type: ignore[index]
    step = AugmentStep.model_validate(
        {"op": "brightness_contrast", "params": {"sigma": 2, "count": 2}}
    )
    assert step.params == {"count": 2, "sigma": 2.0}
    assert list(step.model_dump(mode="json")["params"]) == ["count", "sigma"]
    with pytest.raises(ValidationError, match=r"must lie in \(0.0, 3.0\]"):
        AugmentStep.model_validate({"op": "brightness_contrast", "params": {"sigma": 4.0}})
    with pytest.raises(ValidationError, match="valid boolean"):
        AugmentStep.model_validate({"op": "brightness_contrast", "params": {"flag": "1"}})


@pytest.mark.parametrize("version", [True, "1", 1.0])
def test_a_version_is_a_strict_integer(version: object) -> None:
    with pytest.raises(ValidationError):
        AugmentStep.model_validate({"op": "hflip", "version": version})
