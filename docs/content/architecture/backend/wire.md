# wire

[`src/visionset/wire/`](../../../../src/visionset/wire/) is one hand-written JSON
projection per resource. The CLI uses these projections for `--json` output,
MCP uses them for tool results, and the thumbnail backfill handler uses one
for its persisted result.

## Two spellings, not three

```mermaid
flowchart LR
    Domain["kernel domain models"]
    Wire["visionset.wire\nplain dicts"]
    Models["server/models.py\npydantic"]
    Cli["cli --json"]
    Mcp["mcp tool results"]
    Rest["REST responses"]
    Spec["openapi.json"]

    Domain --> Wire
    Domain --> Models
    Wire --> Cli
    Wire --> Mcp
    Models --> Rest
    Models --> Spec
    Wire <-.->|same keys\ntests/cli/test_json_contract.py| Models
```

The server keeps its own pydantic models because `openapi.json` is generated from
them and a dict cannot do that. So there are two spellings of each shape - and
**two, never three**: this package exists because the CLI and MCP both needed the
same resource projections, and a second hand-written copy is what "promoted, not
copied" exists to prevent.

The two are held to each other by
[`tests/cli/test_json_contract.py`](../../../../tests/cli/test_json_contract.py),
which imports both and asserts each pair has the same keys *and* that the
projection round-trips through the wire model. A test may import what neither
package may.

## A field reaches a caller because somebody wrote it here

Nothing calls `model_dump()` on a domain model. That would publish whatever the
domain happens to hold today and silently republish whatever it holds tomorrow.
Three fields make the case, and each is deliberately absent from what ships:

- `Asset.uri` and `Source.locator` are absolute paths on the machine running the
  server. A caller reading one learns the layout of somebody's disk.
- `Batch.asset_ids` is a batch's whole roll call, which for fifty thousand frames
  must not travel on every read of its name.

Leaf encoding is explicit throughout: UUIDs as strings, enums as `.value`, paths
as strings, timestamps in pydantic's format so the parity gate compares like with
like.

Most projections read kernel domain values. Format matrix projections read
evidence from `visionset.formats`. Inference projections read plans and resolve
capabilities and output geometries through `visionset.inference`, which owns the
installed provider registry.

## Where it sits

The `Kernel purity` contract forbids `visionset.kernel` importing
`visionset.wire`. It is not a delivery mechanism, but it is the same direction:
it is written in terms of domain models, so a kernel that could import it would
close a loop and make a publication decision reachable from the place that decides
what exists.

The shared-library import contract keeps `wire` below the delivery packages.
The contract test can import both `wire` and `server/models.py` to compare their
public shapes.

## Related

[`docs/content/cli.md`](../../cli.md) documents what `--json` promises.
[`docs/content/api.md`](../../api.md) documents the REST spelling of the same shapes.
