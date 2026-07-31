# Releases

A Release is the one artifact in VisionSet that never changes. Everything else is alive — a
[dataset](datasets.md) gains assets and loses them, a [schema](schemas.md) grows a version, a
[batch](batches.md) moves through its states. A Release takes a moment of the trunk out of time
and answers, forever, *which bytes and which labels did we train on?*

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
| Every annotation on those assets, **copied** — geometry, attributes, provenance | `created_at`, `visionset_version` |
| The project's active schema version and its classes | The split recipe |
| | `schema_version`, `asset_count`, `annotation_count` — a read cache |

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
asset's labels sort by id. The `Manifest` model applies that itself, on construction — a rule the
artifact depends on belongs to the artifact, not to the habits of whoever builds one. Which batch
an asset arrived in, and on which day, must never reach the bytes.

`Manifest.classes` is the one collection that is *not* sorted. A schema's class order is
authored — it drives how a labeling surface lists them — so it is part of the frozen contract.

**The manifest hash is a snapshot identity, not a universal content identity.** `ManifestAsset.uri`
is a workspace-local path, kept because an exporter names its output files from it. The same
images ingested on another machine produce a different manifest.

### Which schema version a release pins

The project's **active** version — the highest one — with its classes. Each copied annotation
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
is there, which proves nothing about what is in it — a content-addressed store does not verify
itself, and that is the whole reason this method exists. `exists` is used only to tell a missing
blob from a corrupt one.

The manifest is settled first. If its own bytes no longer hash to `manifest_hash`, the report
says `manifest_intact=False`, `checked=0`, and the walk stops: a document that has been altered
is not an inventory worth trusting, and reporting assets missing on the strength of a tampered
list would be worse than saying nothing.

The row's cached `schema_version` and two counts are checked against the parsed document as well.
Anything in `cache_mismatches` is a bug in the build that wrote the row, not damage to the
workspace — a cache nobody checks is a fact nobody can trust.

## The split recipe

Declarative and stored, never materialized into the release:

```python
SplitRecipe(train=0.8, val=0.1, test=0.1, seed=42)
```

The fractions must add up to one, checked with a tolerance because `0.7 + 0.15 + 0.15` is
`0.9999999999999999` in binary floating point. An all-train recipe is legal. An invalid recipe
cannot be constructed at all — the refusal is pydantic's, like every other per-value rule in the
domain.

`releases.assignment(release_id)` turns it into folds, **from the manifest's frozen asset set**.
Reading live membership there would let a curator change a published release's folds by editing
the trunk afterwards, which is precisely what a release exists to make impossible.

The assignment is deterministic without a random number generator. Each asset is keyed by
`sha256(seed:content_hash)` and ordered by that key, so the result depends on the seed and on the
set — never on the order assets are passed in, on how many there are, or on the Python
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
  deleting its project, whose cascade takes it — and even then the manifest blob survives, because
  [blobs are never deleted](projects.md).
- **No `confirm=`.** That guard is for destroying data, and publishing destroys nothing. This is
  not a third exemption from `ConfirmationRequired`.
- **No change-log entry.** The [dataset log](datasets.md) records mutations of the trunk, and
  publishing mutates nothing in it. "A release happened" is a [domain event](events.md) —
  `ReleasePublished`, carrying the manifest hash — not a curation entry.
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

`visionset.formats.registry` is where that happens — `exporters()` scans the
`visionset.formats` entry-point group and `pick(installed, name)` refuses an unknown one with
`ExportFormatNotFound`. Discovery is `importlib.metadata`, never a hardcoded map and never an
`if fmt == "coco"` chain, because that is the whole plugin promise: a third-party distribution
registers into the same group and is indistinguishable from a built-in. The group carries
importers too, so what comes back is filtered by `isinstance(plugin, Exporter)` rather than by a
naming convention.

### `lossy` is declared by the format, once

`Exporter.lossy` says the format drops information the kernel can represent — a geometry
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

### The destination is the caller's

`dest` is created if it is not there and is **not** emptied if it is — deleting files under a
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
not a fraction. Fractions that do not add up are exit 2 — `SplitRecipe` refuses them with a pydantic
error, which is not a `VisionSetError` — so the CLI parses the recipe before the call.

**A tag is case-sensitive where a project name is not.** Both comparisons live in the kernel beside
the index that enforces them (`ReleaseService.get_by_tag`, `ProjectService.get_by_name`), because
they are opposites and a surface re-deriving either would eventually pick the wrong one.

**`release verify` exits 1 when the answer is no.** Nothing refused — the check ran and found
damage — but a non-zero exit is what `grep` and `diff` already mean, and the only way a script
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
`dummy` — the only exporter this repository ships — writes nothing, so a `file_count` of 0 in its
report is an export that ran, not one that failed.

## Over HTTP

The [API](api.md) is this service, one route per method, plus the format listing.

```
POST /datasets/{id}/releases  { "tag": …, "split"? }  → 201 ReleaseOut
GET  /datasets/{id}/releases                          → 200 ReleasePage
GET  /releases/{id}                                   → 200 ReleaseOut
GET  /releases/{id}/manifest                          → 200 application/json, raw
GET  /releases/{id}/verify                            → 200 ReleaseVerificationOut
GET  /releases/{id}/assignment                        → 200 SplitAssignmentOut
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

**Export is synchronous**, and that is a stated limit. The launch-and-poll pattern the ingest
routes use needs a row to poll and a row needs a table, and M3's migration ledger is spent —
inventing a second place to keep job state would be exactly the logic leaking upward this
milestone watches for. The only installed format writes nothing today, so the wait is nil; M6
brings real exporters and, with them, the case for a job. The archive comes back inline as
`application/zip`, built from `<workspace>/exports/<release_id>/<format>/`, which is a
server-owned directory like `uploads/`. The route clears it before each run so the archive
describes *this* export and not the last one.

**Which formats exist is a property of the deployment**, so `GET /formats` answers it rather
than this document. `lossy` is on the row so a client knows before it POSTs whether the export
will need `allow_lossy=true`, instead of discovering it by getting a 409.

## Errors

| Error | When |
| --- | --- |
| `DatasetNotFound` | No dataset with that id in this workspace — including one in a *different* workspace, which reads as missing rather than as forbidden. |
| `ReleaseNotFound` | No release with that id in this workspace. |
| `SchemaNotFound` | The project has no schema, so there is no version to pin. Checked before emptiness. |
| `EmptyRelease` | The dataset has no assets. A release of nothing is an artifact nobody can train on. Zero *annotations* is fine — unlabeled images are legitimate training data. |
| `InvalidName` | The tag is blank once stripped. Tags go through `normalize_name` like every other name. |
| `ReleaseTagTaken` | This dataset already has a release under that tag. **Case-sensitive**: a tag is an identifier like a git tag, so `v1.0` and `V1.0` are two releases. Enforced by a pre-check and by a unique index, the second so a race cannot slip past the first. |
| `NoSplitRecipe` | `assignment` was asked of a release published without one. Not an error in the release: no recipe means one undivided set, and inventing an all-train answer would be indistinguishable from a real one. |
| `UnserializableManifest` | An annotation carries a NaN or infinite coordinate. `Geometry` accepts any float, so such a label can be stored; canonical JSON cannot express it, and writing `null` or the bare token `NaN` would lose data or produce a document no other tool can parse. |
| `WorkspaceCorrupt` | The manifest blob is gone, or is not a readable manifest, or the trunk holds an asset that is not stored. All are guarantees failing rather than entities missing. |
| `ExportFormatNotFound` | Nothing is installed under that format name. Raised by the registry in `visionset.formats`, not by this service — the kernel never sees a name. |
| `LossyExportNotConsented` | The chosen format cannot carry everything the release holds, and the caller has not passed `allow_lossy`. Retryable with the flag, which is why a client must branch on the code and never on the 409. |


## In the browser

`@visionset/ui-core`'s dataset screen carries the stats, the release timeline, the
publish dialog and export. Three things it takes from this page rather than
re-deciding: a release is immutable, so nothing offers an edit; verification is **on
demand**, because it re-reads every blob; and a split's fractions are compared with
the same tolerance the kernel uses, since `0.7 + 0.15 + 0.15` is not `1.0`.

Export consent is `allow_lossy` and never `confirm` — see
[ui.md](ui.md#the-dataset-its-releases-and-getting-the-data-out).
