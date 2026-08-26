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

## The grammar

| Step | Fields | What it does |
| --- | --- | --- |
| `resize` | `strategy` (`letterbox` or `stretch`), `width`, `height` (32 to 8192), `pad_value` (0 to 255, default 114) | Every exported image, base and variant, lands at `width × height`. `stretch` scales each axis on its own; `letterbox` keeps the aspect, scales to fit, and pads the rest with `pad_value` - the grey YOLO trainers letterbox with themselves. |
| `augment` | `op` (`hflip`, `brightness_contrast`, `rot90`), `amount` (0 to 0.5, default 0.2) | One augmentation applied when generating variants. `amount` bounds the brightness and contrast factors and means nothing to the other two. |

Cross-field rules, refused with the rule named: at most one `resize` step, and it comes first;
each `op` at most once; an `augment` step needs `variants_per_asset` of at least 1; and
`variants_per_asset` (0 to 8) needs at least one `augment` step. `target` records which export
target's hints the recipe was written from and is informational - nothing resolves it, and a
recipe applies to any export.

The hints come from the target: `GET /export-targets`, `visionset target list` and
`list_export_targets` carry `recommended_size`, `recommended_strategy`, `trainer_resizes` and
`augmentation_common` for each, and a surface preselects from them. Every YOLO target resizes on
its own, so pre-resizing is a choice about archive size and loading speed rather than a
requirement.

## Where the geometry moves, and where the pixels do

The kernel owns every coordinate an export writes. `transform_manifest` moves the annotations -
scale and offset for a resize, mirror for `hflip`, a quarter turn for `rot90`, nothing for
`brightness_contrast` - and the pixel driver moves the bytes, and the two agree because both read
the same arithmetic: `letterbox_fit` is the single spelling of where letterboxed content lands,
and the per-variant draws come from one seed.

| step | bbox | polygon | polyline | classification_tag |
| --- | --- | --- | --- | --- |
| stretch | scale x, y | scale | scale | unchanged |
| letterbox | scale then offset | same | same | unchanged |
| hflip | `x' = W - x - w` | mirror points | mirror points, order kept | unchanged |
| brightness_contrast | unchanged | unchanged | unchanged | unchanged |
| rot90 | rotate corners, rebuilt axis-aligned | rotate points | **refused** | unchanged |

A step declares what it can transform, and a geometry it cannot is a **typed refusal, never a
consent**: `PreprocessingStepUnsupportedGeometry` names the step, the geometry and the first asset
carrying it. Today that is `rot90` over a polyline, whose point order carries meaning relative
to the frame's axes. The lossy-consent path is for a format that cannot *carry* a label; a label
that cannot *follow its image* is not something to consent to.

Drivers are plugins on the `PreprocessingDriver` port, discovered over the
`visionset.preprocessing` entry-point group the way exporters are, and the kernel takes driver
instances rather than names. The built-in pair uses Pillow, the only image dependency: a JPEG
comes back a JPEG at quality 95 with its chroma subsampling kept, a PNG a lossless PNG, and any
other encoding a PNG. No metadata travels.

## Determinism, and its scope

Variant `k` of an asset is seeded by `sha256(f"{recipe_hash}:{content_hash}:{k}")`, and every
draw - whether `hflip` mirrors, the brightness and contrast factors, how many quarter turns
`rot90` makes - reads a fixed position of that digest. The same recipe over the same bytes
therefore draws the same variant on any machine, and the geometry arithmetic is exact
everywhere.

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
a polyline a boxes-only target would never write cannot make `rot90` refuse. Consent itself is
asked before any transform: a caller who has not accepted the loss is answered about the loss.

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
an export that applied no recipe:

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
    ]
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
scaled to match, and the response is never cached: the spec is the request's own.

## Refusals

| Error | When |
| --- | --- |
| `PreprocessingRecipeNotFound` | The project has no recipe under that name. 404. |
| `PreprocessingRecipeNameTaken` | Another recipe of the project carries that name, or a rename lands on one. Checked before writing and refused by a unique index, the `ReleaseTagTaken` shape. 409. |
| `InvalidName` | The name is not a slug: lowercase letters, digits, dots, hyphens and underscores, starting with a letter or digit, at most 64 characters. 422. |
| `AugmentationRequiresSplit` | The recipe augments and the release was published without a split recipe. Raised at pre-flight and at export. 409. |
| `PreprocessingStepUnsupportedGeometry` | A step met a geometry it cannot transform - `rot90` over a polyline. Carries `step`, `geometry` and the first `asset_id`. 409. |
| `ExportSourceUnreadable` | A step needs the source's pixel size and the manifest never recorded one, or the asset's bytes are gone. 409. |
| `PreprocessingDriverNotFound` | No installed driver applies a step kind the recipe holds. A fact about the installation, not the request. 500. |

## On every surface

| | |
| --- | --- |
| REST | `POST`/`GET /projects/{id}/preprocessing-recipes`, `GET`/`PUT`/`DELETE /projects/{id}/preprocessing-recipes/{name}`, `POST /projects/{id}/preprocessing-preview`; `recipe=` on `POST /releases/{id}/export` and `GET /releases/{id}/export-compatibility`. The job carries the recipe as a snapshot. |
| CLI | `visionset recipe create NAME -p P --spec FILE` or `--resize letterbox:640x640 --augment hflip,brightness_contrast --variants 2 --target yolo11`; `recipe list`, `show`, `update`, `delete`; `export --recipe NAME`. See [cli.md](cli.md#visionset-release-and-visionset-export). |
| MCP | `create_preprocessing_recipe`, `list_preprocessing_recipes`, `delete_preprocessing_recipe` (only with `--allow-destructive`); `recipe` on `export_release` and `check_export`. See [mcp.md](mcp.md#datasets-releases-and-export). |

The export half is described with the rest of exporting in [releases.md](releases.md#exporting).
