# cli

[`src/visionset/cli/`](../../../../src/visionset/cli/) is Typer over the kernel. Its
commands cover project and schema setup, ingest, batch and job management,
promotion, publishing, and export. A command can record annotation progress or
run model pre-labeling. Use the browser, REST API, or MCP to create or edit labels
interactively.

## The shape of a command

```mermaid
flowchart LR
    Argv["argv"] --> Cmd["command\nparses, resolves the workspace"]
    Cmd --> Svc["kernel service calls"]
    Svc --> Ok{"accepted?"}
    Ok -->|yes| Out["stdout: the datum\nstderr: the prose"]
    Ok -->|no| Err["_errors.py\nsentence on stderr, exit code\n--json: the refusal on stdout"]
```

Two rules make the output composable, and both are held by tests:

- **stdout is data, stderr is prose.** `BATCH=$(visionset ingest …)` works because
  the id is the only thing on stdout; everything a person reads goes to stderr.
- **`--json` is the API's shape.** The projections come from
  [`visionset.wire`](wire.md), not from a second set of dicts written here, so a
  caller moves between `curl | jq` and `visionset --json | jq` without relearning
  field names.

## Exit codes

Three, and one of them carries two meanings deliberately - `visionset release
verify` and `visionset export --check` both use `1` for *the check ran and the
answer is no*, which is distinct from *the command failed*. Both meanings are
written down in [`_errors.py`](../../../../src/visionset/cli/_errors.py).

## What it may depend on

The `Delivery clients are siblings` contract forbids `visionset.cli` importing
`visionset.server` or `visionset.mcp`. Anything two surfaces need is promoted
downward instead - which is the whole reason [`visionset.wire`](wire.md) is its own
package rather than a `cli/_json.py`.

Resolving a format name to an exporter plugin happens *here*, not in the kernel:
`visionset.formats.registry.pick(installed, name)` for a format and the port's
`resolve_target` for a target, never a dict lookup, because a `KeyError` is outside
the `VisionSetError` tree and would answer a typo with a traceback. The
pre-processing drivers an export applies are resolved the same way, through
`visionset.preprocessing.registry`.

## Related

[`docs/content/cli.md`](../../cli.md) is the command reference: the whole cycle as a
script, what `--json` promises, why `--workspace` follows the subcommand, and what
`visionset init` and `visionset server` each do.
