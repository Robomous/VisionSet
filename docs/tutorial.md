# Your first dataset

This tutorial turns a video clip into a trainer-ready YOLO dataset in about half an hour.

You will need [VisionSet installed](install.md) and - because this starts from video -
`ffmpeg` on the `PATH`. If you would rather start from a folder of photographs, skip step 3 and
point `ingest` at the folder instead; everything after it is identical.

> **On screenshots.** There are none here, deliberately. This repository refuses to track binary
> media - an architecture test caps every tracked file at 200 KB and fails on committed pictures,
> which is what keeps a clone small and a history clean. So the browser sections describe what is
> on screen and what to press. The app is two commands away and is the better screenshot.

If you would rather read the whole thing as one program first,
[`examples/thirty_minute_flow.py`](../examples/thirty_minute_flow.py) is exactly these steps with
the assertions still in them, and it runs in under two seconds.

---

## 1. A workspace

```bash
visionset init ~/datasets/road-signs
cd ~/datasets/road-signs
```

Everything from here lives in that directory: `visionset.db` for metadata, `blobs/` for pixels.
`init` refuses a directory that already holds something, and it is the **only** command that
creates one - every other command finds one rather than inventing it, which is why standing in the
wrong directory gives you a refusal instead of a second workspace.

## 2. A project and a labelling contract

```bash
visionset project create road-signs
```

A project owns one dataset - its *trunk*, the curated set that releases are cut from. Before
anything can be labelled it needs a **schema**: the list of classes, and what geometry each one
takes.

```json
{
  "classes": [
    { "name": "vehicle", "geometry": "bbox",    "color": "#eb5a47" },
    { "name": "sign",    "geometry": "bbox",    "color": "#2a9d8f" },
    { "name": "lane",    "geometry": "polygon", "color": "#f4a261" }
  ]
}
```

```bash
visionset schema apply schema.json --project road-signs
```

Schema versions are numbered and **immutable**: applying a new list creates version 2, and version
1 stays readable forever. That matters more than it sounds - every annotation records which
version it was judged against, and a release freezes the version it was cut with. Narrowing a
schema (removing a class, tightening a geometry) needs `--allow-destructive`, and if annotations
already depend on what you are removing it is refused outright with no override. See
[schemas.md](schemas.md).

## 3. Point it at a clip

```bash
visionset ingest ./drive.mp4 --project road-signs --fps 2
```

Two things happen, and the split is worth understanding because it explains most of VisionSet's
behaviour.

**A source is registered.** The clip's path, its probed metadata, and the extraction rate become a
`Source`. The rate is part of *what the source is*, not a per-run flag - "the same source yields
the same assets" only means something if the parameters deciding those assets are recorded with
it. Register the same clip at 1 fps and at 2 fps and you have two sources, deliberately.

**Then it is decomposed.** Frames are cut, hashed, and stored by content. Identical bytes are one
asset, so re-running the same ingest creates nothing and costs nothing:

```bash
visionset ingest ./drive.mp4 --project road-signs --fps 2   # created: 0
```

The command prints a batch id. A **batch** is a unit of work: the assets one ingest produced,
which somebody is going to label.

## 4. Open the batch for annotation

```bash
BATCH=<the id ingest printed>
visionset batch approve "$BATCH" --jobs-of 100
visionset batch start "$BATCH"
```

`approve` does two things that cannot be undone. It **pins the project's active schema version** to
this batch - every label written here will be judged against that version, whatever the project's
schema does later - and it **partitions** the assets into jobs of the size you asked for. The
partition is exact: every asset is in exactly one job.

After approval the membership is frozen. Excluding an asset from then on is a per-asset `skipped`
decision rather than a removal, so a batch always describes what was actually looked at.

## 5. Draw the boxes

Now open the app:

```bash
visionset server
```

The API is at `http://127.0.0.1:8000` and the browser app at `http://127.0.0.1:8000/app`.

The first screen asks for a token. Mint one in another terminal:

```bash
visionset token create --name browser
```

That prints the secret **exactly once** - it is stored as a digest, so there is no way to recover
it and no "show token" anywhere. Paste it into the form; it is verified against the server before
anything is stored, so a typo is refused immediately rather than becoming a broken session.

From there: **Projects → road-signs → the batch → a job**. The annotation page is the left rail,
the image, a floating tool strip with one tool per geometry your schema allows, and the
Objects/Labels panel on the right.

| | |
| --- | --- |
| Draw a box | pick the box tool, drag |
| Draw a polygon | pick the polygon tool, click each vertex, click the first one again to close |
| Pick a class | the number keys, or the Labels tab |
| Move / resize | drag the shape, or drag a grip |
| Delete | select it and press <kbd>Delete</kbd> |
| Undo / redo | <kbd>Ctrl/⌘ Z</kbd> / <kbd>Ctrl/⌘ ⇧ Z</kbd> |
| Zoom | scroll, or trackpad pinch; <kbd>Ctrl/⌘ 0</kbd> fits |
| Next asset | the navigator at the top of the page |

Every edit saves as you go - there is no save button and nothing to lose. The full shortcut table
is in [annotations.md](annotations.md).

Prefer not to click? [`examples/thirty_minute_flow.py`](../examples/thirty_minute_flow.py) writes
fifty boxes through the SDK in one pass, and an agent can do the same over
[MCP](mcp.md) - including *looking* at each frame.

## 6. Close the work and promote it

When every asset in a job has been settled - annotated, skipped or accepted - close it, then close
the batch, then promote:

```bash
visionset job complete <job-id>
visionset batch complete "$BATCH"
visionset batch promote "$BATCH"
```

`complete` on the batch refuses while any job is still open: "derived" here means *recomputed*,
not automatic. **Promotion** is what moves assets into the trunk - a union against what is already
there, so promoting twice adds nothing and re-promoting after a curator removed something puts it
back.

Skipped assets stay out. That is the point of skipping.

## 7. Publish a release

```bash
visionset release publish --tag v1.0 --project road-signs \
  --split 0.7,0.15,0.15 --seed 42
```

A release is the only truly immutable thing here: a frozen manifest naming every asset by content
hash and copying every label as it stood. Publish twice from an unchanged dataset and the two
manifests are **byte-identical**, because nothing time-, machine- or identity-specific goes inside
one.

The split is stored as a *recipe* - three fractions and a seed - not as a materialised assignment,
and folds are computed from the frozen manifest on demand. It keys on **content hash** rather than
asset id, so two copies of the same image cannot straddle a train/test boundary, which is the
classic way a benchmark quietly lies to you.

```bash
visionset release verify v1.0 --project road-signs
```

`verify` re-reads and re-hashes every blob the manifest names. It exits **1** when the answer is
no - so `visionset release verify v1.0 && ./train.sh` means something.

## 8. Export it

Ask first what a format would cost you:

```bash
visionset format list
```

```
NAME          LOSSY
bdd100k-lane  yes
coco          no
culane        yes
curvelanes    yes
dummy         no
openlane-2d   yes
tusimple      yes
voc           yes
yolo          yes
```

The five lane formats write polylines and the rest write boxes and polygons; the whole set is
described in [releases.md](releases.md#exporting). Run the command rather than trusting this
listing — it reads installed entry-point metadata, so a third-party plugin appears in it too.

Then export:

```bash
visionset export --project road-signs --release v1.0 \
  --format yolo --out ./yolo --allow-lossy
```

`--allow-lossy` is required here and the refusal without it is not bureaucracy. YOLO writes five
numbers per label, so attributes, confidence and provenance never survive - and its
`supported_geometries` is boxes only, so the `lane` polygons you drew are written as their bounding
boxes. VisionSet works out exactly what that costs *before* writing anything, tells you by class
with counts, and writes the same report into the export as
`visionset-export-report.json`.

It says which of two different things happens to each class, because they are different decisions:

```
Written in a reduced form by yolo: lane (37). See visionset-export-report.json.
Not carried by yolo: weather (12). See visionset-export-report.json.
```

The `lane` polygons *are* in your labels, as boxes; the `weather` tags are not in them at all -
YOLO has nowhere to put a label with no location.

Choose `--format coco` instead and no consent is needed at all: COCO carries boxes and polygons
natively, and everything it has no field for rides in a `visionset` object per annotation. That
contrast is the whole reason both formats exist. See [releases.md](releases.md#exporting).

What lands in `./yolo`:

```
data.yaml                     classes, in your schema's order
images/train/…  images/val/…  images/test/…
labels/train/…  labels/val/…  labels/test/…
visionset-export-report.json  what this format could not carry
```

That directory is a dataset `ultralytics` will load as it stands. You are done.

---

## What to read next

| | |
| --- | --- |
| [cli.md](cli.md) | every command, `--json` for scripting, and the three exit codes |
| [mcp.md](mcp.md) | pointing an agent at the workspace - the same cycle, with the tools to *look* |
| [api.md](api.md) | the REST surface, and why clients branch on `code` rather than on the status |
| [releases.md](releases.md) | manifests, splits, and what each export format can and cannot carry |
| [examples.md](examples.md) | six runnable examples, including this flow with its assertions |
