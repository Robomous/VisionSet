# Examples

Every other document here explains one thing the kernel does. This one is about the single
runnable file that does all of them at once: [`examples/sdk_end_to_end.py`](../examples/sdk_end_to_end.py)
takes an empty directory and leaves behind a release whose every byte can be re-hashed and
checked — with nothing but `import visionset`.

```bash
uv run python examples/sdk_end_to_end.py
```

It is the milestone's exit criterion made executable, and it runs in CI twice: once as a
[pytest smoke test](../tests/examples/test_sdk_end_to_end.py) that asserts on outcomes, and once
as a plain script, which is the only way to prove it still works from a clean checkout.

## The cycle

| Stage | What happens | Owned by |
| --- | --- | --- |
| Workspace | `WorkspaceService.init` creates `visionset.db` and `blobs/` | [workspaces.md](workspaces.md) |
| Subscribe | `event_bus.subscribe(DomainEvent, ...)` — the catch-all, matched by type | [events.md](events.md) |
| Project | `ProjectService.create` — the 1:1 dataset is created in the same transaction | [projects.md](projects.md) |
| Schema | `SchemaService.create_version` — version 1 of the labeling contract | [schemas.md](schemas.md) |
| Assets | six generated PNGs into the blob store, then the rows that name them | *nothing yet — see below* |
| Batch | `BatchService.create`, then `approve(BySize(size=3))` → 2 jobs, schema pinned | [batches.md](batches.md) |
| Work | `JobService.start` / `next_pending` / `mark`, one asset deliberately skipped | [jobs.md](jobs.md) |
| Labels | `AnnotationService.add` — a box, a polygon and a whole-frame tag per asset | [annotations.md](annotations.md) |
| Trunk | `DatasetService.promote` — five assets, not six | [datasets.md](datasets.md) |
| Release | `ReleaseService.publish`, then `verify`, `manifest` and `assignment` | [releases.md](releases.md) |

## Three things it is built to demonstrate

**A skipped asset settles its job but never reaches the trunk.** One of the six frames is marked
`skipped` instead of being labeled. That is enough for `JobService.complete` — `skipped` is in
`SETTLED_PROGRESS`, the set named for *does-not-block-completion* — but it is absent from
`PROMOTABLE_PROGRESS`, so the trunk ends up with five assets. Two sets, two questions, and the
example makes the difference visible rather than describing it.

**Publishing twice from an unchanged trunk produces the identical document.** The example
publishes `v1.0`, changes nothing, and publishes `v1.1`; the two releases carry the same
`manifest_hash` and therefore share one blob. That is a consequence of the manifest being a pure
function of content — no timestamp, no tag, no release id inside it — rather than something the
service arranges.

**The manifest hash still differs between two runs, and that is correct.** A manifest names
asset and annotation ids, which are fresh UUIDs every time; a manifest hash is a *snapshot*
identity, not a universal content identity. What does hold across runs is the split: `assign_split`
keys on `content_hash`, and the frames are generated deterministically from their index, so the
same pictures land in the same folds on every machine. The smoke test asserts exactly that —
comparing folds by content hash, never by id.

## The one place it reaches below a service

Creating an `Asset` has no door yet. `SourceService` (#18) has landed, but it registers *where*
data comes from, not the assets themselves; the pipeline that hashes, deduplicates, extracts
dimensions and materializes assets into a batch is #20, with `IngestJob` (#19) around it. Until
#20 lands, `_add_assets` writes, by hand, the row that ingest will write:

```python
hashes = [workspace.blob_store.put(BytesIO(frame_bytes(i))) for i in range(count)]
with workspace.unit_of_work() as uow:
    uow.assets.add(Asset(project_id=..., content_hash=..., uri=..., width=..., height=...))
```

This is the only step in the file that does not go through the service that owns its entity, it
is commented as such where it lives, and it disappears when #20 lands. The blobs are written
before the transaction opens on purpose: `BlobStore.put` is not transactional and a rollback
cannot unwrite it — but a blob nothing points at is harmless (content-addressed, deduplicated,
and never deleted), while a row pointing at bytes that were never stored would not be.

## Why three classes for "two classes"

A `LabelClass` is bound to exactly one `GeometryType` — `geometry` is singular. Showing a
bounding box, a polygon and a whole-frame classification therefore takes three classes
(`stop-sign`, `lane-marking`, `weather`), not one class listing three shapes. Exactly one
attribute is *required* (`occlusion` on `stop-sign`), which is what makes
`MissingRequiredAttribute` a live rule in the example rather than a paragraph.

## No committed media, ever

The frames are built by a short PNG encoder using only `zlib` and `struct`: a signature, an IHDR
chunk, zlib-compressed filter-0 scanlines in IDAT, and IEND. M1 has no image library to lean on
— Pillow arrives with the media processor (#16) — and v1 of this product shipped 929 MB of
images into git history, which is why `**/workspace-data/` is ignored and why an example that
needs pictures makes its own.
