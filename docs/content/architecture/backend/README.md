# The backend

The Python distribution in [`src/visionset/`](../../../../src/visionset/) contains
ten packages. They are not peers. The core defines the domain, the next layer
makes that domain usable by callers, and the outer layer exposes protocols.

## The stack

```mermaid
flowchart TB
    subgraph Surfaces["Delivery surfaces — one protocol each, no logic"]
        Server["server\nREST"]
        Cli["cli\nterminal"]
        Mcp["mcp\nagents"]
    end

    subgraph Composition["Composition — shared by every surface"]
        Wire["wire\nJSON shapes"]
        Jobs["jobs\nbackground handlers"]
        Inference["inference\nmodel adapters"]
        Formats["formats\nexporter plugins"]
        Preprocessing["preprocessing\npixel drivers"]
        Tracking["tracking\nexperiment tracking"]
    end

    Kernel["kernel\ndomain · ports · services · adapters"]

    Server --> Wire
    Cli --> Wire
    Mcp --> Wire
    Server --> Jobs
    Server --> Formats
    Cli --> Formats
    Jobs --> Formats
    Jobs --> Inference
    Server --> Preprocessing
    Cli --> Preprocessing
    Mcp --> Preprocessing
    Jobs --> Preprocessing
    Server --> Kernel
    Cli --> Kernel
    Mcp --> Kernel
    Wire --> Kernel
    Jobs --> Kernel
    Inference --> Kernel
    Formats --> Kernel
    Preprocessing --> Kernel
    Tracking --> Kernel
```

Read the diagram as a dependency graph: an arrow is "may import". Nothing points
upward, and the three surfaces do not point at each other.

## The packages

| Package | What it is | Page |
| --- | --- | --- |
| [`kernel`](../../../../src/visionset/kernel/) | The domain, the ports, the services, and the default adapters. Everything else is a client of it. | [kernel.md](kernel.md) |
| [`server`](../../../../src/visionset/server/) | FastAPI. Routes, wire models, and the error mapping. | [server.md](server.md) |
| [`cli`](../../../../src/visionset/cli/) | Typer. The whole cycle from a shell. | [cli.md](cli.md) |
| [`mcp`](../../../../src/visionset/mcp/) | The MCP tool surface, for agents. | [mcp.md](mcp.md) |
| [`formats`](../../../../src/visionset/formats/) | Exporter and importer plugins, discovered by entry point. | [formats.md](formats.md) |
| [`preprocessing`](../../../../src/visionset/preprocessing/) | Pre-processing drivers - the Pillow resize and augmentation engines behind the `PreprocessingDriver` port - discovered over the `visionset.preprocessing` entry-point group the way exporters are. | [preprocessing-drivers.md](preprocessing-drivers.md) |
| [`wire`](../../../../src/visionset/wire/) | The JSON shapes the CLI and MCP publish. | [wire.md](wire.md) |
| [`jobs`](../../../../src/visionset/jobs/) | Handlers for work that outlives a request. | [jobs.md](jobs.md) |
| [`inference`](../../../../src/visionset/inference/) | Where a model connection becomes a running model, and which model families could run next. | [inference.md](inference.md) |
| [`tracking`](../../../../src/visionset/tracking/) | Optional MLflow experiment tracking: a neutral `Tracker`, a no-op default, and an MLflow client imported only when tracking is enabled. | [tracking.md](../../tracking.md) |

## What the rules are, and where they live

Eight import-linter contracts in [`pyproject.toml`](../../../../pyproject.toml) hold
the graph above. They are run by `uv run lint-imports`, which
[`scripts/check.sh`](../../../../scripts/check.sh) invokes.

| Contract | What it forbids |
| --- | --- |
| Kernel purity | `visionset.kernel` importing `server`, `cli`, `mcp`, `formats`, `wire`, `jobs`, `inference`, `preprocessing`, `tracking`, or `fastapi` / `typer` / `mcp` / `uvicorn` / `mlflow` |
| Delivery clients are siblings | `server`, `cli` and `mcp` importing each other |
| Job handlers are below the surfaces | `visionset.jobs` importing any delivery package or web framework (`fastapi` / `typer` / `mcp` / `uvicorn`) |
| Inference adapters are below the surfaces | `visionset.inference` importing any delivery package, web framework (`fastapi` / `typer` / `mcp` / `uvicorn`), or `visionset.jobs` |
| Tracking is below the surfaces | `visionset.tracking` importing any delivery package, `jobs`, `inference`, `formats`, `preprocessing`, `wire`, `kernel.services`, `kernel.adapters`, or `fastapi` / `starlette` / `typer` / `click` / `mcp` / `uvicorn` |
| Shared libraries are below the surfaces | `wire`, `formats` and `preprocessing` importing `server`, `cli`, `mcp`, or `fastapi` / `starlette` / `typer` / `click` / `mcp` / `uvicorn` |
| Shared libraries never touch the database driver | `wire`, `formats`, `preprocessing` and `tracking` importing `sqlalchemy` directly |
| Format plugins never reach a workspace | `formats` importing `visionset.kernel.services` or `visionset.kernel.adapters` directly - an importer reads a directory and returns a value |

The first is the load-bearing one, and it has a second enforcement:
[`tests/architecture/test_kernel_purity.py`](../../../../tests/architecture/test_kernel_purity.py)
imports the kernel in a **fresh interpreter** and asserts no forbidden module
appears in `sys.modules`. A static contract can be satisfied by a deferred import
inside a function; a fresh-process check cannot.

If a change fights one of these, the change is wrong - see
[cross-cutting.md](../cross-cutting.md) for why the boundary sits where it does, and
[kernel.md](kernel.md) for what belongs on each side of it.
