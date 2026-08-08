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

**Over HTTP:** `GET`/`POST /inference/connections`, and
`GET`/`PATCH`/`DELETE /inference/connections/{connection_id}`. `PATCH` edits in place and leaves
out what you omit; `DELETE` needs no confirmation, for the reason below.

## Each kind carries its own parameters, and only its own

A local connection needs a device and a precision; an HTTP one needs an endpoint. Both halves of
that rule are enforced: a local connection may not carry an `endpoint_url` either. A row holding
both would leave a later reader — and a later adapter — with no way to tell which field to
believe.

The kind itself cannot be changed after creation. Switching `local` to `http` would empty every
parameter the row carries and keep only its name, which is a new connection wearing an old id.

## What a connection is not

It is **not a credential store**, yet. An HTTP connection carries no secret today, and the field
is absent rather than nullable: where such a secret should live is an open decision, and a column
added "for later" would answer it by default.

It is **not a model runner**. This layer knows the configuration; running a model is an adapter's
job, and the kernel imports no inference stack at all. A connection can be configured on a
machine that could not possibly run it — which is exactly what you want when the thing that runs
it is somewhere else.

## Deleting one destroys a configuration, not work

Annotations record the model that produced them by **copying** its identity onto the label when
it is written. Nothing anywhere holds a key back to a connection row. So deleting one is an
ordinary delete with no cascade and no confirmation gate: annotations keep their model
provenance, and only this configuration is removed.

That is also why a connection has no lifecycle to speak of — it is a form somebody filled in, and
the remedy for a wrong one is to edit it or make another.

## At a terminal

```bash
visionset inference create local-detector \
    --type local --model some/model --revision abc123 --device cuda --precision fp16
visionset inference list
visionset inference show local-detector --json
visionset inference update local-detector --revision def456
visionset inference delete local-detector --yes
```

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
| `INFERENCE_CONNECTION_INVALID` | 422 | The parameters do not describe a usable connection of that kind |
| `INVALID_NAME` | 422 | The name is blank once stripped |
