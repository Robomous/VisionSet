import inspect
from collections.abc import Mapping
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import Step, StepDraw
from visionset.kernel.errors import PreprocessingDriverNotFound


@runtime_checkable
class PreprocessingDriver(Protocol):
    """A pixel engine for one kind of recipe step.

    Drivers do pixels only: every coordinate an export writes comes from the
    kernel's own geometry transform, so a driver that moved annotations would
    be a second spelling of arithmetic the kernel already owns. ``step_kinds``
    says which step kinds this driver applies — ``{"resize"}`` or
    ``{"augment"}`` — and the kernel takes driver *instances*, never names:
    discovery and composition happen outside it, the way exporters arrive.

    ``apply`` turns one image's bytes into the transformed bytes for one step.
    ``seed`` is the variant's digest from ``variant_seed`` and ``variant`` its
    index; a resize, or any step applied to variant 0, is deterministic and
    reads neither. For an augmentation of variants ``1..n`` the kernel passes
    ``draw``, the step's entry in the variant's ``VariantPlan`` — the value the
    geometry transform moved the annotations by — and a driver applies exactly
    that. A driver whose ``apply`` takes no ``draw`` is still called, without
    it, and must then derive the same draw with ``sample_step(step, seed)``.
    """

    step_kinds: frozenset[str]

    def apply(
        self,
        step: Step,
        image: bytes,
        *,
        seed: bytes,
        variant: int,
        draw: StepDraw | None = None,
    ) -> bytes: ...


def accepts_draw(driver: PreprocessingDriver) -> bool:
    """Whether ``driver.apply`` takes ``draw``, the keyword the port gained with plans."""
    try:
        parameters = inspect.signature(driver.apply).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(
        parameter.name == "draw" or parameter.kind is inspect.Parameter.VAR_KEYWORD
        for parameter in parameters
    )


def driver_for(installed: Mapping[str, PreprocessingDriver], step_kind: str) -> PreprocessingDriver:
    """One driver out of a set already in hand, or say none applies that kind.

    Beside the port for ``resolve_target``'s reason: the kernel may not scan
    entry points, so whoever composed the call passes what is installed, keyed
    by step kind, and the refusal has one wording wherever it is raised. A
    caller must not index the mapping directly — a ``KeyError`` is outside the
    ``VisionSetError`` tree.

    Raises:
        PreprocessingDriverNotFound: no installed driver applies ``step_kind``.
    """
    if step_kind not in installed:
        known = tuple(sorted(installed))
        raise PreprocessingDriverNotFound(
            f"no pre-processing driver is installed for step kind {step_kind!r}; "
            f"installed step kinds: {', '.join(known) or 'none'}",
            installed=known,
        )
    return installed[step_kind]
