---
name: nodejs-setup
description: >
  Frontend environment for the VisionSet pnpm workspace. Node.js 24, corepack/pnpm, per-package
  and recursive scripts.
  Trigger: When setting up the frontend environment, installing packages, adding a workspace
  package, or running frontend build/test/lint scripts.
license: Apache-2.0
metadata:
  author: robomous
  version: "1.0"
  scope: [frontend]
  auto_invoke: "Setting up frontend environment or installing packages"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, WebFetch, WebSearch, Task
---

## Environment

- **Node.js 24**. With nvm on the host: `nvm use 24`.
- **pnpm** only (never npm, never yarn). Pinned via `packageManager` in the root
  `package.json` — enable it with `corepack enable`.
- Single **pnpm workspace** rooted at the repo root; members are `frontend/*`
  (`@visionset/annotator`, `@visionset/ui-core`, `@visionset/app`).
- Run commands **from the repo root**.

## Commands

```bash
pnpm install                     # install the whole workspace

pnpm -r build                    # build every package (topological order)
pnpm -r test                     # vitest where defined
pnpm -r lint                     # eslint

pnpm --filter @visionset/app dev            # Vite dev server
pnpm --filter @visionset/annotator test     # one package
pnpm --filter @visionset/ui-core build

pnpm version:sync                # propagate repo-root VERSION into frontend/*/package.json
pnpm bundle:static               # place the built app into src/visionset/_static/
```

## Dependencies

```bash
pnpm --filter @visionset/app add <pkg>          # runtime dep of one package
pnpm --filter @visionset/ui-core add -D <pkg>   # dev dep of one package
pnpm add -w -D <pkg>                            # root tooling only
```

- Cross-package references use the workspace protocol: `"@visionset/annotator": "workspace:*"`.
- `@visionset/annotator` keeps `react` as an **optional peer dependency** — never promote it to
  a hard dependency; the core must stay usable without React.
- `@visionset/ui-core` UI primitives are **Radix + lucide only**. Do not add another component
  library.
- `@visionset/app` is `private: true` — never published to npm; its bundle ships inside the
  Python wheel.

## Versions

Never hand-edit a `version` field. The repo-root `VERSION` file is the source of truth;
`pnpm version:sync` converts it to npm semver (`0.1.0.dev0` → `0.1.0-dev.0`).

## Before you say it works

`pnpm -r build && pnpm -r test && pnpm -r lint` from the root. Report failures verbatim.
