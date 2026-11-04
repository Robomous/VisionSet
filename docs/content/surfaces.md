# Surfaces

VisionSet has four ways in: the **browser app**, the **REST API**, the **CLI** and **MCP** (the
agent surface). They are clients of the same SDK, so a rule is the same everywhere; what differs is
what each one exposes. This page says, step by step, which surface can do what.

**Two limits matter before anything else, and the README and the tutorial repeat them:**

- **The CLI cannot create annotations.** `visionset job mark` records progress only. Labels are
  drawn in the browser app, written over REST or MCP, or produced by a model with `pre-label`.
- **Video import is a browser feature.** A clip's frames are cut in the browser (range, frame
  rate, downscale) and posted to the server in a session. `visionset ingest` and the MCP `ingest`
  tool take a directory of still images and refuse a video file. A script can drive the REST
  session itself, but must cut the frames; see [ingest.md](ingest.md).

## What each surface can do

| Step | Browser | REST | CLI | MCP |
| --- | --- | --- | --- | --- |
| Create a workspace | - | - | `init` | - |
| Create a project | yes | yes | `project create` | `create_project` |
| Define a schema | yes | yes | `schema apply`, `schema draft ...` | `create_schema_version`, `*_schema_draft` |
| Add still images | upload | multipart upload, then an ingest job | `ingest DIR` (a directory on this machine) | `ingest` (same) |
| Import a video clip | yes | the video-import session endpoints, which the browser drives | **no** | **no** |
| Build and approve batches | yes | yes | `batch approve` | `create_batch`, `approve_batch` |
| Work a job: read assets, set progress | yes | yes | `job next`, `job mark` | `next_pending_assets`, `set_asset_progress` |
| Create and edit annotations | yes | yes | **no** | `add_annotations`, `update_annotations`, `delete_annotations` |
| See the image | yes | yes | no | `get_asset_image` |
| Pre-label with a model | yes | yes | `batch pre-label`, `job pre-label` | `pre_label_batch`, `pre_label_job` |
| Configure model connections | yes | yes | `inference ...` | `*_inference_connection`, `download_connection_weights` |
| Complete a batch and promote | yes | yes | `batch complete --promote` | `complete_batch`, `promote_batch` |
| Publish and verify a release | yes | yes | `release publish`, `release verify` | `publish_release`, `verify_release` |
| Export | yes | yes | `export` | `export_release`, `check_export` |
| Preprocessing recipes | yes | yes | `recipe ...` | `*_preprocessing_recipe` |
| Create or revoke API tokens | - | - | `token ...` | - |
| Start the server | - | - | `server` | - |

"yes" in the browser column means there is a screen for it; the REST column is the complete
surface, and a dash means the step does not exist on that surface. The CLI and MCP columns name the command or tool. [cli.md](cli.md) and
[mcp-tools.md](mcp-tools.md) are the complete listings.

## An agent's quickstart

Pick the surface your client speaks. Both run the same cycle.

**CLI** (still images, progress only):

```bash
visionset init ./ws && export VISIONSET_WORKSPACE=$PWD/ws
visionset project create road-signs
echo '{"classes":[{"name":"sign","geometries":["bbox"]}]}' > schema.json
visionset schema apply schema.json --project road-signs
BATCH=$(visionset ingest ./incoming --project road-signs)
visionset batch approve "$BATCH" --jobs-of 100 --start
# label in the app, or pre-label with a model: visionset batch pre-label "$BATCH" CONNECTION
visionset batch complete "$BATCH" --promote
visionset release publish --tag v1.0 --project road-signs --split 0.7,0.15,0.15
visionset export --project road-signs --release v1.0 --target yolo11 --out ./out
```

**MCP** (the same cycle, and the only agent surface that can write labels): start the server with
`visionset mcp`, then call `create_project`, `create_schema_version`, `ingest`, `approve_batch`,
then loop `next_pending_assets`, `get_asset_image`, `add_annotations`, then `complete_job`,
`complete_batch`, `promote_batch`, `publish_release`, `export_release`. [mcp-walkthrough.md](mcp-walkthrough.md)
runs it end to end.

## Identifiers

A project is addressed by its **name or its id**. Batches, jobs and assets are addressed by **UUID**
only; the commands that create or list them print the ids.

## When something is refused

Every refusal carries a stable code. [error-codes.md](error-codes.md) lists them with their
meaning and remedy, and [glossary.md](glossary.md) defines the words used here.
