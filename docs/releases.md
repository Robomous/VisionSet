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

### Which schema version a release pins

The project's **active** version - the highest one - with its classes. Each copied annotation
still carries the version its own batch pinned, and those can differ: two batches approved
against two versions can both be promoted into one trunk. The mixture is safe rather than sloppy,
because `SchemaChangeWouldOrphan` refuses to remove a class that annotations still depend on. Every
label in a manifest is still described by the classes in that manifest.

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

`ReleaseService.export(release_id, exporter, dest, *, allow_lossy=False)` takes an **`Exporter`
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
beside it, declared and published, and is read below.

`ReleaseService.check_export(release_id, exporter)` judges one release's **frozen manifest**
against one format's declaration and returns an `ExportCompatibility`:

```json
{
  "release_id": "…", "format": "yolo", "compatible": false,
  "format_is_lossy": true,
  "excluded_annotations": 40, "excluded_assets": 40,
  "degraded_annotations": 1204, "degraded_assets": 310,
  "classes": [
    {"label_class": "lane", "geometry": "polygon", "status": "degraded",
     "annotations": 1204, "assets": 310,
     "reason": "yolo writes a polygon as its bounding box; the shape is lost"},
    {"label_class": "sign", "geometry": "bbox", "status": "supported",
     "annotations": 8800, "assets": 2400, "reason": null},
    {"label_class": "weather", "geometry": "classification_tag", "status": "dropped",
     "annotations": 40, "assets": 40,
     "reason": "yolo cannot place a classification_tag and drops it"}
  ]
}
```

**One row per `(label_class, geometry)`, not per class.** A class accepts a *set* of
geometries ([schemas.md](schemas.md)), and a format's answer can differ across it: a class
labelled both as boxes and as outlines is, to YOLO, one half written whole and one half
written reduced. It contributes two rows. A single row could carry only one of those verdicts
and would describe half its own output wrongly whichever it picked - the same defect
`compatible: bool` had before three statuses replaced it, one level down.

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
- **`degraded_geometries`** - written, having lost something the kernel could represent. `{polygon}`
  for `yolo` and `voc`; empty for `coco`, which writes a polygon as a polygon, and empty for
  `dummy`, which writes nothing at all. The two sets are disjoint, and `supported` wins if a plugin
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

**Modality is declared but not yet judged against.** A `ManifestAsset` carries no modality -
adding one would change the shape of every manifest and therefore every release hash ever
computed - and reading it off the live `Asset` would make the report depend on something that
moves after publication. `supported_modalities` is published on `GET /formats` and in
`list_formats` so a caller can see what a format claims; making it part of the verdict needs a
field on `ManifestAsset` behind a `MANIFEST_VERSION` bump, which is its own decision.

### Consent is required if *either* says so

`export` refuses with `LossyExportNotConsented` when the format declares itself lossy **or** when
the report says this release would lose something. The first half is what #30 shipped and has not
moved; the second is the case a capability list makes visible - a format declaring itself
lossless still cannot silently drop a geometry it never claimed to write.

The refusal carries the report, so a caller can say what it is consenting to without asking
twice: `LossyExportNotConsented.compatibility` in Python, `detail.compatibility` on the API's 409,
and - because the MCP envelope is four keys and stays four keys - a hint naming `check_export` for
an agent.

### Every export writes its own report

A successful export writes **`visionset-export-report.json`** at the root of `dest`: the same
document, key for key. It is the kernel's file rather than the format's, so it is written *after*
the plugin runs (a plugin that clears its own subdirectory would otherwise take it along) and is
**excluded from `ExportResult.file_count` on both sides** - not counted when written, and skipped
when an earlier run left one behind. That is what keeps "an exporter that writes nothing reports
zero" true, and keeps exporting twice into one directory agreeing with itself.

### The YOLO detection format

`yolo` is the first format here that writes anything, and it is a rewrite of v1's rather than a
port. The layout:

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
publication, and every class gets an index whether or not anything uses it.

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

Three details of `data.yaml` are ultralytics' contract rather than ours, and each was measured
against its source rather than assumed:

- **There is no `path:` key.** Ultralytics resolves a relative `path` against its own datasets
  directory or the working directory of whatever process loads the file - so the obvious `path: .`
  breaks the moment the export is copied. Omitted, it falls back to the yaml's own parent, which
  is what makes the directory movable.
- **`train` and `val` are both required**, and a missing key is a `SyntaxError` rather than a
  default. A release published without a recipe is one undivided set, so `val` names the training
  images: that says "there is no held-out set", where omitting the key says "this file is
  malformed". `test` is optional and is written only when it has something in it.
- **`images/` → `labels/` is a string substitution on the resolved image path**, not a configured
  location, so those two directory names are load-bearing.

An asset with nothing on it gets an **empty** label file rather than none: ultralytics reads a
missing file as "nobody looked" and an empty one as "somebody looked and there is nothing here",
and a detector needs the second.

`yolo` is `lossy = True` unconditionally, because a label row is five numbers - attributes,
confidence and provenance never survive - so every export in this format asks for consent. Its
`supported_geometries` is `{bbox}`: a polygon is still written, as its axis-aligned bounding box,
but its shape is gone, so #65's report counts it as not carried and says which classes and how
many. A classification tag has no location at all and is dropped rather than given an invented box.

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

**This format is not lossy, and that is the point of having a second one.**
`supported_geometries` is `{bbox, polygon}`, and everything COCO has no field for - attributes,
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
- **`iscrowd` is always 0.** A `1` means an RLE region covering many instances, which the domain
  cannot represent.
- **`info` carries the release**: tag, publication moment, and the manifest hash - so an export
  traces back to a release that can be re-verified. Nothing reads the clock, which is why two
  exports of one release are byte-identical.
- **`licenses` has one entry named `unspecified`.** VisionSet records no licensing information
  about an asset anywhere, so inventing one would be a claim nobody made.

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

`lossy = True` and `supported_geometries` is `{bbox}`. The reason is not YOLO's: a VOC `<object>`
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

`labels.csv` has three columns, `image,fold,class`, and **one row per `(image, tag)` pair**. An
image carrying three tags appears three times, under one path, once per tag; its bytes are written
once. The obvious alternative - a folder per class, which is what most single-label tooling reads -
cannot express that at all: a multi-tagged image would have to be copied into every class
directory, doubling the bytes and making one picture look like several examples. It would also
disagree with the pre-export report, which counts annotations rather than images.

`image` is relative to the export root, so the directory is movable to a training machine and still
resolves. `fold` is derivable from that path and is written anyway, so a consumer reading one split
filters a column instead of parsing a path. The file is written through Python's `csv` module, not
by joining strings: a class name is normalized but not otherwise restricted, and one holding a
comma would shift every later column of a hand-built row while still parsing.

`classes.txt` is every class the release declares that can carry a tag, one per line, **in the
authored schema order, including classes nothing was labelled with**. This is the rule YOLO's class
index follows and for the same reason: a vocabulary derived from the annotations present changes
silently between two releases of one project, and a model trained against the first is evaluated
against a different label space.

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

The lane vocabulary is a convention on attribute names - `style`, `color`, `position_role`, each
a `select` - defined in `visionset/formats/lanes/_core.py` and not in the kernel, because the
domain does not know what a road is and the same geometry labels railway tracks. A missing
attribute resolves to `other` rather than refusing, and `position_role` falls back to the class
name, so a schema whose classes *are* the road positions needs no attributes at all. See
[`src/visionset/formats/lanes/README.md`](../src/visionset/formats/lanes/README.md).

Two of the five refuse rather than invent: TuSimple will not write a lane whose points are not
sorted by ascending Y - its row sampling has no meaning for a path that doubles back - and CULane
will not write two lanes claiming the same one of its four mask slots. Both name the asset, and
both are the same `ExportSourceUnreadable` the YOLO exporter raises for a class the schema does
not declare.

**YOLO, COCO and VOC carry no polyline at all**, and that is checked rather than assumed
(`test_the_three_general_formats_declare_polyline_truthfully`). YOLO and VOC reduce a *polygon*
to its bounding box, which is defensible because a polygon encloses an area a box approximates;
an open path encloses nothing, so a box drawn round it would be an invention. COCO's
`segmentation` is a closed ring and it has no open-path primitive. All three therefore report a
polyline class as **dropped**, and their label files contain no trace of one.

### The destination is the caller's

`dest` is created if it is not there and is **not** emptied if it is - deleting files under a
path a caller named is not the kernel's to do. So `ExportResult`'s counts describe the directory
once the plugin has run, which is the same thing as "this run" for a fresh directory and not for
one holding an older export. A caller that needs the stricter reading clears the directory
first; the REST route does, because it built the path itself.

Counting is `ReleaseService`'s rather than the plugin's, deliberately: a number reported by the
thing it describes is not checkable, and an exporter that writes nothing must report zero rather
than say what it meant to do.

## At a terminal

```bash
visionset release publish --tag v1.0 --project road-signs --split 0.7,0.15,0.15 --seed 42
visionset release list --project road-signs
visionset release verify v1.0 --project road-signs
visionset export --project road-signs --release v1.0 --format dummy --out ./out
```

`--split` is **one** option rather than three, because a split is one concept, `0.7,0.15,0.15` is
how it is written everywhere, and one flag means one refusal to word. `--seed` stays separate; it is
not a fraction. Fractions that do not add up are exit 2 - `SplitRecipe` refuses them with a pydantic
error, which is not a `VisionSetError` - so the CLI parses the recipe before the call.

**A tag is case-sensitive where a project name is not.** Both comparisons live in the kernel beside
the index that enforces them (`ReleaseService.get_by_tag`, `ProjectService.get_by_name`), because
they are opposites and a surface re-deriving either would eventually pick the wrong one.

**`release verify` exits 1 when the answer is no.** Nothing refused - the check ran and found
damage - but a non-zero exit is what `grep` and `diff` already mean, and the only way a script
branches on the result without parsing output:

```bash
visionset release verify v1.0 --project road-signs && ./train.sh
```

For `export`, the CLI resolves the format name through the plugin registry and hands the *instance*
to `ReleaseService.export`, because the kernel is forbidden from importing the registry. It resolves
it with `pick`, never a dict lookup: a `KeyError` is outside the `VisionSetError` tree and a typo
would answer with a traceback instead of the list of installed formats. `visionset format list`
prints that list without opening a workspace at all.

`--allow-lossy` is the third gate word, never folded into `--yes` or `--allow-destructive`. And
`dummy` writes nothing, so a `file_count` of 0 in its report is an export that ran, not one that
failed. The real ones are [YOLO](#the-yolo-detection-format), [COCO](#the-coco-format) and
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
GET  /releases/{id}/export-compatibility?format=      → 200 ExportCompatibilityOut
POST /releases/{id}/export?format=&allow_lossy=       → 200 application/zip
GET  /formats                                         → 200 FormatPage
```

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

**A release with no split recipe has no assignment**, and that is a `404 NO_SPLIT_RECIPE` rather
than an empty answer. No recipe means one undivided set; answering all-train would be
indistinguishable from a real recipe that said so.

**Export is queued**, and this document used to record the opposite. The limit was that
launch-and-poll needs a row to poll and a row needs a table; #328 gave the product a generic one,
so the argument expired. `yolo` writes one file per image and copies the pixels, which is minutes
of work behind a request with no way to report progress and every proxy's timeout in front of it.

```
POST /releases/{id}/export?format=yolo   →  202 Accepted
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
`modalities` beside it are what the format declares it can write.

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
| `InvalidName` | The tag is blank once stripped. Tags go through `normalize_name` like every other name. |
| `ReleaseTagTaken` | This dataset already has a release under that tag. **Case-sensitive**: a tag is an identifier like a git tag, so `v1.0` and `V1.0` are two releases. Enforced by a pre-check and by a unique index, the second so a race cannot slip past the first. |
| `NoSplitRecipe` | `assignment` was asked of a release published without one. Not an error in the release: no recipe means one undivided set, and inventing an all-train answer would be indistinguishable from a real one. |
| `UnserializableManifest` | An annotation carries a NaN or infinite coordinate. `Geometry` accepts any float, so such a label can be stored; canonical JSON cannot express it, and writing `null` or the bare token `NaN` would lose data or produce a document no other tool can parse. |
| `WorkspaceCorrupt` | The manifest blob is gone, or is not a readable manifest, or the trunk holds an asset that is not stored. All are guarantees failing rather than entities missing. |
| `ExportSourceUnreadable` | The release names bytes an export cannot use - the blob is gone, or is not an image the format can write. **409, not 500**: the request is fine and the stored state is not, so the message names the asset and reaches the caller. The remedy is `verify` and then restoring the blob. A previous generation of this tool swallowed this and shipped a training set one image short. |
| `ExportFormatNotFound` | Nothing is installed under that format name. Raised by the registry in `visionset.formats`, not by this service - the kernel never sees a name. |
| `LossyExportNotConsented` | The chosen format cannot carry everything the release holds, and the caller has not passed `allow_lossy`. Raised when the format declares itself lossy **or** when this release's own report is not clean, and it carries that report. Retryable with the flag, which is why a client must branch on the code and never on the 409. |


## In the browser

`@visionset/ui-core`'s dataset screen carries the stats, the release timeline, the
publish dialog and export. Three things it takes from this page rather than
re-deciding: a release is immutable, so nothing offers an edit; verification is **on
demand**, because it re-reads every blob; and a split's fractions are compared with
the same tolerance the kernel uses, since `0.7 + 0.15 + 0.15` is not `1.0`.

Export consent is `allow_lossy` and never `confirm` - see
[ui.md](ui.md#the-dataset-its-releases-and-getting-the-data-out).
