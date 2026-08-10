# usage: from visionset.mcp import annotations
"""Annotation tools: the writes that make an agent an annotator rather than an operator.

**Two input models, and they are the only ones in this package.** Everywhere else
a domain model goes straight into the signature; ``Annotation`` cannot, because
it requires ``schema_version`` and the service *overwrites* whatever it is given
with the version its batch pinned. A required field whose value is discarded is a
lie in the input schema, and an agent that reasoned about which version to send
would be reasoning about nothing. So ``AnnotationInput`` omits it, exactly as
``AnnotationCreate`` does on the wire, and the geometry is still the domain's own
union.

All three writes **start the job they are addressed to**, if nobody has, and say
so in ``job_started`` — the reasoning is in ``_autostart``. The gate is still the
batch being ``in_annotation``, which is what refuses when the write is not allowed
at all.

All three writes are **one transaction and all-or-nothing**: a batch of ten
annotations with one bad geometry writes none of them. When that happens the
refusal carries ``index``, the position in the list you sent — which is
recoverable nowhere else, because nothing landed for the caller to count from.

``delete_annotations`` has **no ``confirm``**, and that is deliberate rather than
an oversight. Deleting a box is the annotator edit loop, not a destructive
operation; the guard is the batch gate, which refuses every write once a batch is
no longer open. It is one of exactly two methods in the whole kernel exempted
from ``confirm``, and the exemption is written down in the error's own docstring.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

from visionset import wire
from visionset.kernel.domain import Annotation, AttributeValue, Geometry, Provenance
from visionset.kernel.services import AnnotationService
from visionset.mcp._autostart import autostarted
from visionset.mcp._resolve import identifier
from visionset.mcp._workspace import opened_workspace

JobRef = Annotated[str, Field(description="The annotation job the write belongs to, by id.")]
"""Module-level for the ``inspect.signature`` reason."""


class AnnotationInput(BaseModel):
    """One label to write. ``schema_version`` is absent: the batch's pin is stamped in."""

    model_config = ConfigDict(extra="forbid")

    asset_id: UUID = Field(description="The asset this label is on. Must belong to the job.")
    label_class: str = Field(description="A class name the batch's pinned schema declares.")
    geometry: Geometry = Field(
        description=(
            "The shape, in the asset's own pixel coordinates — never normalized. "
            "Its 'type' field is required and selects the variant."
        )
    )
    attributes: dict[str, AttributeValue] = Field(
        default_factory=dict,
        description="Values keyed by the attribute names the class declares.",
    )
    provenance: Provenance = Field(
        description="Who produced it. Use 'model' for anything you inferred."
    )
    model_ref: str | None = Field(
        default=None,
        description="Which model produced it. Required when provenance is 'model'.",
    )
    confidence: float | None = Field(
        default=None, ge=0.0, le=1.0, description="Optional confidence between 0 and 1."
    )

    def to_domain(self) -> Annotation:
        """The domain model, with a placeholder version the service replaces."""
        return Annotation(
            asset_id=self.asset_id,
            label_class=self.label_class,
            # Any value ≥ 1 does; `AnnotationService` stamps the batch's pin over
            # it before anything is stored. `1` is what the REST body passes for
            # the same reason.
            schema_version=1,
            geometry=self.geometry,
            attributes=self.attributes,
            provenance=self.provenance,
            model_ref=self.model_ref,
            confidence=self.confidence,
        )


class AnnotationEdit(BaseModel):
    """One label to replace, addressed by id. ``asset_id`` is absent: the stored one wins."""

    model_config = ConfigDict(extra="forbid")

    id: UUID = Field(description="The annotation to replace, by id.")
    label_class: str = Field(description="A class name the batch's pinned schema declares.")
    geometry: Geometry = Field(
        description="The replacement shape, in the asset's own pixel coordinates."
    )
    attributes: dict[str, AttributeValue] = Field(default_factory=dict)
    provenance: Provenance = Field(description="Who produced this version of it.")
    model_ref: str | None = Field(default=None)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)

    def to_domain(self) -> Annotation:
        """The domain model. Both the version and the asset are replaced by the service."""
        return Annotation(
            id=self.id,
            # The service overwrites this with the *stored* annotation's asset,
            # which is the rule that stops an update moving a label to another
            # image. A throwaway id is the honest way to say it is not an input.
            asset_id=uuid4(),
            label_class=self.label_class,
            schema_version=1,
            geometry=self.geometry,
            attributes=self.attributes,
            provenance=self.provenance,
            model_ref=self.model_ref,
            confidence=self.confidence,
        )


def list_asset_annotations(
    job_id: JobRef,
    asset_id: Annotated[str, Field(description="The asset within that job, by id.")],
) -> dict[str, Any]:
    """List the annotations already written on one asset of a job.

    Read this before editing: `update_annotations` and `delete_annotations` both
    address annotations by `id`, and this is where the ids come from. An asset
    with nothing on it yet is an empty list, not an error.
    """
    with opened_workspace() as workspace:
        found = AnnotationService(workspace).for_asset(
            identifier(job_id, what="job_id"), identifier(asset_id, what="asset_id")
        )
    return wire.page([wire.annotation(a) for a in found])


def add_annotations(
    job_id: JobRef,
    annotations: Annotated[
        list[AnnotationInput],
        Field(description="The labels to write. All are written, or none are."),
    ],
) -> dict[str, Any]:
    """Write new annotations into a job. All succeed together or none are written.

    Each is judged against the schema version the job's batch pinned: the class
    must be declared there, the geometry must be the one that class is bound to,
    every required attribute must be present, and no attribute the class does not
    declare is allowed. Coordinates are the asset's own pixels — if you read the
    image through `get_asset_image` at preview size, multiply by the `scale` it
    returned before writing.

    Set `provenance` to `model` and give `model_ref` for anything you inferred;
    that is what lets a human reviewer tell your work from theirs later.

    Writing an annotation moves its asset to `annotated` on its own, and starts
    the job if nobody had — `job_started` in the answer says whether that
    happened, so you never have to mark a job as being worked on yourself.
    Refuses if the job's batch is not `in_annotation`, and if any single item is
    bad the refusal names its position in `index` — nothing was written, so that
    position is the only thing that identifies it.
    """
    with opened_workspace() as workspace:
        resolved = identifier(job_id, what="job_id")
        started = autostarted(workspace, resolved)
        written = AnnotationService(workspace).add(resolved, [a.to_domain() for a in annotations])
    return {**wire.page([wire.annotation(a) for a in written]), "job_started": started}


def update_annotations(
    job_id: JobRef,
    annotations: Annotated[
        list[AnnotationEdit],
        Field(description="The replacements, each addressed by id. All or none."),
    ],
) -> dict[str, Any]:
    """Replace existing annotations wholesale. All succeed together or none are written.

    A whole-value replace, not a patch: what you send is what the annotation
    becomes, so send every field you want to keep. The asset an annotation is on
    cannot be changed — the stored one always wins — and the schema version is
    re-stamped from the batch's pin.

    Same validation and the same all-or-nothing rule as `add_annotations`, and
    the same `job_started` in the answer.
    """
    with opened_workspace() as workspace:
        resolved = identifier(job_id, what="job_id")
        started = autostarted(workspace, resolved)
        written = AnnotationService(workspace).update(
            resolved, [a.to_domain() for a in annotations]
        )
    return {**wire.page([wire.annotation(a) for a in written]), "job_started": started}


def delete_annotations(
    job_id: JobRef,
    annotation_ids: Annotated[
        list[str], Field(description="The annotations to remove, by id. All or none.")
    ],
) -> dict[str, Any]:
    """Remove annotations from a job. All succeed together or none are removed.

    No confirmation is required, unlike `delete_project`: deleting a label is the
    ordinary edit loop, and the guard is that a batch which is no longer
    `in_annotation` refuses every write. Removing every annotation from an asset
    moves it back to `unannotated`.

    A repeated id counts once, and the refusal for an unknown one blames the
    position you gave it rather than a deduplicated offset. Like the other two
    writes, this starts the job if nobody had, and reports it in `job_started`.
    """
    with opened_workspace() as workspace:
        resolved = identifier(job_id, what="job_id")
        started = autostarted(workspace, resolved)
        removed = AnnotationService(workspace).delete(
            resolved,
            [identifier(a, what="annotation_ids") for a in annotation_ids],
        )
    return {"deleted": removed, "job_started": started}
