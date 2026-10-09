# usage: from visionset.kernel.error_codes import ERROR_CODES, error_code, error_detail
"""The machine-readable half of a refusal, owned once for every surface.

A refusal carries a stable ``code`` and, for a few errors, a ``detail`` document.
REST, the CLI and MCP all publish both, and they publish the same values, which
is why they are decided here and not in ``server/errors.py``: the three delivery
packages may not import each other, so a table living in one of them could not be
read by the other two. What stays in each surface is only what is specific to it
— the HTTP status, a ``Retry-After``, a terminal hint, an agent's retry flag.

Codes are written out rather than derived from the class name. A code is a
public contract keyed to a Python identifier, and a pure refactor rename would
otherwise break every client while passing every test.
``tests/server/test_errors.py`` asserts each literal still equals the
SCREAMING_SNAKE of its class, so the drift protection survives.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from visionset.kernel import errors
from visionset.kernel.domain import ClassCount, ExportCompatibility

ERROR_CODES: Final[Mapping[type[errors.VisionSetError], str]] = {
    errors.AnnotationGeometryOutOfBounds: "ANNOTATION_GEOMETRY_OUT_OF_BOUNDS",
    errors.AnnotationNotFound: "ANNOTATION_NOT_FOUND",
    errors.AnnotationNotFromModel: "ANNOTATION_NOT_FROM_MODEL",
    errors.AssetNotFound: "ASSET_NOT_FOUND",
    errors.AssetNotInBatch: "ASSET_NOT_IN_BATCH",
    errors.AssetNotInDataset: "ASSET_NOT_IN_DATASET",
    errors.AssetNotInJob: "ASSET_NOT_IN_JOB",
    errors.AssetNotWritable: "ASSET_NOT_WRITABLE",
    errors.AugmentationRequiresSplit: "AUGMENTATION_REQUIRES_SPLIT",
    errors.BackgroundJobNotFound: "BACKGROUND_JOB_NOT_FOUND",
    errors.BatchImmutable: "BATCH_IMMUTABLE",
    errors.BatchNotComplete: "BATCH_NOT_COMPLETE",
    errors.BatchNotEditable: "BATCH_NOT_EDITABLE",
    errors.BatchNotFound: "BATCH_NOT_FOUND",
    errors.BatchNotInAnnotation: "BATCH_NOT_IN_ANNOTATION",
    errors.ConfirmationRequired: "CONFIRMATION_REQUIRED",
    errors.ConstraintViolated: "CONSTRAINT_VIOLATED",
    errors.CorruptMedia: "CORRUPT_MEDIA",
    errors.DatasetNotFound: "DATASET_NOT_FOUND",
    errors.DestructiveSchemaChange: "DESTRUCTIVE_SCHEMA_CHANGE",
    errors.DisallowedGeometry: "DISALLOWED_GEOMETRY",
    errors.DuplicateClassificationTag: "DUPLICATE_CLASSIFICATION_TAG",
    errors.EmptyBatch: "EMPTY_BATCH",
    errors.EmptyRelease: "EMPTY_RELEASE",
    errors.EntityAlreadyExists: "ENTITY_ALREADY_EXISTS",
    errors.EntityNotFound: "ENTITY_NOT_FOUND",
    errors.ExportFormatNotFound: "EXPORT_FORMAT_NOT_FOUND",
    errors.ExportSourceUnreadable: "EXPORT_SOURCE_UNREADABLE",
    errors.ExportTargetConflict: "EXPORT_TARGET_CONFLICT",
    errors.ExportTargetNotFound: "EXPORT_TARGET_NOT_FOUND",
    errors.FrameContentConflict: "FRAME_CONTENT_CONFLICT",
    errors.FrameOrdinalOutOfRange: "FRAME_ORDINAL_OUT_OF_RANGE",
    errors.FrameTimestampOffGrid: "FRAME_TIMESTAMP_OFF_GRID",
    errors.GeometryNotProduced: "GEOMETRY_NOT_PRODUCED",
    errors.InferenceConnectionInvalid: "INFERENCE_CONNECTION_INVALID",
    errors.InferenceConnectionModelFixed: "INFERENCE_CONNECTION_MODEL_FIXED",
    errors.InferenceConnectionNameTaken: "INFERENCE_CONNECTION_NAME_TAKEN",
    errors.InferenceConnectionNotCheckable: "INFERENCE_CONNECTION_NOT_CHECKABLE",
    errors.InferenceConnectionNotDownloadable: "INFERENCE_CONNECTION_NOT_DOWNLOADABLE",
    errors.InferenceConnectionNotFound: "INFERENCE_CONNECTION_NOT_FOUND",
    errors.InferenceConnectionNotRunnable: "INFERENCE_CONNECTION_NOT_RUNNABLE",
    errors.InferenceConnectionNotSetUp: "INFERENCE_CONNECTION_NOT_SET_UP",
    errors.InferenceConnectionNotTestable: "INFERENCE_CONNECTION_NOT_TESTABLE",
    errors.InferenceEndpointUnavailable: "INFERENCE_ENDPOINT_UNAVAILABLE",
    errors.InferenceOutOfMemory: "INFERENCE_OUT_OF_MEMORY",
    errors.IngestJobNotFound: "INGEST_JOB_NOT_FOUND",
    errors.InvalidAnnotation: "INVALID_ANNOTATION",
    errors.InvalidAttributeValue: "INVALID_ATTRIBUTE_VALUE",
    errors.InvalidExportTarget: "INVALID_EXPORT_TARGET",
    errors.InvalidName: "INVALID_NAME",
    errors.InvalidPartition: "INVALID_PARTITION",
    errors.InvalidSchema: "INVALID_SCHEMA",
    errors.InvalidTransition: "INVALID_TRANSITION",
    errors.JobFinished: "JOB_FINISHED",
    errors.JobNotComplete: "JOB_NOT_COMPLETE",
    errors.JobNotFound: "JOB_NOT_FOUND",
    errors.LabelClassNotInSchema: "LABEL_CLASS_NOT_IN_SCHEMA",
    errors.LocalInferenceUnavailable: "LOCAL_INFERENCE_UNAVAILABLE",
    errors.LossyExportNotConsented: "LOSSY_EXPORT_NOT_CONSENTED",
    errors.MediaError: "MEDIA_ERROR",
    errors.MissingRequiredAttribute: "MISSING_REQUIRED_ATTRIBUTE",
    errors.NoSplitRecipe: "NO_SPLIT_RECIPE",
    errors.NotAWorkspace: "NOT_A_WORKSPACE",
    errors.PreprocessingDriverNotFound: "PREPROCESSING_DRIVER_NOT_FOUND",
    errors.PreprocessingRecipeNameTaken: "PREPROCESSING_RECIPE_NAME_TAKEN",
    errors.PreprocessingRecipeNotFound: "PREPROCESSING_RECIPE_NOT_FOUND",
    errors.PreprocessingStepUnsupportedGeometry: "PREPROCESSING_STEP_UNSUPPORTED_GEOMETRY",
    errors.ProjectNameTaken: "PROJECT_NAME_TAKEN",
    errors.ProjectNotFound: "PROJECT_NOT_FOUND",
    errors.PromptPointOutOfBounds: "PROMPT_POINT_OUT_OF_BOUNDS",
    errors.ReleaseContentWouldViolateSchema: "RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA",
    errors.ReleaseNotFound: "RELEASE_NOT_FOUND",
    errors.ReleaseTagTaken: "RELEASE_TAG_TAKEN",
    errors.SchemaChangeWouldOrphan: "SCHEMA_CHANGE_WOULD_ORPHAN",
    errors.SchemaDraftNotFound: "SCHEMA_DRAFT_NOT_FOUND",
    errors.SchemaHasNoDetectableClass: "SCHEMA_HAS_NO_DETECTABLE_CLASS",
    errors.SchemaNotFound: "SCHEMA_NOT_FOUND",
    errors.SchemaVersionConflict: "SCHEMA_VERSION_CONFLICT",
    errors.SourceNotFound: "SOURCE_NOT_FOUND",
    errors.StaleWrite: "STALE_WRITE",
    errors.ThumbnailNotCached: "THUMBNAIL_NOT_CACHED",
    errors.TokenNameTaken: "TOKEN_NAME_TAKEN",
    errors.TokenNotFound: "TOKEN_NOT_FOUND",
    errors.TooManyOpenVideoImports: "TOO_MANY_OPEN_VIDEO_IMPORTS",
    errors.UnknownAttribute: "UNKNOWN_ATTRIBUTE",
    errors.UnknownJobType: "UNKNOWN_JOB_TYPE",
    errors.UnserializableManifest: "UNSERIALIZABLE_MANIFEST",
    errors.UnsupportedGeometry: "UNSUPPORTED_GEOMETRY",
    errors.UnsupportedMedia: "UNSUPPORTED_MEDIA",
    errors.UnsupportedPrompt: "UNSUPPORTED_PROMPT",
    errors.VideoImportIncomplete: "VIDEO_IMPORT_INCOMPLETE",
    errors.VideoImportNotFound: "VIDEO_IMPORT_NOT_FOUND",
    errors.VideoImportNotOpen: "VIDEO_IMPORT_NOT_OPEN",
    errors.VideoImportTooLarge: "VIDEO_IMPORT_TOO_LARGE",
    errors.WeightsDamaged: "WEIGHTS_DAMAGED",
    errors.WorkspaceAlreadyExists: "WORKSPACE_ALREADY_EXISTS",
    errors.WorkspaceBusy: "WORKSPACE_BUSY",
    errors.WorkspaceCorrupt: "WORKSPACE_CORRUPT",
    errors.WorkspaceFormatTooNew: "WORKSPACE_FORMAT_TOO_NEW",
    errors.WorkspaceNotEmpty: "WORKSPACE_NOT_EMPTY",
    errors.WorkspaceSchemaMismatch: "WORKSPACE_SCHEMA_MISMATCH",
}
"""One code per concrete error declared in ``kernel/errors.py``.

``VisionSetError`` itself is deliberately absent, so an unmapped error cannot
inherit an answer; ``tests/kernel/test_error_codes.py`` asserts the table is
total.
"""


def error_code(exc: BaseException) -> str | None:
    """The code ``exc`` is published under, or ``None`` if nothing covers it.

    Walks the MRO, so a subclass declared outside ``kernel/errors.py`` inherits
    its nearest mapped ancestor's code.
    """
    for cls in type(exc).__mro__:
        code = ERROR_CODES.get(cls)
        if code is not None:
            return code
    return None


def _class_counts(blockers: tuple[object, ...]) -> list[dict[str, Any]]:
    return [count.model_dump(mode="json") for count in blockers if isinstance(count, ClassCount)]


def error_detail(exc: BaseException) -> dict[str, Any] | None:
    """The structure a refusal carries beside its sentence, as JSON-ready primitives.

    ``None`` when there is none. Each ``isinstance`` on a payload is where its
    type comes back: ``kernel/errors.py`` may not import a domain model, so those
    fields are typed ``object | None`` there.
    """
    if isinstance(exc, errors.MediaError):
        # ``reason`` only. ``name`` is a path from a directory the operator
        # pointed at, and publishing it hands out server filesystem layout.
        return {"reason": exc.reason}
    if isinstance(exc, errors.LossyExportNotConsented) and isinstance(
        exc.compatibility, ExportCompatibility
    ):
        # ``by_alias`` makes it key-for-key the document the export endpoint
        # returns and the export writes into its own output.
        return {"compatibility": exc.compatibility.model_dump(mode="json", by_alias=True)}
    if isinstance(exc, errors.SchemaChangeWouldOrphan) and isinstance(exc.blockers, tuple):
        return {"blockers": _class_counts(exc.blockers)}
    if isinstance(exc, errors.ReleaseContentWouldViolateSchema) and isinstance(exc.blockers, tuple):
        return {"blockers": _class_counts(exc.blockers)}
    if isinstance(exc, errors.DestructiveSchemaChange) and isinstance(exc.classes, tuple):
        return {"classes": [name for name in exc.classes if isinstance(name, str)]}
    if isinstance(exc, errors.VisionSetError) and exc.index is not None:
        # Which item of a bulk request was refused. The reason is already the
        # message, so only the position is added.
        return {"index": exc.index}
    return None
