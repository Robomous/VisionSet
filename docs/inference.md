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
        precision="fp16",
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
one could be written. Ask again; a partial cache is verified and resumed rather than restarted.

**Asking twice is refused, not repeated.** Once a connection is ready there is nothing left to
fetch, so `download_weights` stops being offered and the request is answered with
`INFERENCE_CONNECTION_NOT_DOWNLOADABLE`. An `http` connection is refused with the same code for the
other reason: its model runs elsewhere, so it has no weights of its own in any state.

## Running on the CPU

A connection asking for `cuda` on a machine with no GPU falls back to the CPU, in full precision,
with a warning in the log. It is a fallback rather than a preference — a workspace configured on a
workstation should still open on a laptop — but it is slower by a large factor, which is why it is
said out loud rather than silently done.

Half precision (`fp16`, `float16`, `half` — the spelling is yours) applies on CUDA only. On a CPU
it is not the conservative choice it looks like: `float16` arithmetic outside CUDA's autocast is
slower than the `float32` it was avoiding.

## Suggesting a shape from a click

A connection whose model answers *places* rather than *words* can propose a shape for whatever
sits under a point. One call, one asset, one set of points:

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

**`detail` controls how much of the outline survives simplification**, as a fraction of the
region's own size rather than a pixel count, so one setting works on a thing eight pixels across
and a thing eight hundred across alike. Omit it and the server's default keeps a typical object in
the 10–40 vertex range. Smaller is more faithful and more vertices.

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

- **Local** opens pre-filled with the suggested model, `facebook/sam2-hiera-base-plus` at `main`,
  a `cpu` device and `fp16` precision. Every one of those is a starting point you can type over.
  Underneath the fields is what fetching that revision would cost — the size described above, read
  while you are still deciding. If this machine has no `local-inference` extra the size cannot be
  read, and the form says so, in the server's own words, with the install command. **It stays
  usable**: creating a connection downloads nothing, so not knowing the size is information rather
  than a barrier.
- **HTTP** asks for the endpoint URL. There is no credential field; where a secret would live is
  still open (`cf. #421`), and a field added ahead of that answer would be answering it.

Each row shows its name, its kind, `model @ revision`, and its status as a word — **Ready** or
**Not set up** — beside a colour, never as a colour alone. A local row that is not set up carries
**Download weights**, which launches the background job described above and reports its progress
in place; the row becomes **Ready** when the job finishes. A machine without the extra still shows
the control, and pressing it answers with the install command — a control that vanished would take
the remedy with it.

Editing does not offer to change the kind, because the kind is not editable. Deleting asks once
and says exactly what it destroys: *annotations keep their model provenance; only this
configuration is removed.*

Above twenty rows the list grows a filter, which matches a name substring and keeps saying how
many it hid.

**Reached from the editor, too.** Arming the editor's suggest tool with no usable connection shows
a panel naming what is missing and offering **Set up a connection**, which lands here. Nothing
about that flow forces you out of the editor or loses work: the panel is an explanation with a
door, and the door is optional — a host that wires no destination gets the explanation and no
control.

## At a terminal

```bash
visionset inference size some/model --revision abc123
visionset inference create local-detector \
    --type local --model some/model --revision abc123 --device cuda --precision fp16
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
| `INFERENCE_CONNECTION_NOT_SET_UP` | 409 | Asked to predict before its weights were fetched — run `download` |
| `INFERENCE_CONNECTION_INVALID` | 422 | The parameters do not describe a usable connection of that kind |
| `INVALID_NAME` | 422 | The name is blank once stripped |
| `UNSUPPORTED_PROMPT` | 422 | The model does not answer that way of asking |
| `LOCAL_INFERENCE_UNAVAILABLE` | 500 | The `local-inference` extra is not installed; the message carries the command |
| `INFERENCE_CONNECTION_NOT_RUNNABLE` | 500 | This build has no adapter for that kind of connection |

The last two are 5xx because they are conditions of the *installation* rather than of the request:
no state you can change and no retry makes either succeed, so neither is a 409. Both expose their
message, because the message is the remedy — which is the same licence a missing `ffmpeg` gets.
