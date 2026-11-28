# usage: from visionset.kernel.domain import RecipeAssessment, RecipeCounts, RecipeRefusal
"""What one recipe would do to one release, for one export, before anything is saved or written.

The answer :meth:`ReleaseService.assess_recipe` gives for a draft recipe. It is
the resolver's verdicts beside the files the export would write, or beside the
one refusal the export would raise instead. A refusal is data here, never an
exception: the assessment exists to be shown while a recipe is being edited.
"""

from __future__ import annotations

from typing import Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from visionset.kernel.domain.preprocessing_compatibility import AugmentationResolution


class RecipeCounts(BaseModel):
    """The files an export of the recipe writes, and the labels a cropping resize costs.

    ``source_files`` are the base images, one per asset the format is handed,
    and ``augmented_files`` the variants written beside them for the train
    fold. ``train_images``, ``val_images`` and ``test_images`` are the files
    each fold receives, a train image's variants included; all three are
    ``None`` for a release published without a split. ``dropped_labels`` and
    ``clipped_labels`` count the release's own labels a cropping resize cuts
    away or cuts down.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    source_files: int = Field(ge=0)
    augmented_files: int = Field(ge=0)
    train_images: int | None = Field(default=None, ge=0)
    val_images: int | None = Field(default=None, ge=0)
    test_images: int | None = Field(default=None, ge=0)
    dropped_labels: int = Field(default=0, ge=0)
    clipped_labels: int = Field(default=0, ge=0)


class RecipeRefusal(BaseModel):
    """The refusal an export of the recipe would raise: its published code and its sentence."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    code: str
    message: str


class RecipeAssessment(BaseModel):
    """One recipe over one release, for one format and optionally one target.

    ``resolution`` is every verdict the resolver gives, refused or not.
    Exactly one of ``counts`` and ``refusal`` is set: an export that would
    refuse the recipe writes nothing, so there is nothing to count.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    release_id: UUID
    format_name: str
    target: str | None = None
    resolution: AugmentationResolution
    counts: RecipeCounts | None = None
    refusal: RecipeRefusal | None = None

    @model_validator(mode="after")
    def _counted_or_refused(self) -> Self:
        if (self.counts is None) == (self.refusal is None):
            raise ValueError("an assessment carries either counts or a refusal, never both")
        return self

    @property
    def refused(self) -> bool:
        """Whether an export of this recipe would refuse it."""
        return self.refusal is not None
