# Inference connections

VisionSet never downloads a model on its own. Anything that predicts predicts against a
**connection** you created — a small piece of workspace configuration naming which model, at
which revision, and where it runs. Nothing arrives when you install the package, and creating a
connection reaches no network at all: it writes a row.

That is the whole of the promise, and it is worth stating plainly because it is unusual. A fresh
workspace has no connections, so it has no way to predict, and it will not acquire one by being
opened, upgraded, or left running.

Two kinds exist today:

- **`local`** — weights this machine runs. It carries a `device` and a `precision`, and it is
  born **not set up**, because the weights are not here yet. Fetching them is an explicit action
  you take later, with the size shown before you agree to it.
- **`http`** — an endpoint that answers this project's own inference contract. It carries an
  `endpoint_url`, and it is born **ready**, because there is nothing to set up on this machine.
  Whether it *answers* is a separate question with a fresh answer every time it is asked, so it
  is not stored on the row.

The model reference is a pair — an id and a **pinned revision**, both required. A moving pointer
is not a provenance: "which model produced this label" is unanswerable if the answer names
something that means something different next month.

```python
from visionset.kernel.domain import ConnectionType
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    connections = InferenceConnectionService(workspace)

    connections.create(
        "local-detector",
        connection_type=ConnectionType.LOCAL,
        model_id="some/model",
        model_revision="abc123",
        device="cuda",
        precision="fp16",  # fp16 needs a cuda device; a cpu connection is fp32
    )
    for one in connections.list():
        print(one.name, one.connection_type.value, one.setup_state.value)
```

**In the browser:** the **Inference** entry in the rail. See *The Inference section* below.

**Over HTTP:** `GET`/`POST /inference/connections`,
`GET`/`PATCH`/`DELETE /inference/connections/{connection_id}`, and
`POST /inference/connections/{connection_id}/download`. `PATCH` edits in place and leaves out what
you omit; `DELETE` needs no confirmation, for the reason below; `download` answers `202` and points
at a background job.

## Each kind carries its own parameters, and only its own

A local connection needs a device and a precision; an HTTP one needs an endpoint. Both halves of
that rule are enforced: a local connection may not carry an `endpoint_url` either. A row holding
both would leave a later reader — and a later adapter — with no way to tell which field to
believe.

The kind itself cannot be changed after creation. Switching `local` to `http` would empty every
parameter the row carries and keep only its name, which is a new connection wearing an old id.

## Running a model here needs the `local-inference` extra

The auto-labeling feature is always present. What is optional is the runtime that executes a model
*on this machine*:

```bash
pip install "visionset[local-inference]"
```

It brings torch, torchvision, transformers, accelerate and huggingface_hub — roughly two
gigabytes, most of it CUDA — which is why it is not in the base install. Without it you can create a local connection,
list it, edit it and see exactly what it is configured for. What you cannot do is fetch its weights
or ask it to predict, and both refusals print the command above rather than saying "unavailable".

The action stays **offered** on a machine that lacks the extra, deliberately. Whether this
installation has torch is not a fact about your connection, and a control that quietly vanished
would leave the install command with nowhere to be shown.

Working inside the Docker dev stack instead? Its default api image does not carry the extra at
all, so it refuses exactly as above. Two override files add it:

```bash
docker compose -f docker/compose.yaml -f docker/compose.gpu.yaml up --build            # the host's NVIDIA GPU
docker compose -f docker/compose.yaml -f docker/compose.cpu-inference.yaml up --build  # the CPU, anywhere
```

The first needs the NVIDIA Container Toolkit on the host and answers in milliseconds; the second
needs nothing beyond Docker and answers in seconds. Each file's header says the rest, including
what its host needs. Both share the stack's `workspace-data/`, so switching between them — or back
to the plain file — keeps projects, connections and downloaded weights; only the api image changes,
and `--build` is not optional on any of those switches. That stack is for development and changes
nothing about the wheel above.

## Knowing what a download costs, before agreeing to it

A decision you cannot see the price of is not a decision, so the size is readable on its own,
ahead of anything being fetched:

```bash
visionset inference size facebook/sam2-hiera-base-plus --revision main
```

It prints the byte count on stdout and the file count on stderr, and `--json` gives the document
the API answers with. Over HTTP it is
`GET /inference/download-size?model_id=…&model_revision=…`.

This reads the publishing hub's **file listing** — names and byte counts — and downloads nothing.
It takes a model and a revision rather than a connection, because the moment the number is wanted
is usually the moment before a connection exists; the same call answers for a connection that
already has one.

**Every file in the revision is counted**, because fetching takes the whole snapshot. A repository
publishing two serialisations of the same tensors really does cost both, and a figure counting one
of them would understate what lands on your disk. A revision the listing cannot fully size is
refused rather than estimated.

It needs the `local-inference` extra, because the size is read with the same client that would do
the fetching. Without it you get `LOCAL_INFERENCE_UNAVAILABLE` and the install command.

## Fetching weights

Nothing arrives on your behalf: not at install, not at startup, not on the way to anything else.
Weights arrive when you ask for them, and asking is one action.

```bash
visionset inference download local-detector
```

Over HTTP it is `POST /inference/connections/{id}/download`, which answers `202` with a background
job and a `Location` header naming it — the same launch-and-poll contract an export uses. Poll
`GET /background-jobs/{id}` until `state` is `succeeded`, then re-read the connection: its
`setup_state` is now `ready`.

At a terminal there is no queue to hand the work to, so the command **blocks** and reports each
phase on stderr. Interrupting it is safe.

**Where they land.** Inside the workspace, under `models/`, beside `blobs/`. A workspace you copy
to another machine takes its model with it, which is what keeps "does this workspace run?" a
question about the workspace rather than about the machine. One cache for the whole workspace, so
two connections pinned to the same model and revision share the files instead of holding two copies.

**What is fetched.** The model id and the **pinned revision** the connection carries, from the
original source. Never a branch name, and never a substitute: a pin that does not resolve is an
error, because quietly fetching something else would produce weights whose identity the row now
misdescribes.

**A failure changes nothing.** The connection is marked ready as the last step, after every file is
present — so a download that dies partway leaves it exactly as it was, at `not_set_up`, with the
error on the job. There is no half-ready state to recover from because there is no moment at which
one could be written. Ask again: an interrupted transfer resumes from what it had, and each file
that arrives is checked against the size the hub published for it before it is put in place.

**Asking again checks rather than repeats.** `download_weights` stays available once a connection
is `ready`, where the same call re-checks that the snapshot is still complete and fetches only what
is missing — the browser labels it **Check for missing files** and puts it in the row's overflow
menu. That is worth doing on a machine where a disk filled or a cache was pruned. An `http`
connection is refused with `INFERENCE_CONNECTION_NOT_DOWNLOADABLE` in any state, for the other
reason: its model runs elsewhere, so it has no weights of its own.

## Two checks, and what each one proves

They are different questions about the same files, and the labels are written so that neither
claims the other's answer.

| | What it proves | How it works | What it costs |
| --- | --- | --- | --- |
| **Check for missing files** (`download_weights` at `ready`) | Nothing is **missing** | Consults the download index and fetches anything absent | Seconds; it opens no file |
| **Check files are undamaged** (`check_integrity`) | Nothing is **damaged** | Reads every file in full and compares its digest against the one the hub published | Minutes for a large model; it reads every byte |

The first cannot see the second's failure, and that is a property of the cache rather than an
oversight: a file already there under this revision is *returned without being read*, so a copy that
was truncated by a filesystem error, rotted on a failing disk, or edited in place passes the
completeness check for ever. It surfaces much later, inside a model load, in a sentence about
tensors, on a connection the row still calls **Ready**.

```bash
visionset inference check-integrity local-detector
```

Over HTTP it is `POST /inference/connections/{id}/check-integrity`, which answers `202` with a
background job whose `processed` and `total` count files. Legal only for a **local** connection that
is already `ready`: an `http` connection has no files here and one whose weights never arrived has
none to read, and both are `INFERENCE_CONNECTION_NOT_CHECKABLE`.

**A failed check has already acted.** Damage means the offending files are removed and the
connection is put back to `not_set_up` before the job says so, in that order. The order is the whole
point: a cache hit is returned unread, so leaving the bad bytes in place would let the download
somebody runs next hand back the same damaged file and call the connection ready again. With them
gone, **Download weights** is a real transfer, which is why it is the remedy the row then offers.

The two states stay the only two throughout. A check that cannot reach the hub — no network, a
repository that moved — changes nothing and removes nothing: there are no published digests to
compare against, and that is an absence of evidence rather than a verdict in either direction.

## Pointing a connection somewhere else

Editing a local connection's `model_id` or `model_revision` puts it back to `not_set_up`. The
weights on your disk are the weights of the model it used to name, and `setup_state` answers *are
the weights here* — so leaving it `ready` would have it claim to be set up over files nothing ever
fetched. It forgets what kind of model it holds at the same time, and for the same reason.

**The remedy is the ordinary one.** The row offers **Download weights** again, and the cache is
keyed by model rather than by connection: the previous model's files are left where they are, so
pointing a connection back at something it used to name costs a cache hit instead of a second
transfer. Editing anything else — the name, the device, the precision — changes neither the state
nor the family, and neither does sending the same model reference back unchanged.

An `http` connection keeps no weights here, so a model edit resets nothing for it. It stays
`ready`, which for that kind has always meant *there is nothing to set up on this machine*.

## Running on the CPU

A connection asking for `cuda` on a machine with no GPU falls back to the CPU, in full precision,
with a warning in the log. It is a fallback rather than a preference — a workspace configured on a
workstation should still open on a laptop — but it is slower by a large factor, which is why it is
said out loud rather than silently done.

Half precision applies on CUDA only, and the kernel now says so rather than absorbing it: a `cpu`
connection asking for `fp16` is refused at creation. On a CPU it was never the conservative choice
it looks like — `float16` arithmetic outside CUDA's autocast is slower than the `float32` it was
avoiding — and a setting the adapters drop is one the row would otherwise go on displaying as
though it had an effect.

**Both fields are closed vocabularies.** `device` is `cpu`, `cuda`, or `cuda:N` for the second GPU
on a machine that has one; `precision` is `fp16` or `fp32`, and `float16`, `half`, `float32` and
`full` are accepted as spellings of those two. Anything else is refused with a sentence naming the
members. What this closes is a gap rather than a freedom: `gpu` used to be accepted and then
resolved onto the CPU, so the connection described a run that never happened.

## What a connection can be asked for

A connection row says where a model runs and whether its weights are here. Neither answers the
question a caller has to settle *before* asking: does this model take the kind of prompt I am
about to send? So a connection also declares what it can be asked for.

```json
{ "setup_state": "ready", "capabilities": ["point_suggest"], … }
```

| Capability | Means | Families |
| --- | --- | --- |
| `point_suggest` | Give me the thing under these points | the SAM 2 family |
| `text_detect` | Find everything these words name | the grounding-dino family |

**Read from the model, never from its name.** The value comes from the `model_type` the
downloaded config declares — the same fact that decides which adapter runs it, so a model that
runs and a model that declares are the same list. Matching on a model id would answer confidently
for every model this build has never heard of, and the wrongness would only surface as a refusal
deep in a request.

**Empty means nothing is known yet**, which happens four ways: the weights were never fetched, so
nothing has read a config; the config declared no model type; it declared one this build has no
adapter for; or it is an `http` connection, whose model runs elsewhere and which declares nothing
until the remote contract says how an endpoint states what it can do. Empty is not a refusal —
the server still judges every request on its own. It says only that no tool can rely on this
connection.

**It is recorded when the weights arrive**, because that is the first moment it is knowable
without reaching a network. Editing a connection to point at another model or revision clears it
again — nothing has read the new one, and a stale answer reads exactly like a fresh one — and
takes the setup state with it, for the same reason: see [Pointing a connection somewhere
else](#pointing-a-connection-somewhere-else). A connection created before this shipped acquires
its answer the first time something reads it, from files already on your disk.

## Suggesting a shape from a click

A connection whose model answers *places* rather than *words* — one declaring `point_suggest` —
can propose a shape for whatever sits under a point. One call, one asset, one set of points:

```http
POST /inference/suggest
{
  "project_id": "…", "asset_id": "…", "connection_id": "…",
  "positive": [{"x": 412.0, "y": 233.0}],
  "negative": [],
  "allowed_geometries": ["polygon"]
}
```

```json
{
  "model_ref": "some/segmenter@abc123",
  "region": {
    "geometry": {"type": "polygon", "points": [[404.0, 221.0], …]},
    "confidence": 0.87
  }
}
```

**Points are in the asset's own pixels**, the same frame every geometry in a project uses.
`positive` says *this*; `negative` says *not that*, which is how an over-eager first answer gets
carved back without starting over. Refining means sending the accumulated points again, not a
diff — the call keeps no state about your gesture, so the same points always answer the same way.

**`allowed_geometries` is your schema, not a preference.** The answer comes back in one of the
kinds you named or not at all: name `polygon` and you get the outline; name only `bbox` and you
get that outline's extent; name a kind that holds no shape and `region` is `null`. Answering in a
kind your schema would refuse would hand you a suggestion that cannot be accepted.

**`region: null` is a successful answer with nothing to propose** — a click on empty background,
a model less sure than you asked for, or a shape too thin to be a polygon. `model_ref` is still
there, because it is what an accepted suggestion has to carry.

**How much of the outline survives simplification is the server's setting, not a per-call knob.**
The tolerance is a fraction of the region's own size rather than a pixel count, so one setting
works on a thing eight pixels across and a thing eight hundred across alike, and it keeps a typical
object in the 10–40 vertex range. There is nothing to send: every caller gets the same
simplification, which is what makes two clients' suggestions comparable.

### Nothing is written, and the first click is the slow one

Asking is not annotating. The response is a proposal: turning it into an annotation is an ordinary
annotation write that carries `provenance: model`, this response's `model_ref` and its
`confidence`. Discarding it costs nothing, because nothing was recorded.

A segmenter reads the whole image once and then answers any number of clicks from that reading, so
the **first** call for an asset pays for the encode and the ones after it do not. That cached
reading is the only thing the call leaves behind — an optimisation, not a record. It lives in the
server process, is bounded, and a restart costs you nothing but the latency of the next first
click.

### When it refuses

The connection is resolved before the asset, deliberately: if you are part-way through setting a
connection up, you should hear about the connection rather than about an asset that was never the
problem. A connection whose weights are not here yet is `INFERENCE_CONNECTION_NOT_SET_UP` and
names `download` as the remedy; one whose model answers words rather than places is
`UNSUPPORTED_PROMPT`.

That last one is still the law and is still enforced on every call. It is simply no longer how a
person finds out: a client with `capabilities` in hand can decline to ask, which is why the
editor now says so once on the panel instead of collecting one refusal per click.

## What a connection is not

It is **not a credential store**, yet. An HTTP connection carries no secret today, and the field
is absent rather than nullable: where such a secret should live is an open decision, and a column
added "for later" would answer it by default.

It is **not a model runner**. This layer knows the configuration; running a model is an adapter's
job, and the kernel imports no inference stack at all. A connection can be configured on a
machine that could not possibly run it — which is exactly what you want when the thing that runs
it is somewhere else.

It is **not an endpoint client**, yet. An `http` connection can be created, edited and listed, but
nothing in this version speaks to one: asking it to predict is refused with
`INFERENCE_CONNECTION_NOT_RUNNABLE`, which is a statement about this build rather than about your
configuration. There is no `test` action for the same reason.

## Deleting one destroys a configuration, not work

Annotations record the model that produced them by **copying** its identity onto the label when
it is written. Nothing anywhere holds a key back to a connection row. So deleting one is an
ordinary delete with no cascade and no confirmation gate: annotations keep their model
provenance, and only this configuration is removed.

That is also why a connection has no lifecycle to speak of — it is a form somebody filled in, and
the remedy for a wrong one is to edit it or make another.

## The Inference section

Connections live behind **Inference** in the rail, beside Home and Projects. It is a top-level
destination rather than something inside a project because a connection belongs to the
*workspace*: it carries no project id, and every project uses the same ones.

A workspace with none says so and offers one thing — **Add connection**. Creating one is two
steps, because the two kinds share almost no fields: first where the model runs, then that kind's
form.

- **Local** opens on a curated model, a `cpu` device and `fp32` precision. The model field is a
  grouped list — the SAM 2.1 ladder under *Interactive segmentation*, Grounding DINO under
  *Text-prompt detection* — showing each entry's download size and a line on what it is for, and
  each one is pinned to a revision this build was checked against. **Custom model…** is the last
  entry and reveals the free model id and revision fields: the list guides, it does not restrict,
  and any model this build has an adapter for remains typeable. Device and precision are lists too,
  and the precision list follows the device, because half precision applies on CUDA only. Underneath
  is what fetching that revision would cost — the size described above, read while you are still
  deciding. If this machine has no `local-inference` extra the size cannot be read, and the form
  says so, in the server's own words, with the install command. **It stays usable**: creating a
  connection downloads nothing, so not knowing the size is information rather than a barrier.
- **HTTP** asks for the endpoint URL. There is no credential field; where a secret would live is
  still open (`cf. #421`), and a field added ahead of that answer would be answering it.

Each row shows its name, its kind, `model @ revision`, and its status as a word — **Ready** or
**Not set up** — beside a colour, never as a colour alone. A local row that is not set up carries
**Download weights**, which launches the background job described above and reports its progress
in place; the row becomes **Ready** when the job finishes, without a reload. A row that is already
ready carries two checks in its overflow menu instead — **Check for missing files**, which is the
same request re-run, and **Check files are undamaged**, which reads every byte. The table above is
what separates them. A machine without the extra still shows both controls, and pressing either
answers with the install command — a control that vanished would take the remedy with it.

A failed download leaves the row at **Not set up**, because weights arrive or they do not, and says
what happened in the job's own words with what to do about it. There is no separate retry button:
**Download weights** is the retry. A failed *integrity* check leaves the row at **Not set up** for a
different reason — the damaged files were removed and the connection stood down before the row said
so — and the retry is the same **Download weights**, which now has to fetch them again for real.

Editing does not offer to change the kind, because the kind is not editable. Saving an edit that
moves a local row to another model or revision returns it to **Not set up** in place, with
**Download weights** as the next step — the files on the disk belong to the model it was pointing
at before. Deleting asks once and says exactly what it destroys: *annotations keep their model
provenance; only this configuration is removed.*

Above twenty rows the list grows a filter, which matches a name substring and keeps saying how
many it hid.

**Reached from the editor, too.** Arming the editor's suggest tool with no usable connection shows
a panel naming what is missing and offering **Set up a connection**, which lands here. Nothing
about that flow forces you out of the editor or loses work: the panel is an explanation with a
door, and the door is optional — a host that wires no destination gets the explanation and no
control.

*No usable connection* covers one case more than it reads: a workspace can hold a connection that
is configured, downloaded and running, and still have nothing that can answer a click, because
the model it holds answers words. The panel says which of the two it is — nothing set up, nothing
downloaded, or nothing of the right kind — and each names a different thing to do.

## At a terminal

```bash
visionset inference size some/model --revision abc123
visionset inference create local-detector \
    --type local --model some/model --revision abc123 --device cuda --precision fp16
# --device takes cpu, cuda or cuda:N; --precision takes fp16 or fp32, and fp16 needs a cuda device
visionset inference list
visionset inference show local-detector --json
visionset inference update local-detector --revision def456
visionset inference download local-detector
visionset inference delete local-detector --yes
```

`size` is the one command here that opens no workspace: it asks about a published model rather
than about a configured row, so it takes no `--workspace`.

`create` prints the new id on stdout alone. `list` leads with the id, so `awk '{print $1}'` is
stable even for a name holding internal whitespace. Every command takes `--json`, and the
document it prints is the same shape the REST API answers with.

A connection is addressed by **name or id** wherever one is taken — names are unique in a
workspace, compared without regard to case, so `local` and `Local` cannot name two of them.

## Errors

| Code | Status | Means |
| --- | --- | --- |
| `INFERENCE_CONNECTION_NOT_FOUND` | 404 | No connection with that id or name in this workspace |
| `INFERENCE_CONNECTION_NAME_TAKEN` | 409 | Another connection already holds that name |
| `INFERENCE_CONNECTION_NOT_DOWNLOADABLE` | 409 | Already set up, or a kind with no weights of its own |
| `INFERENCE_CONNECTION_NOT_CHECKABLE` | 409 | A kind with no weights of its own, or weights that are not here yet — run `download` |
| `WEIGHTS_DAMAGED` | 409 | An integrity check found files that do not match; they were removed and the connection stood down |
| `INFERENCE_CONNECTION_NOT_SET_UP` | 409 | Asked to predict before its weights were fetched — run `download` |
| `INFERENCE_CONNECTION_INVALID` | 422 | The parameters do not describe a usable connection of that kind |
| `INVALID_NAME` | 422 | The name is blank once stripped |
| `UNSUPPORTED_PROMPT` | 422 | The model does not answer that way of asking |
| `LOCAL_INFERENCE_UNAVAILABLE` | 500 | The `local-inference` extra is not installed; the message carries the command |
| `INFERENCE_CONNECTION_NOT_RUNNABLE` | 500 | This build has no adapter for that kind of connection |

The last two are 5xx because they are conditions of the *installation* rather than of the request:
no state you can change and no retry makes either succeed, so neither is a 409. Both expose their
message, because the message is the remedy — which is the same licence a missing `ffmpeg` gets.
