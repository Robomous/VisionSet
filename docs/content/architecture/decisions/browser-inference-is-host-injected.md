# Browser inference is host-injected

[`@visionset/ui-core`](../frontend/ui-core.md) declares a narrow port for running a model in
the browser and carries it through a React provider. It never selects an implementation, never
imports one, and works unchanged when no host supplies one.

This is the third seam of the same kind, and deliberately the same shape as the other two:
`data/port.ts` for the data client, `media/port.ts` for browser video import, and
`inference/browserPort.ts` for running a suggestion on this device.

## Absence is ordinary

`useBrowserInferenceRuntime()` answers `null` when no host supplied a runtime, and never
throws. That follows the rule already running the navigation callbacks and the media runtime:
**a host that cannot honor a control passes nothing and gets no control, rather than a dead
one.** A build with no browser runtime renders no local target, the same way a screen with no
`onOpenProject` renders no link.

`useApiClient()` throws on absence because every screen in the package assumes a data client
exists - there is no legitimate path without one. A browser runtime has no such unconditional
caller. It is missing whenever the host does not offer it, which is an expected state and not a
composition bug, so there is one nullable hook and no second asserting variant beside it.

## Why the port stays narrow

The port names two things: which targets can answer right now, and how to ask one of them. It
names no execution backend, no model format, no artifact source and no acquisition mechanism.

Those belong to whatever package implements it. A port that mentioned them would put an
implementation's vocabulary into the reusable UI's public type, which is how a seam stops being
a seam: the next implementation has to either adopt the first one's assumptions or break the
contract. Keeping it to two members costs nothing to widen later - a host implementing today's
port keeps working when a member is added - and cannot be narrowed at all once published.

## What this forbids

- `@visionset/ui-core` importing a model runtime, an execution backend, or any concrete
  adapter;
- resolving or discovering an implementation inside `@visionset/ui-core`;
- a default implementation shipped behind a flag, which is the same coupling with a switch on
  it;
- treating a missing runtime as an error state, a warning, or anything a user sees;
- execution-backend or artifact-source vocabulary appearing on the port's types.

## Where it lives

```text
frontend/ui-core/src/inference/browserPort.ts                     the port
frontend/ui-core/src/inference/VisionSetBrowserInferenceProvider.tsx   provider + nullable hook
```

The host composes it, the same place it composes the data client and the media runtime:
`frontend/app/src/data/OssSession.tsx`.
