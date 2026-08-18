# Inference connections

VisionSet never downloads a model automatically. Predictions use a **connection** that you
create. This workspace configuration identifies the model, its revision, and where it runs.
Installing the package downloads no model data, and creating a connection only writes a row;
it does not access the network.

A new workspace has no connections and therefore cannot make predictions. Opening, upgrading,
or leaving the workspace running does not create one.

Two kinds exist today:

- **`local`** - weights this machine runs. It carries a `device` and a `precision`, and it is
  born **not set up**, because the weights are not here yet. Fetching them is an explicit action
  you take later, with the size shown before you agree to it.
- **`http`** - an endpoint that answers this project's own inference contract. It carries an
  `endpoint_url`, and it is born **ready**, because there is nothing to set up on this machine.
  Whether it *answers* is a separate question with a fresh answer every time it is asked, so it
  is not stored on the row.

The model reference is a pair - an id and a **pinned revision**, both required. A moving pointer
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
        precision="fp16",  # fp16 needs a cuda device; cpu and mps connections are fp32
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
both would leave a later reader - and a later adapter - with no way to tell which field to
believe.

The kind itself cannot be changed after creation. Switching `local` to `http` would empty every
parameter the row carries and keep only its name, which is a new connection wearing an old id.

## Running a model here needs the `local-inference` extra

The auto-labeling feature is always present. What is optional is the runtime that executes a model
*on this machine*:

```bash
pip install "visionset[local-inference]"
```

It brings torch, torchvision, transformers, accelerate and huggingface_hub - roughly two
gigabytes, most of it CUDA - which is why it is not in the base install. Without it you can create a local connection,
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
what its host needs. Both share the stack's `workspace-data/`, so switching between them - or back
to the plain file - keeps projects, connections and downloaded weights; only the api image changes,
and `--build` is not optional on any of those switches. That stack is for development and changes
nothing about the wheel above.

`HF_TOKEN` is forwarded from whoever runs `docker compose`, so fetching weights that have to be
asked for (below) works the same way inside the stack as outside it - export it in the shell you
bring the stack up in. It is empty when you have none, which is what every ungated model already
expects.

## Knowing what a download costs, before agreeing to it

A decision you cannot see the price of is not a decision, so the size is readable on its own,
ahead of anything being fetched:

```bash
visionset inference size facebook/sam2.1-hiera-base-plus --revision b7320756a133
```

It prints the byte count on stdout and the file count on stderr, and `--json` gives the document
the API answers with. Over HTTP it is
`GET /inference/download-size?model_id=…&model_revision=…`.

This reads the publishing hub's **file listing** - names and byte counts - and downloads nothing.
It takes a model and a revision rather than a connection, because the moment the number is wanted
is usually the moment before a connection exists; the same call answers for a connection that
already has one.

**Every file in the revision is counted**, because fetching takes the whole snapshot. A repository
publishing two serialisations of the same tensors really does cost both, and a figure counting one
of them would understate what lands on your disk. A revision the listing cannot fully size is
refused rather than estimated.

`facebook/sam3` is the live example of that and the largest entry in the curated list: it publishes
its weights as both a checkpoint and safetensors, so about 6.9 GB arrives to install a model of
about 3.4 GB. The number shown is the one that describes your disk.

It needs the `local-inference` extra, because the size is read with the same client that would do
the fetching. Without it you get `LOCAL_INFERENCE_UNAVAILABLE` and the install command.

## Fetching weights

Nothing arrives on your behalf: not at install, not at startup, not on the way to anything else.
Weights arrive when you ask for them, and asking is one action.

```bash
visionset inference download local-detector
```

Over HTTP it is `POST /inference/connections/{id}/download`, which answers `202` with a background
job and a `Location` header naming it - the same launch-and-poll contract an export uses. Poll
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
present - so a download that dies partway leaves it exactly as it was, at `not_set_up`, with the
error on the job. There is no half-ready state to recover from because there is no moment at which
one could be written. Ask again: an interrupted transfer resumes from what it had, and each file
that arrives is checked against the size the hub published for it before it is put in place.

**Some models have to be asked for first.** A publisher can put its weights behind an access gate,
where the files are served only to accounts that have been granted them. `facebook/sam3` is one:
its weights are under Meta's SAM License and access is granted by request. Two steps, once per
machine rather than once per connection - ask for access on the model's own page, then put a token
from that account in the environment the server or the CLI runs in:

```bash
export HF_TOKEN=hf_…
```

The token is read by the hub client itself, so there is nothing to configure in a workspace and
nothing stored in one. A download attempted without it fails with a sentence naming both halves of
the remedy rather than an HTTP status. Reading a model's **size** needs no token and no access:
that is what lets the connection form tell you what a download costs before you decide whether to
go and ask for it.

The gate is on fetching, never on running. Once the files are in a workspace's `models/`, the model
loads and answers clicks with no token present at all - which is what makes a workspace you copy to
another machine still work there.

**Asking again checks rather than repeats.** `download_weights` stays available once a connection
is `ready`, where the same call re-checks that the snapshot is still complete and fetches only what
is missing - the browser labels it **Check for missing files** and puts it in the row's overflow
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

The two states stay the only two throughout. A check that cannot reach the hub - no network, a
repository that moved - changes nothing and removes nothing: there are no published digests to
compare against, and that is an absence of evidence rather than a verdict in either direction.

## Asking twice while one is running

**A second request joins the run already in flight.** Ask for a download while this connection has
one queued or running and the answer is that job - the same `202`, the same `Location`, the id of
the transfer already going - rather than a second transfer of the same gigabytes. A check behaves
the same way. So a double-click, a second tab and a retried request all end up watching one run,
which is what they wanted in the first place.

It removes the ordinary repetition rather than winning a race: two requests arriving at the same
instant can still both find nothing running and both queue. Closing that would mean the queue
claiming work at the moment it is asked for, which is a cost every kind of background job would
pay for this one screen's benefit.

**The browser withdraws the offer while either run is live.** All three controls over a
connection's files grey out and say what is happening - *Downloading…*, *Checking…*, *Reading every
file…* - because they act on one cache. The flag is read off the connection rather than remembered
by the tab that pressed the button, so a second tab and a colleague's browser withdraw it too.

**Nothing is refused, though.** What a connection declares in `allowed_actions` is a function of
its setup state and its kind, and no run of either sort changes either one: a download requested
while a check reads the same files is accepted and queued. That is deliberate. A refusal would have
to be built on a job row being live, and **only the HTTP surface makes one** - the CLI and the MCP
tools run the same two operations inline, because neither has a dispatcher to hand the work to. So
the rule would bind one caller in three while claiming an exclusivity none of them could rely on.
It would also strand a connection behind actions it refuses whenever a worker died holding a job -
the failure `sweep_orphans` exists to clear up rather than one to design around.

At a terminal, and through an MCP tool, each call blocks until it is done, so one shell or one
agent serialises itself. Two of them, or either beside the server, do not coordinate: nothing here
makes a download and a check over one cache impossible, only unlikely to be asked for by accident.

## Pointing a connection somewhere else

Editing a local connection's `model_id` or `model_revision` puts it back to `not_set_up`. The
weights on your disk are the weights of the model it used to name, and `setup_state` answers *are
the weights here* - so leaving it `ready` would have it claim to be set up over files nothing ever
fetched. It forgets what kind of model it holds at the same time, and for the same reason.

**The remedy is the ordinary one.** The row offers **Download weights** again, and the cache is
keyed by model rather than by connection: the previous model's files are left where they are, so
pointing a connection back at something it used to name costs a cache hit instead of a second
transfer. Editing anything else - the name, the device, the precision - changes neither the state
nor the family, and neither does sending the same model reference back unchanged.

An `http` connection keeps no weights here, so a model edit resets nothing for it. It stays
`ready`, which for that kind has always meant *there is nothing to set up on this machine*.

## Which device runs the model

A local connection names the device it runs on, and there are three to name.

| Device | What it is | Precision |
| --- | --- | --- |
| `cpu` | The processor. Every machine has one, and it is the default a new connection opens on | `fp32` |
| `cuda` | An NVIDIA GPU. A machine with more than one addresses the rest as `cuda:1`, `cuda:2` and so on | `fp16` or `fp32` |
| `mps` | Apple Silicon's GPU, on an M-series Mac. There is only ever one of it | `fp32` |

**On Apple Silicon nothing needs configuring beyond choosing the device.** The `local-inference`
extra is the same one everybody installs, the macOS wheels it brings carry Metal support already,
and there is no second package index, no environment variable and no build flag. Create the
connection with `mps` and it runs on the GPU.

**A device this machine does not offer falls back to the CPU**, in full precision, with a warning
in the log naming the connection and the device it asked for. The same rule covers all three, so
`mps` on a machine with no Metal behaves exactly as `cuda` on a machine with no NVIDIA GPU. It is a
fallback rather than a preference - a workspace configured on a workstation should still open on a
laptop - but it is slower by a large factor, which is why it is said out loud rather than silently
done.

**A device that is there and full is a different answer.** Falling back covers a device this
machine does not have; it cannot cover one that exists and does not have the memory for the model
you chose, which is what a large checkpoint on a small GPU runs into. That surfaces as
`INFERENCE_OUT_OF_MEMORY` at the moment of the run - the load is lazy, so the first prediction is
where you meet it - and the message names the device that filled up and the ways off it: a smaller
model from the curated list, the same connection moved to `cpu`, or whatever else is holding the
device released. On the CPU the middle remedy is left out, because there is nowhere further to go.

**A run on a GPU can also exhaust the machine's own memory rather than the card's**, because the
images are decoded and the tensors built on the host before anything moves to the device, and the
result is copied back the same way. The message says which of the two ran out, and the remedies
differ: a host shortage is answered by a smaller model or by freeing memory on the machine, and
moving that connection to `cpu` is named as the thing *not* to do, because it puts the weights in
the memory that just ran out. Exhausting the machine's memory outside the model - decoding a very
large image, say - is not this error at all, and arrives as an internal one.

**Half precision applies on CUDA only**, and the kernel says so rather than absorbing it: a `cpu`
or `mps` connection asking for `fp16` is refused at creation. On a CPU it was never the
conservative choice it looks like - `float16` arithmetic outside CUDA's autocast is slower than the
`float32` it was avoiding - and Metal has no float64 at all with a bfloat16 that varies between
releases, so full precision is the only format that behaves the same on every Mac. A setting the
adapters would drop is one the row would otherwise go on displaying as though it had an effect.

Where Metal has no implementation for an operator a model reaches for, that one operator runs on
the CPU and the rest of the forward pass stays on the GPU. Nothing has to be turned on for this;
the adapters ask for it themselves.

**Both fields are closed vocabularies.** `device` is `cpu`, `mps`, `cuda`, or `cuda:N` for the
second GPU on a machine that has one; `precision` is `fp16` or `fp32`, and `float16`, `half`,
`float32` and `full` are accepted as spellings of those two. Anything else is refused with a
sentence naming the members. What this closes is a gap rather than a freedom: `gpu` used to be
accepted and then resolved onto the CPU, so the connection described a run that never happened.
A device is in the vocabulary when the adapters can honour it, which is why `mps` is in it and
`gpu` and `auto` are not.

## What a connection can be asked for

A connection row says where a model runs and whether its weights are here. Neither answers the
question a caller has to settle *before* asking: does this model take the kind of prompt I am
about to send? So a connection also declares what it can be asked for.

```json
{ "setup_state": "ready", "capabilities": ["point_suggest"], … }
```

| Capability | Means |
| --- | --- |
| `point_suggest` | Give me the thing under these points |
| `text_detect` | Find everything these words name |

**The vocabulary is closed and the set of models answering to it is not.** These two are the
whole of what a connection can declare, and each exists because a surface renders it. Which
*model families* answer to them belongs to this installation rather than to this release: a
driver declares the families it serves and what each may be asked for, and drivers are found
through an entry-point group, so one somebody `pip`-installed serves families this repository
has never heard of. What this distribution ships serves the SAM 2 and SAM 3 families for
`point_suggest` and the Grounding DINO families for `text_detect`.

**Read from the model, never from its name.** The value comes from the `model_type` the
downloaded config declares - the same fact that decides which adapter runs it, so a model that
runs and a model that declares are the same list. Matching on a model id would answer confidently
for every model this build has never heard of, and the wrongness would only surface as a refusal
deep in a request.

**Empty means nothing is known yet**, which happens four ways: the weights were never fetched, so
nothing has read a config; the config declared no model type; it declared one no installed driver
serves; or it is an `http` connection, whose model runs elsewhere and which declares nothing
until the remote contract says how an endpoint states what it can do. Empty is not a refusal -
the server still judges every request on its own. It says only that no tool can rely on this
connection.

**It is recorded when the weights arrive**, because that is the first moment it is knowable
without reaching a network. Editing a connection to point at another model or revision clears it
again - nothing has read the new one, and a stale answer reads exactly like a fresh one - and
takes the setup state with it, for the same reason: see [Pointing a connection somewhere
else](#pointing-a-connection-somewhere-else). A connection created before this shipped acquires
its answer the first time something reads it, from files already on your disk.

## Suggesting a shape from a click

A connection whose model answers *places* rather than *words* - one declaring `point_suggest` -
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
  "confidence": 0.87,
  "regions": [
    {
      "geometry": {"type": "polygon", "points": [[404.0, 221.0], …]},
      "contour": [[404.0, 221.0], …]
    }
  ],
  "applied": {"detail": "balanced"},
  "parameters": ["detail"]
}
```

**Points are in the asset's own pixels**, the same frame every geometry in a project uses.
`positive` says *this*; `negative` says *not that*, which is how an over-eager first answer gets
carved back without starting over. Refining means sending the accumulated points again, not a
diff - the call keeps no state about your gesture, so the same points always answer the same way.

**Every point has to be on the asset**, positive and negative alike: `x` in `[0, width]` and `y`
in `[0, height]`, both ends included. One point outside refuses the whole request with 422
`PROMPT_POINT_OUT_OF_BOUNDS`, naming the coordinate you sent and the size of the asset. Nothing is
clamped and nothing is dropped, because both would answer a question you did not ask - a
segmenter handed a coordinate off the picture still returns a mask, with a confidence attached,
and that confidence is about nowhere.

**`allowed_geometries` is bounded by your schema, and chosen within it.** The answer comes back
in one of the kinds you named or not at all: name `polygon` and you get the outline; name only
`bbox` and you get that outline's extent; name a kind that holds no shape and `region` is `null`.
Every kind you send must be one the class admits — answering in a kind your schema would refuse
would hand you a suggestion that cannot be accepted.

**Which of them to send is yours to decide, and it matters**, because this route prefers the
polygon whenever both are named. A class accepting a box *and* a polygon, asked for both, always
comes back as a polygon. If your user is holding a box tool, send `["bbox"]` alone — sending both
answers past the tool they are holding, with nothing on their screen to say so. The annotator's
own client does exactly this (`suggestGeometriesFor`, narrowed through the same resolution the
tool strip reads).

**An empty `regions` is a successful answer with nothing to propose** - a click on empty
background, a model less sure than you asked for, or a shape too thin to be a polygon. `model_ref` is still there, because it is what an accepted suggestion has to
carry, and so is `parameters`, because a caller that adjusted its way into an empty answer needs
the controls to adjust its way back out.

`confidence` is one number for the whole answer rather than one per shape. The model scored one
mask; the pieces cut out of it are that same claim seen in parts, and a separate number for each
would be precision nobody expressed.

## What happens to the mask, and the one thing you can move

A segmenter answers with a grid of booleans. Turning that into a polygon or a box is a fixed
chain, and the whole of it happens here rather than inside whatever ran the model - so a second
segmenter inherits it instead of reimplementing it, and none of these settings ever reaches the
model.

1. **Which pieces** of the mask become shapes.
2. **Closing the gaps** in them that are narrower than a reach.
3. **Tracing** the boundary of what is left.
4. **Simplifying** that boundary to a vertex count somebody can edit.

The geometry branch happens after the second step: a polygon class takes steps 3 and 4 on the
piece you pointed at, a box class takes one extent over every piece that survived. A box
therefore does not move when `detail` does.

| Setting | What it moves | Applies to |
| --- | --- | --- |
| `detail` | `coarse`, `balanced` or `fine` - how much of the outline survives | polygon |

It is optional, and omitting it gives what this route always gave: `balanced`.

**Two settings used to be here and are not** (#557). How wide a gap gets closed and how many
pieces become shapes are still decided, at fixed defaults nobody asks for. As controls they
did nothing at all to the ordinary single clean mask - every position gave an identical
shape - so they read as knobs wired to nothing, and could only be got wrong on the unusual
one. Their value is in the default rather than in the choice. They come back as settings if
a real need for the choice appears.

**The tolerance is relative, which is what makes one setting work everywhere.** It is a fraction
of the region's own size rather than a pixel count, so it does the same thing to a thing eight
pixels across and a thing eight hundred across, and `balanced` keeps a typical object in the
10-40 vertex range.

**Specks are dropped first, and a click never becomes a cleanup job.** A mask routinely carries
more than one separate piece - a scrap of antialiasing along an edge, a reflection, a patch of
the same colour elsewhere - and anything under a twentieth of the largest piece is discarded
before anything else looks at the mask.

**A polygon is the piece you pointed at, not the biggest one on the frame.** Which of the
survivors you meant is a question only the points can answer, so the choice is made from the
prompt: a point inside a piece picks that piece; several points inside several pieces pick the
largest of *those*, because two positives describe one object rather than propose two; and a
point inside none of them picks the piece nearest to it, since a mask need not cover the exact
pixel you clicked. Negative points never select - they say what the shape is not, and a piece is
chosen before its shape is known.

Picking whichever piece happened to own the topmost-leftmost lit pixel would be a different rule
and a worse one: that is a fact about where the speckle fell, not about what you asked for.

**A box is one box over every surviving piece.** A point prompt means *this object*, and a mask
that arrives in several pieces is nearly always one object seen around an occlusion - a railing
across an animal, a post in front of a car. Both alternatives are wrong in exactly that case:
the largest piece alone cuts the object off at the occlusion, and a box per piece annotates one
thing twice.

**`parameters` says which settings apply here**, for the kind of shape your `allowed_geometries`
will produce. A box has no outline, so `detail` has nothing to do to one and the list comes back
**empty** - which is how a client is told to offer no adjustments at all. A client renders what
this lists and works none of it out for itself.

**Closing gaps is not filling enclosed holes**, and the distinction is worth stating because the
obvious reading is the other one. Boundary tracing walks a shape's *outer* ring and a polygon is
one ring with no interior, so an enclosed hole is invisible to the answer - filling an 8x8 hole
in a 20x20 square moves the mask and leaves the traced outline byte-identical. What the close
does reach is the notches and bays a segmenter bites out of an edge, which are exactly what
makes an outline ragged. Its reach grows with the piece and stops at a few pixels: past that, a
gap is a feature of the shape rather than an artefact of tracing it.

**`contour` is the outline the shape was reduced from**, in the asset's own pixels, and it is
there so a client can re-run `detail` without asking again. It is the same points the server
reduced, which matters:
simplification is not nested, so a client starting from anything else could not be held to the
server's answer. A box carries none, because it is an extent rather than something reduced from
anything.

**`regions` is a list that holds at most one shape today.** One click asks about one object, and
both geometries now answer with one. The plural shape is kept rather than collapsed because
accepting *part* of a plural proposal is real planned work - it needs a selection the preview
does not have - tracked as *accepting part of a plural suggestion* (#548). Where several are
proposed they are written together as one entry in the undo history.

### Nothing is written, and the first click is the slow one

Asking is not annotating. The response is a proposal: turning it into an annotation is an ordinary
annotation write that carries `provenance: model`, this response's `model_ref` and its
`confidence`. Discarding it costs nothing, because nothing was recorded.

A segmenter reads the whole image once and then answers any number of clicks from that reading, so
the **first** call for an asset pays for the encode and the ones after it do not. That cached
reading is the only thing the call leaves behind - an optimisation, not a record. It lives in the
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

## The built-in stand-in, and what it is for

One model id is served without downloading anything: `visionset/stub-segmenter`, at any revision.
It answers a point prompt with a square centred on the click. It is not a model, it predicts
nothing, and no dataset should contain its output.

It exists so the path between a click and a shape can be exercised without weights. Set one up as
a custom-model local connection and the suggest tool works end to end - the form, the download
action, the connection's lifecycle, the request, the mask pipeline and the editor - which is what
you want when you are asking *is my setup working, or is it the model?*. It also needs neither the
`local-inference` extra nor a network, so it answers on a base install where nothing else can.

It is deliberately absent from the model list. Nobody choosing a model should be offered a
segmenter that cannot segment; typing the id is the whole of how you reach it.

This is the same decision as the `dummy` export format, and taken for the same reason.

## What a connection is not

It is **not a credential store**, yet. An HTTP connection carries no secret today, and the field
is absent rather than nullable: where such a secret should live is an open decision, and a column
added "for later" would answer it by default.

It is **not a model runner**. This layer knows the configuration; running a model is an adapter's
job, and the kernel imports no inference stack at all. A connection can be configured on a
machine that could not possibly run it - which is exactly what you want when the thing that runs
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

That is also why a connection has no lifecycle to speak of - it is a form somebody filled in, and
the remedy for a wrong one is to edit it or make another.

## The Inference section

Connections live behind **Inference** in the rail, beside Home and Projects. It is a top-level
destination rather than something inside a project because a connection belongs to the
*workspace*: it carries no project id, and every project uses the same ones.

A workspace with none says so and offers one thing - **Add connection**. Creating one is two
steps, because the two kinds share almost no fields: first where the model runs, then that kind's
form.

- **Local** opens on an offered model, a `cpu` device and `fp32` precision. What the model field
  lists belongs to *this installation* rather than to this release: every installed driver
  declares the checkpoints it offers by name, the form asks the server for them, and a driver
  somebody `pip`-installed is offered here without this repository knowing it exists. The headings
  are the abilities - *Interactive segmentation*, *Text-prompt detection* - because a driver says
  which question its model answers and never how that question is named on screen. Each entry
  carries its id, one line on what it is for, and the commit the driver that offers it pinned; no
  size, because what a download costs is read live for the exact pair, and a number frozen into a
  list would be a second answer to a question already answered accurately. **Custom model...** is
  the last entry and reveals the free model id and revision fields: the list guides, it does not
  restrict, and any model this build has an adapter for remains typeable. Device and precision are
  lists too, and the precision list follows the device, because half precision applies on CUDA
  only - so picking `mps` leaves `fp32` as the only precision offered. Underneath is what fetching
  the chosen pair would cost, read while you are still deciding. An entry whose weights have to be
  asked for says so on the line above that one, with a link to the page where access is requested,
  so the requirement is read while the model is being chosen rather than met as a refused download
  later. If this machine has no `local-inference` extra the size cannot be read, and the form says
  so, in the server's own words, with the install command. **It stays usable**: creating a
  connection downloads nothing, so not knowing the size is information rather than a barrier.
- **HTTP** asks for the endpoint URL. There is no credential field; where a secret would live is
  still open (`cf. #421`), and a field added ahead of that answer would be answering it.

Because that list is a request rather than a constant, the model field has four states and says
which one it is in. While the answer is in flight it says it is reading, and puts nothing else in
that space: a disabled grey select is a question the interface refuses to answer, and a free model
id field would be asking somebody to answer one the server has not answered yet. A refusal is
rendered as prose, in the server's own words, with another attempt beside it. An installation that
offers nothing by name is invited to install a driver rather than shown an empty list. Those last
two leave the free model id and revision fields on screen, because a model id typed by hand needs
no list at all - a catalog that could not be read is no reason to stop a connection being
configured.

Each row shows its name, its kind, `model @ revision`, and its status as a word - **Ready** or
**Not set up** - beside a colour, never as a colour alone. A local row that is not set up carries
**Download weights**, which launches the background job described above and reports its progress
in place; the row becomes **Ready** when the job finishes, without a reload. A row that is already
ready carries two checks in its overflow menu instead - **Check for missing files**, which is the
same request re-run, and **Check files are undamaged**, which reads every byte. The table above is
what separates them. A machine without the extra still shows both controls, and pressing either
answers with the install command - a control that vanished would take the remedy with it. While
either run is under way all three are disabled and labelled with what is happening, for the reason
above: they act on one cache, and the run is read off the row, so a tab that started nothing shows
it too.

A failed download leaves the row at **Not set up**, because weights arrive or they do not, and says
what happened in the job's own words with what to do about it. There is no separate retry button:
**Download weights** is the retry. A failed *integrity* check leaves the row at **Not set up** for a
different reason - the damaged files were removed and the connection stood down before the row said
so - and the retry is the same **Download weights**, which now has to fetch them again for real.

Editing does not offer to change the kind, because the kind is not editable. Saving an edit that
moves a local row to another model or revision returns it to **Not set up** in place, with
**Download weights** as the next step - the files on the disk belong to the model it was pointing
at before. Deleting asks once and says exactly what it destroys: *annotations keep their model
provenance; only this configuration is removed.*

Above twenty rows the list grows a filter, which matches a name substring and keeps saying how
many it hid.

**Reached from the editor, too.** Arming the editor's suggest tool with no usable connection shows
a panel naming what is missing and offering **Set up a connection**, which lands here. Nothing
about that flow forces you out of the editor or loses work: the panel is an explanation with a
door, and the door is optional - a host that wires no destination gets the explanation and no
control.

*No usable connection* covers one case more than it reads: a workspace can hold a connection that
is configured, downloaded and running, and still have nothing that can answer a click, because
the model it holds answers words. The panel says which of the two it is - nothing set up, nothing
downloaded, or nothing of the right kind - and each names a different thing to do.

## At a terminal

```bash
visionset inference size some/model --revision abc123
visionset inference create local-detector \
    --type local --model some/model --revision abc123 --device cuda --precision fp16
# --device takes cpu, mps, cuda or cuda:N; --precision takes fp16 or fp32, and fp16 needs a cuda device
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

A connection is addressed by **name or id** wherever one is taken - names are unique in a
workspace, compared without regard to case, so `local` and `Local` cannot name two of them.

## Errors

| Code | Status | Means |
| --- | --- | --- |
| `INFERENCE_CONNECTION_NOT_FOUND` | 404 | No connection with that id or name in this workspace |
| `INFERENCE_CONNECTION_NAME_TAKEN` | 409 | Another connection already holds that name |
| `INFERENCE_CONNECTION_NOT_DOWNLOADABLE` | 409 | Already set up, or a kind with no weights of its own |
| `INFERENCE_CONNECTION_NOT_CHECKABLE` | 409 | A kind with no weights of its own, or weights that are not here yet - run `download` |
| `WEIGHTS_DAMAGED` | 409 | An integrity check found files that do not match; they were removed and the connection stood down |
| `INFERENCE_CONNECTION_NOT_SET_UP` | 409 | Asked to predict before its weights were fetched - run `download` |
| `INFERENCE_CONNECTION_INVALID` | 422 | The parameters do not describe a usable connection of that kind |
| `INVALID_NAME` | 422 | The name is blank once stripped |
| `UNSUPPORTED_PROMPT` | 422 | The model does not answer that way of asking |
| `PROMPT_POINT_OUT_OF_BOUNDS` | 422 | A suggest point falls outside the asset; the message names the coordinate and the size |
| `LOCAL_INFERENCE_UNAVAILABLE` | 500 | The `local-inference` extra is not installed; the message carries the command |
| `INFERENCE_CONNECTION_NOT_RUNNABLE` | 500 | This build has no adapter for that kind of connection |
| `INFERENCE_OUT_OF_MEMORY` | 500 | The device ran out of memory loading or running the model; the message names the device and what to do about it |

The last three are 5xx because they are conditions of the *machine* rather than of the request:
none of them is a fact about what you sent, so none is a 409. The first two never succeed until
somebody installs something; the third can succeed on a retry, but only after you free the device
or choose a smaller model - which is why its message names both. All three expose their message,
because the message is the remedy - which is the same licence a missing `ffmpeg` gets.
