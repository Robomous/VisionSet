# usage: from visionset.kernel.domain import ExportTarget, Task, TargetFamily
"""Export targets: the model a person will train, declared by an exporter.

The user-facing unit of export is a target, and the format that writes for it
is an implementation detail of the declaration: a target resolves to exactly
one exporter, never to a runtime switch. Exporters declare their targets on the
``Exporter`` port, so the catalog every surface renders is derived from what is
installed rather than kept anywhere by hand.

``ResizeStrategy`` lives here rather than with the pre-processing steps because
:class:`PreprocessingHints` references it: a target recommends a strategy, and
a recipe later applies one.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Final

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from visionset.kernel.domain.schema import GeometryType

TARGET_NAME_PATTERN: Final = re.compile(r"^[a-z0-9][a-z0-9-]*$")
"""What a target may be called: a lowercase slug, as typed in a URL or a flag.

A target name is an identifier a person types and a script repeats — ``yolo11``,
never a display string. The label field is where capitals and spaces belong.
"""


class Task(StrEnum):
    """A trainer-side task an export target accepts."""

    DETECT = "detect"
    SEGMENT = "segment"
    CLASSIFY = "classify"
    POSE = "pose"
    OBB = "obb"
    SEMANTIC = "semantic"
    DEPTH = "depth"


class ResizeStrategy(StrEnum):
    """How an image reaches a requested size.

    ``stretch`` scales each axis independently onto the size; ``letterbox``
    scales by the limiting axis and pads the rest, preserving aspect ratio.
    """

    STRETCH = "stretch"
    LETTERBOX = "letterbox"


class PreprocessingHints(BaseModel):
    """What a target's trainer expects of its input images.

    Hints, never requirements: an export is valid without honouring any of
    them. ``recommended_size`` is ``(width, height)``. ``trainer_resizes`` says
    the trainer resizes on its own, so pre-resizing is an optimization rather
    than a need; ``augmentation_common`` says augmentation is the ordinary
    practice when training this target.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    recommended_size: tuple[int, int] | None
    recommended_strategy: ResizeStrategy | None
    trainer_resizes: bool
    augmentation_common: bool

    @model_validator(mode="after")
    def _strategy_requires_a_size(self) -> PreprocessingHints:
        if self.recommended_strategy is not None and self.recommended_size is None:
            raise ValueError("a recommended strategy without a recommended size resizes to nothing")
        return self


class TargetFamily(StrEnum):
    """Which group of trainers a target belongs to.

    ``other`` is the family of every exporter that is not a YOLO trainer: such
    an exporter declares one target named after itself, so every export is
    addressed the same way.
    """

    ULTRALYTICS_YOLO = "ultralytics-yolo"
    COMMUNITY_YOLO = "community-yolo"
    OTHER = "other"


class ExportTarget(BaseModel):
    """One model a person can train on an exporter's output.

    Declared on the ``Exporter`` port; names are unique across every installed
    plugin, which is what lets a caller name a target and nothing else.
    ``tasks`` is what the trainer accepts — empty for family ``other``, where
    there is no trainer to accept anything. ``supported_geometries`` is what an
    export addressed to this target carries, never wider than what the
    declaring exporter can write.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    label: str
    family: TargetFamily
    tasks: frozenset[Task]
    supported_geometries: frozenset[GeometryType] = Field(min_length=1)
    hints: PreprocessingHints

    @field_validator("name")
    @classmethod
    def _name_is_a_slug(cls, value: str) -> str:
        if not TARGET_NAME_PATTERN.match(value):
            raise ValueError(
                f"target name {value!r} is not a slug: lowercase letters, digits and "
                "hyphens, starting with a letter or digit"
            )
        return value
