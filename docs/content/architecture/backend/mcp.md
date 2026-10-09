# mcp

[`src/visionset/mcp/`](../../../../src/visionset/mcp/) is the surface an agent uses.
It speaks MCP over stdio, and it is the fourth client of the same kernel - every
tool is a thin mapping onto one or two service calls.

## Registration is a table

```mermaid
flowchart TB
    Main["main.py\nthe registration table"]
    Guard["guarded()\nwraps every body"]
    Doc["inspect.cleandoc\ndescription="]
    Ann["ToolAnnotations\nread / write hints"]
    Tools["projects · schemas · sources · batches\njobs · assets · annotations\ndatasets · releases · formats · preprocessing · inference"]
    Dtools["DESTRUCTIVE_TOOLS\nregistered only on request"]

    Main --> Guard
    Main --> Doc
    Main --> Ann
    Main --> Tools
    Main -.->|--allow-destructive| Dtools
```

Registration happens in one table in
[`main.py`](../../../../src/visionset/mcp/main.py) rather than as a decorator at each
definition site. That is not style: `@server.tool()` inside `projects.py` would
make that module import `main`, which imports it. Doing it in one place also gives
the three cross-cutting decisions exactly one home - the error wrapper, the
cleaned docstring that becomes the tool description, and the read/write
annotations - and lets
[`tests/mcp/test_registration.py`](../../../../tests/mcp/test_registration.py) assert
that every registered tool went through all three.

## The destructive posture

Tools that destroy something are **not registered** unless the server was started
with `--allow-destructive`. The reason is measured rather than theoretical: when
the caller is a model, a `confirm=True` parameter is documented in the same
listing the caller reads before choosing, so the description that explains the
gate is also the instruction for clearing it. Moving the gate to the server's own
startup puts it somewhere the agent cannot reach.

`confirm` itself is untouched and stays correct for every other surface.

## The error envelope

An agent both reads and decides, so it gets the kernel's own sentence **and** the
machine-readable fields:

```json
{"error": {"message": "…", "retry_with": "allow_destructive", "hint": null, "index": null,
           "code": "DESTRUCTIVE_SCHEMA_CHANGE", "detail": {"classes": ["car"]}}}
```

`code` and `detail` are what REST answers for the same refusal, read from the
kernel's [`error_codes.py`](../../../../src/visionset/kernel/error_codes.py) -
this package may not import `server/errors.py`, under the `Delivery clients are
siblings` contract, so the table lives below all three surfaces. The question an
agent most often has, *may I retry this, and with what?*, is still answered
directly by `RETRY_WITH` in
[`_errors.py`](../../../../src/visionset/mcp/_errors.py).

## Two generated artifacts

- [`docs/content/mcp-tools.md`](../../mcp-tools.md) is written from the tool listing the
  server actually advertises, by `scripts/export_mcp_tools.py`. A hand-written
  reference would be a second copy of an interface an agent reads verbatim.
- [`tests/architecture/test_capability_reachability.py`](../../../../tests/architecture/test_capability_reachability.py)
  resolves every declared batch action against the real routing table *and* the
  real tool listing, so a capability the wire declares cannot be unperformable.

## Related

[`docs/content/mcp.md`](../../mcp.md) is the surface itself - every tool and what it is
for, the coordinate-frame rule, the three gate words, and the stated limits.
[`docs/content/mcp-walkthrough.md`](../../mcp-walkthrough.md) is a session start to finish.
