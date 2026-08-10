# Architecture

VisionSet is an SDK with clients attached. There is one Python package that knows
what a dataset *is*, and everything a person or a program can touch — the REST
API, the CLI, the MCP server, the browser — is a thin translation layer over it.
Reading the code in that order is the fastest way to understand it, and this tree
is written to be walked that way: start here, then follow whichever branch you are
about to work in.

These pages describe *shape* — what each layer is, what it may depend on, and
where the rule is enforced. They do not restate behaviour. Where a topic has an
authoritative page under [`docs/`](../README.md) or a skill under
`.agents/skills/`, this tree links to it rather than paraphrasing it, because a
restated rule is a rule that goes stale silently.

## The system

```mermaid
flowchart TB
    Browser["Browser<br/>@visionset/app"]
    Agent["Agent<br/>MCP client"]
    Shell["Shell<br/>visionset CLI"]
    Program["Program<br/>import visionset"]

    subgraph Distribution["Python distribution — pip install visionset"]
        Server["visionset.server<br/>FastAPI"]
        Cli["visionset.cli<br/>Typer"]
        Mcp["visionset.mcp<br/>MCP tools"]
        Kernel["visionset.kernel<br/>domain · ports · services"]
        Adapters["kernel.adapters<br/>SQLite · filesystem · Pillow · ffmpeg"]
    end

    Store[("Workspace<br/>one directory, one SQLite file")]

    Browser --> Server
    Agent --> Mcp
    Shell --> Cli
    Program --> Kernel
    Server --> Kernel
    Cli --> Kernel
    Mcp --> Kernel
    Kernel --> Adapters
    Adapters --> Store
```

Every arrow points one way. The kernel never imports a surface, and the surfaces
never import each other — both are checked by import-linter contracts in
[`pyproject.toml`](../../pyproject.toml) and by a fresh-process test in
[`tests/architecture/`](../../tests/architecture/).

## The two halves

| Half | Lives in | Ships as | Page |
| --- | --- | --- | --- |
| Python distribution | [`src/visionset/`](../../src/visionset/) | a `pip` wheel | [backend/](backend/README.md) |
| Frontend workspace | [`frontend/`](../../frontend/) | npm packages, and a bundle inside the wheel | [frontend/](frontend/README.md) |

The browser is not a separate product. `visionset server` serves the compiled
bundle from `src/visionset/_static/` under `/app`, so one `pip install` is the
whole thing.

## Where to go next

- [backend/](backend/README.md) — the layer stack, and a page per package.
- [frontend/](frontend/README.md) — the three workspace packages and how they
  depend on each other.
- [cross-cutting.md](cross-cutting.md) — the two machine-enforced boundaries, the
  capabilities contract, and the batch lifecycle at a glance.

For what the system *does* rather than how it is arranged, the index at
[`docs/README.md`](../README.md) is the map. [`DESIGN.md`](../../DESIGN.md) is the
visual contract, and [`CONTRIBUTING.md`](../../CONTRIBUTING.md) lists the checks.
