---
name: annotator-core
description: >
  The headless boundary of @visionset/annotator: pure-TS interaction state machine, geometry and
  input in src/core/, React (and any other renderer) confined to src/adapters/.
  Trigger: When adding or changing annotation behavior, canvas interaction, geometry, undo/redo,
  or an annotator render adapter — and when the "no React in core" ESLint rule fires.
license: Apache-2.0
metadata:
  author: robomous
  version: "1.0"
  scope: [frontend]
  auto_invoke:
    - "Changing annotation/canvas interaction behavior"
    - "Adding or modifying an annotator render adapter"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, WebFetch, WebSearch, Task
---

## The shape

```
frontend/annotator/src/
  core/           pure TypeScript — no React, no DOM globals
    types.ts        the wire contract, mirrored exactly (annotations, schema, asset)
    wire.ts         unknown in, typed out — plus the outbound create/update projections
    ids.ts          the IdFactory port; core cannot mint a uuid, `crypto` is a host global
    _fixture.ts     test harness (kernel-written fixture loader) — excluded from the build
    geometry/       math: clamp, hit-testing, transforms
    input/          normalized pointer/keyboard events -> intents
    state/          document.ts + selection.ts + commandLog.ts (undo/redo)
  adapters/
    ids.ts          randomUuid — a host capability, not a renderer
    react/          AnnotatorCanvas and friends — the only place React exists
  index.ts        public entry point
```

**The document** (`state/document.ts`) is `AnnotationDocument`: an asset, a schema, and
`ReadonlyMap<string, Annotation>`. Immutable — every operation returns a new one. Never named
`Document` (a host global). Annotations are addressed by UUID, never by index.

**Selection** (`state/selection.ts`) is a `ReadonlySet<string>` held *beside* the document and
**filtered on read**, never pruned on write. That is what makes it survive undo/redo with no
coordination: undoing a delete makes the annotation resolve again, still selected. Do not move
selection into the document, and do not add an eager prune.

The document refuses only its own invariants — duplicate id, unknown id, foreign asset. Kernel
rules (class↔geometry agreement, required attributes, bounds) stay the kernel's; the tools refuse at
draw time, where a user can be told.

## The rules the machine enforces

`src/core/**` must not import React and must not reach the DOM. Three gates, the frontend mirror
of the backend's import-linter kernel contracts, all run by
`pnpm --filter @visionset/annotator lint`:

| Gate | Where | Scope | Catches |
| --- | --- | --- | --- |
| `no-restricted-imports` | `eslint.config.js` | `src/core/**` | `react`, `react-dom`, `react-*` |
| `no-restricted-globals` | `eslint.config.js` | `src/core/**`, **tests included** | `document`, `window`, `navigator`, `requestAnimationFrame`, … as **values** |
| `tsconfig.core.json` | its own file | `src/core/**` **minus** `*.test.ts` | DOM **types in signatures** (`KeyboardEvent`, `SVGSVGElement`), plus `setTimeout` / `console` / `fetch` in shipping code |

Two ESLint rules and a compiler pass because each reaches where the others cannot. A lint rule
reports *value* references, so `getSvgSize(svg: SVGSVGElement)` passes it — that is what the
DOM-free `lib` is for. Conversely the type gate excludes the vitest harness, which legitimately
runs under Node and reads a kernel-written fixture through `node:fs`; admitting it would take
`types: ["node"]`, and @types/node re-declares `setTimeout`, `console` and `fetch`, so buying the
tests would cost the timer ban on the engine. The ESLint half covers those files instead.

`tests/scripts/annotator_boundary.test.mjs` proves all three fire, and pins the two traps: `jsx:
"preserve"` in `tsconfig.core.json` is load-bearing (`jsx: "react-jsx"` imports
`react/jsx-runtime`'s types into every file, dragging in @types/react's empty `interface
KeyboardEvent {}` DOM stand-ins), and a type-gate probe must live inside the package, because from
`os.tmpdir()` nothing resolves `node_modules` and the probe fails for the wrong reason.

**If a change fights the boundary, the change is wrong — not the boundary.** Do not add an
eslint-disable, do not widen a rule's file scope, do not put `DOM` back in the `lib`.

When a gate fires, the fix is one of:

- The logic is renderer-agnostic → keep it in `core/`, drop the React import or the DOM reference
  (take values as arguments, return plain data).
- The logic is genuinely about rendering → move it to `adapters/react/`.
- The signature wanted a DOM type for its *shape* → define the shape in `core/` as a plain
  interface. That is what the input layer's normalized events are for; a DOM type in a core
  signature is the leak this gate exists to stop.

## Writing core logic

- Pure functions and explicit state transitions. No hidden globals, no `window`/`document`
  access, no timers owned by core — the adapter supplies those.
- Input arrives as normalized events; core returns intents/state, never DOM mutations.
- Every mutating action goes through the command log so undo/redo stays a core capability, not
  an adapter feature.
- Deterministic: same input sequence → same state. That is what makes it testable and what will
  let 3D/point-cloud modes reuse it later.

## Writing an adapter

An adapter only: subscribes to core state, paints it, and forwards normalized input back. It
holds no annotation logic of its own. React is the first adapter, not the only intended one —
anything it "knows" that core doesn't will not survive the second renderer.

## Tests

Core is unit-tested with **vitest** and needs no DOM:

```bash
pnpm --filter @visionset/annotator test
pnpm --filter @visionset/annotator lint   # all three headless boundary gates
```

The wire mirror is proved against `tests/fixtures/wire_annotations.json`, which
`scripts/export_wire_fixtures.py` writes from the same pydantic models `openapi.json` comes from —
it carries the asset, the schema and the annotations a document is built from. Never hand-write a
TypeScript copy of a kernel shape: extend the exporter and regenerate
(`uv run python scripts/export_wire_fixtures.py`), which both gates then hold in step.

`lint` is `eslint src` plus two compiler passes — `typecheck` (the whole package, tests included)
and `typecheck:core` (the boundary). Either is runnable on its own by name.

New interaction behavior ships with a core test that drives the state machine directly.
