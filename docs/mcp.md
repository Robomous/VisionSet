# The MCP server

VisionSet speaks [Model Context Protocol](https://modelcontextprotocol.io) over stdio, so an
agent can run the whole cycle — create a project, declare a schema, ingest images, **look at
them**, write annotations, promote, publish, verify and export — without a browser, an HTTP
client or a line of Python.

It is the fourth client of the same kernel the API, the CLI and the SDK use. Nothing is decided
here that is not decided in the kernel, and every rule the other surfaces follow holds unchanged.

```bash
visionset mcp --workspace ~/datasets/road-signs
```

## Configuring a client

A client spawns the server itself and talks to it on stdin and stdout. The workspace travels in
the environment, because there is no other channel:

```json
{
  "mcpServers": {
    "visionset": {
      "command": "visionset",
      "args": ["mcp"],
      "env": { "VISIONSET_WORKSPACE": "/home/you/datasets/road-signs" }
    }
  }
}
```

`python -m visionset.mcp.main` is the same server without the pre-flight check, for a client that
cannot run a console script.

### Destructive tools are not offered unless you ask

`delete_project` is **absent from the listing** unless the server was started with
`--allow-destructive` (or, for the module form, `VISIONSET_MCP_ALLOW_DESTRUCTIVE=1`):

```json
{ "command": "visionset", "args": ["mcp", "--allow-destructive"] }
```

This is measured rather than cautious. Four real agent runs were asked to tidy a schema and then
delete a project; in **four of four** the model sent `confirm: true` on the *first* call, having
read the parameter in the tool description. `ConfirmationRequired` never fired once, because
nothing ever made the un-gated call.

That is not the flag failing. Over HTTP or at a terminal `confirm` works exactly as designed,
because a **person** is the one adding it. What the runs settle is narrower: *when the caller is a
model, `confirm` is not a human in the loop.* It is a parameter documented in the same listing the
caller reads before choosing, so the description that exists to explain the gate is also the
instruction for clearing it. There is no version of a self-describing tool schema where that is
not true.

So the gate moved somewhere an agent cannot reach — the server's own startup. A tool that is not
advertised cannot be called with a flag. `confirm` itself is unchanged, and stays: it is correct
for every other surface, and when these tools *are* registered they behave exactly as before. The
only decision is whether an agent is shown them at all.

`visionset mcp` prints which posture it started with, on stderr beside the workspace.

`visionset mcp` resolves the workspace with the full precedence documented in
[workspaces.md](workspaces.md) — `--workspace`, then `$VISIONSET_WORKSPACE`, then the nearest
workspace at or above the working directory — and then **states** the answer in the environment,
so the server it starts cannot disagree with it. It also opens the workspace before starting
anything, which runs any pending migration and turns "that is not a workspace" into one sentence
at a terminal instead of a refusal inside the agent's first tool call.

**No token is involved.** A token authenticates an HTTP client; an agent reaching this server is
already inside the sandbox the workspace defines, and there is nothing further to prove. There
are no token-administration tools either, for the reason [auth.md](auth.md) gives: minting a
credential is a privilege-escalation primitive pointed at the agent's own sandbox, and an agent's
"shown exactly once" is a transcript.

For the same cycle as a session rather than a reference — every call in the order an agent meets
it, and what twelve real agent runs did with it — see
[mcp-walkthrough.md](mcp-walkthrough.md).

## The tools

Thirty-three by default, listed in the order an agent meets them, plus one offered only on
request — see [above](#destructive-tools-are-not-offered-unless-you-ask).

### Projects and schema

| | |
| --- | --- |
| `create_project` | Make a project and the empty dataset that is its trunk. |
| `list_projects` | Everything in this workspace. |
| `get_project` | The project, its dataset id, and how far its work has got. |
| `get_schema` | The classes, the active version, and every version that exists. |
| `preview_schema_change` | What a proposed change would do. Writes nothing. |
| `create_schema_version` | Apply one. `allow_destructive` for a narrowing change. |

### Sources and ingest

| | |
| --- | --- |
| `ingest` | A local path in, one batch out. Synchronous. |
| `list_sources` | The folders and clips a project was built from. |
| `backfill_thumbnails` | Render previews that are missing. |

### Batches

| | |
| --- | --- |
| `list_batches` | Outstanding work, with progress. |
| `get_batch` | One batch: state, schema pin, progress, jobs. |
| `approve_batch` | Freeze it, pin the schema, cut it into jobs. |
| `start_batch` | Open it for annotation. |
| `list_batch_assets` | What is in it, paged, with each asset's job and progress. |
| `complete_batch` | Close it, once every job is complete. |
| `promote_batch` | Move the finished assets into the dataset. |

### Jobs and annotations

| | |
| --- | --- |
| `get_job` | State, counts, and the batch and schema it answers to. |
| `start_job` | Mark it as being worked on. |
| `next_pending_assets` | The loop primitive: what is left to annotate. |
| `get_asset_image` | **Look at the pixels.** See below. |
| `list_asset_annotations` | What is already on an asset, with ids for editing. |
| `add_annotations` | Write labels. All or none. |
| `update_annotations` | Replace labels wholesale, by id. All or none. |
| `delete_annotations` | Remove labels. All or none. No confirmation. |
| `set_asset_progress` | Say an asset is `skipped`, or move it otherwise. |
| `complete_job` | Close it, once every asset is settled. |

### Datasets, releases and export

| | |
| --- | --- |
| `dataset_stats` | Class balance in the trunk right now. |
| `publish_release` | Freeze it under a tag, immutably. |
| `list_releases` | Everything published, with counts and hashes. |
| `verify_release` | Re-hash every blob a release names. |
| `list_formats` | Installed exporters, which are lossy, and what each can write. |
| `check_export` | What a format would drop from a release, before writing anything. |
| `export_release` | Write a release to a local directory. `allow_lossy` where needed. |

### Offered only with `--allow-destructive`

| | |
| --- | --- |
| `delete_project` | **Destructive.** Removes the project, its dataset, its batches, its jobs and its annotations. Requires `confirm: true` as well — the parameter is unchanged; what changed is that the tool is not in the listing unless somebody started the server for it. |

## `get_asset_image`, and the coordinate frame

This is the tool that makes an agent an annotator rather than an operator. Everything else moves
rows around; without this one a model can drive the whole workflow and never see what it is
labelling, and `add_annotations` with `provenance: "model"` means nothing unless the model looked.

It returns the image **and four numbers**, because they are not the same frame:

```json
{ "asset_id": "…", "width": 4032, "height": 3024, "format": "jpeg",
  "image_width": 256, "image_height": 192, "resolution": "thumbnail", "scale": 15.75 }
```

- `width` / `height` are the **asset's own size**, and that is the coordinate system every
  annotation uses. Geometry is never normalized, at any surface.
- `image_width` / `image_height` are what was actually sent. The default is the cached preview,
  capped at 256 on its long edge, because the bytes travel base64-encoded inside a single
  JSON-RPC message and an original would cost an agent its context window.
- `scale` is the factor between them. **Multiply any coordinate measured on the returned image
  by `scale` before writing it.**

That last line is the whole reason four numbers travel instead of two. An agent that measures a
box on a 256-pixel preview and submits it unscaled produces annotations that are individually
plausible and uniformly wrong — wrong in a way nothing downstream can detect, because every
number is in range and every shape is well formed.

`full: true` returns the original bytes at the asset's own size, where `scale` is 1.

An asset whose preview has never been rendered is refused, and the refusal names
`backfill_thumbnails`. An asset with no recorded image format has no honest media type, so its
measurements come back with an explanation rather than pixels.

## How a tool refuses

There are **two** failure shapes, and telling them apart is deliberate.

A **malformed request** — an argument the schema refuses before the tool body runs — comes back
as an MCP error carrying the validating library's own message, which names the offending field
(`classes.0.name`, `annotations.2.geometry`). This is the API's 422, and it is a bug in the call.

A **domain refusal** is an ordinary successful call whose payload is the error envelope:

```json
{ "error": { "message": "…", "retry_with": "allow_destructive", "hint": null, "index": null } }
```

- `message` is the kernel's own sentence. It is written to be read, and an agent reads.
- `retry_with` names the parameter that turns this exact call into a successful one, or is
  `null` when nothing does. **This is what to branch on.** `DESTRUCTIVE_SCHEMA_CHANGE` is
  retryable with `allow_destructive` and `SCHEMA_CHANGE_WOULD_ORPHAN` is not; over HTTP those are
  both 409, and a client branching on the status would retry the second one forever.
- `hint` is a next step this surface can suggest where the kernel's sentence names a remedy an
  agent cannot reach.
- `index` names which item of a list you sent is at fault, for the three annotation writes. They
  are all-or-nothing, so nothing landed and there is no partial result to count from — the
  position is the only thing identifying it.

There is deliberately **no `code` field**. The REST API's codes live in `server/errors.py`, which
this package may not import, and deriving one from a class name would make a refactor a silent
breaking change. What a code was needed for here is one question — "may I retry this, and with
what?" — and `retry_with` answers it directly.

### The three gate words

Never merged into one, because they guard different things:

| | guards | on |
| --- | --- | --- |
| `confirm` | destroying data | `delete_project` |
| `allow_destructive` | narrowing a contract | `create_schema_version` |
| `allow_lossy` | emitting an incomplete copy of something that stays intact | `export_release` |

`confirm` is the one of the three that an agent will clear by itself — see
[above](#destructive-tools-are-not-offered-unless-you-ask) — which is why the tool that takes it
is not advertised by default. The other two guard *narrowing a contract* and *emitting an
incomplete copy*, neither of which destroys anything: the release stays intact, the earlier schema
version stays readable, and both refusals are recoverable by resubmitting. They stay advertised.

`delete_annotations` takes **none** of them. Removing a label is the annotator edit loop, and the
guard is that a batch which is no longer `in_annotation` refuses every write.

## Stated limits

**Ingest and export are synchronous.** A stdio server has no background worker: something has to
do the decode, and an agent driving a "resume" loop would block for exactly as long as doing the
work in the first place. A long video makes `ingest` a long call.

There is therefore no ingest polling, and no `resume_ingest`. If a call is cut off part way, call
`ingest` again — registration is idempotent on `(kind, path, extraction_fps)` and content
addressing means the re-run creates nothing it created before. That is the same argument that
gave the CLI no `--resume`.

**Paths are local.** `ingest` and `export_release` take paths on the machine the server runs on.
The API's upload staging exists because HTTP has bytes where the kernel has paths; an agent runs
beside the workspace and has the filesystem.

**One workspace per server.** No tool takes a workspace parameter — threading one through
thirty-odd tools would put a path an agent has no way to know into every call. The workspace is
opened and closed per tool call rather than held, so the file is never kept from `visionset ui` or
a second agent between calls.

**A discriminated union's `type` must be spelled out.** `geometry` and the partition variants
carry a default on their tag, so the generated schema shows `type` as optional — but it is read
out of the object to pick the variant, and omitting it fails. Always send
`{"type": "bbox", …}`.

## What is not here, and why

Fifty candidate tools were recorded across the four REST tasks; thirty ship, twenty do not, and
#65 added `check_export` afterwards — the plan-before-apply half of an export, on the
`preview_schema_change` precedent. The
parity rule means *evaluated*, not *implemented* — tool-selection accuracy degrades with count,
so a tool ships only when an agent has a reason to reach for it that no neighbour covers.

**Folded into a parent**, because the parent already reads it and a second tool is a second round
trip: `get_project_dataset`, `get_dataset`, `list_schema_versions`, `get_source`,
`list_batch_jobs`, `get_job_progress`, `get_asset`, `get_release`.

**Folded into `ingest`**: `register_image_source`, `register_video_source`, `start_ingest`. The
kernel splits registration in two because a clip needs a rate and a probe while a folder needs
neither; by the time ingest runs, the source already carries the kind, the path and the rate. The
dispatch is whether the path is a directory.

**Dropped, no poll to make**: `get_ingest_job`, `list_ingest_jobs`, `resume_ingest` — see the
synchronous limit above.

**Dropped, no agent caller**: `list_dataset_assets` (the annotation loop iterates batches, not the
trunk), `list_dataset_changes` (an audit record a person reads), `remove_dataset_asset`
(curation — a judgement about what a dataset should contain, not a step in producing one),
`get_release_manifest` (the whole frozen document is a token bill an agent cannot afford;
`verify_release` answers "is it intact" and `export_release` writes the contents somewhere
usable), `get_release_assignment` (`export_release` puts the folds on disk in the form anything
downstream actually consumes), `rename_project`.

**Never offered**: anything to do with tokens.

Three tools are not on the parity list at all: `ingest` (one tool standing for three candidates),
`preview_schema_change` and `backfill_thumbnails` — the last because it is the remedy
`get_asset_image` names, and a refusal naming an unreachable remedy is worse than no refusal.

## For contributors

Tool modules live in `src/visionset/mcp/`, one per noun, beside three private ones: `_errors.py`
(the envelope and `guarded`), `_workspace.py` (`opened_workspace()`) and `_resolve.py` (turning a
name or a tag into the thing it names).

A new tool is a plain function in the module for its noun plus one row in `main.py`'s `TOOLS`
table. Registration lives there rather than at the definition site — a decorator in `projects.py`
would make that module import `main.py`, which imports it — and it is also where `guarded`,
`inspect.cleandoc` and the read/write annotations are applied, so none of the three can be
forgotten.

**Take domain models as parameters.** `list[LabelClass]`, `Geometry`, `SplitRecipe` and
`AssetProgress` all go straight into signatures: their docstrings become `$defs` on the tool's
input schema, which is the best guidance an agent gets, and their own validators refuse malformed
input without anything being restated. The exception is a model with a field the service
overwrites — `Annotation.schema_version` — where a required input whose value is discarded would
be a lie, so `mcp/annotations.py` defines the two input models that omit it.

**Publish through `visionset.wire`**, never `model_dump()`. The projections there are shared with
the CLI and gated key-for-key against the REST wire models by
`tests/cli/test_json_contract.py`, so one concept has one shape across all three surfaces.

**Mirror every domain bound in the parameter.** A kernel call that raises outside the
`VisionSetError` tree — a bare `ValueError` from a non-positive rate, a `FileNotFoundError` from a
missing path, a pydantic `ValidationError` from constructing a `BySize` — never reaches `guarded`,
and would arrive at the client as an exception's text. Either bound the parameter (`ge=1`) or
refuse in the body with `_errors.refused`.

Tests are in `tests/mcp/`, and every one drives the **real protocol** through
`create_connected_server_and_client_session` rather than calling the Python function. `_flow.py`
bridges the async client with `anyio.run`, so every test is plain synchronous pytest with no
marker and no plugin, and it builds each rung by calling tools rather than by reaching past them
into the SDK.

Module basenames must be unique across the whole suite — there is no `__init__.py` anywhere, so
`tests/mcp/test_batches.py` beside `tests/server/test_batches.py` would be a collection error
rather than two modules. Hence `test_<noun>_tools.py`.
