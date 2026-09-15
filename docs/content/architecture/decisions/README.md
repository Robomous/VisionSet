# Decisions

Most of this section describes the system's shape as it stands. These pages describe
*constraints* - rules that hold across more than one layer, that cost something to keep, and
that a reasonable contributor could undo by accident because the code alone does not explain
why they are there.

A page belongs here when all three are true:

- **it binds code that exists.** A decision about work nobody has started is a plan, and plans
  are not documentation.
- **it rules something out.** If nothing is forbidden, there is no decision to record - there
  is a description, and descriptions belong on the layer's own page.
- **the code cannot say it.** A rule a test, an import contract or a type can enforce is
  enforced there instead. This tree is the residue: the rules only prose can hold.

Each page states the rule, what it forbids, and what would go wrong without it. None of them
restate behavior, and where a topic has an authoritative page elsewhere they link to it.

## Interactive suggestions

Four constraints hold the boundary between a model the VisionSet server runs and a model a
browser runs. They were written together, and they are easiest to read in this order.

| Page | The rule |
| --- | --- |
| [A connection is not a browser](a-connection-is-not-a-browser.md) | `ConnectionType.LOCAL` means *on the server machine*, and never *in this browser*. |
| [Browser inference is host-injected](browser-inference-is-host-injected.md) | The reusable UI declares a port for running a model here; it never chooses an implementation. |
| [Asking is not sending](asking-is-not-sending.md) | Requesting a suggestion and posting it to a route are separate concerns, and the answer has one shape either way. |
| [Where a model runs is not where it came from](where-a-model-runs-is-not-where-it-came-from.md) | `ModelOrigin` describes provenance. It never implies an execution location. |
