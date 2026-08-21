# Cross-cutting

Three things run through every layer. Each has an authoritative home elsewhere;
this page says what they are and points at it.

## The two machine-enforced boundaries

Everything else in this repository is a convention. These two are checked, and a
change that fights one is wrong - the boundary does not move to make a build pass.

### Kernel purity

`visionset.kernel` never imports `visionset.server`, `visionset.cli`,
`visionset.mcp`, `visionset.formats`, `visionset.wire`, `visionset.jobs` or
`visionset.inference`, nor `fastapi`, `typer`, `mcp` or `uvicorn`.

- **Contract** - `[[tool.importlinter.contracts]]` in
  [`pyproject.toml`](../../../pyproject.toml), run by `uv run lint-imports`.
- **Second check** -
  [`tests/architecture/test_kernel_purity.py`](../../../tests/architecture/test_kernel_purity.py)
  imports the kernel in a fresh interpreter and inspects `sys.modules`, which is
  what a deferred import inside a function cannot satisfy.
- **Why it is drawn there** - [backend/kernel.md](backend/kernel.md).

### The headless annotator

`frontend/annotator/src/core/` never imports React and never reaches the DOM.

- **Three gates**, all run by `pnpm --filter @visionset/annotator lint`: ESLint
  `no-restricted-imports` and `no-restricted-globals` scoped to `src/core/`, plus
  `tsconfig.core.json` - a `noEmit` pass compiling the shipped engine with no DOM
  `lib` and no ambient `@types`, and the only one of the three that can see a DOM
  type in a *signature*.
- **Second check** -
  [`tests/scripts/annotator_boundary.test.mjs`](../../../tests/scripts/annotator_boundary.test.mjs)
  proves each gate fires by breaking it.
- **Why it is drawn there** - [frontend/annotator.md](frontend/annotator.md).

## The capabilities contract

The kernel answers *what may be asked of this resource, right now*, and every
surface publishes that answer as `allowed_actions`. A client renders what the wire
declares and computes nothing.

```mermaid
flowchart LR
    Tables["domain tables\nBATCH_TRANSITIONS · BATCH_GATES\nASSET_PROGRESS_TRANSITIONS"]
    Cap["kernel/domain/capabilities.py\nbatch_actions · job_actions · asset_actions"]
    Wire["allowed_actions on the wire"]
    Client["a control, or none"]
    Service["the service gate"]

    Tables --> Cap
    Tables --> Service
    Cap --> Wire
    Wire --> Client
    Client -->|the call| Service
```

Both arrows into `Service` read the *same* tables, which is the whole point: a
declaration and a refusal cannot disagree, because neither is a second encoding of
the rule.

Two consequences follow, and both are load-bearing:

- **A client may not mirror a state table.** A hand-written `canSkip` reproduces
  one dimension and drops another, and the dropped dimension is invisible until a
  user meets it.
- **A declared action obliges every client to offer it.** So a name lands on the
  wire only in the same change as the route, the tool and the control that honour
  it. [`tests/architecture/test_capability_reachability.py`](../../../tests/architecture/test_capability_reachability.py)
  resolves every declared batch action against the real routing table and the real
  MCP listing.

The authority is
[`kernel/domain/capabilities.py`](../../../src/visionset/kernel/domain/capabilities.py)
and the [`ui-capabilities`](../../../.agents/skills/frontend/ui-capabilities/SKILL.md)
skill, which also bans the two antipatterns this contract exists to remove.

## The batch lifecycle, at a glance

Three state machines, and they do not cascade - each is derived separately.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> draft
    draft --> approved: approve — freezes membership, pins the schema, cuts jobs
    approved --> in_annotation: start
    in_annotation --> completed: complete — derived, once every job is settled
    completed --> [*]
```

An asset inside one has its own five states:

```mermaid
stateDiagram-v2
    direction LR
    unannotated --> annotated
    unannotated --> skipped
    annotated --> review_pending
    annotated --> skipped
    annotated --> unannotated
    skipped --> unannotated
    review_pending --> accepted
    review_pending --> annotated
    accepted --> [*]
```

And a job runs `pending → in_progress → completed`.

The trap worth knowing before touching any of it: **a job completing does not
complete its batch.** `BatchService` derives that separately, so the ordinary
state of a finished job is *inside an open batch* - which is why writes are gated
on the job as well as on the batch, and why `asset_actions` reads all three
dimensions.

There is no route back from `completed`, at any level. Correcting finished work is
a new batch, not a reopened one.

The settled model - and it *is* settled, not to be re-litigated in an
implementation task - is the
[`batch-lifecycle`](../../../.agents/skills/domain/batch-lifecycle/SKILL.md) skill.
[`docs/batches.md`](../batches.md) and [`docs/jobs.md`](../jobs.md) are the
behavioural pages.
