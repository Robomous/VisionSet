# Pre-processing

An optional stage between a release and the files a trainer reads: resize every exported image to
one size, and write augmented variants of the training images beside their sources. It is
declared as a **recipe** - a named project resource - and applied at export, by name, beside the
target. Releases and manifests are untouched: a release is still the frozen inventory it always
was, and a recipe is what one export chose to do with it.

```python
from visionset.kernel.domain import AugmentOp, AugmentStep, RecipeSpec, ResizeStep, ResizeStrategy
from visionset.kernel.services import PreprocessingRecipeService, ReleaseService
from visionset.preprocessing.registry import drivers

spec = RecipeSpec(
    target="yolo11",
    steps=(
        ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=640, height=640),
        AugmentStep(op=AugmentOp.HFLIP),
        AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.2),
    ),
    variants_per_asset=2,
)
recipe = PreprocessingRecipeService(workspace).create(project.id, "yolo-640", spec)
ReleaseService(workspace).export(
    release.id,
    exporter,
    dest,
    target=target,
    recipe=recipe.spec,
    recipe_name=recipe.name,
    drivers=drivers(),
)
```

## A recipe is a value

`RecipeSpec` is what an export snapshots: the steps, in order, and how many augmented variants
each training image gets. `PreprocessingRecipe` wraps one under a name so a project can list and
edit it. The two are deliberately separate, because **an export keeps the spec by value**:
editing or deleting a recipe after an export changes nothing about that export, and the export
report carries the spec it ran with, its hash, and the Pillow version that produced the bytes.

There is no state on a recipe and no `allowed_actions` vocabulary. Nothing depends on the stored
value once an export has run, so every operation is always offered and every write is
unconditional - the one resource here that a schema draft's revision protocol does not apply to.

`recipe_hash(spec)` is `sha256` over the spec's canonical bytes, the same encoder and digest the
manifest uses, so two exports carrying the same spec carry the same hash whatever order the
fields were written in.

## Which exports ran a recipe

Every recipe a surface returns carries `used_by`: how many succeeded exports ran it
(`export_count`), and the newest one's `release_id`, `release_tag`, `target` and `format` -
`target` is null for an export that named a format rather than a target. `used_by` is null when
no export ran it. `PreprocessingRecipeService.usage(project_id)` reads it once for the whole
project, from the workspace's succeeded `export.release` jobs and the project's releases, so
its cost does not grow with the number of recipes listed.

The relation exists only on the job side, and it is **matched by name**: the job's recipe
snapshot keeps the name the recipe had when the export was asked for, and nothing else
identifies it. Three consequences follow, and all three are by design:

- a renamed recipe leaves the exports it ran under its old name behind;
- a new recipe created under a deleted recipe's name inherits that recipe's exports;
- only queued exports count - `POST /releases/{id}/export` leaves a job behind, while the CLI's
  `export` and MCP's `export_release` write straight to a directory and leave no record.

## The grammar

| Step | Fields | What it does |
| --- | --- | --- |
| `resize` | `strategy` (`letterbox`, `stretch`, `fill` or `center_crop`), `width`, `height` (32 to 8192), `pad_value` (0 to 255, default 114) | Every exported image, base and variant, lands at `width × height`. `stretch` scales each axis on its own; `letterbox` keeps the aspect, scales to fit, and pads the rest with `pad_value` - the grey YOLO trainers letterbox with themselves. `fill` keeps the aspect, scales by `max(W'/W, H'/H)` so the image covers the canvas, and crops the overflow, centred. `center_crop` does not scale: it cuts a centred `width × height` window out of the source, and pads with `pad_value` along an axis where the source is smaller than the window. The two cropping strategies can cut labels down or away - see [Cropping](#cropping-what-survives-the-cut). |
| `augment` | `op` (`hflip`, `brightness_contrast`, `rot90`), `amount` (above 0 and at most 0.5, default 0.2), `version` (default 1), `params` (default none) | One augmentation applied when generating variants. `amount` bounds the brightness and contrast factors and means nothing to the other two. `version` names which [registered version](#the-augmentation-registry) of the op runs, and `params` holds the parameters that version declares beyond `amount` - none, for every op today. The SDK, MCP's recipe tools and the CLI's `--spec FILE` accept and validate both, since they take the spec itself; the REST body, the CLI flag form and every surface's read-back carry neither yet, so only their legacy values are usable end to end - which is every value the registry holds today. |

Cross-field rules, refused with the rule named: at most one `resize` step, and it comes first;
each `op` at most once; an `augment` step needs `variants_per_asset` of at least 1; and
`variants_per_asset` (0 to 8) needs at least one `augment` step. `target` records which export
target's hints the recipe was written from and is informational - nothing resolves it, and a
recipe applies to any export.

A step's `version` must be one the registry holds for its `op`, and every key in `params` must be
a parameter that version declares, of its declared type and inside its range; `amount` is the
step's own field and never a member of `params`. Each is refused with the reason named. `version`
and `params` are left out of a stored or hashed step while they hold their legacy values -
version 1, no params - so a recipe written before they existed keeps its canonical bytes and its
`recipe_hash`, and so does one that spells `"version": 1` out.

The hints come from the target: `GET /export-targets`, `visionset target list` and
`list_export_targets` carry `recommended_size`, `recommended_strategy`, `trainer_resizes` and
`augmentation_common` for each, and a surface preselects from them. Every YOLO target resizes on
its own, so pre-resizing is a choice about archive size and loading speed rather than a
requirement.

## The augmentation registry

What an augmentation *is* is declared once, in `AUGMENT_OPERATIONS` (`augment_operations()` lists
it in its stable order: by op, then version), and never inferred from the code that runs it. Each
`AugmentOperation` is one `(op, version)` and declares:

| Field | What it says |
| --- | --- |
| `parameters` | Every parameter the step carries, with its type (`float`, `int` or `bool`), default and range. `inert` marks one the step validates but the operation never reads. |
| `family` | `spatial` (moves pixels, and so labels) or `photometric` (changes pixel values only). |
| `modalities` | What the operation can run on. `image` only; a scan is refused. |
| `geometries` | What it can transform - read from `AUGMENT_GEOMETRIES`, the table the geometry transform refuses by, never restated. |
| `tasks` | The trainer tasks it can serve. A task not listed is unsupported, not assumed. |
| `semantics` | What it does to a label's meaning: `preserves`, `mirrors` (a class named for a side now names the other) or `reorients` (a class tied to up or down may not survive). |
| `loss` | `lossless` (never cuts a label it supports) or `lossy` (asks the same explicit consent a cropping resize does). |
| `drivers` | The built-in drivers that apply it. |
| `preview` | Whether a preview's `showcase` can show it at its declared strength. |

| op | version | family | `amount` | semantics | loss | tasks |
| --- | --- | --- | --- | --- | --- | --- |
| `hflip` | 1 | spatial | inert | mirrors | lossless | detect, segment, classify, obb, semantic |
| `brightness_contrast` | 1 | photometric | bounds both factors | preserves | lossless | detect, segment, classify, pose, obb, semantic |
| `rot90` | 1 | spatial | inert | reorients | lossless | detect, segment, classify, obb, semantic |

All three run on images, are applied by the built-in Pillow driver and can be previewed. `pose` is
absent from the two spatial ops because no keypoint geometry yet says which point becomes which
under a mirror or a turn, and `depth` from all three because no label the system carries is a
depth map. A registered version is never changed: a different default, draw or behaviour is a
new version beside it, so a stored recipe keeps meaning what it meant. `modalities`, `geometries`,
`tasks`, `loss` and `drivers` are what the [compatibility resolver](#which-step-serves-which-label)
refuses an export by. See
[An augmentation is a registered version](architecture/decisions/an-augmentation-is-a-registered-version.md)
for the rule and why it holds.

## Which step serves which label

Before an export transforms anything, `resolve_augmentation(recipe, carried, target_tasks=,
installed_step_kinds=)` judges every step of the recipe against every `(class, geometry,
modality)` the export would hand its plugin, and answers one `StepCompatibility` per pair:
`supported`, `conditional` (it runs and loses labels the export report counts and consent must
cover) or `refused`, with every reason that applies and a one-sentence message. Pre-flight
(`check_export`, `require_export_consent`) and the export itself compute it the same way, from
the same inputs, and `ReleaseService.recipe_compatibility` returns it to an SDK caller without
refusing anything. Nothing stops at the first problem: a mixed release gets an entry for every
class and geometry that fails, so a refusal names all of them.

What the export carries is `carried_by(manifest, folds)` over the manifest the export hands its
plugin - after the format and the target have narrowed it, so a label the export drops is never
judged. A resize meets every label; an augmentation meets the labels of the train fold only,
because no other fold is augmented, and a release without a split is judged against every label
and refused `requires_split` besides.

**Fail closed.** A step is supported for a label only where the registry declares it: the op's
`modalities`, `geometries` and `tasks` for an augmentation, `RESIZE_GEOMETRIES` for a resize.
Anything else is refused, `unknown_combination` when nothing more specific names why. That is a
property of the resolver rather than something an export meets today: a recipe cannot name an
unregistered version, since the spec refuses one when it is written, and every label a release
holds is of a geometry the registry rules on. It is what keeps a kind added later - the gated rows
below - refused until somebody declares it.

**The target is the export's, never the recipe's.** A recipe's `target` only records where its
hints came from. The task set judged is that of the target the export is addressed to; an export
addressed to a format, or to a target whose family has no trainer (its task set is empty), is
judged on the format alone, with no task constraint. A label serves the tasks of its geometry
that the target accepts - `bbox` feeds `detect`, `polygon` `segment` and `detect`, `mask`
`segment` and `semantic`, `obb` `obb`, `keypoints` `pose`, `classification_tag` `classify` - and
a label serving none of them is judged against every task of the target, since which one it
feeds is not something the export can say. So `hflip` over a box is supported for a target that
also trains pose, and refused over its keypoints.

| Reason code | Verdict | When |
| --- | --- | --- |
| `modality_unsupported` | refused | The step reads images and the label, or an asset, is on a scan. |
| `geometry_unsupported` | refused | The step cannot transform the geometry - the table in [Where the geometry moves](#where-the-geometry-moves-and-where-the-pixels-do). |
| `task_unsupported` | refused | The target trains the label for a task the op does not declare. |
| `semantics_unrepresentable` | refused | The op's semantic effect would change what the label means, and nothing in the data model can say how. |
| `driver_unavailable` | refused | No installed driver applies the step's kind, or none is declared for the op. Judged only when the caller hands the installed drivers; the export always does. |
| `loss_requires_consent` | conditional for a `fill` or `center_crop` resize; refused for a `lossy` op | The step can cut a label down or away. A cropping resize's loss is counted in the compatibility report and consented to with `allow_lossy`; an augmentation's loss has no accounting yet, so a `lossy` op is refused. |
| `requires_split` | refused | The recipe augments and the release has no split. |
| `unknown_combination` | refused | Nothing declares the combination supported. |

The matrix for every registered op, judged over one label of each kind - generated from the
resolver by `scripts/export_augmentation_matrix.py`, and held to it by a test. **Feeds** is the
tasks a label of the kind can be trained for. A cell is the verdict without a target, then what a
target's tasks add: "when trained for pose" refuses the cell when the target trains that label
for pose, and "under a target training ..." is the fail-closed rule above - a label whose fed
tasks the target trains none of is judged against every task it does train. A lane or a 3D label
feeds nothing, so a target training pose or depth refuses a spatial op over it. `depth` is
refused by every op, because no op declares it and no label feeds it.
`text` and `panoptic` are gated: no geometry carries them yet, and every op refuses them until one
does.

<!-- augmentation-matrix:begin — generated by scripts/export_augmentation_matrix.py; do not edit -->
| Label | Feeds | `hflip` v1 | `brightness_contrast` v1 | `rot90` v1 |
| --- | --- | --- | --- | --- |
| classification (`classification_tag` on image) | classify | supported; `task_unsupported` under a target training none of classify and training pose or depth | supported; `task_unsupported` under a target training none of classify and training depth | supported; `task_unsupported` under a target training none of classify and training pose or depth |
| bbox (`bbox` on image) | detect | supported; `task_unsupported` under a target training none of detect and training pose or depth | supported; `task_unsupported` under a target training none of detect and training depth | supported; `task_unsupported` under a target training none of detect and training pose or depth |
| obb (`obb` on image) | obb | supported; `task_unsupported` under a target training none of obb and training pose or depth | supported; `task_unsupported` under a target training none of obb and training depth | supported; `task_unsupported` under a target training none of obb and training pose or depth |
| polygon (`polygon` on image) | detect, segment | supported; `task_unsupported` under a target training none of detect or segment and training pose or depth | supported; `task_unsupported` under a target training none of detect or segment and training depth | supported; `task_unsupported` under a target training none of detect or segment and training pose or depth |
| mask (`mask` on image) | segment, semantic | supported; `task_unsupported` under a target training none of segment or semantic and training pose or depth | supported; `task_unsupported` under a target training none of segment or semantic and training depth | supported; `task_unsupported` under a target training none of segment or semantic and training pose or depth |
| lane (`polyline` on image) | nothing | supported; `task_unsupported` under a target training pose or depth | supported; `task_unsupported` under a target training depth | refused: `geometry_unsupported`; `task_unsupported` under a target training pose or depth |
| keypoints (`keypoints` on image) | pose | supported; `task_unsupported` when trained for pose; `task_unsupported` under a target training none of pose and training depth | supported; `task_unsupported` under a target training none of pose and training depth | supported; `task_unsupported` when trained for pose; `task_unsupported` under a target training none of pose and training depth |
| image_3d (`cuboid_3d` on image) | nothing | refused: `geometry_unsupported`; `task_unsupported` under a target training pose or depth | supported; `task_unsupported` under a target training depth | refused: `geometry_unsupported`; `task_unsupported` under a target training pose or depth |
| scan (`cuboid_3d` on point_cloud) | nothing | refused: `modality_unsupported`, `geometry_unsupported`; `task_unsupported` under a target training pose or depth | refused: `modality_unsupported`; `task_unsupported` under a target training depth | refused: `modality_unsupported`, `geometry_unsupported`; `task_unsupported` under a target training pose or depth |
| text (gated) | — | refused: `unknown_combination`, `semantics_unrepresentable` | refused: `unknown_combination` | refused: `unknown_combination`, `semantics_unrepresentable` |
| panoptic (gated) | — | refused: `unknown_combination` | refused: `unknown_combination` | refused: `unknown_combination` |
<!-- augmentation-matrix:end -->

What the data model cannot say is not refused. Nothing marks a class as orientation-bound - a lane
whose meaning is its driving side, a sign whose meaning is its reading direction, a label defined
by a colour - so `hflip`, `rot90` and `brightness_contrast` treat such a class like any other of
its geometry. `hflip` over keypoints is supported when no target trains pose, as described below:
no metadata says which points mirror each other.

A refusal keeps the class it has always had, and the order an export always met them in. A scan
is `ExportSourceUnreadable`; then a missing split is `AugmentationRequiresSplit`, a geometry a step
cannot move `PreprocessingStepUnsupportedGeometry` and a source size the manifest never recorded
`ExportSourceUnreadable`, each with its message and first offender; then a missing driver is
`PreprocessingDriverNotFound`. Every other refusal is `AugmentationIncompatible`, which never
names a missing driver and carries every refused entry as `offenders` (`detail.offenders` on
REST, the CLI's `--json` refusal and the MCP envelope); its message names the first five and
counts the rest. A `conditional` entry refuses nothing:
its loss is in the compatibility report and the existing consent decides.

## Where the geometry moves, and where the pixels do

The kernel owns every coordinate an export writes. `transform_manifest` moves the annotations -
scale and offset for a resize, mirror for `hflip`, a quarter turn for `rot90`, nothing for
`brightness_contrast` - and the pixel driver moves the bytes, and the two agree because both read
the same arithmetic: `canvas_fit` is the single spelling of where `letterbox`, `fill` and
`center_crop` content lands - the scale, the content size `round(W·scale) × round(H·scale)`, and
each offset as the integer-floored half of `target - content`, negative where the content
overflows and is cropped - and the per-variant draws come from one seed.

| step | bbox | obb | polygon | polyline | mask | keypoints | polyline_3d, cuboid_3d | classification_tag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stretch | scale x, y | **refused** | scale | scale | **refused** | scale | **refused** | unchanged |
| letterbox | scale then offset | centre and sides scaled, centre offset, angle kept | same | same | **refused** | same | **refused** | unchanged |
| fill, center_crop | scale then offset, clipped to the canvas | **refused** | same, clipped; the largest piece kept | **refused** | **refused** | **refused** | **refused** | unchanged |
| hflip | `x' = W - x - w` | `cx' = W - cx`, `angle' = -angle` | mirror points | mirror points, order kept | mirrored, exact | mirror points, order and visibility kept | **refused** | unchanged |
| brightness_contrast | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged, calibration kept | unchanged |
| rot90 | rotate corners, rebuilt axis-aligned | `(cx, cy)' = (cy, W - cx)`, `angle' = angle - pi/2` | rotate points | **refused** | turned, exact; `size` swaps | rotate points, order and visibility kept | **refused** | unchanged |

`hflip` mirrors a keypoints label's coordinates and nothing else. It does not swap the points a
class's spec names left and right, because no metadata says which pairs mirror each other yet, so a
flipped `left_eye` is still point `1` and now sits on the right of the picture. A dataset whose
keypoints are handed (left and right limbs) should not use `hflip` until that exists.

A step declares what it can transform, and a geometry it cannot is a **typed refusal, never a
consent**: `PreprocessingStepUnsupportedGeometry` names the step, the geometry and the first asset
carrying it. Today that is `rot90` over a polyline, whose point order carries meaning relative
to the frame's axes; a `fill` or `center_crop` resize over a polyline, which a crop can cut into
pieces with no rule for which piece is the lane - a resize's reach depends on its strategy; a
rotated box (`obb`) under `stretch`, which scales the axes apart and turns a rotated rectangle
into a parallelogram, and under `fill` or `center_crop`, whose canvas edge cuts one into a shape
that is no longer a rectangle - only `letterbox` carries it, exactly, since its one scale keeps
every angle; every resize strategy - `stretch`, `letterbox`, `fill` and `center_crop` - over a
`mask`, which is not resized (`hflip` and `rot90` move one exactly, and
`rot90` swaps its `size`; `brightness_contrast` leaves it); a `fill` or `center_crop` resize over
`keypoints` (#1158), because a keypoint cut away keeps its slot in the list and nothing in a crop
can say whether it became occluded or unlabeled - so no step ever moves a point out of the frame and
a keypoint's visibility is never rewritten; and every pixel-moving step over a
3D label: a resize changes the
intrinsics it is read through, and a mirror or a quarter turn changes the frame's handedness or
axes, so each would need a new calibration per variant. Only `brightness_contrast` keeps one, and
each variant carries its source's calibration. An export that does not write the 3D label - every
installed format for a label on an image, with or without a target - drops it before any step
runs, counted and behind lossy consent, so it cannot make a step refuse; only the preview, which
shows every label, and a format that writes 3D meet the refusal. `kitti`, the one format that
writes 3D, writes scans, and a recipe is refused for an export that writes scans. The lossy-consent path is for a format that cannot *carry* a label; a label
that cannot *follow its image* is not something to consent to.

### Cropping: what survives the cut

`fill` and `center_crop` are the only steps that lose labels. Each label is placed on the canvas
by the same arithmetic as the pixels and then cut to the canvas rectangle:

- a **box** is clipped to the canvas;
- a **polygon** is clipped to the canvas. When the cut leaves several separate pieces - a concave
  shape whose middle falls off the edge - only the largest piece by area is written; the others
  are not joined to it along the edge. A run of vertices along a canvas edge is reduced to its
  two ends, so a source edge lying on the crop line leaves no zero-width spike to stretch a box
  derived from the points, and no zero-area piece is ever written. Areas are unsigned, per piece.
  A ring that crosses itself is outside what this promises: the schema does not refuse one, and
  it may come back as one clipped ring rather than its separate pieces;
- a label left with **less than half** its area on the canvas (`CROP_KEEP_FRACTION`, a fixed 0.5
  measured against the label as scaled, before the cut; for a polygon, the piece kept) is
  **dropped**, and so is one wholly off it. Exactly half is kept;
- a `classification_tag` has no coordinates and always passes.

A label cut down and kept is reported **degraded**; a label cut away is reported **dropped**. The
resize runs before every augmentation, so each variant loses exactly the labels its base image
does, and the counts are of the release's own labels. Both go into the export's compatibility
report beside what the format loses - `excluded_annotations` and `degraded_annotations` - and
in rows of their own: the labels the crop cut away leave their `(class, geometry)` row for a
`dropped` row, and the ones it cut down for a `degraded` row, each with `cropped_by` naming the
strategy and the crop's count in its `reason`, while the class's other row counts only what the
crop left alone. Summed by status, the rows then agree with the totals, and a surface can say the
recipe cut a label rather than blaming the format or the target. A drop asks for `allow_lossy`
like any other loss. The geometry transform writes nothing, so it runs before consent is asked:
pre-flight (`GET /releases/{id}/export-compatibility`, `export --check`, `check_export`) answers
200 with the loss in the report, and an export without `allow_lossy` is refused with
`LossyExportNotConsented` **before anything is written**, carrying the same report - the
format's loss and the crop's together, so what a person consents to is what the export writes.
A cut-away label is no company for a solitary geometry: if the crop takes every box, a format
that writes tags only when they are alone is reported writing them.

Drivers are plugins on the `PreprocessingDriver` port, discovered over the
`visionset.preprocessing` entry-point group the way exporters are, and the kernel takes driver
instances rather than names. The built-in pair uses Pillow, the only image dependency: a JPEG
comes back a JPEG at quality 95 with its chroma subsampling kept, a PNG a lossless PNG, and any
other encoding a PNG. No metadata travels.

## Determinism, and its scope

Variant `k` of an asset is seeded by `sha256(f"{recipe_hash}:{content_hash}:{k}")`, and every
draw - the brightness and contrast factors, how many quarter turns `rot90` makes - reads a fixed
position of that digest: brightness word 1, contrast word 2, `rot90` word 3. The draws are
sampled once into a **plan**, `sample_plan(spec, content_hash=, variant=k)`: a frozen
`VariantPlan` holding one draw per augmentation step in recipe order. It is a function of the
recipe, the image and `k` alone, and both the geometry transform and the pixel driver read it, so
neither draws for itself. An operation registered after these three will read its own
`StepStream` instead - an index-addressed sequence of words derived from the variant seed and the
step's `(op, version)` under a domain tag - so under one variant seed a step's draw never depends
on which other steps the recipe holds. The seed digests the recipe hash, so changing the steps
still changes every variant, as it always has. Nothing draws from a global random source. `hflip` draws nothing and always mirrors, for the reason `rot90` never
draws zero turns: a variant that came out identical to its source would be the base image under a
variant's name. The same recipe over the same bytes
therefore draws the same variant on any machine, and the geometry arithmetic is exact
everywhere. This is the export's path; the preview's `showcase` mode, described below, is the
one place a draw is fixed rather than seeded.

**Byte stability is promised within one environment only.** The pixels a resize or an
enhancement produces depend on the codec and resampling code that produced them, so two
machines with different Pillow builds can write different bytes for the same variant. The report
records `pillow_version` for exactly this reason, and a digest in the report's `mapping` is a
fact about one run rather than a promise about the next.

## The train fold, and nothing else

Augmented variants are generated **for the train fold only**: a model must never validate on a
variant of an image it trained on. The folds are the release's own split recipe over its frozen
manifest - the same cut `GET /releases/{id}/assignment` answers - so a variant lands exactly
where its source does. A recipe that augments therefore requires a release published with a
split, and one without is refused with `AugmentationRequiresSplit` at pre-flight and again at
export. Base images are written for every asset whatever its fold, resized when the recipe says
so.

The transform runs **after** the export is narrowed to its target. A geometry the target's task
set does not accept is dropped first, consented through `allow_lossy` like every other drop, so
a polyline a boxes-only target would never write cannot make `rot90` refuse. The transform
runs before consent is asked, so the refusal's report includes what a cropping resize cuts away;
a recipe the transform refuses outright (`AugmentationRequiresSplit`,
`PreprocessingStepUnsupportedGeometry`, `AugmentationIncompatible`, `PreprocessingDriverNotFound`,
`ExportSourceUnreadable`) still loses to an unconsented
format loss, so a caller who has not accepted that loss is answered about it first. Either
refusal comes before any output exists.

## Naming, counting, and the report

A base image keeps its original-hash-derived name; variant `k` is `<hash>-aug<k>`, with its label
file named the same way beside it. Inside the kernel that key is what the export's content
reader resolves: the plugin sees one manifest asset per file to write, the base under its source
hash and each variant under its `-aug` key, sharing the source's `asset_id` so the plugin's own
fold lookup keeps it with its source.

`ExportResult` separates what the release held from what the recipe added: `source_file_count`
and `augmented_file_count` count the images the plugin read and wrote, and the annotation pair
counts the labels the same way; `file_count` stays the total of everything written, labels and
descriptors included. `visionset-export-report.json` gains a `preprocessing` block - `null` for
an export that applied no recipe. `dropped_annotations` and `clipped_annotations` count the
release's labels a cropping resize cut away, and cut down and kept; both are 0 for any other
recipe:

```json
{
  "preprocessing": {
    "recipe_name": "yolo-640",
    "spec": { "target": "yolo11", "steps": [ … ], "variants_per_asset": 2 },
    "recipe_hash": "…",
    "pillow_version": "12.0.0",
    "mapping": [
      { "file": "images/train/<hash>.jpg", "source_content_hash": "<hash>", "exported_sha256": "…", "variant": 0 },
      { "file": "images/train/<hash>-aug1.jpg", "source_content_hash": "<hash>", "exported_sha256": "…", "variant": 1 }
    ],
    "dropped_annotations": 0,
    "clipped_annotations": 0
  }
}
```

Every row of `mapping` traces a written image to the manifest asset it came from; a plugin that
names its images after the key it read them under is matched by name, and one that names them
its own way is matched by digest.

## Previewing a recipe

`POST /projects/{id}/preprocessing-preview` takes a spec, an asset and a variant index and answers
the image and its placed annotations, rendered on the export's own kernel path over a one-asset
manifest with the asset in the train fold - so every variant a spec declares can be looked at
whether or not a release exists. The image is capped to 512 pixels on its longer side, labels
scaled to match - a rotated box by the cap's one ratio on both axes, so it stays a rectangle and
may sit under half a pixel off on the short axis, where the capped size was rounded, and a
mask is resampled nearest-neighbour to the capped size, which is lossy and a preview-only
resampling - and the
response is never cached: the spec is the request's own. `width` and
`height` are the rendered size; `original_width` and `original_height` are the size the asset
recorded, and `frame_index` and `source_name` say where the sample came from - the frame of a
clip, and the name of the source it was ingested from. Each is null when the asset recorded none.

The body also takes `showcase`, false by default. With it true the variant's draws are fixed at
each step's declared strength - `hflip` mirrors, `rot90` makes one quarter turn, brightness and
contrast use the full `amount` - so the picture shows what a step *does* rather than one seeded
draw of it. That is a preview's concern only: an export always takes the seeded path above, and
the kernel spells the fixed draws as one sentinel seed (`SHOWCASE_SEED`) that every draw
recognises, sampled into a plan with `showcase` set, so the pixel driver and the geometry
transform still agree through the same code.

## Refusals

| Error | When |
| --- | --- |
| `PreprocessingRecipeNotFound` | The project has no recipe under that name. 404. |
| `PreprocessingRecipeNameTaken` | Another recipe of the project carries that name, or a rename lands on one. Checked before writing and refused by a unique index, the `ReleaseTagTaken` shape. 409. |
| `InvalidName` | The name is not a slug: lowercase letters, digits, dots, hyphens and underscores, starting with a letter or digit, at most 64 characters. 422. |
| `VALIDATION_ERROR` | The spec breaks the grammar: two resize steps, a resize after an augmentation, an augmentation repeated, augmentation steps with `variants_per_asset` 0, variants with no augmentation step, an unknown `op`, a `version` the registry does not hold for it, or a `params` key the version does not declare or a value of the wrong type or out of its range. The rule that was broken is the message, in the words above. Refused by the spec model itself, so every surface says the same thing. 422. |
| `AugmentationRequiresSplit` | The recipe augments and the release was published without a split recipe. Raised at pre-flight and at export. 409. |
| `AugmentationIncompatible` | The [compatibility resolver](#which-step-serves-which-label) refuses a step for a label the export carries, for a reason none of the refusals around it names. Today that is one cause: the export's target trains the label for a task the op does not serve - `hflip` or `rot90` over keypoints a target trains for pose, or any op under a target that trains depth. Carries every refused entry as `offenders`. Raised at pre-flight and at export. 409. |
| `PreprocessingStepUnsupportedGeometry` | A step met a geometry outside the set it declares it can transform - every step declares `supported_geometries` the way an exporter does, and today the exclusions are those the table above marks refused: a `stretch` resize over a rotated box, every resize over a mask, a `fill` or `center_crop` resize over a rotated box, a polyline or keypoints, `rot90` over a polyline, and every step but `brightness_contrast` over a 3D label. Carries `step`, `geometry` and the first `asset_id`. 409. |
| `LossyExportNotConsented` | A `fill` or `center_crop` resize cuts a label down or away and `allow_lossy` is false - the same refusal, and the same report, as a format that cannot carry a label. Raised by `POST /releases/{id}/export` (before the job is queued), the CLI's `export` and MCP's `export_release`, before anything is written; `GET /releases/{id}/export-compatibility` and `--check` answer 200 with the report instead. 409. |
| `ExportSourceUnreadable` | A step needs the source's pixel size and the manifest never recorded one, or the asset's bytes are gone. 409. |
| `PreprocessingDriverNotFound` | No installed driver applies a step kind the recipe holds. Raised at pre-flight when the surface hands its drivers - REST, the CLI and MCP all do - and at export before anything is written. A fact about the installation, not the request. 500. |

## On every surface

| | |
| --- | --- |
| UI | A release's **Export** section, in the Dataset's column: its **Recipe** list chooses one by name, *No recipe* by default, and its last row writes a new one; the chosen recipe's *Edit* and *Delete* sit at its row's end. A recipe opens in a modal over the page, written in three steps — *Name and model*, *Resize*, *Augmentation* — with Previous and Next, the last step's Next being *Create recipe* or *Save changes*; delete asks first. See [ui.md](ui.md#the-dataset-its-releases-and-getting-the-data-out). |
| REST | `POST`/`GET /projects/{id}/preprocessing-recipes`, `GET`/`PUT`/`DELETE /projects/{id}/preprocessing-recipes/{name}`, `POST /projects/{id}/preprocessing-preview`; `recipe=` on `POST /releases/{id}/export` and `GET /releases/{id}/export-compatibility`. The job carries the recipe as a snapshot. |
| CLI | `visionset recipe create NAME -p P --spec FILE` or `--resize letterbox:640x640 --augment hflip,brightness_contrast --variants 2 --target yolo11`; `recipe list`, `show`, `update`, `delete`; `export --recipe NAME`. See [cli.md](cli.md#visionset-release-and-visionset-export). |
| MCP | `create_preprocessing_recipe`, `list_preprocessing_recipes`, `get_preprocessing_recipe`, `update_preprocessing_recipe`, `delete_preprocessing_recipe` (only with `--allow-destructive`); `recipe` on `export_release` and `check_export`. See [mcp.md](mcp.md#datasets-releases-and-export). |

The export half is described with the rest of exporting in [releases.md](releases.md#exporting).
