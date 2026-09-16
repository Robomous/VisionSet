# Where a model runs is not where it came from

`ModelOrigin` says where a model came from. It says nothing about where it executes, and no
surface may treat it as though it did.

## Two axes

```text
origin      where the artifact came from
execution   what machine runs it
```

They are independent. An artifact of any origin could in principle be run by the VisionSet
server or by a browser, and the same artifact can be both in two different deployments.
Collapsing them produces a rule that is right for today's rows and wrong for the next one - the
worst kind, because nothing fails until someone adds a model that breaks it.

## The same mistake, already made once

This is not hypothetical here. `usableConnection()` once selected a connection by asking only
whether it was ready. A workspace whose one ready connection answered text prompts therefore
sent every point-prompt click to it, and the server refused each one truthfully: a tool offered
where it could never work, one refusal at a time.

The fix was to read the declared capability instead of inferring it. Reading an origin as an
execution location is the same inference with a different field, and it fails the same way.

## What this forbids

- reading any `ModelOrigin` member as a statement about where execution happens;
- deriving an execution location from a model id, a model reference, or a name;
- a type whose members mix the two axes, so that one field must answer both questions;
- offering or withholding a control based on origin when the real question is capability - see
  the [capabilities contract](../backend/inference.md).

## What to read instead

Ask the thing that knows. Whether the server can do something is the connection's declared
capability. Whether this browser can do something is the host's runtime, which either offers a
target or does not - see
[browser inference is host-injected](browser-inference-is-host-injected.md). Neither answer is
guessed from an identifier.

Provenance on a saved annotation is the model's own identity, and stays stable whichever
machine produced it. That is deliberate: an annotation outlives the runtime that made it, and
two machines running the same model should attribute it identically.
