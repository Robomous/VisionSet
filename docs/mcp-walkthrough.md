# The MCP walkthrough

[mcp.md](mcp.md) is the reference: thirty-three tools, what each is for, and the rules they all
follow. This one is about a *session* — the cycle in the order an agent meets it, and then what
happened when a model that had never seen this repository was pointed at the server and asked to do
the job.

It is in two halves, and the second is the one that earns the document. Anyone can write a
walkthrough where the surface works. The measurement is whether a model **chooses** these tools and
**reads** what they return, and that is a claim about the tool descriptions rather than about the
kernel underneath them.

The walk below is the executable
[`tests/mcp/test_agent_walk.py`](../tests/mcp/test_agent_walk.py) in prose. Every call it makes,
this section makes; every assertion it makes is stated here as what the answer is good for.

To run it yourself rather than read it, [`examples/mcp_end_to_end.py`](../examples/mcp_end_to_end.py)
is the same walk against a **real server over a real pipe** — it spawns `visionset mcp --workspace
<root>` exactly as an MCP client configuration would and speaks JSON-RPC down its stdin and stdout,
where the test drives the protocol over a paired in-memory stream. The test proves the tools; the
example proves the transport.

---

# The walk

## The shape of it

| Step | Tool | What it settles |
| --- | --- | --- |
| 1 | `list_projects`, `create_project` | somewhere to work, and its dataset |
| 2 | `create_schema_version`, `get_schema` | the contract, before any work is judged against it |
| 3 | `ingest` | a folder becomes assets in a draft batch |
| 4 | `approve_batch`, `start_batch` | membership frozen, schema pinned, jobs cut, work opened |
| 5 | `start_job`, `next_pending_assets`, `get_asset_image`, `add_annotations`, `set_asset_progress` | the loop |
| 6 | `complete_job`, `complete_batch`, `promote_batch`, `dataset_stats` | the finished work reaches the trunk |
| 7 | `publish_release`, `verify_release`, `list_formats`, `export_release` | a frozen artifact, on disk |
| 8 | `publish_release` again | a refusal, on purpose |

## 1 — Find out where you are

```
list_projects  ->  {"items": [], "total": 0}
```

An empty collection is a collection, not an error. Every listing in this surface answers
`items`/`total`, so a client — or a model — never has to tell "nothing here" apart from "something
went wrong".

```
create_project name="road-signs" description="signage survey"
```

The project and its dataset are created in one transaction. There is no `create_dataset`, and no
tool that reads the dataset on its own: `get_project` already carries `dataset_id`, and
`dataset_stats` takes the *project*. Two of the twenty tools that folded, folded here.

## 2 — Declare the contract first

```
create_schema_version project="road-signs" classes=[
  {"name": "sign",       "geometry": "bbox"},
  {"name": "empty-road", "geometry": "classification_tag"}]
->  {"version": 1, ...}
```

A `LabelClass` is bound to exactly one geometry, so "a box round a sign" and "a tag on a picture
with nothing in it" are two classes, not one class with two shapes. The whole list is sent every
time: a version is the complete contract, never a patch against the last one, which is what lets
[schemas.md](schemas.md) call removal *narrowing* and gate it.

`get_schema` answers with `active_version` and `available_versions` beside the schema itself, which
is the third fold: there is no `list_schema_versions`, because the parent already read them.

## 3 — Read the folder in

```
ingest project="road-signs" path="/abs/incoming"
->  {"created": 4, "deduplicated": 0, "failed": 0, "batch_id": "...", "failures": []}
```

One tool, and it **blocks until the run has finished**. The kernel splits registration in two —
a clip needs a rate and a probe where a folder needs neither — and `ingest` dispatches on whether
the path is a directory, so `register_image_source`, `register_video_source` and `start_ingest`
became one call. A video is the same call with `extraction_fps`.

There is no job to poll and no `resume_ingest`, and that is a stated limit rather than an omission:
a stdio server has no background worker, so an agent driving a resume loop would block for exactly
as long as doing the work. If a call is cut off, call `ingest` again — registration is idempotent on
`(kind, path, extraction_fps)` and content addressing means the re-run creates nothing.

`failed` and `failures` are how a run reports the files it could not read *while still succeeding*.
An unreadable JPEG in a folder of five thousand is not a reason to refuse the other 4,999.

The answer also carries `ingest_job_id`, which names *this run* and nothing else. No tool reads it
back, and it is emphatically not an annotation job — those do not exist until `approve_batch` cuts
them. It is called that because it was once called `job_id`, and [an agent took that straight to
`get_job`](#what-a-real-agent-actually-did).

## 4 — Freeze it, cut it, open it

```
approve_batch batch_id=... jobs_of=2   ->  {"schema_version": 1, "jobs": [ {...}, {...} ]}
start_batch   batch_id=...             ->  {"state": "in_annotation"}
```

Approval does three things at once and none of them can be undone: membership freezes, the
project's *active* schema version is pinned to this batch forever, and the assets are cut into an
exact partition of jobs. A later `create_schema_version` does not move the pin, which is what makes
"judged against the contract it was cut for" true rather than aspirational.

`start_batch` is separate because nothing may be written into a batch nobody opened. The lifecycle
is one-way — there is no route back to `draft` — since the jobs are already cut against the pin.

## 5 — Look, then label

This is the step that makes an agent an annotator rather than an operator.

```
start_job job_id=...                     ->  {"state": "in_progress"}
next_pending_assets job_id=... count=10  ->  {"items": [...], "total": 2}
```

`next_pending` returns only assets nobody has settled, in the batch's own order, and it **shrinks as
work lands**. That is the loop's termination condition: keep calling until `total` is 0. There is no
cursor to hold and nothing to page past.

```
get_asset_image project="road-signs" asset_id=...
->  image bytes, and
    {"width": 640, "height": 480, "image_width": 256, "image_height": 192, "scale": 2.5, ...}
```

**Those are two different frames, and the whole design turns on saying so.** `width`/`height` are
the asset's own size and the coordinate system every annotation uses. `image_width`/`image_height`
are what was actually sent — by default the cached preview, capped at 256 on its long edge, because
the bytes travel base64-encoded inside one JSON-RPC message. `scale` is the factor between them.

A box measured on the preview and submitted unscaled is **individually plausible and uniformly
wrong**: every number is in range, every shape is well formed, and nothing downstream can tell. So:

```
add_annotations job_id=... annotations=[{
    "asset_id": "...", "label_class": "sign",
    "geometry": {"type": "bbox", "x": 25.0, "y": 30.0, "width": 100.0, "height": 75.0},
    "provenance": "model", "model_ref": "walkthrough@1", "confidence": 0.82}]
```

— where every one of those four numbers is what was measured on the returned image, multiplied by
`scale`. `type` is spelled out because the geometry is a discriminated union and pydantic reads the
tag out of the input dict to pick a variant. `provenance: "model"` cannot be sent without a
`model_ref`; the domain refuses it, so nothing re-checks it here.

Writing an annotation moves its asset to `annotated` on its own — nothing has to remember to mark
it. An asset with nothing in it is settled the other way:

```
set_asset_progress job_id=... asset_id=... progress="skipped"
```

`skipped` settles the job without going to the trunk. That is the difference between
`SETTLED_PROGRESS` (does not block completion) and `PROMOTABLE_PROGRESS` (belongs in the dataset),
and it is why the counts change at step 6.

## 6 — Close it, and move the finished work

```
complete_job   job_id=...    ->  {"state": "completed"}
complete_batch batch_id=...  ->  {"state": "completed"}
promote_batch  batch_id=...  ->  {"total": 2}
dataset_stats  project=...   ->  {"asset_count": 2, "annotation_count": 2,
                                  "classes": [{"label_class": "sign", "annotations": 2, "assets": 2}]}
```

Completing every job does not complete the batch; `complete_batch` derives that itself, because one
state machine in two places is one too many. Promotion is a union against current membership, so it
is idempotent — and it admits only promotable assets, which is why four assets become two.

`dataset_stats` counts **both** annotations and the assets carrying them, per class: a thousand
labels over a thousand pictures and the same thousand over ten are the same total and a very
different dataset. A class the schema declares but nobody used is **absent, not zero** — which
classes exist is a question for `get_schema`.

## 7 — Freeze it, check it, write it out

```
publish_release project=... tag="v1.0" split={"train":0.5,"val":0.25,"test":0.25,"seed":7}
verify_release  project=... tag="v1.0"  ->  {"ok": true, "checked": 2, ...}
list_formats                            ->  {"items": [{"name": "dummy", "lossy": false}]}
export_release  project=... tag="v1.0" format="dummy" dest="/abs/out"
```

A release is immutable and its manifest is a pure function of content, so publishing an unchanged
dataset twice produces the identical document. `verify_release` re-reads and re-hashes every blob
the manifest names — it does not consult an index, because an index agreeing with itself proves
nothing.

`list_formats` exists because the installed set is a property of *this* installation, not of the
API: `dummy` is the only exporter that ships, and it writes nothing, so a `file_count` of 0 is an
export that ran. `export_release` takes a **local `dest`**, not an archive: an agent runs beside the
workspace and has a filesystem, and a zip travelling base64 through a JSON-RPC message is a token
bill nobody should pay.

There is no `get_release_manifest`, for that last reason, and no `get_release_assignment` —
`export_release` puts the folds on disk in the form anything downstream actually consumes.

## 8 — And it ends on a refusal

```
publish_release project=... tag="v1.0"
->  {"error": {"message": "release tag 'v1.0' already exists ...",
               "retry_with": null, "hint": null, "index": null}}
```

`isError` is **false**. A domain refusal is an ordinary successful call whose payload happens to be
the error envelope, and only a malformed *request* — the wrong shape, a missing field — is a
protocol error. The two are kept apart because they need different responses: fix your arguments,
versus fix the world.

`retry_with` is `null` here, and that is the load-bearing part. A release is immutable, so no flag
turns this call into a successful one; the remedy is a different tag. Where a flag *would* work,
`retry_with` names it.

---

# What a real agent actually did

On **2026-07-29**, for [#36](https://github.com/Robomous/VisionSet/issues/36), a headless Claude
Code agent was pointed at `visionset mcp` twelve times: three scenarios, two models (**Opus 5** and
**Sonnet 5**), two trials each. The agent had the thirty-three tools and nothing else — no
repository on its path, no `CLAUDE.md`, no other MCP server, and no file or shell tools with which
to read the source or open the database. Anything it knew about this surface, it read in the tool
listing. The prompts were written the way somebody would actually ask, and named no tool and no
parameter.

The three scenarios: the whole cycle from an empty workspace to an exported release; the annotation
loop against four 640×480 stills each carrying one bright rectangle at a **known** pixel rectangle;
and a schema tidy-up that walks into two refusals and a destructive delete.

**184 tool calls. Zero malformed requests.** Not one call in twelve runs got a shape wrong — not the
discriminated union's `type`, not `provenance: "model"` needing a `model_ref`, not a nested
`SplitRecipe`. That is the strongest single result here, and it is the payoff of putting domain
models straight into the tool signatures: FastMCP publishes their docstrings into `$defs`, so the
schema an agent reads is the one the domain's own validators enforce.

**Thirty of the thirty-three tools were used.** The three never reached for were
`backfill_thumbnails` (nothing needed it — previews were already cached), `set_asset_progress` (no
scenario had an empty picture in it) and `update_annotations` (nothing needed revising). No run
reached for a tool that does not exist, and no run showed the wrong-tool churn the degradation
argument predicts. **There is no evidence for folding the lifecycle verbs**, which was the declared
next move if selection turned out noisy; the sequences read as the cycle.

## The coordinate frame: sixteen boxes, none of them in the wrong frame — and not for the expected reason

| model | boxes | mean IoU against ground truth | measured on the preview | asked for `full` |
| --- | --- | --- | --- | --- |
| Opus 5 | 8/8 | 0.987 | 0 | 8 |
| Sonnet 5 | 8/8 | 1.000 | 0 | 8 |

Every box landed in the asset's own frame. Not one collapsed into the preview's top-left corner,
which is what a forgotten `scale` looks like and what would have been invisible to everything
downstream.

**But no model did the multiplication.** All sixteen looks passed `full=true`, so `scale` was 1
every time and there was no arithmetic to get wrong. Opus said so out loud in its own summary:
*"No filesystem tools here, so I'll measure from the full-resolution renders."* Both models
independently decided that the way to be accurate about pixels is to look at the pixels.

That is worth being precise about, because it is easy to read as either a better result than it is
or a worse one. It does **not** show that publishing four numbers makes an agent scale correctly —
that was never tested, because nothing chose to be in the position where it mattered. What it does
show is that the four numbers make the *situation* legible: a tool that returned only pixels would
have given a model no way to know it was looking at a downscale, and `full=true` is a door that only
opens for someone who knows the room has two sizes.

So the default stays the preview. Flipping it to full resolution would make every browse, every
triage pass and every look-before-skipping cost an original-sized image, to serve a case where
agents already opt in unprompted. The mechanism is doing its job by making the choice available,
which is a different claim from the one `docs/mcp.md` used to make, and the honest one.

## `retry_with`: the un-retryable refusal was hit four times out of four, and nothing looped

Every S3 run walked into `SCHEMA_CHANGE_WOULD_ORPHAN` — narrowing a schema out from under
annotations that already exist. `retry_with` was `null`, as it must be, and in all four runs the
agent **read the message, fixed the world, and moved on**: it found the offending annotations,
deleted them, and re-applied the same schema. Nothing re-attempted the refused call more than once.

Over HTTP that refusal and `DESTRUCTIVE_SCHEMA_CHANGE` are both 409, and a client branching on the
status retries the second one forever. Four runs is not a proof, but it is four more data points
than the argument had before.

**The retryable refusals never happened at all**, and that is the uncomfortable finding. In four
runs out of four, the agent sent `allow_destructive: true` and `confirm: true` on the **first**
call, having read them in the tool description. `delete_project` destroyed the project first time
of asking, every time.

That is not a bug — the flags did exactly what they are specified to do, and the gate words are
still three rather than one. But it does settle a question that was open: **`confirm` is not a
human-in-the-loop check when the caller is a model.** It is a speed bump the description tells the
caller how to step over. If a real gate is ever wanted for this surface, it has to live somewhere
the agent cannot reach — the server's own configuration, not a parameter. That is
[#108](https://github.com/Robomous/VisionSet/issues/108), deliberately not decided here.

## Two pieces of friction, and both were about names rather than shapes

**`ingest` answered with a `job_id` that no tool could read.** One run took it straight to
`get_job`, was refused with *"no job … in workspace"*, and diagnosed the problem itself in its final
report: *"`ingest` returned a `job_id` that doesn't resolve — real jobs only appear at
`approve_batch`."* Two different things were called `job`, and the one an agent met first was the
unreachable one. Renamed, and both ends now say which is which.

**`start_job` was skipped, and `complete_job` paid for it.** Two runs — one on each model — wrote
every label and then tried to complete a job still `pending`. They were right to be surprised:
writing is gated on the *batch* being `in_annotation`, not on the job, so nothing forces `start_job`
until the very end of the loop. Both recovered in two calls, because the kernel's own sentence names
`in_progress` as the only state reachable from there. That refusal was doing real work, which is why
the answer was a description rather than a redesign.

## What the runs could not settle

**The canonical cycle finished twice and stopped twice, on the same reasoning.** In trial 1 both
models drove the whole thing — ingest at 5 fps, approve, cut, look, label, complete, promote,
publish `v1.0`, verify, export — in 29 calls each. In trial 2 both models looked at the frames,
correctly identified them as a synthetic test card with no traffic signs in it, declined to invent
labels, and stopped to ask. That is the behaviour anybody would want and it says nothing about the
tools; it does mean a generated clip is a poor instrument for measuring a cycle that ends in
labelled data, which is why the labelling half was measured separately against a target the agent
could actually see.

**`allow_lossy` was never exercised by an agent.** `dummy` is the only installed exporter and it is
not lossy, and installing a second one for the run would have changed the surface under test. It
stays covered by `tests/mcp/test_release_tools.py`.

**Twelve runs is twelve runs.** Every number above is a small sample against two models on one day.
The failures are the durable part — a thing that went wrong once will go wrong again — and the
successes are weaker evidence than they look.

---

# What changed because of it

Three edits, all inside the MCP package, all pinned by a test that fails without them. None of them
touched the kernel, a route, or a stored shape; `openapi.json` and the generated client are
byte-identical, because MCP is a client like any other.

| Change | The transcript behaviour that caused it |
| --- | --- |
| `ingest` answers `ingest_job_id`, not `job_id`, and says the annotation jobs come from `approve_batch` | an agent took `job_id` to `get_job` and was refused |
| `get_job` says which id it takes, and that it is not the one `ingest` returned | the other half of the same confusion |
| `start_job` and `complete_job` each name the other — one the consequence, one the remedy | two runs labelled everything, then could not complete |

The last one is stated in **both** directions on purpose: an agent reads whichever description it
reaches first, and the two runs that hit it reached them in opposite orders.

Three things were deliberately **not** changed:

- **The preview stays the default for `get_asset_image`.** Argued above: agents opt into `full`
  exactly when it matters, and making everyone pay for an original would serve nobody.
- **`retry_with` keeps no entry for the orphan refusal.** Four runs read `null` and correctly
  concluded that no flag exists. Adding a hint that names "delete the annotations first" was
  considered and dropped — every run worked that out from the kernel's own sentence, and a hint
  suggesting a destructive remedy for a refusal whose whole point is refusing to destroy is the
  wrong thing to put in front of a model.
- **The thirty-three tools stay thirty-three.** Nothing was missed and nothing was confused for
  something else. The twenty that folded stay folded.

## What was left

- [#108](https://github.com/Robomous/VisionSet/issues/108) — `confirm` is satisfiable from the tool
  description, so a destructive tool self-authorises in one call. If this surface wants a real gate
  it belongs in the server's configuration, out of the agent's reach. Post-beta.
- [#109](https://github.com/Robomous/VisionSet/issues/109) — whether `start_job` earns its place
  here at all, given that writes are gated on the batch. The evidence is two wasted calls in twelve
  runs, which is friction rather than a case for surgery; the data is on the issue for whoever
  revisits it.

The limits in [mcp.md](mcp.md) were not re-litigated and none of them caused a failure: ingest and
export stayed synchronous, paths stayed local, no run wanted a token, and every discriminated union
arrived with its `type` spelled out.
