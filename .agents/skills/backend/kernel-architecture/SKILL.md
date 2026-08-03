---
name: kernel-architecture
description: >
  VisionSet hexagonal architecture: what belongs in kernel/ vs server/, cli/, mcp/, formats/,
  the machine-enforced import boundaries, and how to add a port, an adapter, or a format plugin.
  Trigger: When adding or moving Python modules, designing domain models or ports, writing a
  FastAPI route / Typer command / MCP tool, or when an import contract fails.
license: Apache-2.0
metadata:
  author: robomous
  version: "1.0"
  scope: [root, backend]
  auto_invoke:
    - "Adding or moving modules under src/visionset/"
    - "Writing a FastAPI route, Typer command, or MCP tool"
    - "Fixing a lint-imports / architecture test failure"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, WebFetch, WebSearch, Task
---

## The shape

```
src/visionset/
  kernel/     domain models + ports (Protocols) + default adapters — framework-free
  server/     FastAPI. Thin: parse -> call SDK -> serialize
  cli/        Typer. Thin: parse -> call SDK -> print
  mcp/        MCP stdio server. Thin: tool -> SDK call
  formats/    importer/exporter plugins, discovered via the `visionset.formats` entry point
  _static/    compiled UI bundle, injected at build time
```

Every surface (UI, CLI, MCP, REST) is a **thin client of the same SDK**. If a behavior exists
in only one of them, it is in the wrong place.

## Two rules the machine enforces

1. **Kernel purity** — `visionset.kernel` must never import `visionset.server`,
   `visionset.cli`, `visionset.mcp`, `visionset.formats`, nor `fastapi` / `typer` / `mcp` /
   `uvicorn`. Enforced by import-linter contracts in `pyproject.toml` **and** a fresh-process
   test under `tests/architecture/`.
2. **Delivery clients are siblings** — `server`, `cli`, and `mcp` never import each other.
   Shared logic moves down into the kernel, never sideways.

```bash
uv run lint-imports        # both contracts
uv run pytest tests/architecture
```

**If a change fights either boundary, the change is wrong — not the boundary.** Never relax a
contract in `pyproject.toml` to make a build pass; restructure instead.

## Where does this code go?

| You are writing… | It goes in |
| --- | --- |
| A concept with invariants (Dataset, Annotation, Label) | `kernel/domain/` as a pydantic v2 model |
| A use case / orchestration ("import a dataset") | `kernel/` service — callable from every surface |
| An interface to the outside world (storage, repo, clock, ids) | `kernel/ports/` as a `Protocol` |
| A concrete implementation of a port (filesystem, sqlite, uuid4) | `kernel/adapters/` |
| HTTP shape: routes, request/response models, status codes | `server/` |
| A `visionset ...` subcommand, flags, human output | `cli/` |
| An MCP tool declaration and its mapping | `mcp/` |
| Reading/writing COCO, YOLO, … | `formats/` + an entry point |

Rule of thumb: **if it would still make sense with no HTTP, no terminal, and no LLM, it belongs
in the kernel.**

## Adding a port

1. Define the `Protocol` in `kernel/ports/` — narrow, domain-worded (`ImageStore`, not
   `S3Client`), fully typed, no framework types in the signature.
2. Ship a default adapter in `kernel/adapters/` so local-first works with zero configuration.
3. Inject it — constructor parameter with a default, never a module-level singleton and never
   an import from a delivery module.
4. Test against the Protocol with a fake; the default adapter gets its own test.

## Adding a format plugin

- Implement the importer/exporter under `formats/`.
- Register it in `pyproject.toml` under `[project.entry-points."visionset.formats"]`.
- Discovery goes through `importlib.metadata` — never a hardcoded registry, never an
  `if fmt == "coco"` chain. Third-party distributions (`visionset-format-x`) register into the
  same group; anything that breaks that breaks the plugin promise.
- A change to the plugin surface ships with a test proving discoverability via
  `importlib.metadata`.

## Delivery-layer discipline

- A route/command/tool body should read as: validate input → call one SDK function → shape the
  output. Business logic in a route is a bug.
- `openapi.json` at the repo root is a **committed contract** consumed by the generated TS
  client. After changing routes or response models:
  `uv run python scripts/export_openapi.py` and commit the diff.
- Errors: raise domain errors from the kernel; translate them to HTTP status / exit codes at
  the boundary. The kernel never raises `HTTPException`.
