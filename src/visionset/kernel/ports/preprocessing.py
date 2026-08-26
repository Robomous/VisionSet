from typing import Protocol, runtime_checkable

from visionset.kernel.domain import Step


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
    reads neither. Everything random must be derived from the seed through the
    kernel's draw functions — ``hflip_applied``,
    ``brightness_contrast_factors``, ``rot90_quarter_turns`` — so the pixels
    land where the geometry transform already put the annotations.
    """

    step_kinds: frozenset[str]

    def apply(self, step: Step, image: bytes, *, seed: bytes, variant: int) -> bytes: ...
