"""The JSON shape each ``visionset.wire`` projection returns, one TypedDict apiece.

Kept apart from ``wire/__init__.py`` so the names do not collide with the kernel
domain classes it imports. Pydantic derives the JSON Schema an MCP tool publishes
from these, so they carry no docstrings and every one forbids extra keys.
"""

from typing import Any, Generic, Literal, NotRequired, TypeVar

from pydantic import ConfigDict, with_config
from typing_extensions import TypedDict

T = TypeVar("T")

closed = with_config(ConfigDict(extra="forbid"))

AttributeKind = Literal["string", "number", "boolean", "select"]
Provenance = Literal["human", "model", "import"]
AttributeValue = bool | float | str


@closed
class Page(TypedDict, Generic[T]):
    items: list[T]
    total: int


@closed
class Project(TypedDict):
    id: str
    name: str
    description: str | None
    thumbnail_asset_id: str | None
    thumbnail_hash: str | None
    created_at: str | None


@closed
class Dataset(TypedDict):
    id: str
    project_id: str
    name: str
    description: str | None


@closed
class Attribute(TypedDict):
    name: str
    kind: AttributeKind
    required: bool
    options: list[str] | None
    default: AttributeValue | None


@closed
class LabelClass(TypedDict):
    name: str
    geometries: list[str]
    color: str | None
    attributes: list[Attribute]


@closed
class SchemaVersion(TypedDict):
    project_id: str
    version: int
    classes: list[LabelClass]
    description: str | None
    created_at: str | None
    provenance: str | None


@closed
class DraftAttribute(TypedDict):
    name: str
    kind: AttributeKind | None
    required: bool
    options: list[str] | None
    default: AttributeValue | None


@closed
class DraftLabelClass(TypedDict):
    name: str
    geometries: list[str]
    color: str | None
    attributes: list[DraftAttribute]


@closed
class SchemaDraft(TypedDict):
    project_id: str
    kind: str
    classes: list[DraftLabelClass]
    note: str | None
    based_on: int | None
    revision: int
    updated_at: str


@closed
class SchemaPublication(TypedDict):
    published: SchemaVersion
    advanced_batches: list[str]


@closed
class SchemaChange(TypedDict):
    kind: str
    label_class: str
    attribute: str | None
    detail: str


@closed
class SchemaDiff(TypedDict):
    is_destructive: bool
    destructive_classes: list[str]
    changes: list[SchemaChange]


@closed
class ClassCount(TypedDict):
    label_class: str
    annotations: int
    assets: int


@closed
class SchemaChangePreview(TypedDict):
    diff: SchemaDiff
    blockers: list[ClassCount]
    is_refused: bool


@closed
class Asset(TypedDict):
    id: str
    project_id: str
    modality: str
    content_hash: str
    width: int | None
    height: int | None
    format: str | None
    source_id: str | None
    frame_index: int | None
    frame_timestamp: float | None
    thumbnail_hash: str | None
    ingested_at: str | None


@closed
class BlockingAsset(TypedDict):
    asset: Asset
    label_classes: list[str]
    annotations: int
    batch_ids: list[str]


@closed
class TimeRange(TypedDict):
    start_seconds: float
    end_seconds: float


@closed
class VideoProvenance(TypedDict):
    width: int
    height: int
    fps: float | None
    duration_seconds: float
    codec: str
    extraction_fps: float
    scale_percent: int
    policy_version: int | None
    materializer: str | None
    ranges: list[TimeRange]


@closed
class Source(TypedDict):
    id: str
    project_id: str
    kind: str
    name: str
    registered_at: str
    video: VideoProvenance | None


@closed
class CameraIntrinsics(TypedDict):
    fx: float
    fy: float
    cx: float
    cy: float
    skew: float
    width: int
    height: int


@closed
class SensorExtrinsics(TypedDict):
    rotation: list[list[float]]
    translation: list[float]


@closed
class Distortion(TypedDict):
    model: Literal["plumb_bob"]
    k1: float
    k2: float
    p1: float
    p2: float
    k3: float


@closed
class Calibration(TypedDict):
    intrinsics: CameraIntrinsics
    extrinsics: SensorExtrinsics
    distortion: Distortion | None


@closed
class SourceCalibration(TypedDict):
    source_id: str
    calibration: Calibration | None


@closed
class AssetCalibration(TypedDict):
    asset_id: str
    override: Calibration | None
    effective: Calibration | None


@closed
class IngestFailure(TypedDict):
    name: str
    kind: str
    reason: str


@closed
class IngestJob(TypedDict):
    id: str
    source_id: str
    state: str
    error: str | None
    batch_id: str | None
    batch_name: str | None
    processed: int
    total: int | None
    failures: list[IngestFailure]


@closed
class BatchAsset(Asset):
    job_id: str | None
    progress: str | None
    allowed_actions: list[str]
    annotation_count: int
    min_confidence: float | None


@closed
class ThumbnailBackfill(TypedDict):
    project_id: str
    examined: int
    filled: list[str]
    missing: list[str]
    unreadable: list[IngestFailure]


@closed
class ProgressCounts(TypedDict):
    unannotated: int
    pre_labeled: int
    annotated: int
    skipped: int
    review_pending: int
    accepted: int
    total: int


@closed
class PreLabelRun(TypedDict):
    annotation_job_id: str
    job_id: str
    state: str
    assets_processed: int
    assets_total: int | None
    error: str | None
    error_code: str | None
    stopped_early: bool | None
    assets_labeled: int | None
    regions_discarded: int | None
    regions_out_of_bounds: int | None
    annotations_replaced: int | None


@closed
class ExcludedClass(TypedDict):
    name: str
    reasons: list[str]


@closed
class PreLabelPlan(TypedDict):
    schema_version: int
    asked_classes: list[str]
    produces: list[str]
    excluded_classes: list[ExcludedClass]


@closed
class Batch(TypedDict):
    id: str
    project_id: str
    name: str
    state: str
    schema_version: int | None
    asset_count: int
    progress: ProgressCounts
    allowed_actions: list[str]
    promoted_asset_count: int
    parent_batch_id: str | None
    pre_label_run: PreLabelRun | None


@closed
class Job(TypedDict):
    id: str
    batch_id: str
    state: str
    assignee: str | None
    asset_count: int
    allowed_actions: list[str]
    pre_label_run: PreLabelRun | None


@closed
class AssetProgress(TypedDict):
    asset_id: str
    progress: str


@closed
class BboxGeometry(TypedDict):
    type: Literal["bbox"]
    x: float
    y: float
    width: float
    height: float


@closed
class PolygonGeometry(TypedDict):
    type: Literal["polygon"]
    points: list[list[float]]


@closed
class PolylineGeometry(TypedDict):
    type: Literal["polyline"]
    points: list[list[float]]
    visibility: NotRequired[list[Literal[0, 1, 2]]]


@closed
class ClassificationGeometry(TypedDict):
    type: Literal["classification_tag"]


Geometry = BboxGeometry | PolygonGeometry | PolylineGeometry | ClassificationGeometry


@closed
class Annotation(TypedDict):
    id: str
    asset_id: str
    label_class: str
    schema_version: int
    geometry: Geometry
    attributes: dict[str, Any]
    provenance: Provenance
    model_ref: str | None
    confidence: float | None
    job_id: str | None


@closed
class DatasetStats(TypedDict):
    dataset_id: str
    asset_count: int
    annotated_asset_count: int
    annotation_count: int
    classes: list[ClassCount]


@closed
class SplitRecipe(TypedDict):
    train: float
    val: float
    test: float
    seed: int


@closed
class Release(TypedDict):
    id: str
    dataset_id: str
    tag: str
    manifest_hash: str
    schema_version: int
    asset_count: int
    annotation_count: int
    split: SplitRecipe | None
    created_at: str
    visionset_version: str | None


@closed
class Token(TypedDict):
    name: str
    created_at: str
    revoked_at: str | None


@closed
class ReleaseVerification(TypedDict):
    release_id: str
    manifest_hash: str
    manifest_intact: bool
    ok: bool
    checked: int
    missing: list[str]
    corrupt: list[str]
    cache_mismatches: list[str]


@closed
class ExportFormat(TypedDict):
    name: str
    lossy: bool
    geometries: list[str]
    degraded_geometries: list[str]
    modalities: list[str]
    targets: list[str]


@closed
class CuratedModel(TypedDict):
    provider_id: str
    model_id: str
    model_revision: str
    family: str
    capability: str
    hint: str | None
    access_note: str | None
    access_url: str | None


@closed
class Provider(TypedDict):
    provider_id: str
    families: dict[str, str]
    curated: list[CuratedModel]


@closed
class PreprocessingHints(TypedDict):
    recommended_size: list[int] | None
    recommended_strategy: str | None
    trainer_resizes: bool
    augmentation_common: bool


@closed
class ExportTarget(TypedDict):
    name: str
    label: str
    family: str
    format: str
    tasks: list[str]
    geometries: list[str]
    hints: PreprocessingHints


@closed
class ClassCompatibility(TypedDict):
    label_class: str
    geometry: str
    status: str
    annotations: int
    assets: int
    reason: str | None


@closed
class ExportCompatibility(TypedDict):
    release_id: str
    format: str
    target: str | None
    compatible: bool
    format_is_lossy: bool
    excluded_annotations: int
    excluded_assets: int
    degraded_annotations: int
    degraded_assets: int
    classes: list[ClassCompatibility]


@closed
class ResizeStep(TypedDict):
    kind: Literal["resize"]
    strategy: str
    width: int
    height: int
    pad_value: int


@closed
class AugmentStep(TypedDict):
    kind: Literal["augment"]
    op: str
    amount: float


RecipeStep = ResizeStep | AugmentStep


@closed
class RecipeSpec(TypedDict):
    target: str | None
    steps: list[RecipeStep]
    variants_per_asset: int


@closed
class RecipeUsage(TypedDict):
    export_count: int
    release_id: str
    release_tag: str
    target: str | None
    format: str


@closed
class PreprocessingRecipe(TypedDict):
    id: str
    project_id: str
    name: str
    spec: RecipeSpec
    created_at: str
    updated_at: str
    used_by: RecipeUsage | None


@closed
class TransformedAnnotation(TypedDict):
    id: str
    label_class: str
    schema_version: int
    geometry: Geometry
    attributes: dict[str, Any]
    provenance: Provenance
    model_ref: str | None
    confidence: float | None


@closed
class PreprocessingPreview(TypedDict):
    asset_id: str
    variant: int
    width: int | None
    height: int | None
    original_width: int | None
    original_height: int | None
    frame_index: int | None
    source_name: str | None
    annotations: list[TransformedAnnotation]
    image_base64: str
    media_type: str


@closed
class ExportFileMapping(TypedDict):
    file: str
    source_content_hash: str
    exported_sha256: str
    variant: int | None


@closed
class ExportPreprocessing(TypedDict):
    recipe_name: str | None
    spec: RecipeSpec
    recipe_hash: str
    pillow_version: str
    mapping: list[ExportFileMapping]


@closed
class ExportResult(TypedDict):
    release_id: str
    format: str
    target: str | None
    directory: str
    file_count: int
    total_bytes: int
    source_file_count: int
    augmented_file_count: int
    source_annotation_count: int
    augmented_annotation_count: int
    compatibility: ExportCompatibility
    preprocessing: ExportPreprocessing | None


@closed
class ImportLoss(TypedDict):
    kind: str
    subject: str
    count: int
    reason: str


@closed
class ImportedClass(TypedDict):
    name: str
    geometries: list[str]


@closed
class ImportPlan(TypedDict):
    project_id: str
    format: str
    classes: list[ImportedClass]
    source_images: int
    images: int
    labels: int
    missing_images: list[str]
    losses: list[ImportLoss]
    loss_kinds: list[str]
    conflicts: list[str]
    creates_schema: bool
    new_assets: int
    new_annotations: int
    annotations_already_present: int


@closed
class ImportRun(TypedDict):
    project_id: str
    format: str
    batch_id: str | None
    schema_version: int | None
    asset_count: int
    created_asset_count: int
    annotations_written: int
    annotations_already_present: int
    losses: list[ImportLoss]


@closed
class WeightDownload(TypedDict):
    job_id: str
    state: str
    bytes_done: int
    bytes_total: int | None
    error: str | None
    error_code: str | None


@closed
class IntegrityCheck(TypedDict):
    job_id: str
    state: str
    files_read: int
    files_total: int | None
    error: str | None
    error_code: str | None


@closed
class Connection(TypedDict):
    id: str
    name: str
    connection_type: str
    model_id: str
    model_revision: str
    device: str | None
    precision: str | None
    endpoint_url: str | None
    setup_state: str
    provider_id: str | None
    credential_env: str | None
    origin: str
    allowed_actions: list[str]
    capabilities: list[str]
    produces: list[str]
    download: WeightDownload | None
    integrity_check: IntegrityCheck | None
    created_at: str
    updated_at: str


@closed
class DownloadSize(TypedDict):
    model_id: str
    model_revision: str
    total_bytes: int | None
    file_count: int
