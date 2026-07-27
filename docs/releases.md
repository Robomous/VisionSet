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
