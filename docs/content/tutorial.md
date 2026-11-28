# Your first dataset

Start with a folder of photographs, label them in the browser, and export a YOLO dataset from a
versioned release. This tutorial uses the current repository version of VisionSet. Earlier
releases may have a different browser sign-in flow or fewer commands. See the
[installation guide](install.md).

To follow the same general workflow in Python, see
[the runnable SDK example](../../examples/thirty_minute_flow.py).

## 1. A workspace

```bash
visionset init ~/datasets/road-signs
cd ~/datasets/road-signs
```

The workspace stores metadata in `visionset.db` and media in `blobs/`. Use an empty directory
or a path that does not exist yet. Run the remaining commands from the workspace directory.

## 2. A project and a labelling contract

```bash
visionset project create road-signs
```

A project has one dataset, called its *trunk*. Releases are snapshots of that curated dataset.
Before labeling, define the classes and the geometry allowed for each class. Save this example
as `schema.json` in the workspace:

```json
{
  "classes": [
    { "name": "vehicle", "geometries": ["bbox"],    "color": "#eb5a47" },
    { "name": "sign",    "geometries": ["bbox"],    "color": "#2a9d8f" }
  ]
}
```

```bash
visionset schema apply schema.json --project road-signs
```

This publishes schema version 1. Every version is immutable. Later versions can extend the
schema while preserving the versions that earlier annotations and releases reference.
See [annotation schemas](schemas.md).

## 3. Point it at a folder of images

Place your photographs in a `photos/` directory in the workspace, or substitute an absolute path
to your image directory:

```bash
BATCH=$(visionset ingest ./photos --project road-signs)
```

VisionSet registers the folder as a source and scans its top level. It reports unreadable
entries and creates a draft batch for the successfully ingested images. Within a project,
identical bytes identify the same asset. Running the command again on an unchanged folder with
no new assets prints no batch ID.

If you are starting from a video, run `visionset server`, open the project overview in the
browser, and choose the clip in **Add images**. The browser decodes the clip locally and uploads
JPEG frames. Run `visionset batch list --project road-signs` to find the new batch ID, then
set `BATCH` to that ID for the next step. See [ingest](ingest.md).

## 4. Open the batch for annotation

```bash
visionset batch approve "$BATCH" --jobs-of 100 --start
```

Approval pins the project's active schema version and partitions the batch into jobs of up to
100 assets. Each asset belongs to exactly one job. The membership stays fixed after approval.
Use **Skip** if an asset should be excluded during annotation.

The `--start` flag opens the approved batch for annotation. To inspect the jobs first, run
`batch approve` without the flag, then run `visionset batch start "$BATCH"`. The batch uses its
pinned schema to validate labels. See [how open batches follow compatible schema updates](batches.md#the-pin-follows-a-widening-version-on-its-own).

## 5. Draw the boxes

Start the server from the workspace:

```bash
visionset server
```

Open the local [browser app](http://127.0.0.1:8000/app). The server signs in the browser it
serves automatically. See [the browser session](auth.md#the-browser-session).

Open **Projects → road-signs**, select the batch, and open a job. Choose **vehicle** or **sign**
from **Labels**, then drag a box around the object. Repeat for each object in the image.

| Action | Control |
| --- | --- |
| Select a class | **Labels**, or the number keys |
| Move or resize a box | Drag the box or one of its handles |
| Delete the selected box | <kbd>Delete</kbd> |
| Undo or redo | <kbd>Ctrl/⌘ Z</kbd> or <kbd>Ctrl/⌘ ⇧ Z</kbd> |
| Fit the image | <kbd>Ctrl/⌘ 0</kbd> |
| Move to the next asset | **Next** |

Edits save after a short pause. Navigation saves pending edits first, and <kbd>Ctrl/⌘ S</kbd>
saves immediately. Check the save status in the toolbar before closing the page. Use **Skip**
for any image you intend to exclude from the dataset. See the [editor shortcuts](annotations.md#keys-are-bound-in-one-place-and-the-table-is-data).

## 6. Close the work and promote it

Once every asset in each job is annotated, skipped, or accepted, return to your terminal and run:

```bash
visionset batch finish "$BATCH" --promote
```

`finish` completes the remaining jobs and the batch in one transaction. The optional
`--promote` step then adds annotated and accepted assets to the trunk. A repeated promotion
adds only eligible assets that are missing from the trunk. See [batches](batches.md#finishing-closes-the-jobs-and-the-batch-together)
and [datasets](datasets.md).

## 7. Publish a release

```bash
visionset release publish --tag v1.0 --project road-signs \
  --split 0.7,0.15,0.15 --seed 42
```

The manifest freezes the media hashes and labels in the trunk. The split recipe specifies
train, validation, and test proportions and a seed. VisionSet computes the assignment from the
manifest, so an image with the same content hash always goes to the same fold for that seed
when splitting by asset.

```bash
visionset release verify v1.0 --project road-signs
```

Verification re-reads and hashes the media named in the manifest. A failed verification exits
with status 1.

## 8. Export it

Use `visionset target list` to see the trainer targets installed in your environment. The
`yolo11` target writes the Ultralytics format. Preview its compatibility report before
writing files. The check prints its findings and exits with status 1 when the export
requires loss consent.

```bash
visionset export --project road-signs --release v1.0 --target yolo11 --check
```

Ultralytics label rows carry class indices and geometry. Exporting to this format requires
consent because information such as attributes, confidence, and provenance is lost. If that
loss is acceptable, export:

```bash
visionset export --project road-signs --release v1.0 --target yolo11 --out ../road-signs-yolo --allow-lossy
```

Export to a directory outside the workspace. The output contains `data.yaml`, fold directories
under `images/` and `labels/`, and `visionset-export-report.json`. Check that each fold has
enough images for training and evaluation. Start Ultralytics from inside `../road-signs-yolo`
because the descriptor uses `path: .`.

For other targets, layouts, and optional export-time resizing or augmentation, see
[exporting](releases.md#exporting) and [pre-processing](preprocessing.md).

## What to read next

| | |
| --- | --- |
| [cli.md](cli.md) | every command, `--json` for scripting, and the three exit codes |
| [mcp.md](mcp.md) | pointing an agent at the workspace - the same cycle, with the tools to *look* |
| [api.md](api.md) | the REST surface, and why clients branch on `code` rather than on the status |
| [releases.md](releases.md) | manifests, splits, and what each export format can and cannot carry |
| [examples.md](examples.md) | six runnable examples, including this flow with its assertions |
