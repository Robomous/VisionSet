/**
 * DO NOT EDIT — generated from the repo-root openapi.json.
 *
 * Regenerate with `pnpm generate:client` and commit the result. CI fails on drift.
 *
 * One check per schema a 2xx JSON response can carry, plus one alias per operation named
 * after its `operationId`. `unwrap` takes the alias, so a response that is well-formed JSON
 * and the wrong document is reported as MALFORMED_RESPONSE instead of reaching a renderer.
 *
 * Two things are deliberately **not** checked, and both are argued in `../data/check.ts`:
 * `format` (a `uuid` is validated as a string and nothing more), and unknown keys (a server
 * that grows a field must not break an older client).
 */

import {
  arrayOf,
  checkBlob,
  checkNoContent,
  either,
  isBoolean,
  isInteger,
  isJsonValue,
  isNull,
  isNumber,
  isString,
  lit,
  mapOf,
  object,
  oneOf,
  tagged,
  tuple,
} from "../data/check";
import type { Check } from "../data/check";
import type { components, operations } from "./api";

type Schemas = components["schemas"];

export const checkBboxBody: Check<Schemas["BboxBody"]> =
  /*#__PURE__*/ object({ "height": [true, isNumber], "type": [true, lit("bbox")], "width": [true, isNumber], "x": [true, isNumber], "y": [true, isNumber] } as const);

export const checkClassificationBody: Check<Schemas["ClassificationBody"]> =
  /*#__PURE__*/ object({ "type": [true, lit("classification_tag")] } as const);

export const checkPolygonBody: Check<Schemas["PolygonBody"]> =
  /*#__PURE__*/ object({ "points": [true, arrayOf(tuple([isNumber, isNumber] as const))], "type": [true, lit("polygon")] } as const);

export const checkPolylineBody: Check<Schemas["PolylineBody"]> =
  /*#__PURE__*/ object({ "points": [true, arrayOf(tuple([isNumber, isNumber] as const))], "type": [true, lit("polyline")] } as const);

export const checkAnnotationOut: Check<Schemas["AnnotationOut"]> =
  /*#__PURE__*/ object({ "asset_id": [true, isString], "attributes": [true, mapOf(either([isBoolean, isNumber, isString] as const))], "confidence": [true, either([isNumber, isNull] as const)], "geometry": [true, tagged("type", { "bbox": checkBboxBody, "classification_tag": checkClassificationBody, "polygon": checkPolygonBody, "polyline": checkPolylineBody })], "id": [true, isString], "job_id": [true, either([isString, isNull] as const)], "label_class": [true, isString], "model_ref": [true, either([isString, isNull] as const)], "provenance": [true, oneOf(["human", "model", "import"] as const)], "schema_version": [true, isInteger] } as const);

export const checkAnnotationPage: Check<Schemas["AnnotationPage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkAnnotationOut)], "total": [true, isInteger] } as const);

export const checkImageFormat: Check<Schemas["ImageFormat"]> =
  /*#__PURE__*/ oneOf(["jpeg", "png"] as const);

export const checkAssetOut: Check<Schemas["AssetOut"]> =
  /*#__PURE__*/ object({ "content_hash": [true, isString], "format": [true, either([checkImageFormat, isNull] as const)], "frame_index": [true, either([isInteger, isNull] as const)], "frame_timestamp": [true, either([isNumber, isNull] as const)], "height": [true, either([isInteger, isNull] as const)], "id": [true, isString], "ingested_at": [true, either([isString, isNull] as const)], "modality": [true, lit("image")], "project_id": [true, isString], "source_id": [true, either([isString, isNull] as const)], "thumbnail_hash": [true, either([isString, isNull] as const)], "width": [true, either([isInteger, isNull] as const)] } as const);

export const checkAssetPage: Check<Schemas["AssetPage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkAssetOut)], "total": [true, isInteger] } as const);

export const checkAssetProgress: Check<Schemas["AssetProgress"]> =
  /*#__PURE__*/ oneOf(["unannotated", "annotated", "skipped", "review_pending", "accepted"] as const);

export const checkAssetProgressOut: Check<Schemas["AssetProgressOut"]> =
  /*#__PURE__*/ object({ "asset_id": [true, isString], "progress": [true, checkAssetProgress] } as const);

export const checkBackgroundJobState: Check<Schemas["BackgroundJobState"]> =
  /*#__PURE__*/ oneOf(["queued", "running", "succeeded", "failed", "cancelled"] as const);

export const checkItemFailureOut: Check<Schemas["ItemFailureOut"]> =
  /*#__PURE__*/ object({ "name": [true, isString], "reason": [true, isString] } as const);

export const checkJsonValue: Check<Schemas["JsonValue"]> =
  /*#__PURE__*/ isJsonValue;

export const checkBackgroundJobOut: Check<Schemas["BackgroundJobOut"]> =
  /*#__PURE__*/ object({ "attempt": [true, isInteger], "cancel_requested": [true, isBoolean], "created_at": [true, isString], "error": [true, either([isString, isNull] as const)], "failures": [true, arrayOf(checkItemFailureOut)], "finished_at": [true, either([isString, isNull] as const)], "id": [true, isString], "processed": [true, isInteger], "result": [true, mapOf(checkJsonValue)], "started_at": [true, either([isString, isNull] as const)], "state": [true, checkBackgroundJobState], "total": [true, either([isInteger, isNull] as const)], "type": [true, isString] } as const);

export const checkBackgroundJobPage: Check<Schemas["BackgroundJobPage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkBackgroundJobOut)], "total": [true, isInteger] } as const);

export const checkAssetAction: Check<Schemas["AssetAction"]> =
  /*#__PURE__*/ oneOf(["annotate", "skip", "restore", "submit_for_review", "accept", "return_to_annotator"] as const);

export const checkBatchAssetOut: Check<Schemas["BatchAssetOut"]> =
  /*#__PURE__*/ object({ "allowed_actions": [true, arrayOf(checkAssetAction)], "content_hash": [true, isString], "format": [true, either([checkImageFormat, isNull] as const)], "frame_index": [true, either([isInteger, isNull] as const)], "frame_timestamp": [true, either([isNumber, isNull] as const)], "height": [true, either([isInteger, isNull] as const)], "id": [true, isString], "ingested_at": [true, either([isString, isNull] as const)], "job_id": [true, either([isString, isNull] as const)], "modality": [true, lit("image")], "progress": [true, either([checkAssetProgress, isNull] as const)], "project_id": [true, isString], "source_id": [true, either([isString, isNull] as const)], "thumbnail_hash": [true, either([isString, isNull] as const)], "width": [true, either([isInteger, isNull] as const)] } as const);

export const checkBatchAssetPage: Check<Schemas["BatchAssetPage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkBatchAssetOut)], "total": [true, isInteger] } as const);

export const checkBatchAction: Check<Schemas["BatchAction"]> =
  /*#__PURE__*/ oneOf(["approve", "start", "complete", "repin", "promote", "create_correction", "edit_membership", "delete"] as const);

export const checkBatchState: Check<Schemas["BatchState"]> =
  /*#__PURE__*/ oneOf(["draft", "approved", "in_annotation", "completed"] as const);

export const checkProgressCounts: Check<Schemas["ProgressCounts"]> =
  /*#__PURE__*/ object({ "accepted": [true, isInteger], "annotated": [true, isInteger], "review_pending": [true, isInteger], "skipped": [true, isInteger], "total": [true, isInteger], "unannotated": [true, isInteger] } as const);

export const checkBatchOut: Check<Schemas["BatchOut"]> =
  /*#__PURE__*/ object({ "allowed_actions": [true, arrayOf(checkBatchAction)], "asset_count": [true, isInteger], "id": [true, isString], "name": [true, isString], "parent_batch_id": [true, either([isString, isNull] as const)], "progress": [true, checkProgressCounts], "project_id": [true, isString], "promoted_asset_count": [true, isInteger], "schema_version": [true, either([isInteger, isNull] as const)], "state": [true, checkBatchState] } as const);

export const checkBatchMembershipOut: Check<Schemas["BatchMembershipOut"]> =
  /*#__PURE__*/ object({ "batch": [true, checkBatchOut], "changed": [true, arrayOf(isString)] } as const);

export const checkBatchPage: Check<Schemas["BatchPage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkBatchOut)], "total": [true, isInteger] } as const);

export const checkConnectionAction: Check<Schemas["ConnectionAction"]> =
  /*#__PURE__*/ oneOf(["download_weights", "check_integrity", "update", "delete"] as const);

export const checkConnectionSetupState: Check<Schemas["ConnectionSetupState"]> =
  /*#__PURE__*/ oneOf(["not_set_up", "ready"] as const);

export const checkConnectionType: Check<Schemas["ConnectionType"]> =
  /*#__PURE__*/ oneOf(["local", "http"] as const);

export const checkModelCapability: Check<Schemas["ModelCapability"]> =
  /*#__PURE__*/ oneOf(["point_suggest", "text_detect"] as const);

export const checkPrecision: Check<Schemas["Precision"]> =
  /*#__PURE__*/ oneOf(["fp16", "fp32"] as const);

export const checkConnectionOut: Check<Schemas["ConnectionOut"]> =
  /*#__PURE__*/ object({ "allowed_actions": [true, arrayOf(checkConnectionAction)], "capabilities": [true, arrayOf(checkModelCapability)], "connection_type": [true, checkConnectionType], "created_at": [true, isString], "device": [true, either([isString, isNull] as const)], "endpoint_url": [true, either([isString, isNull] as const)], "id": [true, isString], "model_id": [true, isString], "model_revision": [true, isString], "name": [true, isString], "precision": [true, either([checkPrecision, isNull] as const)], "setup_state": [true, checkConnectionSetupState], "updated_at": [true, isString] } as const);

export const checkConnectionPage: Check<Schemas["ConnectionPage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkConnectionOut)], "total": [true, isInteger] } as const);

export const checkDatasetChangeOut: Check<Schemas["DatasetChangeOut"]> =
  /*#__PURE__*/ object({ "actor": [true, either([isString, isNull] as const)], "dataset_id": [true, isString], "id": [true, isString], "occurred_at": [true, isString], "operation": [true, isString], "subject_ids": [true, arrayOf(isString)] } as const);

export const checkDatasetChangePage: Check<Schemas["DatasetChangePage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkDatasetChangeOut)], "total": [true, isInteger] } as const);

export const checkDatasetOut: Check<Schemas["DatasetOut"]> =
  /*#__PURE__*/ object({ "description": [true, either([isString, isNull] as const)], "id": [true, isString], "name": [true, isString], "project_id": [true, isString] } as const);

export const checkClassCountOut: Check<Schemas["ClassCountOut"]> =
  /*#__PURE__*/ object({ "annotations": [true, isInteger], "assets": [true, isInteger], "label_class": [true, isString] } as const);

export const checkDatasetStatsOut: Check<Schemas["DatasetStatsOut"]> =
  /*#__PURE__*/ object({ "annotated_asset_count": [true, isInteger], "annotation_count": [true, isInteger], "asset_count": [true, isInteger], "classes": [true, arrayOf(checkClassCountOut)], "dataset_id": [true, isString] } as const);

export const checkDownloadSizeOut: Check<Schemas["DownloadSizeOut"]> =
  /*#__PURE__*/ object({ "file_count": [true, isInteger], "model_id": [true, isString], "model_revision": [true, isString], "total_bytes": [true, isInteger] } as const);

export const checkClassExportStatus: Check<Schemas["ClassExportStatus"]> =
  /*#__PURE__*/ oneOf(["supported", "degraded", "dropped"] as const);

export const checkGeometryType: Check<Schemas["GeometryType"]> =
  /*#__PURE__*/ oneOf(["bbox", "polygon", "mask", "polyline", "keypoints", "cuboid_3d", "polyline_3d", "classification_tag"] as const);

export const checkClassCompatibilityOut: Check<Schemas["ClassCompatibilityOut"]> =
  /*#__PURE__*/ object({ "annotations": [true, isInteger], "assets": [true, isInteger], "geometry": [true, checkGeometryType], "label_class": [true, isString], "reason": [false, either([isString, isNull] as const)], "status": [true, checkClassExportStatus] } as const);

export const checkExportCompatibilityOut: Check<Schemas["ExportCompatibilityOut"]> =
  /*#__PURE__*/ object({ "classes": [true, arrayOf(checkClassCompatibilityOut)], "compatible": [true, isBoolean], "degraded_annotations": [true, isInteger], "degraded_assets": [true, isInteger], "excluded_annotations": [true, isInteger], "excluded_assets": [true, isInteger], "format": [true, isString], "format_is_lossy": [true, isBoolean], "release_id": [true, isString] } as const);

export const checkFormatOut: Check<Schemas["FormatOut"]> =
  /*#__PURE__*/ object({ "degraded_geometries": [true, arrayOf(isString)], "geometries": [true, arrayOf(isString)], "lossy": [true, isBoolean], "modalities": [true, arrayOf(isString)], "name": [true, isString] } as const);

export const checkFormatPage: Check<Schemas["FormatPage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkFormatOut)], "total": [true, isInteger] } as const);

export const checkIngestFailureKind: Check<Schemas["IngestFailureKind"]> =
  /*#__PURE__*/ oneOf(["unsupported", "corrupt", "partial"] as const);

export const checkIngestFailureOut: Check<Schemas["IngestFailureOut"]> =
  /*#__PURE__*/ object({ "frames_expected_estimate": [true, either([isInteger, isNull] as const)], "frames_produced": [true, either([isInteger, isNull] as const)], "kind": [true, checkIngestFailureKind], "name": [true, isString], "reason": [true, isString] } as const);

export const checkIngestState: Check<Schemas["IngestState"]> =
  /*#__PURE__*/ oneOf(["pending", "running", "completed", "failed"] as const);

export const checkIngestJobOut: Check<Schemas["IngestJobOut"]> =
  /*#__PURE__*/ object({ "batch_id": [true, either([isString, isNull] as const)], "batch_name": [true, either([isString, isNull] as const)], "error": [true, either([isString, isNull] as const)], "failures": [true, arrayOf(checkIngestFailureOut)], "id": [true, isString], "processed": [true, isInteger], "source_id": [true, isString], "state": [true, checkIngestState], "total": [true, either([isInteger, isNull] as const)] } as const);

export const checkIngestJobPage: Check<Schemas["IngestJobPage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkIngestJobOut)], "total": [true, isInteger] } as const);

export const checkAnnotationJobState: Check<Schemas["AnnotationJobState"]> =
  /*#__PURE__*/ oneOf(["pending", "in_progress", "completed"] as const);

export const checkJobAction: Check<Schemas["JobAction"]> =
  /*#__PURE__*/ oneOf(["start", "complete"] as const);

export const checkJobOut: Check<Schemas["JobOut"]> =
  /*#__PURE__*/ object({ "allowed_actions": [true, arrayOf(checkJobAction)], "asset_count": [true, isInteger], "batch_id": [true, isString], "id": [true, isString], "state": [true, checkAnnotationJobState] } as const);

export const checkJobPage: Check<Schemas["JobPage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkJobOut)], "total": [true, isInteger] } as const);

export const checkProjectOut: Check<Schemas["ProjectOut"]> =
  /*#__PURE__*/ object({ "description": [true, either([isString, isNull] as const)], "id": [true, isString], "name": [true, isString] } as const);

export const checkProjectPage: Check<Schemas["ProjectPage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkProjectOut)], "total": [true, isInteger] } as const);

export const checkProjectStatsOut: Check<Schemas["ProjectStatsOut"]> =
  /*#__PURE__*/ object({ "annotated_asset_count": [true, isInteger], "annotated_pct": [true, isNumber], "annotation_count": [true, isInteger], "asset_count": [true, isInteger], "class_count": [true, isInteger], "classes": [true, arrayOf(checkClassCountOut)], "last_ingest_at": [false, either([isString, isNull] as const)], "project_id": [true, isString] } as const);

export const checkSplitRecipeBody: Check<Schemas["SplitRecipeBody"]> =
  /*#__PURE__*/ object({ "seed": [true, isInteger], "test": [true, isNumber], "train": [true, isNumber], "val": [true, isNumber] } as const);

export const checkReleaseOut: Check<Schemas["ReleaseOut"]> =
  /*#__PURE__*/ object({ "annotation_count": [true, isInteger], "asset_count": [true, isInteger], "created_at": [true, isString], "dataset_id": [true, isString], "id": [true, isString], "manifest_hash": [true, isString], "schema_version": [true, isInteger], "split": [true, either([checkSplitRecipeBody, isNull] as const)], "tag": [true, isString], "visionset_version": [true, isString] } as const);

export const checkReleasePage: Check<Schemas["ReleasePage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkReleaseOut)], "total": [true, isInteger] } as const);

export const checkReleaseVerificationOut: Check<Schemas["ReleaseVerificationOut"]> =
  /*#__PURE__*/ object({ "cache_mismatches": [true, arrayOf(isString)], "checked": [true, isInteger], "corrupt": [true, arrayOf(isString)], "manifest_hash": [true, isString], "manifest_intact": [true, isBoolean], "missing": [true, arrayOf(isString)], "ok": [true, isBoolean], "release_id": [true, isString] } as const);

export const checkChangeKind: Check<Schemas["ChangeKind"]> =
  /*#__PURE__*/ oneOf(["additive", "destructive"] as const);

export const checkSchemaChangeOut: Check<Schemas["SchemaChangeOut"]> =
  /*#__PURE__*/ object({ "attribute": [true, either([isString, isNull] as const)], "detail": [true, isString], "kind": [true, checkChangeKind], "label_class": [true, isString] } as const);

export const checkSchemaDiffOut: Check<Schemas["SchemaDiffOut"]> =
  /*#__PURE__*/ object({ "changes": [true, arrayOf(checkSchemaChangeOut)], "destructive_classes": [true, arrayOf(isString)], "is_destructive": [true, isBoolean] } as const);

export const checkAttributeBody: Check<Schemas["AttributeBody"]> =
  /*#__PURE__*/ object({ "default": [false, either([isBoolean, isNumber, isString, isNull] as const)], "kind": [true, oneOf(["string", "number", "boolean", "select"] as const)], "name": [true, isString], "options": [false, either([arrayOf(isString), isNull] as const)], "required": [true, isBoolean] } as const);

export const checkLabelClassBody: Check<Schemas["LabelClassBody"]> =
  /*#__PURE__*/ object({ "attributes": [true, arrayOf(checkAttributeBody)], "color": [false, either([isString, isNull] as const)], "geometry": [true, checkGeometryType], "name": [true, isString] } as const);

export const checkSchemaProvenance: Check<Schemas["SchemaProvenance"]> =
  /*#__PURE__*/ oneOf(["curated", "annotation"] as const);

export const checkSchemaVersionOut: Check<Schemas["SchemaVersionOut"]> =
  /*#__PURE__*/ object({ "classes": [true, arrayOf(checkLabelClassBody)], "created_at": [false, either([isString, isNull] as const)], "description": [false, either([isString, isNull] as const)], "project_id": [true, isString], "provenance": [false, either([checkSchemaProvenance, isNull] as const)], "version": [true, isInteger] } as const);

export const checkSchemaVersionPage: Check<Schemas["SchemaVersionPage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkSchemaVersionOut)], "total": [true, isInteger] } as const);

export const checkSourceKind: Check<Schemas["SourceKind"]> =
  /*#__PURE__*/ oneOf(["image_directory", "video"] as const);

export const checkVideoProvenanceOut: Check<Schemas["VideoProvenanceOut"]> =
  /*#__PURE__*/ object({ "codec": [true, isString], "duration_seconds": [true, isNumber], "extraction_fps": [true, isNumber], "fps": [true, isNumber], "height": [true, isInteger], "width": [true, isInteger] } as const);

export const checkSourceOut: Check<Schemas["SourceOut"]> =
  /*#__PURE__*/ object({ "id": [true, isString], "kind": [true, checkSourceKind], "name": [true, isString], "project_id": [true, isString], "registered_at": [true, isString], "video": [true, either([checkVideoProvenanceOut, isNull] as const)] } as const);

export const checkSourcePage: Check<Schemas["SourcePage"]> =
  /*#__PURE__*/ object({ "items": [true, arrayOf(checkSourceOut)], "total": [true, isInteger] } as const);

export const checkSplitAssignmentOut: Check<Schemas["SplitAssignmentOut"]> =
  /*#__PURE__*/ object({ "test": [true, arrayOf(isString)], "train": [true, arrayOf(isString)], "val": [true, arrayOf(isString)] } as const);

export const checkBboxGeometry: Check<Schemas["BboxGeometry"]> =
  /*#__PURE__*/ object({ "height": [true, isNumber], "type": [true, lit("bbox")], "width": [true, isNumber], "x": [true, isNumber], "y": [true, isNumber] } as const);

export const checkClassificationGeometry: Check<Schemas["ClassificationGeometry"]> =
  /*#__PURE__*/ object({ "type": [true, lit("classification_tag")] } as const);

export const checkPolygonGeometry: Check<Schemas["PolygonGeometry"]> =
  /*#__PURE__*/ object({ "points": [true, arrayOf(tuple([isNumber, isNumber] as const))], "type": [true, lit("polygon")] } as const);

export const checkPolylineGeometry: Check<Schemas["PolylineGeometry"]> =
  /*#__PURE__*/ object({ "points": [true, arrayOf(tuple([isNumber, isNumber] as const))], "type": [true, lit("polyline")] } as const);

export const checkSuggestedRegion: Check<Schemas["SuggestedRegion"]> =
  /*#__PURE__*/ object({ "confidence": [true, isNumber], "geometry": [true, tagged("type", { "bbox": checkBboxGeometry, "classification_tag": checkClassificationGeometry, "polygon": checkPolygonGeometry, "polyline": checkPolylineGeometry })] } as const);

export const checkSuggestionOut: Check<Schemas["SuggestionOut"]> =
  /*#__PURE__*/ object({ "model_ref": [true, isString], "region": [false, either([checkSuggestedRegion, isNull] as const)] } as const);

// One alias per operation. `unwrap` takes these, never a schema check directly, so that
// `tests/scripts/checks_wiring.test.mjs` can pair every call with its own operationId.

export const checkAddAnnotations = checkAnnotationPage;
export const checkAddBatchAssets = checkBatchMembershipOut;
export const checkApproveBatch = checkBatchOut;
export const checkCancelBackgroundJob = checkBackgroundJobOut;
export const checkCheckConnectionIntegrity = checkBackgroundJobOut;
export const checkCheckExport = checkExportCompatibilityOut;
export const checkCompareSchemaVersions = checkSchemaDiffOut;
export const checkCompleteBatch = checkBatchOut;
export const checkCompleteJob = checkJobOut;
export const checkCreateBatch = checkBatchOut;
export const checkCreateCorrectionBatch = checkBatchOut;
export const checkCreateInferenceConnection = checkConnectionOut;
export const checkCreateProject = checkProjectOut;
export const checkCreateSchemaVersion = checkSchemaVersionOut;
export const checkDatasetStats = checkDatasetStatsOut;
export const checkDeleteAnnotations = checkNoContent;
export const checkDeleteBatch = checkNoContent;
export const checkDeleteInferenceConnection = checkNoContent;
export const checkDeleteProject = checkNoContent;
export const checkDownloadConnectionWeights = checkBackgroundJobOut;
export const checkExportRelease = checkBackgroundJobOut;
export const checkGetActiveSchema = checkSchemaVersionOut;
export const checkGetAsset = checkAssetOut;
export const checkGetAssetContent = checkBlob;
export const checkGetAssetThumbnail = checkBlob;
export const checkGetBackgroundJob = checkBackgroundJobOut;
export const checkGetBackgroundJobArtifact = checkBlob;
export const checkGetBatch = checkBatchOut;
export const checkGetDataset = checkDatasetOut;
export const checkGetInferenceConnection = checkConnectionOut;
export const checkGetIngestJob = checkIngestJobOut;
export const checkGetJob = checkJobOut;
export const checkGetJobProgress = checkProgressCounts;
export const checkGetProject = checkProjectOut;
export const checkGetProjectDataset = checkDatasetOut;
export const checkGetProjectStats = checkProjectStatsOut;
export const checkGetRelease = checkReleaseOut;
export const checkGetReleaseAssignment = checkSplitAssignmentOut;
export const checkGetReleaseManifest = checkBlob;
export const checkGetSchemaVersion = checkSchemaVersionOut;
export const checkGetSource = checkSourceOut;
export const checkHealth: Check<operations["health"]["responses"][200]["content"]["application/json"]> =
  /*#__PURE__*/ mapOf(isString);
export const checkInferenceDownloadSize = checkDownloadSizeOut;
export const checkListAssetAnnotations = checkAnnotationPage;
export const checkListAssetBatches = checkBatchPage;
export const checkListBackgroundJobs = checkBackgroundJobPage;
export const checkListBatchAssets = checkBatchAssetPage;
export const checkListBatchJobs = checkJobPage;
export const checkListBatches = checkBatchPage;
export const checkListDatasetAssets = checkAssetPage;
export const checkListDatasetChanges = checkDatasetChangePage;
export const checkListFormats = checkFormatPage;
export const checkListInferenceConnections = checkConnectionPage;
export const checkListIngestJobs = checkIngestJobPage;
export const checkListProjectAssets = checkAssetPage;
export const checkListProjects = checkProjectPage;
export const checkListReleases = checkReleasePage;
export const checkListSchemaVersions = checkSchemaVersionPage;
export const checkListSources = checkSourcePage;
export const checkNextPendingAssets = checkAssetPage;
export const checkPromoteBatch = checkAssetPage;
export const checkPublishRelease = checkReleaseOut;
export const checkRegisterImageSource = checkSourceOut;
export const checkRegisterVideoSource = checkSourceOut;
export const checkRemoveBatchAssets = checkBatchMembershipOut;
export const checkRemoveDatasetAsset = checkNoContent;
export const checkRenameProject = checkProjectOut;
export const checkRepinBatch = checkBatchOut;
export const checkResumeIngest = checkIngestJobOut;
export const checkSetAssetProgress = checkAssetProgressOut;
export const checkStartBatch = checkBatchOut;
export const checkStartIngest = checkIngestJobOut;
export const checkStartJob = checkJobOut;
export const checkSuggestRegion = checkSuggestionOut;
export const checkUpdateAnnotations = checkAnnotationPage;
export const checkUpdateInferenceConnection = checkConnectionOut;
export const checkVerifyRelease = checkReleaseVerificationOut;
