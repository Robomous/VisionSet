# The inference worker is persistent

[`@visionset/browser-inference`](../frontend/browser-inference.md) creates **one** worker per
runtime handle and keeps it from `createInferenceRuntime()` until `dispose()`. Every loaded graph
lives in that worker for the whole of that span. This is the opposite of the choice
[`@visionset/media`](../frontend/media.md) makes, and the difference is deliberate rather than
inconsistent.

## Why media terminates and inference does not

A video import is one long, self-contained job. Mediabunny's adapter spawns a worker, decodes,
and terminates - and termination is the cheapest and most complete cleanup available, because
nothing about that decode is worth keeping afterwards.

Inference is the other shape. Everything expensive about it is state that exists *between*
operations:

- an ONNX Runtime session costs hundreds of milliseconds to create, and holds compiled kernels
  and, on the WebGPU path, device resources;
- a segmentation model is two sessions - an encoder and a decoder - and both have to stay
  loaded;
- refining a prompt is supposed to re-run only the decoder, against an image embedding the
  encoder already produced.

A worker that ended with each operation would discard all three on every click, and the
interaction that makes browser suggestion worth having - a second point landing in tens of
milliseconds rather than seconds - would not exist. So the worker outlives the operation, and
the cost is that disposal is now something the runtime has to get right rather than something
termination does for free.

## What that costs, and who pays it

Persistence means pending work exists at moments the caller does not control, so the runtime
owns three obligations a per-operation worker never has:

- **every asynchronous request carries an operation id**, and a reply is routed by looking that
  id up in a table of pending operations;
- **a reply whose id is not in that table is dropped, silently.** That single rule is what makes
  cancellation, late replies and post-disposal traffic safe - there is no second guard, because
  each of them is the same situation seen from a different angle;
- **disposal settles everything.** Outstanding operations reject rather than hanging, and nothing
  can resolve afterwards;
- **a failure the worker cannot come back from must be terminal, not just reported.** A worker
  that ended with the operation could let its caller start over with a fresh one by construction;
  a persistent worker that failed silently mid-life and kept accepting new work would hang every
  later caller instead. A channel-level crash or a `configure` failure moves the runtime into a
  permanent failed state: everything pending rejects with it, and every later `loadGraph()` and
  `run()` rejects with the same error immediately, without touching the worker again. `ready()`
  is the one thing it does not retract, because `ready()` answers what initialization decided
  rather than whether the runtime is usable now;
- **the worker is stopped exactly once.** Disposal, a channel crash and a configuration failure
  all end in a stopped worker, and any two of them can happen in either order - so whichever
  arrives first stops it and the rest do nothing, rather than each being trusted to know what
  the others already did;
- **cancellation bookkeeping must not outlive the operation it names.** Operation ids are minted
  once and never reused for the life of a persistent worker, so any record kept past its
  operation is kept forever. Two rules bound it: a `cancel` is remembered only while the worker
  still owns that id - which is what makes the main thread's `cancel` racing a `result` it
  already sent a no-op - and every way out of an operation, success and failure alike, drops
  that id from both its records.

## An operation id is not a suggestion serial

Both exist. They look alike and they are not interchangeable.

| | Protects | Lives in | Spans |
| --- | --- | --- | --- |
| Runtime operation id | **routing** - that a promise settles with its own answer | `@visionset/browser-inference` | one worker request |
| Suggestion serial | **editor state** - that a stale answer cannot overwrite a newer one on screen | `@visionset/annotator` session state | one editing session |

A perfectly routed answer can still be stale on screen: the user clicked again while it was in
flight, and the runtime has no way to know that. Collapsing the two would mean either the runtime
reading editor state or the editor trusting the transport to have opinions about freshness, and
both are wrong. See [asking is not sending](asking-is-not-sending.md) for the boundary the serial
sits behind.

## The package stays framework-free

`@visionset/browser-inference` depends on no VisionSet package - not
[`ui-core`](../frontend/ui-core.md), not `annotator`, not `media` - and on no framework. It does
**not** implement `VisionSetBrowserInferenceRuntime`, the port
[`ui-core` declares](browser-inference-is-host-injected.md), and the omission is the point:
that interface is `ui-core`'s, so implementing it here would make the runtime depend on the
package that is supposed to be injected *with* runtimes. A host that has both adapts one to the
other; that is what a host is for.

## What this forbids

- terminating the worker between operations, or spawning one per operation;
- settling a promise on anything other than an id match;
- a `cancel` that leaves its caller waiting for the worker to acknowledge it;
- an automatic worker restart after a terminal failure, silent or otherwise;
- a worker-side cancellation record that outlives the operation it names;
- reusing the suggestion serial as a transport identifier, or the reverse;
- a dependency from this package on `@visionset/ui-core`, `@visionset/annotator` or a UI
  framework;
- building the worker from a string, a `blob:` URL or anything else a host's content-security
  policy is entitled to refuse.

## What would have to change to revisit it

Evidence that sessions are cheap to recreate - a runtime that compiles in single-digit
milliseconds, or a model small enough that reloading it is free. Until then, the expensive thing
is the state, and the state needs somewhere to live.
