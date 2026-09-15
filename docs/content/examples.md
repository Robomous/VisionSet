# Examples

Every other document here explains one thing the kernel does. This one is about the runnable
files that do several of them at once. There are six:

| Example | What it drives | Milestone |
| --- | --- | --- |
| [`sdk_end_to_end.py`](../../examples/sdk_end_to_end.py) | an empty directory to a release whose every byte can be re-hashed and checked | M1 |
| [`ingest_end_to_end.py`](../../examples/ingest_end_to_end.py) | two folders of stills - one a rerun, one overlapping - to an approved, partitioned batch | M2 |
| [`http_end_to_end.py`](../../examples/http_end_to_end.py) | the same cycle over HTTP, against a real server on a real port, with a bearer token | M3 |
| [`cli_end_to_end.sh`](../../examples/cli_end_to_end.sh) | the same cycle from a shell, using nothing but the `visionset` command | M3 |
| [`mcp_end_to_end.py`](../../examples/mcp_end_to_end.py) | the same cycle over MCP stdio, spawning `visionset mcp` and talking down its pipe | M3 |
| [`thirty_minute_flow.py`](../../examples/thirty_minute_flow.py) | photographs to a YOLO dataset a trainer loads, every stage timed against a wall-clock ceiling | M6 |

```bash
uv run python examples/sdk_end_to_end.py
uv run python examples/ingest_end_to_end.py
uv run python examples/http_end_to_end.py
uv run bash examples/cli_end_to_end.sh
uv run python examples/mcp_end_to_end.py
uv run python examples/thirty_minute_flow.py
```

None of the six needs a media binary of any kind any more. Video import is a **browser**
capability - a client decodes a clip locally and posts frames it already materialized - so there
is no server-side decode left for a script to demonstrate, and `ingest_end_to_end.py` and
`thirty_minute_flow.py` are both stills-only. See [ingest.md](ingest.md) for where a video import
actually lives.

**Why M3 has three.** The standing rule is one example per milestone. M3's exit criterion is
*the same flow three ways* - REST, CLI, MCP - so for this milestone the count is the
deliverable rather than an exception to it. The three run as a matrix in CI, one job each, so
a failure names the surface that broke.

Each example runs in CI **twice**: once as a pytest smoke test
([M1](../../tests/examples/test_sdk_end_to_end.py), [M2](../../tests/examples/test_ingest_end_to_end.py),
[HTTP](../../tests/examples/test_http_end_to_end.py), [CLI](../../tests/examples/test_cli_end_to_end.py),
[MCP](../../tests/examples/test_mcp_end_to_end.py),
[M6](../../tests/examples/test_thirty_minute_flow.py)) that asserts on outcomes, and once as a plain
script, which is the only way to prove it still works from a clean checkout. The last one runs its
second pass from the **installed wheel** rather than from the source tree, which is the whole
point of it — see [The thirty-minute flow](#the-thirty-minute-flow).

They overlap by design and none subsumes another. The SDK example walks the whole cycle
and treats ingest as one stage of thirteen; the ingest example stops at an approved batch and
spends its length on where assets come from - two sources over one file, dedup, progress and the
per-file report. The three surface examples walk the whole cycle again, and what they prove is not
the cycle but the *surface*. The thirty-minute flow walks it once more and ends outside the
product, at a trainer loading what came out.

## What the three surfaces do not share

Driving one cycle three ways is what makes the differences legible, and they are all deliberate:

- **Ingest is asynchronous over HTTP and synchronous over MCP.** The API answers 202 with a job
  row and hands the work to a background worker, so a client polls; the MCP tool returns when the
  work is done. A stdio server has no worker to hand anything to, so a job an agent had to poll
  would block for exactly as long as doing the work. Same capability, two honest shapes - and the
  remedy for an interrupted MCP run is to call `ingest` again, which is free.
- **Only HTTP uploads bytes.** Registration over the API is upload-only, because an HTTP client
  has bytes and not a path on the server's filesystem; the CLI and MCP both hand over a path,
  because both run beside the workspace. The server's content-addressed staging area exists for
  exactly that gap and has no other caller.
- **Only MCP has to scale its coordinates.** `get_asset_image` sends a preview capped at 256
  pixels on its long edge while annotation geometry is always in the asset's own pixels, so an
  agent measures in one frame and writes in another. No other surface shows an image at all.
- **Only the CLI writes no labels.** Drawing a box is an application's job, not a terminal's, so
  its release honestly reports `annotation_count: 0`.

---

# The SDK example

## The cycle

| Stage | What happens | Owned by |
| --- | --- | --- |
| Workspace | `WorkspaceService.init` creates `visionset.db` and `blobs/` | [workspaces.md](workspaces.md) |
| Subscribe | `event_bus.subscribe(DomainEvent, ...)` - the catch-all, matched by type | [events.md](events.md) |
| Project | `ProjectService.create` - the 1:1 dataset is created in the same transaction | [projects.md](projects.md) |
| Schema | `SchemaService.create_version` - version 1 of the labeling contract | [schemas.md](schemas.md) |
| Source | six generated PNGs written to `incoming/`, registered as an image directory | [sources.md](sources.md) |
| Assets | `IngestService.ingest` - hashed, stored once, and put in a draft batch | [ingest.md](ingest.md) |
| Batch | `approve(BySize(size=3))` → 2 jobs, schema pinned | [batches.md](batches.md) |
| Work | `JobService.start` / `next_pending` / `mark`, one asset deliberately skipped | [jobs.md](jobs.md) |
| Labels | `AnnotationService.add` - a box, a polygon and a whole-frame tag per asset | [annotations.md](annotations.md) |
| Trunk | `DatasetService.promote` - five assets, not six | [datasets.md](datasets.md) |
| Release | `ReleaseService.publish`, then `verify`, `manifest` and `assignment` | [releases.md](releases.md) |

## Three things it is built to demonstrate

**A skipped asset settles its job but never reaches the trunk.** One of the six frames is marked
`skipped` instead of being labeled. That is enough for `JobService.complete` - `skipped` is in
`SETTLED_PROGRESS`, the set named for *does-not-block-completion* - but it is absent from
`PROMOTABLE_PROGRESS`, so the trunk ends up with five assets. Two sets, two questions, and the
example makes the difference visible rather than describing it.

**Publishing twice from an unchanged trunk produces the identical document.** The example
publishes `v1.0`, changes nothing, and publishes `v1.1`; the two releases carry the same
`manifest_hash` and therefore share one blob. That is a consequence of the manifest being a pure
function of content - no timestamp, no tag, no release id inside it - rather than something the
service arranges.

**The manifest hash still differs between two runs, and that is correct.** A manifest names
asset and annotation ids, which are fresh UUIDs every time; a manifest hash is a *snapshot*
identity, not a universal content identity. What does hold across runs is the split: `assign_split`
keys on `content_hash`, and the frames are generated deterministically from their index, so the
same pictures land in the same folds on every machine. The smoke test asserts exactly that -
comparing folds by content hash, never by id.

## Every step goes through the service that owns it

That sentence used to carry an exception. Creating an `Asset` had no door, so the example wrote
the row by hand - through the same public port a service uses, commented as the one place it
reached below one, and flagged in three files as something #20 would delete. It did:

```python
incoming = _write_frames(dest / "incoming", FRAME_COUNT)
source = sources.register_images(project.id, incoming)
ingested = ingest.ingest(source.id, batch_name="batch-001")
```

The frames go to disk, the folder is registered as an origin, and [ingest](ingest.md) hashes
them, stores the bytes once and puts them in a draft batch - which is what a real caller does with
a real folder of photographs. `BatchService.create` disappeared from the example along with it:
the ingest is what makes the batch now.

The frames are still generated by the example's own six-line PNG encoder rather than by Pillow,
which is a dependency these days. Their bytes are fixed, and that is the point: an asset's
identity is the SHA-256 of its content and the split keys on content hash, so the same pictures
land in the same folds on every machine. (The [ingest example](#the-ingest-example) does reach
for Pillow - it is not carrying a determinism argument about folds.)

## Why three classes for "two classes"

A `LabelClass` accepts a *set* of geometries, so one class could carry all three shapes - and
these are three classes anyway, because they mean three different things rather than three
shapes of one thing. `stop-sign`, `lane-marking` and `weather` is what an ontology looks like;
a single class accepting a box and an outline is what one *object* looks like from two
distances. Exactly one
attribute is *required* (`occlusion` on `stop-sign`), which is what makes
`MissingRequiredAttribute` a live rule in the example rather than a paragraph.

## No committed media, ever

The frames are built by a short PNG encoder using only `zlib` and `struct`: a signature, an IHDR
chunk, zlib-compressed filter-0 scanlines in IDAT, and IEND. It was written when M1 had no image
library to lean on, and it stays for the reason in the section above rather than out of nostalgia.
v1 of this product shipped 929 MB of images into git history, which is why `**/workspace-data/`
is ignored and why an example that needs pictures makes its own.

---

# The ingest example

Where [`sdk_end_to_end.py`](../../examples/sdk_end_to_end.py) treats ingest as one stage,
[`ingest_end_to_end.py`](../../examples/ingest_end_to_end.py) is about nothing else. It ingests a
folder of fifty photographs with one file that is not an image, re-ingests the same folder to
show that creates nothing, ingests a second folder that overlaps the first by content, and stops
at an approved batch cut into two jobs. Nothing is annotated and nothing is released. Video is
not exercised: importing one is a browser capability now, so there is no server-side decoder left
for a script like this to drive - see [ingest.md](ingest.md).

## What it does

| Stage | What happens | Owned by |
| --- | --- | --- |
| Project | `ProjectService.create` + `SchemaService.create_version` - one class, because approval needs a version to pin | [projects.md](projects.md), [schemas.md](schemas.md) |
| Source | `register_images` over a folder of 50 synthetic photographs plus a `notes.txt` | [sources.md](sources.md) |
| Assets | `IngestService.ingest` → **50 assets** in a draft batch; `notes.txt` is one reported `IngestFailure` | [ingest.md](ingest.md) |
| Progress | `IngestService.get(job_id)` → `processed=50`, `total=50` | [ingest.md](ingest.md) |
| Batch | `approve(BySize(size=25))` → 2 jobs of 25, schema pinned | [batches.md](batches.md) |
| Re-run | the same source again → `created=0`, `deduplicated=50`, same asset ids | [ingest.md](ingest.md) |
| Second folder | 2 photographs byte-identical to the first folder's, 8 new → a *different* source, `created=8` | [sources.md](sources.md) |
| Previews | every asset carries a `thumbnail_hash` | [media.md](media.md) |

## Three things it is built to demonstrate

**A directory states its total before the first file.** `IngestJob.processed` climbs to 50
against `total=50`, both written to the row as the run goes, which is what makes them pollable
from another process rather than a return value dressed up as progress. The stray file is
reported, not skipped: `notes.txt` produces one `IngestFailure` - `name`, `kind`, `reason`, where
the reason never repeats the name so a surface can group by kind instead of reading prose - and
the run still ends `completed`, because guessing which files an operator meant to offer is a
policy the kernel would be inventing.

**Two different sources can hold the same asset, and identity does not care which one got there
first.** The second folder is a distinct `Source` - a different directory is a different origin -
but two of its photographs are byte-identical to ones the first folder already ingested, and
content addressing collapses them on sight: `created=8` for ten files offered, not ten. Their
recorded origin stays the first folder's, because origin is provenance and provenance is never
rewritten once an asset exists.

**Re-ingesting a source is a no-op that still succeeds.** Running `ingest` again over the exact
same source creates nothing (`created=0`, `deduplicated=50`) and returns the same asset ids in a
new draft batch, because a batch is an ephemeral unit of work and two may legitimately name the
same assets. That is the whole remedy for an interrupted run: content addressing means a redo
costs re-hashing and nothing else.

The stills are Pillow's work - a real dependency since #16 - written with `write_stills`, a small
deterministic pixel generator that lets the second folder reuse a couple of indices from the
first and get byte-identical overlap without copying a file.


---

# The HTTP example

## What it does

| Stage | What happens |
| --- | --- |
| Setup | `WorkspaceService.init` then `TokenService.create` - the last SDK lines in the file |
| Serve | `visionset server --host 127.0.0.1 --port <free> --workspace <root>` as a subprocess, polled at `/health` until it answers |
| Project | `POST /projects`, `POST /projects/{p}/schema/versions` |
| Upload | `POST /projects/{p}/sources/images` - four PNGs as `multipart/form-data`, built by hand |
| Ingest | `POST /sources/{s}/ingest-jobs` → **202** + `Location`, then `GET /ingest-jobs/{id}` until it settles |
| Batch | `approve` with `{"kind": "by_size", "size": 2}` → `start` → `GET /batches/{b}/jobs` |
| Annotate | per job: `start`, `GET /jobs/{j}/next?n=10`, `POST …/annotations`, read them back, `PUT …/progress`, `complete` |
| Trunk | `complete` → `promote` → `GET /datasets/{d}/stats` |
| Release | `POST /datasets/{d}/releases`, `GET …/manifest`, `GET …/verify` |
| Export | `GET /formats` → `POST /releases/{r}/export?format=dummy` → a zip on disk |
| Recipe | `POST /projects/{p}/preprocessing-recipes`, then `POST /releases/{r}/export?target=yolo11&recipe=yolo-640` - refused **409 `LOSSY_EXPORT_NOT_CONSENTED`** until `allow_lossy=true` - and the archive is opened for `preprocessing.recipe_hash` in `visionset-export-report.json` and a `labels/train/<hash>-aug1.txt` beside its image |
| Pixels | `GET /projects/{p}/assets/{a}/content`, hashed against the asset's `content_hash` |
| Refusal | the same request with no `Authorization` header → **401 `UNAUTHORIZED`** |

## Four things it is built to demonstrate

**The contract is reachable from anything that speaks HTTP.** The walk uses `urllib.request` and
nothing else - not `httpx`, not `requests`, not `curl`. That is two arguments at once: `httpx` is a
*development* dependency, so an example using it could not run from an installed wheel; and a
contract only a smart client can drive is not really a contract. The multipart body is twenty-odd
lines in the file, written out rather than delegated, and it is the price of the claim.

**The server actually starts.** [`tests/cli/test_server.py`](../../tests/cli/test_server.py) patches
`uvicorn.run` and asserts the arguments, which is right for a unit test and says nothing about
whether the process comes up. This example binds an ephemeral port, spawns the shipped command
against it, and waits for `/health` - the one unauthenticated route, and therefore the readiness
probe. If the process dies at startup the example reports its exit code rather than timing out and
reading like a slow machine.

**Launch-and-poll, which no other example shows.** Ingest over HTTP returns before the work does,
so the client watches a job row. The example counts its polls and puts the number in its summary,
which is a small way of saying out loud that at least one round trip happened after the launch.

**The manifest arrives byte for byte.** `sha256(body) == release["manifest_hash"]` is the single
best assertion in the walk: the route streams the stored blob, and a build that parsed and re-dumped
the document would put its own JSON encoder between a client and the bytes the hash is *of*. Nothing
else in the walk would notice.

## What it deliberately does not need

No HTTP client library, no `jq`, and no file on disk for its inputs - the four PNGs are
built in memory and uploaded as bytes, because that is what an HTTP client has. Its one requirement
is that `visionset` is on `PATH`, which `uv run` arranges.

---

# The CLI example

## What it does

`examples/cli_end_to_end.sh` is M3's exit criterion - *the full cycle without touching Python* -
written as the thing that criterion describes. It runs `visionset init`, `project create`,
`schema apply`, `ingest`, `batch approve/start/complete/promote`, a `job` loop, `release
publish/verify`, `format list` and `export`, then `recipe create` and a second `export --target
yolo11 --recipe yolo-640 --allow-lossy`, and then asserts - on the release's `--json`, and on the
recipe export's report and its three `-aug1` train variants.

## Three things it is built to demonstrate

**Ids travel on stdout.** `WS=$(visionset init "$DEST/ws")`, `BATCH=$(visionset ingest …)`, and
every listing read with `tail -n +2 | awk '{print $1}'` - which works because a header always
prints and the first column is always an id. Nothing here parses prose.

**The workspace is stated once.** `export VISIONSET_WORKSPACE="$WS"` after `init`, and no command
after that carries `-w`. That is the environment-variable branch of the resolution rule, and it is
the branch a script should use: the flag is for a one-off, and the upward walk is for a person
standing in a project directory.

**`--json` is stable enough to assert on.** Step 9 pipes `release list --json` through `python3`
and checks the envelope, the tag, the asset count and the split recipe - which *is* the "`--json`
outputs stable, documented shapes" acceptance criterion, tested rather than promised.

There is a fourth, at the end: a deliberate refusal. Publishing `v1.0` twice exits 1 with one
sentence on stderr, and the script asserts that it did. A command inside an `if` condition does not
trip `set -e`, which is what makes demonstrating a failure safe.

## What it deliberately does not need

**Media of any kind.** Its images are six PNGs plus one `notes.txt` that is deliberately not an
image, so the per-file report has something in it. **No `jq`**, because the column format is
designed to be read with `awk`. **No `curl` and no server**:
the CLI calls the SDK in-process, which is the whole point of it being a sibling of the REST API
rather than a client of it.

`python3` appears twice - once to write PNGs, because a shell cannot, and once to assert on a JSON
document. Neither touches the SDK.

## The honest note it carries

Every asset in this run is marked `annotated` and carries **no labels**. Drawing a box is the app's
job; `visionset job mark` records that somebody did it. So the release reports
`annotation_count: 0`, the manifest says so, and the smoke test asserts it - rather than the script
quietly leaving the impression that a terminal can label images.

---

# The MCP example

## What it does

| Stage | What happens |
| --- | --- |
| Setup | `WorkspaceService.init` - the only SDK line, and it has to be one: creating a workspace is deliberately not a tool |
| Connect | `stdio_client(StdioServerParameters(command="visionset", args=["mcp", "--workspace", root]))` → `ClientSession` → `initialize()` |
| Discover | `list_tools()` → the tools this server advertises, then `list_projects` on an empty workspace |
| Project | `create_project`, `create_schema_version`, `get_schema` |
| Ingest | `ingest` with a **local path** - one call, and it returns when the work is done |
| Batch | `approve_batch(jobs_of=2)` → `start_batch` |
| Look | per asset: `get_asset_image` → a base64 image block beside `width`/`height`/`image_width`/`image_height`/`scale` |
| Annotate | `add_annotations` with every edge multiplied by `scale`, then `set_asset_progress` for the rest, then `complete_job` |
| Trunk | `complete_batch` → `promote_batch` → `dataset_stats` |
| Release | `publish_release`, `list_releases`, `verify_release` |
| Export | `list_formats` → `export_release(format="dummy", dest=…)` - a directory, not an archive; a `format` addresses no trainer, so this is the plain-format call and the Recipe row below is the same release addressed by `target` |
| Recipe | `create_preprocessing_recipe`, `list_preprocessing_recipes`, then `export_release(target="yolo11", recipe="yolo-640", allow_lossy=True, dest=…)` - the result's `preprocessing` names the recipe under its hash and maps the train fold's `-aug1` variant to its source, and both files are on disk |
| Refusal | `publish_release` on the same tag → a **result** carrying an error envelope, `retry_with` null |

## Four things it is built to demonstrate

**The transport, which nothing else proved.** Every test under
[`tests/mcp/`](../../tests/mcp/) drives the protocol over a paired in-memory stream inside one
process. That proves the tools themselves and says nothing about the pipe. Meanwhile
[`tests/cli/test_mcp_command.py`](../../tests/cli/test_mcp_command.py) pins `visionset mcp`
thoroughly - and mocks `subprocess.run`, so before this example no JSON-RPC byte had ever crossed
that command. Here the client spawns exactly what an MCP configuration spawns, and the workspace
travels the way it really travels: resolved by the CLI, opened once to run any migration, stated in
`VISIONSET_WORKSPACE`, and inherited by the server it starts.

**One session for the whole walk.** `tests/mcp/_flow.py` opens a fresh session per call, which is
convenient for a test and is not what a client does. Holding one open is safe because the server
opens and closes the workspace *inside each tool call* - so a long-lived session holds no SQLite
handle and locks nobody out of `visionset server`.

**The pixels an agent sees are not the frame its coordinates live in.** The frames are 640×480 on
purpose. The preview is capped at 256 pixels on its long edge, so what arrives is 256×192 and
`scale` is 2.5. Every box the example submits is multiplied by it, and the smoke test asserts
`scale > 1` - because if a future change made previews full size, the example would still pass
while demonstrating nothing. An unscaled box would be individually plausible and uniformly wrong,
and nothing downstream could detect it: every number would be in range and every shape well formed.

**A refusal is a result, not an error.** There are two failure shapes over MCP. A malformed
*request* comes back with `isError` set and the validator's field path; a domain refusal comes back
as an ordinary result whose payload is an error envelope, because the call was well formed and the
answer is no. The example ends on the second kind and checks all four keys - and that `retry_with`
is **null**, because a release is immutable and no flag makes a reused tag work. That is the
distinction a status code could not carry, and the reason the envelope has no `code`.

## What it deliberately does not need

No development dependency: `mcp` is a runtime dependency, so its client half ships with the
package, and the async bridge is `asyncio.run` from the standard library rather than the `anyio.run`
the tests use. No server, no port. Its one requirement is `visionset` on `PATH`.

---

# The thirty-minute flow

## What it does

`examples/thirty_minute_flow.py` is the sentence the product exists for, written as a program:
fifty photographs become fifty boxes, a verified release and a YOLO dataset `ultralytics` agrees
to load. It drives the SDK the way the [SDK example](#the-sdk-example) does and ends where none of
the others do — at a trainer reading the output.

## What makes it different from the other five

**It is a gate rather than a demonstration.** Every stage is named, timed and asserted against a
wall-clock ceiling, so a change that makes the cycle slower fails rather than being noticed later
by somebody with a stopwatch. The other five assert on outcomes; this one asserts on outcomes and
on how long they took.

**CI runs it from the installed wheel.** The `30-minute flow (wheel, end to end)` job builds the
distribution, installs it into an empty virtual environment together with `ultralytics`, and runs
this file from a working directory that is not the repository. What it exercises is therefore what
`pip install visionset` gives somebody — entry points and plugin discovery included — rather than
what a source checkout happens to resolve. That is the half no source-tree suite can cover, and it
is why this example is also the check the beta cannot ship without.

**Locally it degrades honestly.** Run against the source tree it skips the `ultralytics` step when
the library is absent and says so, rather than passing quietly with the last stage missing.
`tests/examples/test_thirty_minute_flow.py` runs the same file in process on every push, which is
the cheap half.

## What it needs

**No media binary at all.** Its fifty photographs are Pillow's work, the same `write_stills`
helper the ingest example uses. `ultralytics` is optional locally and required in CI. It writes
into `./thirty-minute-flow` with no argument, or wherever you name.
