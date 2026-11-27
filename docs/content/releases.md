# Releases

A Release is the only VisionSet artifact that never changes. A [dataset](datasets.md) gains and
loses assets, a [schema](schemas.md) gains versions, and a [batch](batches.md) moves through its
states. A Release captures the trunk at one moment and permanently answers: *which bytes and
labels did we train on?*

There is no operation that edits one. An error in a release is fixed by publishing another
release.

```python
from visionset.kernel.domain import SplitRecipe
from visionset.kernel.services import ProjectService, ReleaseService, WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    releases = ReleaseService(workspace)
    dataset = ProjectService(workspace).get_dataset(project.id)

    recipe = SplitRecipe(train=0.8, val=0.1, test=0.1, seed=42)
    release = releases.publish(dataset.id, "v1.0", split=recipe)
    releases.manifest(release.id)  # the frozen inventory, read back out of the blob store
    releases.verify(release.id)  # re-read and re-hash everything it names
    releases.assignment(release.id)  # the recipe, materialized over the frozen asset set
    releases.list(dataset.id)  # every release of that dataset, oldest first
```

## What publishing freezes

| Frozen into the manifest | Kept on the release row |
| --- | --- |
| Every asset in the trunk, by content hash, with its `uri` and dimensions | `tag`, `manifest_hash` |
| Every annotation on those assets, **copied** - geometry, attributes, provenance | `created_at`, `visionset_version` |
| The project's active schema version and its classes | The split recipe |
| | `schema_version`, `asset_count`, `annotation_count` - a read cache |

Curating an asset out of the trunk afterwards, labeling one of those assets again in a later
batch, or creating a new schema version changes **none** of the manifest. The labels are copies,
not references.

## Why two publishes agree byte for byte

Nothing time-, machine- or identity-specific goes inside the document: no timestamp, no tag, no
release id. That is why

```python
first = releases.publish(dataset.id, "v1")
second = releases.publish(dataset.id, "v2")  # nothing changed in between
assert first.manifest_hash == second.manifest_hash
```

holds as a property of the design rather than as something the service arranges. Two
consequences fall out of it:

- The manifest hash is a real fingerprint. Two releases with the same hash contain the same
  assets and the same labels, whoever published them and whenever.
- They share **one blob**. The store is content-addressed, so the second `put` is a no-op.

Ordering is canonical rather than historical: assets sort by content hash and then by id, and an
asset's labels sort by id. The `Manifest` model applies that itself, on construction - a rule the
artifact depends on belongs to the artifact, not to the habits of whoever builds one. Which batch
an asset arrived in, and on which day, must never reach the bytes.

`Manifest.classes` is the one collection that is *not* sorted. A schema's class order is
authored - it drives how a labeling surface lists them - so it is part of the frozen contract.

**The manifest hash is a snapshot identity, not a universal content identity.** `ManifestAsset.uri`
is a workspace-local path, kept because an exporter names its output files from it. The same
images ingested on another machine produce a different manifest.

### The manifest's own format version

`manifest_version` names the shape of the document itself, independent of the workspace
database's format and of the package version. A build writes the **lowest version that can
express the release**: **3** for a release of images with no 3D label, **4** for one that holds
any, **5** for one that holds a point-cloud asset, **6** for one that holds an asset with a
group label, **7** for one that holds an annotation a track observes, **8** for one that
holds a rotated box (`obb`), **9** for one that holds an asset of an image-sequence source or
an observation whose timing is unknown, and **10** for one that holds a `mask`.

| Version | Since | What changed |
| --- | --- | --- |
| 1 | the first release | - |
| 2 | #584 | `LabelClass.geometries` became plural; a version-1 class's singular `geometry` still loads |
| 3 | #352 | a polyline may carry per-vertex `visibility` |
| 4 | #1038, #1045 | the `polyline_3d` and `cuboid_3d` geometries, and a `calibration` on each asset that carries one |
| 5 | #1046 | an asset's `modality`, and on a point-cloud asset its `point_cloud` metadata and the scan `frame` |
| 6 | #1147 | an asset's `group_label`, the group its importer placed it in |
| 7 | #1181 | `tracks`, each with the observations of it the release holds |
| 8 | #1160 | the `obb` geometry, a rotated pixel rectangle |
| 9 | #1199 | `sources`, each image-sequence source with the occurrences the release holds; a `timestamp` may be `null` |
| 10 | #1162 | the `mask` geometry, a run-length encoded raster |

An older document keeps the version it was written with, so its bytes and its hash never move and
`verify` still passes. Version 3 changes no existing bytes: a polyline with unknown visibility
**omits** the key rather than writing `null`, so it serializes exactly as it did under version 2.
What the bump announces is that a version-3 document *may* carry the key.

**The number is a label, not a gate on the build.** Loading a manifest never compares
`manifest_version` against the build's own; what a build refuses is a key it does not know, because
a manifest is read with unknown keys forbidden - half-understanding hash-pinned evidence is worse
than refusing it. The one thing the number is checked against is the manifest's own content: a
document below version 4 that carries a calibration, or below version 5 that holds a point-cloud
asset, is refused, because its version claims a shape that cannot express what it holds. So a
version-2 build refuses a version-3 manifest only when that manifest carries a `visibility`; one
with no visibility recorded anywhere loads there unchanged.

Version 4 changes no existing bytes either. An asset's `calibration` is embedded only when the
asset carries a 3D label, and **omitted** otherwise - even when its source is calibrated - and a
release with no 3D label is still written as version 3. So a 2D release published now hashes
exactly as it did before 3D labels existed, and only a release holding one is refused by a
version-3 build. A manifest that carries a calibration under a version below 4, or a 3D label on
an asset with no calibration beside it, does not load.

Version 5 changes no existing bytes either. `modality` is **omitted** when it is `image`, so a
release of images is still written as version 3 or 4 with the hash it always had. A point-cloud
asset carries `"modality": "point_cloud"`, its `point_cloud` metadata (format, point count,
bounds, fields) and the `frame` its source declares, and never a `calibration` or a pixel size; a
manifest holding one under a version below 5 does not load, and neither does a pixel-space label
(`bbox`, `polygon`, `polyline`) on a scan.

Version 6 changes no existing bytes either. `group_label` is **omitted** when an asset has none,
so a release of unlabelled assets keeps the version and the hash it had. The label is copied
whatever the release's split recipe says: the document is a function of content, and a recipe is
not content, so a grouped and an ungrouped release of one dataset still share one manifest. A
manifest carrying a group label under a version below 6 does not load.

Version 7 changes no existing bytes either. `tracks` is **omitted** when no track observes an
annotation the release copies, so an untracked release keeps the version and the hash it had. A
track is listed as its `id`, `source_id`, `label_class` and `external_id`, with only the
observations whose asset **and** annotation the release holds - a frame the release does not
contain is simply absent, and a track left with none is not listed. Each observation is the
occurrence's `position` and `timestamp`, its `asset_id` and its `annotation_id`. Observations sort
by position, never by when they were recorded, and tracks by source, then the position each is
first observed at, then id, so two publishes of an unchanged dataset still agree byte for byte. An
asset that occurs at two positions appears under both, once per annotation. A manifest carrying
tracks under a version below 7, or an observation naming an annotation the document does not hold,
does not load. An export hands its format the tracks cut to the annotations it carries.

Version 8 changes no existing bytes either. It adds a geometry and no key anywhere else, so a
release with no rotated box keeps the version and the hash it had; a manifest holding an `obb`
under a version below 8 does not load. The box is copied in its canonical spelling (see
[annotations](annotations.md#a-rotated-box-is-a-centre-a-size-and-an-angle)), so two publishes of
an unchanged dataset still agree byte for byte.

Version 9 changes no existing bytes either. `sources` is **omitted** when the release holds no
asset of an `image_sequence` source, so such a release keeps the version and the hash it had. A
source is listed as its `source_id` with every occurrence whose asset the release holds, observed
or not, each as `position`, `timestamp` and `asset_id`, in position order; sources sort by id. A
position the release holds no asset for is absent, so an exporter writes every held frame and
leaves only those positions as gaps. A video source is not listed: its frames are its own clip's.
A `timestamp`, here or on an observation, is `null` where the source recorded no timing, as a CVAT
task does - which is not the same document as `0`. A manifest carrying `sources` or a `null`
timestamp under a version below 9, an occurrence naming an asset it does not hold, or an
observation that disagrees with the occurrence its source lists at that position, does not load.
An export cuts `sources` to the assets it hands its format, as it cuts tracks.

Version 10 changes no existing bytes either. It adds a geometry and no key anywhere else, so a
release holding no `mask` keeps the version and the hash it had; a manifest holding a `mask` under
a version below 10 does not load, and a build that predates the geometry refuses a version-10
manifest, since it does not know the `mask` type. The mask is copied in its canonical spelling (see
[annotations](annotations.md#a-mask-is-run-length-encoded-pixels-over-the-whole-asset)), so two
publishes of an unchanged dataset still agree byte for byte. Two exporters write a mask whole,
[`coco`](#the-coco-format) as RLE and [`segmentation-png`](#the-segmentation-png-format) as a
class-index PNG; every other export reports each one **dropped**, never degraded.

Publishing content that needs a newer version than an older build wrote still produces a
different manifest hash, because the version number is part of the document.

### A 3D label travels with its calibration

Publishing copies, beside every asset that carries a 3D label, the calibration that applied to it
at that moment - the asset's own override, else its source's - so the release can be read
without the workspace. An asset carrying one with no calibration refuses the publish with
`CALIBRATION_MISSING` (409), and one whose calibration was measured at another size than the
asset with `CALIBRATION_RESOLUTION_MISMATCH` (422). One installed format writes a 3D geometry:
[`kitti`](#the-kitti-format) writes a `cuboid_3d` on a scan. No format writes a `polyline_3d`, and
none writes a 3D label on an image. Every other format, and `kitti` for a `polyline_3d`, reports the
class **dropped**, with its annotation and asset counts, and needs `allow_lossy` like any other
loss. The drop happens before pre-processing, with or without a target, so a resize or flip in the
export's recipe never refuses over a 3D label the format would not write anyway.

### A scan travels with its frame

A point-cloud asset is read in its source's declared frame, not against a camera calibration, so
publishing copies that frame beside every scan, labelled or not. A `cuboid_3d` on a scan has its
yaw about that frame's up axis. See [sources.md](sources.md#point-cloud-directories-and-their-frame).

### Which schema version a release pins

The project's **active** version - the highest one - with its classes. Each copied annotation
still carries the version its own batch pinned, and those can differ: two batches approved
against two versions can both be promoted into one trunk. Publishing validates every copied
annotation against the active schema before freezing the manifest. If any do not conform, it
refuses with the affected class counts; reconcile that content before publishing.

That publication gate makes newly created manifests internally schema-consistent. Exporters still
defend against undeclared classes when reading archived or externally supplied malformed manifests,
because those documents may not have come through this publication path.

## Verification

```python
report = releases.verify(release.id)
report.ok  # everything present and unaltered
report.missing  # content hashes with no blob at all
report.corrupt  # blobs present whose bytes no longer hash to their own name
report.checked  # how many were actually read
```

`verify` **re-reads and re-hashes**. `BlobStore.exists` answers whether a path *named by* a hash
is there, which proves nothing about what is in it - a content-addressed store does not verify
itself, and that is the whole reason this method exists. `exists` is used only to tell a missing
blob from a corrupt one.

The manifest is settled first. If its own bytes no longer hash to `manifest_hash`, the report
says `manifest_intact=False`, `checked=0`, and the walk stops: a document that has been altered
is not an inventory worth trusting, and reporting assets missing on the strength of a tampered
list would be worse than saying nothing.

The row's cached `schema_version` and two counts are checked against the parsed document as well.
Anything in `cache_mismatches` is a bug in the build that wrote the row, not damage to the
workspace - a cache nobody checks is a fact nobody can trust.

## The split recipe

Declarative and stored, never materialized into the release:

```python
SplitRecipe(train=0.8, val=0.1, test=0.1, seed=42)
```

The fractions must add up to one, checked with a tolerance because `0.7 + 0.15 + 0.15` is
`0.9999999999999999` in binary floating point. An all-train recipe is legal. An invalid recipe
cannot be constructed at all - the refusal is pydantic's, like every other per-value rule in the
domain.

`releases.assignment(release_id)` turns it into folds, **from the manifest's frozen asset set**.
Reading live membership there would let a curator change a published release's folds by editing
the trunk afterwards, which is precisely what a release exists to make impossible.

The assignment is deterministic without a random number generator. Each asset is keyed by
`sha256(seed:content_hash)` and ordered by that key, so the result depends on the seed and on the
set - never on the order assets are passed in, on how many there are, or on the Python
implementation.

Keying on the **content hash** rather than the asset id is a training decision. Two assets holding
identical bytes are the classic train/test contamination, and nothing stops a project ingesting
the same image twice; keying on content puts the duplicates next to each other, so the only thing
that can separate them is a fold boundary landing precisely between them. It also means a
re-ingest into a fresh project reproduces the split, every id being new.

Counts come from largest-remainder apportionment, with the last fold taking the tail of the
ordering outright. One asset under a `0.8/0.1/0.1` recipe is one training asset, not a rounding
error that loses it, and no asset can go missing to an argument about arithmetic.

### Keeping a group in one fold

Neighbouring frames are not identical bytes, so keying on content does not keep them together.
nuScenes keyframes are half a second apart and a scene holds about forty of them; split per asset,
every scene lands in all three folds and validation holds near-copies of training frames. On
`v1.0-mini` under `0.8/0.1/0.1` with seed 0, all ten scenes do.

A recipe can therefore ask for grouping:

```python
SplitRecipe(train=0.8, val=0.1, test=0.1, seed=42, group_by="group_label")
```

`group_label` is a name an importer writes on an asset at first arrival - the
[nuScenes import](import.md#formats) writes the scene's name. It is provenance, like a source:
never rewritten by a later import, and taken from the source's own content rather than from an id,
so a re-ingest into a fresh project carries the same label and reproduces the split. The manifest
carries it, so the folds are cut from the document alone. With `group_by`:

- Every asset sharing one label is a single unit, keyed by `sha256(seed:group:label)`. An asset
  with no label is a unit of its own, keyed exactly as above. A group never straddles a fold.
- **The fractions apply to groups, not assets.** Ten scenes under `0.7/0.15/0.15` are seven, two
  and one scenes, however many keyframes each holds, so **fold sizes in assets are approximate** -
  as close to the fractions as the groups are equal. A single group lands whole in the fold with
  the largest fraction, and a fold may be empty.
- Everything else holds unchanged: no asset goes missing, ties break on the label and then the
  asset id, and the result depends only on the seed and the set. Over assets that carry no label,
  a grouped recipe cuts exactly the folds an ungrouped one does, so it is not refused there.

**Grouping is opt-in.** `group_by` defaults to none and is **omitted** from a stored recipe that
does not group, so every recipe stored before it existed - and every split it cuts - is the same
bytes and the same folds it always was.

**Frames cut from a video clip are still split per asset.** Their natural key is the clip, and a
clip's `source_id` is a per-project id, so a re-ingest would not reproduce a split keyed on it; a
stable key for clips needs its own design. Until then a grouped recipe treats extracted frames as
unlabelled. An asset imported before group labels existed carries none either, and importing the
same bytes again does not add one - import into a fresh project to have them.

An export writes these folds and no others. The assignment is cut once, over the whole frozen
manifest, and handed to the format plugin as `assignment=` beside the manifest; the plugin
places each asset by it and never cuts its own. That matters when a release holds images and
scans: an image format is handed only the images, and a cut by count over fewer assets would draw
other boundaries, so its folds would stop matching `assignment` and an augmented variant, generated
for a train asset, could land in `val`. A plugin whose `export` does not take the keyword is
called without it, as before.

## What is deliberately not here

- **No `delete`.** A release is the immutable artifact. The only thing that removes one is
  deleting its project, whose cascade takes it - and even then the manifest blob survives, because
  [blobs are never deleted](projects.md).
- **No `confirm=`.** That guard is for destroying data, and publishing destroys nothing. This is
  not a third exemption from `ConfirmationRequired`.
- **No change-log entry.** The [dataset log](datasets.md) records mutations of the trunk, and
  publishing mutates nothing in it. "A release happened" is a [domain event](events.md) -
  `ReleasePublished`, carrying the manifest hash - not a curation entry.
- **No mutation at all.** `Release` is a frozen model, so the refusal belongs to the type rather
  than to a service method that could be forgotten.

## Exporting

`Exporter.export(release, manifest, dest)` takes the manifest beside the release rather than off
it: a `Release` only *names* its document, so an exporter given the release alone would hold a
hash and no way to resolve it. `ReleaseService.manifest` is what a caller resolves it with.
Coordinate normalization a format requires happens in the exporter, never in the domain.

### The kernel takes a plugin; it does not find one

`ReleaseService.export(release_id, exporter, dest, *, allow_lossy=False, allow_non_empty=False)` takes an **`Exporter`
instance**, never a format name, and that is structural rather than stylistic: import-linter
forbids `visionset.kernel` from importing `visionset.formats` at all. Resolving a name to an
implementation therefore belongs to whoever composed the call.

`visionset.formats.registry` is where that happens - `exporters()` scans the
`visionset.formats` entry-point group and `pick(installed, name)` refuses an unknown one with
`ExportFormatNotFound`. Discovery is `importlib.metadata`, never a hardcoded map and never an
`if fmt == "coco"` chain, because that is the whole plugin promise: a third-party distribution
registers into the same group and is indistinguishable from a built-in. The group carries
importers too, so what comes back is filtered by `isinstance(plugin, Exporter)` rather than by a
naming convention.

### `lossy` is declared by the format, once

`Exporter.lossy` says the format drops information the kernel can represent - a geometry
variant, an attribute kind, per-annotation provenance. It is a property of the **format** and
not of a particular release: a bbox-only format loses a polygon whether or not today's dataset
happens to hold one, and asking per release would mean re-answering on every export and getting
a different answer as the data drifted.

Exporting in a lossy format raises `LossyExportNotConsented` unless the caller passes
`allow_lossy=True`. That is a third word beside `confirm=` and `allow_destructive=`, and the
three are never one `except`: `confirm=` guards destroying data, `allow_destructive=` guards
narrowing a contract, and this guards emitting an incomplete *copy* of something that stays
exactly as it was. The refusal happens before anything is created, so a refused export leaves no
half-written directory behind.

### What a format can carry, and what this release actually holds

`lossy` is a blanket claim nobody can check. `Exporter.supported_geometries` is the checkable
half of it: the set of `GeometryType` members the format can write. `supported_modalities` sits
beside it: the asset modalities the format can write, judged below.

`ReleaseService.check_export(release_id, exporter)` judges one release's **frozen manifest**
against one format's declaration and returns an `ExportCompatibility`:

```json
{
  "release_id": "…", "format": "yolov5-yaml", "compatible": false,
  "format_is_lossy": true,
  "excluded_annotations": 40, "excluded_assets": 40,
  "degraded_annotations": 1204, "degraded_assets": 310,
  "classes": [
    {"label_class": "lane", "geometry": "polygon", "status": "degraded",
     "annotations": 1204, "assets": 310,
     "reason": "yolov5-yaml writes a polygon as its bounding box; the shape is lost",
     "cropped_by": null},
    {"label_class": "sign", "geometry": "bbox", "status": "supported",
     "annotations": 8800, "assets": 2400, "reason": null, "cropped_by": null},
    {"label_class": "weather", "geometry": "classification_tag", "status": "dropped",
     "annotations": 40, "assets": 40,
     "reason": "yolov5-yaml cannot place a classification_tag and drops it",
     "cropped_by": null}
  ],
  "dropped_modalities": []
}
```

**One row per `(label_class, geometry)`, not per class.** A class accepts a *set* of
geometries ([schemas.md](schemas.md)), and a format's answer can differ across it: a class
labelled both as boxes and as outlines is, to YOLO, one half written whole and one half
written reduced. It contributes two rows. A single row could carry only one of those verdicts
and would describe half its own output wrongly whichever it picked - the same defect
`compatible: bool` had before three statuses replaced it, one level down.

The one exception is a recipe whose resize crops (`fill` or `center_crop`): the labels it cuts
away or cuts down move to `dropped` and `degraded` rows of their own with `cropped_by` naming
the strategy, so a class can have up to three rows for one geometry and each row's count is
the labels that meet its status. `cropped_by` is null on every other row. See
[preprocessing.md](preprocessing.md#cropping-what-survives-the-cut).

A class the schema declares and nobody used still gets a row per geometry, at zero. Zero
excludes nothing, so it never makes a report incompatible however unsupported its shape is.

### Dropped is not degraded, and one word for both was a lie

`status` has three values, and the reason is #158. Until then a class was `supported: true` or
`supported: false`, and that single word was read with two different intents by two parts of the
system that were each internally consistent:

- `_compatibility` read "not in `supported_geometries`" as **will not be in the output**, and
  counted it in `excluded_annotations`.
- The YOLO and VOC exporters read the same declaration as **convert it to something I can
  write**, and emitted the polygon as its axis-aligned bounding box - which is a real capability
  #62 and #414 deliberately included, documented in both module docstrings.

So a user exporting a release of 3 boxes, 2 polygons and 1 tag was told three annotations would
be lost, consented, and received **four label rows where the API held two exportable boxes**. The
extra two carried the polygon's own class name and were well-formed in every way a validator can
check: every index real, every coordinate in range. Nothing was corrupt; it simply was not what
the report promised.

The fix is vocabulary rather than capability. `Exporter` declares two geometry sets:

- **`supported_geometries`** - written as they stand.
- **`degraded_geometries`** - written, having lost something the kernel could represent. `{obb,
  polygon}` for `yolov5-yaml`, `darknet` and `voc`, each written as its axis-aligned bounding box;
  `{polygon}` for `segmentation-png`, which rasterizes a polygon into its class map; and empty
  for `coco`, which writes a polygon as a polygon and a mask as RLE and drops a rotated box,
  for `yolo-obb` and `dota`, which write a rotated box as itself and drop everything else, and for
  `cvat-images` and `cvat-video`, which write a rotated box as a CVAT box and its `rotation`. The two sets are disjoint, and `supported` wins if a plugin
  says both, because resolving a contradiction towards the weaker claim would report a loss that
  does not happen.

A geometry in neither set is **dropped**. `excluded_annotations` counts dropped only -
the number that disappears is the number worth having under that name - and `degraded_annotations`
sits beside it. `compatible` is false for either, so **the `allow_lossy` gate did not move**: a
polygon flattened to a box has lost its shape, and the consent it always required is still
required. Only the accounting became true.

The guard that comes with it is the part worth keeping: `tests/formats/test_report_agreement.py`
exports the same release through **every installed format** and counts the annotations in the
written label files, XML documents and COCO JSON. It asserts `excluded_annotations` equals what
the artifacts are actually missing, rather than restating an expected number. A fourth exporter
either lands a counter there or is declared non-writing, and the test fails until somebody
chooses - which is how a format that converts silently stops being possible.

Three more properties are worth stating, because each is a decision rather than a detail.

**A class with zero annotations excludes nothing**, whatever its status. A schema that declares
`mask` and holds no masks is carried whole by a format that cannot write one. The row is still
published, with its zeros, because "this format cannot write masks and you have none" is an
answer somebody is looking for.

**The counts are per class and there are two of them.** `annotations` is what would be lost and
`assets` is how wide the loss is - a thousand labels over a thousand images and the same thousand
over ten are the same total and a very different dataset, which is the argument `DatasetStats`
already makes.

**It is computed from the manifest, never from live membership.** An export describes a release,
and a release is a snapshot: curating an asset out of the trunk afterwards does not move the
answer. That is what lets one document be shown in a consent dialog, attached to a refusal and
written into the output without three chances to disagree.

**Modality is judged first, from the manifest.** A version-5 `ManifestAsset` records its modality,
and an asset whose modality the format does not list in `supported_modalities` is absent from the
output whole. It gets one row per modality in `dropped_modalities` - `modality`, `assets`,
`annotations` and a `reason` - is counted in `excluded_assets` and `excluded_annotations`, and
makes the report incompatible, so the export needs `allow_lossy`. Its labels appear in no row of
`classes`, which judge only what reaches the format, and the export never hands such an asset to
the plugin, nor is its blob read: an image export does not refuse because a scan's blob is
missing. A plugin that declares no `supported_modalities`, as every one did before scans existed,
writes images: it is still discovered, and a release's scans are reported dropped for it rather
than breaking the export. `kitti` is the one installed format that writes a point cloud, and it
writes nothing else, so it reports a release's images dropped by count and every other format
reports its scans dropped.

**A tracked-only format drops what no track observes.** A format may declare `tracked_only`, as
[`mot`](#the-motchallenge-format) and [`cvat-video`](#the-cvat-xml-formats) do, because a MOT row or a
CVAT track shape is one observation of one track. A label
that format would otherwise write and no track in the release observes leaves its row for a
`dropped` row of its own, with its own counts and a reason saying no track observes it, so an
untracked box is counted in `excluded_annotations` and asks for consent like any other loss.

### Consent is required if *either* says so

`export` refuses with `LossyExportNotConsented` when the format declares itself lossy **or** when
the report says this release would lose something. The first half is what #30 shipped and has not
moved; the second is the case a capability list makes visible - a format declaring itself
lossless still cannot silently drop a geometry it never claimed to write.

The refusal carries the report, so a caller can say what it is consenting to without asking
twice: `LossyExportNotConsented.compatibility` in Python, and `detail.compatibility` on the API's
409, in the MCP error envelope and in the CLI's `--json` refusal.

### Every export writes its own report

A successful export writes **`visionset-export-report.json`** at the root of `dest`: the same
document, key for key. It is the kernel's file rather than the format's, so it is written *after*
the plugin runs (a plugin that clears its own subdirectory would otherwise take it along) and is
**excluded from `ExportResult.file_count` on both sides** - not counted when written, and skipped
when an earlier run left one behind. That is what keeps "an exporter that writes nothing reports
zero" true, and keeps exporting twice into one directory agreeing with itself.

### A recipe at export

`ReleaseService.export(..., recipe=, recipe_name=, drivers=)` applies a [pre-processing
recipe](preprocessing.md): every image is resized as the recipe says, and augmented variants of
the train-fold images are written beside their sources as `<hash>-aug<k>`. The recipe is a
value the export snapshots - the report carries the spec it ran with, its hash and the Pillow
version - so editing or deleting the stored recipe afterwards changes nothing here. The narrowing
above runs first and the recipe runs over what is left, so a geometry the target drops can never
make a step refuse; consent is asked before any transform. `check_export(..., recipe=)` refuses
now what the export would refuse: `AugmentationRequiresSplit` for an augmenting recipe over a
release published without a split, and `PreprocessingStepUnsupportedGeometry` for a step that
cannot move a geometry the export would carry. A recipe reads and writes images, so an export that
would hand the format a scan refuses one, at the check and at the export, with
`ExportSourceUnreadable`. `ExportResult` separates `source_file_count` from
`augmented_file_count`, and `preprocessing` on the report maps every written image to the asset
it came from.

### Export targets

The user-facing unit of export is a **target**: the model the release will train. A target
resolves to exactly one format - the *dialect* that writes its descriptor grammar - and a model
with two trainer homes gets two named targets, never a runtime switch. Every installed format
declares the targets it writes for on the `Exporter` port, and a format that is not a trainer's
declares one target named after itself, family `other`, so every export is addressed the same
way. The kernel derives the catalog from those declarations; `GET /export-targets`,
`visionset target list` and the `list_export_targets` tool all render the same derivation, and
nothing keeps a list by hand. The registry refuses a target declared by two installed formats
(`ExportTargetConflict`) and a target promising a geometry its format never writes
(`InvalidExportTarget`), at the scan rather than at the first export.

The catalog this build ships, generated from the declarations by
`scripts/export_target_catalog.py` and held current by a drift gate:

<!-- export-targets:begin — generated by scripts/export_target_catalog.py; do not edit -->
| Target | Label | Family | Format | Tasks | Geometries | Recommended size | Strategy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `bdd100k-lane` | bdd100k-lane | `other` | `bdd100k-lane` | — | polyline | — | — |
| `classification` | classification | `other` | `classification` | — | classification_tag | — | — |
| `coco` | coco | `other` | `coco` | — | bbox, mask, polygon | — | — |
| `culane` | culane | `other` | `culane` | — | polyline | — | — |
| `curvelanes` | curvelanes | `other` | `curvelanes` | — | polyline | — | — |
| `cvat-images` | cvat-images | `other` | `cvat-images` | — | bbox, classification_tag, obb, polygon, polyline | — | — |
| `cvat-video` | cvat-video | `other` | `cvat-video` | — | bbox, obb, polygon, polyline | — | — |
| `dota` | dota | `other` | `dota` | — | obb | — | — |
| `kitti` | kitti | `other` | `kitti` | — | cuboid_3d | — | — |
| `mot` | mot | `other` | `mot` | — | bbox | — | — |
| `openlane-2d` | openlane-2d | `other` | `openlane-2d` | — | polyline | — | — |
| `segmentation-png` | segmentation-png | `other` | `segmentation-png` | — | mask, polygon | — | — |
| `tusimple` | tusimple | `other` | `tusimple` | — | polyline | — | — |
| `voc` | voc | `other` | `voc` | — | bbox | — | — |
| `yolo-obb` | yolo-obb | `other` | `yolo-obb` | — | obb | — | — |
| `yolo11` | YOLO11 | `ultralytics-yolo` | `ultralytics` | classify, detect, obb, pose, segment | bbox, classification_tag, polygon | 640×640 | letterbox |
| `yolo12` | YOLO12 | `ultralytics-yolo` | `ultralytics` | classify, detect, obb, pose, segment | bbox, classification_tag, polygon | 640×640 | letterbox |
| `yolo26` | YOLO26 | `ultralytics-yolo` | `ultralytics` | classify, depth, detect, obb, pose, segment, semantic | bbox, classification_tag, polygon | 640×640 | letterbox |
| `yolov10` | YOLOv10 | `ultralytics-yolo` | `ultralytics` | detect | bbox | 640×640 | letterbox |
| `yolov3` | YOLOv3 | `ultralytics-yolo` | `ultralytics` | detect | bbox | 640×640 | letterbox |
| `yolov4` | YOLOv4 | `community-yolo` | `darknet` | detect | bbox | 416×416 | stretch |
| `yolov5` | YOLOv5 | `ultralytics-yolo` | `ultralytics` | classify, detect, segment | bbox, classification_tag, polygon | 640×640 | letterbox |
| `yolov6` | YOLOv6 | `ultralytics-yolo` | `ultralytics` | detect | bbox | 640×640 | letterbox |
| `yolov7` | YOLOv7 | `community-yolo` | `yolov5-yaml` | detect | bbox | 640×640 | letterbox |
| `yolov8` | YOLOv8 | `ultralytics-yolo` | `ultralytics` | classify, detect, obb, pose, segment | bbox, classification_tag, polygon | 640×640 | letterbox |
| `yolov9` | YOLOv9 | `ultralytics-yolo` | `ultralytics` | detect, segment | bbox, polygon | 640×640 | letterbox |
<!-- export-targets:end -->

`tasks` is the trainer's whole vocabulary, pose and depth included; `geometries` is what an export
addressed to the target carries, which is never wider than the format writes and narrower where
the trainer has no task for a shape. A geometry VisionSet cannot produce - pose, obb, semantic,
depth - is absence rather than a drop, and is never a row of the compatibility report.

**A target narrows its format.** `check_export`, `require_export_consent` and `export` each take
an optional `target`, and a geometry the format writes whole but the target's trainer has no task
for is reported `dropped` with a reason naming the target - consented through the same `allow_lossy`
gate as every other loss. The export then honours the drop the report promises: the plugin is
handed the manifest with every annotation the target does not carry removed, because the port has
no word for a target and a promise the report makes must not depend on every plugin reading a
declaration it cannot see. The class vocabulary stays whole, since a class index is the frozen
schema's. The report and the `ExportResult` both record `target` - `null` when the export was
addressed to a format alone - so a reader of `visionset-export-report.json` can tell which question
it answers.

**The per-export task is derived, never chosen.** `segment` when the target accepts it and the
manifest carries any polygon; otherwise `classify` when the target accepts it and the manifest
carries classification tags and no box or polygon; otherwise `detect`. Because the manifest a
target-addressed export hands to the plugin already holds only what the target carries, the
derivation and the declaration cannot disagree: a `yolov10` export of a release holding polygons is
a `detect` layout of its boxes, and the report says the polygons were dropped.

### The YOLO dialects

Three formats write a YOLO detection dataset, and they differ only in the descriptor grammar; the
fourth YOLO layout, Ultralytics OBB, is written by [`yolo-obb`](#the-rotated-box-formats). Each is a
*dialect*: the wire identifier `format_name` names the descriptor grammar, and the model a person
will train - the *target* - resolves to exactly one dialect. `ultralytics` is what every trainer
from YOLOv3 to YOLO26 in the Ultralytics line reads; `yolov5-yaml` is the older grammar YOLOv7
reads; `darknet` is the Darknet-framework layout YOLOv4 reads. `yolo`, the former name of `ultralytics`, is accepted as an alias until the release after
next, and then removed. Every surface resolves it to the same plugin and reports `format_name` as
`ultralytics`; only the CLI warns, because `visionset export --format yolo` has a stderr to say
so on. `POST /releases/{id}/export?format=yolo` and `export_release(format="yolo")` accept it
silently, the response carrying no deprecation text at all - a warning has no field to land in
on a 202 or in a tool result.

The layout both share:

```
data.yaml
images/train/<content-hash>.png     labels/train/<content-hash>.txt
images/val/…                        labels/val/…
images/test/…                       labels/test/…
visionset-export-report.json
```

Four of v1's decisions are deliberately not kept, and each was a way to be wrong quietly.

**Classes come from the frozen schema, never from the annotations present.** v1 built its class
index by sorting the names it found in the labels, so a class nobody had used yet vanished from
`data.yaml` - and, worse, drawing the first box of a new class *renumbered every other class*. A
model trained against one export and evaluated against the next is then wrong with nothing to
report it. Here the order is `Manifest.classes`, the project's authored schema order frozen at
publication, and every class gets an index whether or not anything uses it. Indices are positions
in that order, so they are contiguous from zero by construction - a class carries no number of
its own that could leave a gap.

**A read failure aborts.** v1 wrapped the image read in `except Exception: pass` and wrote the
label file anyway, so one lost object produced a training set silently short of an image and
carrying labels pointing at nothing. Every read goes through the `ContentReader` the kernel
composes, and a missing or undecodable blob is `409 EXPORT_SOURCE_UNREADABLE` naming the asset.

**Pixel dimensions are required.** v1 parsed `"WxH"` out of a string and fell back to `(1, 1)`,
which does not fail - it divides by one and writes raw pixel coordinates into a file whose whole
contract is that every number is a fraction. An asset with no recorded size is refused by name.

**Files are named by content hash.** v1 used the original filename with a `_2` de-duplicating
suffix, which makes the mapping depend on iteration order and lets one picture ingested from two
directories land twice. A hash is stable across machines and runs and cannot collide. The cost is
that the names are not human-readable, which a directory destined for a trainer does not need.

#### `ultralytics`

The descriptor is `path: .`, one key per fold present, and `names` as a mapping from index:

```yaml
path: .
train: images/train
val: images/val
test: images/test
names:
  0: "sign"
  1: "lane"
```

There is no `nc`; the trainer counts the mapping. `train` and `val` are both required by the
trainer, so a release published without a recipe - one undivided set - still declares `val` and
points it at the training images: that says "there is no held-out set", where omitting the key
would say "this file is malformed". `test` is written only when it has something in it. `path: .`
resolves against the working directory of the process that loads the file, so a training run
starts from inside the export directory. `images/` → `labels/` is a string substitution on the
resolved image path, not a configured location, so those two directory names are load-bearing.

**The task is derived from the release, never chosen.** One export is written for one of the
trainer's tasks:

- `segment` when the release holds any polygon - every polygon is written as its vertices and
  every box as its four corners, so nothing located is reduced;
- `classify` when the release holds classification tags and no box or polygon - the export is
  then the class tree the trainer reads, `<fold>/<class>/<image>`, one copy of an image per tag
  it carries, with a directory for every tag-capable class whether or not anything used it, and
  no `data.yaml`;
- `detect` otherwise - `class cx cy w h` per box, clamped into the image.

`supported_geometries` is `{bbox, polygon, classification_tag}` and `degraded_geometries` is
empty, so a rotated box is dropped: the oriented-box layout ultralytics reads is
[`yolo-obb`](#yolo-obb), a format of its own. A tag beside a located label has no layout to land in and is not written, so the format
also declares `solitary_geometries = {classification_tag}`: whenever a box or polygon reaches the
output, the report lists every tag row as **dropped** and counts it in `excluded_annotations`,
which is what the label files hold. `lossy = True`, so consent is always asked. An asset with nothing on it gets an **empty** label file rather than
none: ultralytics reads a missing file as "nobody looked" and an empty one as "somebody looked and
there is nothing here", and a detector needs the second.

#### `yolov5-yaml`

The descriptor has no `path` key, every split path starts `./` and resolves against the yaml's
own directory, `nc` is an integer, and `names` is a list:

```yaml
train: ./images/train
val: ./images/val
test: ./images/test
nc: 2
names: ["sign", "lane"]
```

Detection only, always. `supported_geometries` is `{bbox}` and `degraded_geometries` is
`{obb, polygon}`: a polygon or a rotated box is written as its axis-aligned bounding box, and the report counts it as
written in a reduced form and says which classes and how many. A classification tag has no
location and is dropped rather than given an invented box.

#### `darknet`

The descriptor is `obj.data`, a list of `key = value` lines, beside `obj.names` (one class per line, in
the release's frozen schema order) and the image lists `train.txt` and `valid.txt`:

```text
classes = 2
train = train.txt
valid = valid.txt
names = obj.names
backup = backup/
```

The lists hold one image path per line, relative to the export root (`images/train/<hash>.jpg`),
and Darknet finds each label by swapping `images` for `labels` in that path, which is the layout
the other dialects already write. `valid.txt` is always written: a release with no validation fold
points it at the training list, as `yolov5-yaml` points `val` at the training images. Darknet has
no test key, so test images are written under `images/test` and listed in neither file.

Detection only, always, with the same capabilities as `yolov5-yaml`: a polygon or a rotated box is
written as its axis-aligned bounding box and reported as reduced, and a classification tag is dropped. The one
target is `yolov4`; `yolov3` stays with `ultralytics`.

### The rotated-box formats

Two formats write rotated boxes (`obb`), and only rotated boxes: `yolo-obb` for the oriented-box
models in the Ultralytics line (`yolo11n-obb` and its siblings) and `dota` for the DOTA benchmark
and the toolkits that read it. The [CVAT XML formats](#the-cvat-xml-formats) also write a rotated
box as itself, beside their other geometries. **Ordinary YOLO detection is a different format**: a `class cx cy w
h` row has no angle, so `ultralytics`, `yolov5-yaml` and `darknet` either drop a rotated box or
write its enclosing axis-aligned box and report it degraded. Here the rotated box is native -
`supported_geometries` is `{obb}` and `degraded_geometries` is empty - and every other geometry is
**dropped and reported dropped**. Nothing is converted on the way out: a four-point polygon that
happens to be a rectangle is a polygon, and is dropped like any other. Both declare `lossy = True`
and one target each, named after the format, in family `other`; neither changes the `ultralytics`
targets.

A box is written as the four corners `obb_corners` gives, in order round the rectangle, and read
back through `obb_from_corners`, which takes any start corner in either direction and returns the
canonical box (see [annotations](annotations.md#a-rotated-box-is-a-centre-a-size-and-an-angle)).
Corners are **not clamped** into the picture: clamping one corner of a box that crosses the edge
bends it into a quadrilateral that is no longer a rectangle, and Ultralytics' own DOTA converter
does not clamp either. They are written with enough digits - twelve decimals of a fraction for
`yolo-obb`, nine of a pixel for `dota`, trailing zeros dropped - that **a round trip returns every
corner within `1e-6` of the box's longest side**, and the angle equal modulo the canonical form;
a box whose canonical angle sits at `-pi/2` may come back a hair inside `pi/2`, which is the same
rectangle. That is the importer's exact case, so an export reads back with no loss. A file written
elsewhere, with fewer decimals or hand-drawn whole pixels, is fitted instead: corners each within a
sixth of the shorter side of the nearest rectangle (or within one unit of their last decimal, for a
box too small to judge) import as that rectangle and a `geometry` loss, and anything farther is a
lost label (see [import](import.md#formats)). Each picture gets a label file, empty when it holds no rotated box.

#### `yolo-obb`

The `ultralytics` detection layout - `images/<fold>/<content-hash>.<ext>`,
`labels/<fold>/<content-hash>.txt` and the same `data.yaml`, `path: .`, a key per fold present and
`names` by index in the release's frozen schema order - with one row per rotated box:

```text
0 0.34375 0.416666666667 0.65625 0.416666666667 0.65625 0.583333333333 0.34375 0.583333333333
```

a class index and four `x y` corners, each a fraction of the picture's width or height - here a
20 by 8 pixel box at angle 0 on a 64 by 48 picture. A release
with no recipe points `val` at the training images, as `ultralytics` does.

#### `dota`

The benchmark's own layout, fold first, with no class list:

```
train/images/<content-hash>.png     train/labelTxt/<content-hash>.txt
val/…                               val/…
test/…                              test/…
```

One row per rotated box, the corners in pixels, then the class name as the category token, then
`difficult`:

```text
24 18 56 10 62 34 30 42 large-vehicle 0
```

No `imagesource:` or `gsd:` header is written. A category is one whitespace-free token and a row
cannot quote one, so each run of whitespace in a class name is written as a single hyphen, DOTA's
own spelling: `baseball diamond` is written `baseball-diamond`. The export report does not list the
rename, and an import of the output names the class `baseball-diamond`, because nothing in the file
records the original spelling. Two written classes that would share a category, such as
`small vehicle` and `small-vehicle`, refuse the export with `ExportSourceUnreadable` naming both,
rather than merging them. `yolo-obb` keeps names as they are, since they live in `data.yaml`.
`difficult` is `1` for a box carrying a boolean attribute named `difficult` set to true and `0`
otherwise, and an import reads it back into that attribute (see [import.md](import.md#formats)).

### The COCO format

`coco` writes COCO instances JSON - **one file per split**, under
`annotations/instances_<fold>.json`, beside the same `images/<fold>/` layout YOLO uses.

**v1 had two COCO exporters and neither described a dataset.** One skipped every annotation that
was not a box, the other every one that was not a polygon, so a project holding both - the
ordinary case, and now expressible in a single class since a class declares a *set* of
geometries - had to pick an export and silently lose the other half. There is one exporter here: COCO has always carried both, and
`bbox` is a required field on every annotation whether or not it also has a `segmentation`.

**`area` is the polygon's own area, by the shoelace formula, not its bounding box's.** v1 wrote
`width * height` for a segmentation, which overstates a triangle by exactly two and any concave
shape by more. That number is not decoration: `pycocotools` buckets detections into
small/medium/large by it, so every evaluation against such a file reports the wrong breakdown and
nothing says so.

**A mask is written as compressed RLE**, `{"size": [height, width], "counts": "..."}` - the stored
counts, byte for byte the string `pycocotools` encodes - with `bbox` the smallest pixel-aligned box
around its pixels and `area` its pixel count, the two numbers `pycocotools` computes from the same
RLE. An export reads back pixel for pixel. A mask not the size of its picture refuses the export by
asset rather than being written against the wrong frame.

**This format is not lossy, and that is the point of having a second one.**
`supported_geometries` is `{bbox, polygon, mask}`, and everything COCO has no field for - attributes,
confidence, provenance, the annotation's own id - rides in a `"visionset"` object on each
annotation. COCO is JSON and every reader tolerates keys it does not know; one nested object
cannot collide with a future COCO field the way four top-level keys could. So a release of boxes
and polygons exports **clean, with no consent at all**, and #65's report is what refuses a release
holding a classification tag - which COCO genuinely has nowhere to put.

Smaller decisions, each of which a reader can see:

- **Category ids are 1-based**, COCO's convention rather than ours: id 0 is conventionally
  background and `pycocotools` treats a missing category id as an error. The order is the frozen
  schema's, so a class nobody used still has its id.
- **Image and annotation ids restart at 1 in every fold.** `pycocotools` loads one file at a time
  and each is its own dataset; ids continuing across folds would leave `instances_val.json`
  starting at an arbitrary number, which reads as a file with rows missing.
- **A box gets an empty `segmentation`**, not its own rectangle. A box says where something is,
  not what shape it is, and writing the rectangle would claim the object fills it - which a mask
  consumer takes literally.
- **`iscrowd` is always 0**, a mask's included. A `1` marks a region covering many instances,
  which `COCOeval` ignores rather than matches; VisionSet has no crowd flag, a mask is one object,
  and `pycocotools` decodes an RLE `segmentation` whatever `iscrowd` says. A crowd region imported
  from COCO therefore exports as an ordinary mask, the flag already reported lost on import.
- **`info` carries the release**: tag, publication moment, and the manifest hash - so an export
  traces back to a release that can be re-verified. Nothing reads the clock, which is why two
  exports of one release are byte-identical.
- **`licenses` has one entry named `unspecified`.** VisionSet records no licensing information
  about an asset anywhere, so inventing one would be a claim nobody made.

### The segmentation-png format

`segmentation-png` writes semantic segmentation as class-index PNGs: `images/<fold>/<hash>.<ext>`
beside `masks/<fold>/<hash>.png`, one mask per picture, and `segmentation.json` at the top - the
descriptor the [`segmentation-png` importer](import.md#formats) requires, so an export reads back
with nothing guessed. Every class whose declared geometries include `mask` or `polygon` gets an id,
`1` upward in the frozen schema's order, as COCO's categories do; a class that can never reach a
mask, a box-only or tag-only one, gets none, as `classification` lists only tag-capable classes.
`0` is background and no id is ignore. A mask is an 8-bit greyscale (`L`) PNG whose grey level is
the id, or 16-bit (`I;16`) when there are more than 255 ids. An unlabelled picture's mask is all
background, so a picture with nothing in it reads back as one.

```json
{
  "format": "segmentation-png",
  "version": 1,
  "encoding": "index",
  "classes": {"1": "road", "2": "car"},
  "background": [0],
  "ignore": [],
  "images": "images",
  "masks": "masks",
  "splits": ["train", "val"],
  "visionset": {"release_id": "...", "release_tag": "v1", "manifest_hash": "...", "overlaps": []}
}
```

`supported_geometries` is `{mask}`: a mask's pixels are written exactly. `degraded_geometries` is
`{polygon}`: a polygon is rasterized at the picture's size, lighting each pixel whose centre it
holds, so what is finer than a pixel is lost. A box is dropped - a box says where something is, not
which pixels it covers - as are a tag and every other geometry. A class map holds one class per
pixel, so what it cannot say is content, not geometry: several masks of one class on one picture are
written as their union, one region on re-import, and a pixel two classes claim keeps the **lower**
id. Each picture where classes contested pixels is listed under `visionset.overlaps` with the
contested pixel count and the classes involved, the one that kept them included. Attributes, confidence and provenance have nowhere to go, so `lossy` is
true. COCO panoptic layouts and RGB colour-encoded masks are not written.

### The Pascal VOC format

`voc` writes one XML per image under `Annotations/`, the pictures under `JPEGImages/`, and the
folds as **listings** under `ImageSets/Main/<fold>.txt`.

That last one is the structural difference from its two siblings, and it decides the layout:
**VOC splits by listing rather than by directory.** A fold's file names stems, and a reader
resolves each against the one `JPEGImages/` - so every image lives in one flat directory whatever
fold it is in. Putting them in per-fold directories, as YOLO and COCO do, would make every path in
those files wrong.

**Coordinates are 1-based and inclusive, which is what "Pascal VOC" means.** The original devkit's
annotations index from 1, and evaluation code written against them subtracts one - detectron2's
VOC loader does exactly that, with a comment saying why. A box stored as `x=8, width=16` covers
0-based pixels 8..23 and is written `<xmin>9</xmin><xmax>24</xmax>`: sixteen pixels, counted the
way the format counts them. Writing the domain's own numbers through would be off by one against
every consumer that assumes the devkit, and off by one is the error nobody notices.

Boxes are also **rounded outwards** - `floor` on the near edge, `ceil` on the far one - so the
integer box covers every pixel the float box touches. Rounding to nearest would shrink a box by up
to a pixel on each side, which matters most for the small objects a detector is already worst at.
They are clamped into the image for the reason YOLO's are, and a box whose extent rounds away
still gets `xmax >= xmin`, because an inverted box gives a reader a negative area rather than an
error.

`lossy = True` and `supported_geometries` is `{bbox}`; `degraded_geometries` is `{obb, polygon}`,
each written as its axis-aligned bounding box. The reason is not YOLO's: a VOC `<object>`
has a fixed set of children its consumers index by tag name, so there is nowhere to put an
attribute, a confidence or a provenance - where COCO can carry all three precisely because JSON
readers ignore keys they do not know.

Two values are constants rather than measurements, and both are said out loud rather than dressed
up: `<depth>3</depth>`, because VisionSet records an asset's width and height and not its channel
count while VOC readers expect the element; and `<difficult>0</difficult>` on every object, which
matters more than it looks - VOC's evaluation *excludes* objects marked `1` from both the ground
truth and the false positives, so writing one anywhere would silently change what a score means.

There is **no reference-reader smoke test** for this format, unlike the other two. VOC's devkit is
MATLAB and every Python consumer parses the XML itself, so there is no loader worth pinning a CI
job to: the document is the contract, and the golden-file tests assert it as text.

### The classification format

The one installed format whose content *is* tags, and the only one that does not drop them. It
writes the pictures the way YOLO does - `images/<fold>/<content-hash>.<ext>` - plus two files at
the root: `labels.csv`, and `classes.txt` naming the label space.

`labels.csv` has three columns, `image,fold,class`, and **one row per tag annotation**. An image
carrying three tags appears three times, under one path, once per tag; its bytes are written once.
The kernel enforces no `(asset, class)` uniqueness for a classification tag, so two annotations of
the same class on one image produce two identical rows - the count follows the annotations exactly,
duplicates included, rather than deduplicating a label space this format does not own. The obvious
alternative - a folder per class, which is what most single-label tooling reads - cannot express any
of this: a multi-tagged image would have to be copied into every class directory, doubling the bytes
and making one picture look like several examples. It would also disagree with the pre-export
report, which counts annotations rather than images.

`image` is relative to the export root, so the directory is movable to a training machine and still
resolves. `fold` is derivable from that path and is written anyway, so a consumer reading one split
filters a column instead of parsing a path. The file is written through Python's `csv` module, not
by joining strings: a class name is normalized but not otherwise restricted, and one holding a
comma would shift every later column of a hand-built row while still parsing.

`classes.txt` is every *tag-capable* class the release declares, one per line, in the authored
schema order, including classes nothing was labelled with. Filtering to tag-capable classes is a
real departure from YOLO and COCO, which both name every declared class unfiltered - listing a
bbox-only class here would let a trainer allocate an output for a class this format can never emit.
So this format follows YOLO's class index on the *from-the-schema-not-the-data* half of its rule -
deriving the list from the annotations present is what silently changes it between two releases of
one project - and departs on the *every-class-gets-a-slot* half, which is the half that keeps a line
index stable. An additive schema change that adds `classification_tag` to an existing class can
therefore insert a name mid-vocabulary and shift every later line across two releases of one
project. `labels.csv` names a class by string, never by index, so line order is not part of this
format's contract - a consumer wanting a stable integer label builds its own name-to-index map from
`classes.txt` and cannot assume that map holds across releases.

`lossy = True`, because a row is a path and a class name - attributes, confidence, provenance and
the annotation's id have nowhere to go. `supported_geometries` is `{classification_tag}` and
`degraded_geometries` is **empty**: a box is not reduced to an image-level tag. Three boxes of one
class on one image would emit three identical rows, and a report counting them would be truthful
about a file that is not. Boxes, polygons and polylines are dropped, and the compatibility report
names them by class with a count before anything is written.

An asset with no tags gets its bytes and no row. There is no per-image file to leave empty here, so
absence from `labels.csv` is the only available spelling and it is the honest one.

### The lane formats

Five plugins - `tusimple`, `curvelanes`, `bdd100k-lane`, `culane`, `openlane-2d` - over the
`polyline` geometry #223 added. They are the port of the workload VisionSet's predecessor
actually ran, and they are what makes a lane dataset a first-class product of this tool rather
than a thing you write a script for.

All five declare `lossy = True`. A lane file has fields for a *lane*, and none of them has
anywhere to put an annotation's arbitrary attributes, its confidence, its provenance or its id.
Four of them write the vertices they were given, so `polyline` is in `supported_geometries`;
**TuSimple does not**, because its file format is "the X where the lane crosses each of these
rows", so a lane goes in as vertices and comes out as samples on a fixed grid. That is the third
state - carried, but reduced - and it is why `tusimple` declares `polyline` under
`degraded_geometries` while the other four do not.

A polyline's per-vertex `visibility` reaches **only `openlane-2d`**, the one lane format with a
per-point slot. OpenLane's flag is binary, so `visible` writes `1`, `occluded` writes `0`, and
`unlabeled` writes `1` - as does a lane with no visibility recorded at all, because OpenLane has no
"unknown" and an unjudged vertex is no claim that anything hid it. The other four have no
per-vertex field and drop it, which their `lossy = True` already covers. `openlane-2d` is also
the one lane format with an importer, which reads `0` back as occluded and `1` as visible; see
[import](import.md#formats).

The lane vocabulary is a convention on attribute names - `style`, `color`, `position_role`, each
a `select` - defined in `visionset/formats/lanes/_core.py` and not in the kernel, because the
domain does not know what a road is and the same geometry labels railway tracks. A missing
attribute resolves to `other` rather than refusing, and `position_role` falls back to the class
name, so a schema whose classes *are* the road positions needs no attributes at all. See
[`src/visionset/formats/lanes/README.md`](../../src/visionset/formats/lanes/README.md).

Two of the five refuse rather than invent: TuSimple will not write a lane whose points are not
sorted by ascending Y - its row sampling has no meaning for a path that doubles back - and CULane
will not write two lanes claiming the same one of its four mask slots. Both name the asset, and
both are the same `ExportSourceUnreadable` the YOLO exporter raises for a class the schema does
not declare.

**The YOLO dialects, COCO and VOC carry no polyline at all**, and that is checked rather than
assumed (`test_the_general_formats_declare_polyline_truthfully`). `yolov5-yaml` and `voc` reduce a
*polygon* to its bounding box, which is defensible because a polygon encloses an area a box
approximates; an open path encloses nothing, so a box drawn round it would be an invention.
`ultralytics` writes a polygon as its vertices - its presence is what selects the `segment` layout,
and its `degraded_geometries` is empty - but has no row for an open path either. COCO's
`segmentation` is a closed ring and it has no open-path primitive. All four therefore report a
polyline class as **dropped**, and their label files contain no trace of one.

### The KITTI format

`kitti` writes a release's point-cloud scans as KITTI 3D object detection splits, one per fold:
`<fold>/velodyne/<content-hash>.bin`, `<fold>/label_2/<content-hash>.txt` and
`<fold>/calib/<content-hash>.txt`, the layout the [`kitti` importer](import.md#formats) reads
back. It declares `supported_modalities` `{point_cloud}` and `supported_geometries`
`{cuboid_3d}`, so a release's images are reported dropped by count, and a `polyline_3d` or a
classification tag on a scan is reported dropped by class. `lossy = True`: attributes, provenance
and ids have nowhere to go. A confidence is written as the 16th column, KITTI's score.

**The boxes are in a canonical camera frame, not the sensor's.** A cuboid is stored in its scan's
declared frame, a `label_2` box is in a rectified camera frame, and a release holds no camera
calibration for a scan (see [the decision record](architecture/decisions/three-dimensional-labels-are-calibrated-image-labels.md)).
So every box is converted with one fixed calibration, and that calibration is written beside every
frame: `Tr_velo_to_cam` is KITTI's nominal axis swap with no offset (`x_cam = -y_lidar`,
`y_cam = -z_lidar`, `z_cam = x_lidar`) and `R0_rect` is the identity. The centre drops by
`h / 2` to the bottom face, the size `(l, w, h)` becomes `h w l`, and
`rotation_y = -yaw - pi/2`, wrapped into `[-pi, pi]`; `alpha` is `rotation_y` less the angle of
the ray to the box, `atan2(x, z)`. The boxes agree with the calibration that ships beside them,
and importing the export returns the same boxes within 2 micrometres (`y` and `h` are each written
to the micrometre and the importer recomputes the centre from both), but they are not in the
original rig's camera frame, and projecting them into the original images would place them wrongly.
A written angle stays within `[-pi, pi]` after rounding: `pi` itself is written `3.141592`.
There is no image, so `P0` to `P3` are `[I | 0]`, `Tr_imu_to_velo` is the identity, the 2D box is
zeros, truncation is `0` and occlusion is `3`, KITTI's unknown.

**A `.bin` is in the lidar's forward-left-up axes.** A scan in `lidar_flu` is written as stored;
one in `lidar_rfu` or `camera_rdf` is turned into `lidar_flu`, points and boxes alike, by the axis
permutation its frame declares, which keeps each cuboid's yaw. Coordinates are written in the
scan's own units, which KITTI reads as metres. Each point is float32 `x, y, z, intensity`, decoded
from the stored PCD, whose fields are read by name and any numeric type: a scan imported from KITTI
is written back byte for byte. Intensity is written as stored, not normalised: KITTI's own
reflectance is 0 to 1, while a scan imported from nuScenes carries 0 to 255. A point with a
non-finite coordinate is left out, and a missing or non-finite intensity is written as `0`. Three kinds of scan are refused by asset with
`ExportSourceUnreadable` rather than written wrongly: a PLY scan, an LZF-compressed
(`binary_compressed`) PCD, and a scan whose coordinates are stored wider than float32 and lie 8192
or more from the origin, as a georeferenced scan's do, which a float32 `.bin` would round.

A class name is KITTI's first token, so whitespace inside one is written as `_`; two class names
that would become one token refuse the export, and so does a class written `DontCare`, which KITTI
readers treat as a region to ignore and the importer drops. A pre-processing recipe is refused for this format,
because it transforms images.

### The MOTChallenge format

`mot` writes a release's tracked boxes as MOTChallenge (MOT16/17/20) sequences, one per source a
released track observes: `<source-id>/seqinfo.ini`, every frame the release holds of that source,
observed or not, as `<source-id>/img1/<frame:06d><ext>`, and `<source-id>/gt/gt.txt` with
`<source-id>/gt/labels.txt`, the layout the [`mot` importer](import.md#formats) reads back. Frame
`n` is the occurrence at position `n - 1`, so only a position the release holds no frame for is a
gap in `img1/`, and the frames after it keep their numbers; `seqLength` runs to the last held
position. A video source is not listed in the manifest, and a release published before version 9
lists no source at all, so for a clip, or any sequence of such a release, only the observed frames
are written. A row is
`frame,id,bb_left,bb_top,bb_width,bb_height,conf,class,visibility`: the box in pixels as stored,
`conf` `1` for a label with no confidence and its confidence otherwise, `class` the class's 1-based
position in the release's schema, which `labels.txt` lists in that order, and visibility `-1`
(unknown). A track whose imported id is a positive integer written without leading zeros keeps it;
every other track is numbered after the largest such id in its sequence, in manifest order, so no
two tracks of a sequence share an id and ids never cross sequences.

The manifest carries no sequence name and no frame rate, so a sequence is named by its source id
and `frameRate` is the last written position over its timestamp, rounded to six decimals: an
imported MOT sequence or a clip gives its own rate back, and timing that was not uniform keeps its
frame numbers and loses its spacing. A sequence whose timing is unknown (`null`, as a CVAT task's
is) is refused with `ExportSourceUnreadable` naming the first such frame, and so, with another
message, is one whose frames after the first are all at timestamp `0`, or whose frames differ in
pixel size or image type, because `seqinfo.ini` has one of each. It declares `supported_geometries` `{bbox}` and `tracked_only`, so a
box no track observes is reported dropped (see
[dropped is not degraded](#dropped-is-not-degraded-and-one-word-for-both-was-a-lie)); a frame whose
labels are all untracked is still written when its source is listed, without them.
`lossy = True`: attributes, provenance, the source's name and a confidence of exactly `0` or `1`
have nowhere to go (`0` reads back as an ignored entry, `1` as ground truth). The release's split
recipe is not applied, because a sequence is not cut across folds, and augmented variants observe no
track and are not written. MOTS, whose rows are instance masks, is not written.

### The CVAT XML formats

Two formats write CVAT's XML 1.1, one per dialect, and the [`cvat-images` and `cvat-video`
importers](import.md#formats) read each back. Neither is a generic "CVAT XML": each writes only its
own dialect. Both write coordinates in pixels as stored, at full precision rather than CVAT's two
decimals, a box as `xtl = x`, `xbr = x + width`, and polygon and polyline `points` as
`x,y;x,y;...`. `<meta><task>` names the release's classes in schema order, each label's `<type>` the
CVAT name of its one geometry (`rectangle`, `polygon`, `polyline`, `tag`) or `any` when it declares
several, and its attribute definitions: a `string` attribute as `text`, `number` as `number` with no
range, `boolean` as `checkbox` and `select` as `select` with its options. A shape's attribute values
are written as `<attribute name>` children, a boolean as `true` or `false`. Provenance survives only
as CVAT's `source`: `human` as `manual`, `model` as `auto` and `import` as `file`. Every shape is
`occluded="0"` and `z_order="0"`. A rotated box (`obb`) is a `<box>` of its width and height
about its centre, `xtl = cx - width / 2` and `ybr = cy + height / 2`, and a `rotation` of its angle
in degrees in `[0, 360)`, clockwise on screen as CVAT turns a box (see
[import](import.md#formats)); a rotated box at angle 0 writes no `rotation`, as CVAT does, so it
reads back as an axis-aligned box. Read back by the importer, a rotated box keeps its centre and
size to float rounding and its angle within `1e-9` radians, because it is written at full
precision; CVAT itself rounds `rotation` and coordinates to two decimals, so a box re-saved by
CVAT moves by up to `0.005` degrees and `0.005` pixels. A name or value holding a control character XML 1.0 cannot carry
refuses the export with `ExportSourceUnreadable` before anything is written. Both declare `lossy = True`: confidence, a polyline's per-vertex
visibility and the model behind a label have nowhere to go.

`cvat-images` writes `annotations.xml` and the pictures under `images/`, named by content hash, as
CVAT for images 1.1: one `<image>` per asset with its `id` in manifest order, its `name`, `width`
and `height`, and a `subset` that is its fold under the release's split recipe or `default` without
one. It writes boxes, rotated boxes, polygons, polylines and classification tags (`<tag>`) whole,
so its `supported_geometries` are those five and nothing is degraded.

`cvat-video` writes CVAT for video 1.1, one task per source a released track observes:
`<source-id>/annotations.xml` and every frame the release holds of that source, observed or not, as
`<source-id>/images/frame_<position:06d><ext>`. `<size>` runs to the last held position, and
`<original_size>` is the frames' one size; frames of two sizes or two image types refuse the
export, checked for every task before any is written. Only a position the release holds no frame
for is missing - one the source never held, or whose asset the dataset does not contain. The
importer, which keys frames by name, reads such a task back, but CVAT, which numbers a task's
pictures in sorted order, would shift every frame after that gap; a source released whole has
none. A video source is not listed in the manifest, and a release published before version 9 lists
no source at all, so for a clip, or any sequence of such a release, only the observed frames are
written. Attribute definitions are written
`mutable="True"`, because a value may change from frame to frame. A track whose imported id is a non-negative integer written without leading zeros keeps
it, and every other is numbered after the largest such id in its task. Each observation is a shape
at `keyframe="1" outside="0"`; where a track does not continue to the next frame, an
`outside="1"` keyframe follows, because CVAT otherwise carries a track across a gap and to the
task's end. A CVAT track holds one shape element, so a track observing two refuses the export; a
box and a rotated box are both a `<box>` and may share a track. It
declares `{bbox, obb, polygon, polyline}` and `tracked_only`, so a label no track observes, and every tag,
is reported dropped. The split recipe is not applied, and augmented variants observe no track.

### The destination is the caller's

`ReleaseService.export` checks `dest` before anything is written, so every surface refuses the
same paths with the same codes:

- it must be **absolute** - a relative or `~` path is `EXPORT_DESTINATION_REFUSED`. The CLI
  resolves `--out` against its working directory first; MCP passes `dest` as given;
- it must be **outside the workspace** - the workspace root, anything under it, and any directory
  containing it are refused, so an export can neither write beside `visionset.db` and `blobs/`
  nor walk them when counting. Paths are compared by file identity, so a different spelling of
  the same directory on a case-insensitive file system is refused too. Only the REST surface's
  export job, passing `owned_by_workspace`, writes inside the workspace - under its own
  `exports/`, which it clears first;
- a **file**, or a directory that cannot be created or read, is `EXPORT_DESTINATION_REFUSED`
  naming the operating system's reason;
- a directory that **already holds files** is `EXPORT_DESTINATION_NOT_EMPTY` unless the caller
  passes `allow_non_empty` (`--allow-non-empty` on the CLI; MCP's envelope carries
  `retry_with: "allow_non_empty"`). Two exports in one directory would otherwise mix - a split
  release's `val`/`test` files beside an unsplit one's `train` - under a report naming only the
  second.

Even with consent the directory is **not** emptied - deleting files under a path a caller named
is not the kernel's to do - so `ExportResult`'s counts then describe the directory once the
plugin has run rather than this run alone. The REST route clears its own path first, because it
built the path itself.

Every image blob the release names is then **hash-checked**, the check `verify` makes, and a
missing, unreadable or altered one is `EXPORT_SOURCE_UNREADABLE` naming the asset - before `dest`
is created, so a refused export writes nothing. The recipe is checked before `dest`, so retrying
with `allow_non_empty` does not then meet a recipe refusal. The hash check precedes the copy
rather than covering it: a blob rewritten in between is not caught.

Counting is `ReleaseService`'s rather than the plugin's, deliberately: a number reported by the
thing it describes is not checkable, and an exporter that writes nothing must report zero rather
than say what it meant to do.

## At a terminal

```bash
visionset release publish --tag v1.0 --project road-signs --split 0.7,0.15,0.15 --seed 42
visionset release list --project road-signs
visionset release verify v1.0 --project road-signs
visionset export --project road-signs --release v1.0 --target yolo11 --out ./out
visionset export --project road-signs --release v1.0 --format coco --out ./out
visionset export --project road-signs --release v1.0 --target yolo11 --recipe yolo-640 --out ./out
visionset target list
```

`--split` is **one** option rather than three, because a split is one concept, `0.7,0.15,0.15` is
how it is written everywhere, and one flag means one refusal to word. `--seed` stays separate; it is
not a fraction, and without `--split` it is refused as exit 2 because it would change nothing.
`--group-by group_label` [keeps a group in one fold](#keeping-a-group-in-one-fold) and is refused
the same way without `--split`. Fractions that do not add up are exit 2 - `SplitRecipe` refuses
them with a pydantic error, which is not a `VisionSetError` - so the CLI parses the recipe before
the call.

**A tag is case-sensitive where a project name is not.** Both comparisons live in the kernel beside
the index that enforces them (`ReleaseService.get_by_tag`, `ProjectService.get_by_name`), because
they are opposites and a surface re-deriving either would eventually pick the wrong one.

**`release verify` exits 1 when the answer is no.** Nothing refused - the check ran and found
damage - but a non-zero exit is what `grep` and `diff` already mean, and the only way a script
branches on the result without parsing output:

```bash
visionset release verify v1.0 --project road-signs && ./train.sh
```

For `export`, the CLI resolves the name through the plugin registry and hands the *instance* to
`ReleaseService.export`, because the kernel is forbidden from importing the registry. It resolves a
format with `pick` and a target with `resolve_target`, never a dict lookup: a `KeyError` is outside
the `VisionSetError` tree and a typo would answer with a traceback instead of the list of installed
names. `visionset format list` and `visionset target list` print those lists without opening a
workspace at all.

**`--target` and `--format` are one choice.** A target is the model the release will train and
resolves to the format that writes for it; a format addresses no trainer. Giving both, or neither,
is a usage error at exit 2, because the mistake is on the command line and nothing has been opened
yet. `--format yolo`, the former name of `ultralytics`, still works for one release and prints a
deprecation line on stderr naming the current name.

`--allow-lossy` is the third gate word, never folded into `--yes` or `--allow-destructive`. The
formats are [the YOLO dialects](#the-yolo-dialects), [COCO](#the-coco-format) and
[VOC](#the-pascal-voc-format) below.

When an export does leave something behind, the names go to **stderr** with the rest of the prose,
so `visionset export … | xargs` still receives exactly the directory:

```
Not carried by boxes-only: lane (1204). See visionset-export-report.json.
```

`--json` carries the whole report under `compatibility`, for the caller that never opens the
directory.

**`export --check` is how you see that report before committing to anything** (#163). Until it
landed, `check_export` was reachable over HTTP and from MCP and from nowhere at a terminal, so the
only way to find out what an export would cost was to attempt one and read a refusal naming neither
the classes nor the counts:

```bash
$ visionset export --check -p road-signs --release v1.0 -f boxes-only
CLASS  GEOMETRY  STATUS   ANNOTATIONS  ASSETS  REASON
sign   bbox      dropped  6            6       boxes-only cannot write bbox
boxes-only would drop 6 annotation(s) across 6 asset(s), and write 0 annotation(s) across 0
asset(s) in a reduced form.
Re-run without --check and with --allow-lossy to export anyway.
```

Exit **1**, on `release verify`'s precedent, and on the same predicate `export` gates on - see
[Consent is required if *either* says so](#consent-is-required-if-either-says-so): a lossy format
exits 1 here even when the table is clean, because otherwise `--check && export` would promise
something the export then refuses.

The refusal from a real `export` now also names the flag a person types. The kernel's sentence says
`allow_lossy`, which is the service parameter; `cli/_errors.py`'s `_HINTS` adds `--allow-lossy` and
`--check` underneath, which is the surface supplying a remedy without bending a domain message
toward one caller. See [cli.md](cli.md#visionset-release-and-visionset-export).

## Over HTTP

The [API](api.md) is this service, one route per method, plus the format listing.

```
POST /datasets/{id}/releases  { "tag": …, "split"? }  → 201 ReleaseOut
GET  /datasets/{id}/releases                          → 200 ReleasePage
GET  /releases/{id}                                   → 200 ReleaseOut
GET  /releases/{id}/manifest                          → 200 application/json, raw
GET  /releases/{id}/verify                            → 200 ReleaseVerificationOut
GET  /releases/{id}/assignment                        → 200 SplitAssignmentOut
GET  /releases/{id}/export-compatibility?target=|format=&recipe=   → 200 ExportCompatibilityOut
POST /releases/{id}/export?target=|format=&allow_lossy=&recipe=    → 202 BackgroundJobOut
GET  /formats                                                 → 200 FormatPage
GET  /export-targets                                          → 200 ExportTargetPage
```

**`target` and `format` are query aliases, and exactly one is given.** Both or neither is a 422
`VALIDATION_ERROR` whose one error has `loc: ["query"]` and the message
`give exactly one of target and format`, so a client branches on the code and the location like
every other malformed request. An unknown target is 404 `EXPORT_TARGET_NOT_FOUND` naming the
installed ones; a target two installed formats both declare is 500 `EXPORT_TARGET_CONFLICT`.

**The manifest download is raw bytes off the blob store**, not `ReleaseService.manifest()`
re-serialized, and that is the point of the route rather than an optimization. A manifest is
hash-pinned evidence: what arrives must hash to `manifest_hash`, and a round trip through this
build's JSON encoder would put a second serializer between a client and the bytes the hash is
*of*. The `ETag` is that digest and the response is `Cache-Control: …, immutable`, both honest
because a document named by its own hash cannot change.

**`verify` is a GET and is not free.** It changes nothing, which is what decides the method, but
it re-reads and re-hashes every blob the release names. `missing` and `corrupt` stay separate
lists because they are different faults with different remedies, and `ok` is published as a
plain field so a client does not re-derive the conjunction slightly differently from us.

**`split` is `{train, val, test, seed?, group_by?}`**, and `ReleaseOut.split` answers all five,
`group_by` `null` for a recipe that does not group. `group_by` takes `"group_label"` and nothing
else; another value is a 422 `VALIDATION_ERROR`.

**A release with no split recipe has no assignment**, and that is a `404 NO_SPLIT_RECIPE` rather
than an empty answer. No recipe means one undivided set; answering all-train would be
indistinguishable from a real recipe that said so.

**Export is queued**, and this document used to record the opposite. The limit was that
launch-and-poll needs a row to poll and a row needs a table; #328 gave the product a generic one,
so the argument expired. `ultralytics` writes one file per image and copies the pixels, which is minutes
of work behind a request with no way to report progress and every proxy's timeout in front of it.

```
POST /releases/{id}/export?format=ultralytics   →  202 Accepted
                                            Location: /background-jobs/{job_id}

GET  /background-jobs/{job_id}           →  200 { "state": "running",   … }
GET  /background-jobs/{job_id}           →  200 { "state": "succeeded", "result": { … } }
GET  /background-jobs/{job_id}/artifact  →  200 application/zip
```

**Everything a caller can be told now is still told now**, which is the half of the old shape
that survived: an unknown format is a 404 and an unconsented lossy export is a 409, both on
*this* request, and neither creates a job. So a caller holding a job id holds one that will run.
The consent check therefore happens twice - once here as the answer, once in the worker as the
guarantee - which is the same bargain a uniqueness pre-check and its unique index already strike.

The output is built in `<workspace>/exports/<release_id>/<format>/`, a server-owned directory
like `uploads/`, and the handler clears it before each run so the archive describes *this* export
and not the last one. The archive is a sibling of that directory rather than a file inside it, so
a re-export cannot sweep the previous one into the new one.

**Nothing expires it, and that is the policy rather than a gap.** An export stays in
`<workspace>/exports/` until somebody deletes it: there is no TTL, no size cap, no sweeper, and
no `DELETE` route. VisionSet is local-first and the disk is the user's - a tool that quietly
removed a training set somebody had exported, on a schedule they did not choose, would be
solving a problem they did not report by taking an action they cannot undo. It is the same
posture blobs and staged uploads already have, and it is stated here rather than left implicit
so that "exports are never cleaned up" reads as an answer instead of an omission. A deployment
that does want a policy owns one: the directory is plain files under a path the operator chose,
and `find`, a cron job or a retention rule on the volume are all better placed to express it
than this product is. Re-exporting is free, so deleting the lot is safe.

**Which formats exist is a property of the deployment**, so `GET /formats` answers it rather
than this document. `lossy` is on the row so a client knows before it POSTs whether the export
will need `allow_lossy=true`, instead of discovering it by getting a 409; `geometries` and
`modalities` beside it are what the format declares it can write, and `targets` names the models
it writes for. `GET /export-targets` is the same installation seen from the trainer's side, one
row per target with its `format`, `tasks`, `geometries` and `hints` - flattened so a client renders
one control from one read. The job an export launches carries `target` and `format` in its payload
and its result, and the archive is still laid down under `<workspace>/exports/<release_id>/<format>/`.

**`export-compatibility` is the pre-flight, and it is optional.** Same release, same format name,
and the same document the export refuses with and writes into its own output - a client showing a
consent dialog asks first, one that would rather be refused does not have to. A GET, because it
writes nothing and a release is immutable, so the answer is as stable as the release is. The 409
carries the identical body under `detail.compatibility`.

## Errors

| Error | When |
| --- | --- |
| `DatasetNotFound` | No dataset with that id in this workspace - including one in a *different* workspace, which reads as missing rather than as forbidden. |
| `ReleaseNotFound` | No release with that id in this workspace. |
| `SchemaNotFound` | The project has no schema, so there is no version to pin. Checked before emptiness. |
| `EmptyRelease` | The dataset has no assets. A release of nothing is an artifact nobody can train on. Zero *annotations* is fine - unlabeled images are legitimate training data. |
| `InvalidName` | The tag is blank once stripped, longer than 128 characters, or not a slug: it must start with a letter or digit and hold only letters, digits, `.`, `_`, `+` and `-`, because a tag can become a path component in an export. Checked on publish only; looking up a tag never refuses it for its shape. Tags stay case-sensitive. |
| `ReleaseTagTaken` | This dataset already has a release under that tag. **Case-sensitive**: a tag is an identifier like a git tag, so `v1.0` and `V1.0` are two releases. Enforced by a pre-check and by a unique index, the second so a race cannot slip past the first. |
| `NoSplitRecipe` | `assignment` was asked of a release published without one. Not an error in the release: no recipe means one undivided set, and inventing an all-train answer would be indistinguishable from a real one. |
| `UnserializableManifest` | An annotation carries a NaN or infinite coordinate. `Geometry` accepts any float, so such a label can be stored; canonical JSON cannot express it, and writing `null` or the bare token `NaN` would lose data or produce a document no other tool can parse. |
| `CalibrationMissing` | An asset carrying a 3D label has no calibration, neither its own nor its source's. 409. |
| `CalibrationResolutionMismatch` | An asset carrying a 3D label has a calibration measured at another size than the asset. 422. |
| `WorkspaceCorrupt` | The manifest blob is gone, or is not a readable manifest, or the trunk holds an asset that is not stored. All are guarantees failing rather than entities missing. |
| `ExportSourceUnreadable` | The release names bytes an export cannot use - the blob is gone, no longer matches its content hash, is not an image the format can write, or is a scan `kitti` cannot decode; also a recipe given for an export that writes scans. **409, not 500**: the request is fine and the stored state is not, so the message names the asset and reaches the caller. For a missing or altered blob the remedy is `verify` and then restoring it; for the recipe, exporting without it. A previous generation of this tool swallowed this and shipped a training set one image short. |
| `ExportDestinationRefused` | The export directory is relative, inside or containing the workspace, a file, or cannot be created or read. Not overridable; the remedy is another path. |
| `ExportDestinationNotEmpty` | The export directory already holds files and the caller has not passed `allow_non_empty`. Overridable; the files are then kept and counted. |
| `ExportFormatNotFound` | Nothing is installed under that format name. Raised by the registry in `visionset.formats`, not by this service - the kernel never sees a name. |
| `ExportTargetNotFound` | No installed format declares a target under that name. Raised by `resolve_target` on the port, over the exporters the surface passed in; the message names the installed targets. |
| `ExportTargetConflict` | Two installed formats declare one target name. A defect of the installation rather than of the request - 500 over HTTP - and the remedy is removing one of the distributions, or exporting by format name. |
| `InvalidExportTarget` | An installed format declares a target promising a geometry the format never writes. Refused at the registry scan, so a defective plugin fails every listing rather than one export. |
| `LossyExportNotConsented` | The chosen format cannot carry everything the release holds, and the caller has not passed `allow_lossy`. Raised when the format declares itself lossy **or** when this release's own report is not clean, and it carries that report. Retryable with the flag, which is why a client must branch on the code and never on the 409. |
| `PreprocessingRecipeNotFound` | The release's project has no recipe under the name the export was given. Resolved through the project the release's dataset hangs off. |
| `AugmentationRequiresSplit` | The recipe asks for augmented variants and the release was published without a split recipe, so there is no train fold to augment. Raised at pre-flight and again at export. |
| `PreprocessingStepUnsupportedGeometry` | A recipe step cannot transform a geometry the export would carry - `rot90` over a polyline, or a resize, flip or quarter turn over a 3D label. A refusal, never a consent: a label that cannot follow its image is not something to consent to. Carries the step, the geometry and the first asset. |
| `PreprocessingDriverNotFound` | No installed driver applies a step kind the recipe holds. A fact about the installation rather than the request, 500 over HTTP; the message lists the kinds that are installed. |


## In the browser

`@visionset/ui-core`'s dataset screen carries the stats, the release timeline, the
publish dialog, the project's [pre-processing recipes](preprocessing.md) and export -
addressed to a target model, with a recipe chosen beside it. Three things it takes from this page rather than
re-deciding: a release is immutable, so nothing offers an edit; verification is **on
demand**, because it re-reads every blob; and a split's fractions are compared with
the same tolerance the kernel uses, since `0.7 + 0.15 + 0.15` is not `1.0`.

Export consent is `allow_lossy` and never `confirm` - see
[ui.md](ui.md#the-dataset-its-releases-and-getting-the-data-out).
