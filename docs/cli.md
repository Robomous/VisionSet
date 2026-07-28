# The command line

`visionset` is a thin client of the SDK, exactly like the REST API and the MCP server. It calls
the kernel in-process — there is no HTTP hop, and no command reaches a capability the SDK does not
already have.

```
visionset --version
visionset ui           [--host] [--port] [--reload] [--workspace]
visionset token create --name NAME [--workspace]
visionset token list   [--workspace]
visionset token revoke NAME [--yes] [--workspace]
visionset mcp          # not implemented yet
```

## Three exit codes, and no others

| | Meaning |
| --- | --- |
| **0** | the command did what it said |
| **1** | a domain refusal — one sentence on stderr, no traceback |
| **2** | a usage error, raised and formatted by Click itself |

One non-zero code for the whole `VisionSetError` family, rather than a table mapping each error to
its own. That is the deliberate difference from [the REST surface](api.md), where a client branches
on a machine-readable `code` because it is a program; a shell branches on zero versus non-zero, and
a person reads the sentence.

Where the kernel's own message names a Python API — `NotAWorkspace` ends in "use
`WorkspaceService.init` to create one" — the CLI adds a second line naming something a terminal can
actually do. It does not rewrite the kernel's sentence: bending a domain message toward one surface
is how the other surfaces end up with the wrong wording.

```
$ visionset ui
Error: /tmp is not a VisionSet workspace (no visionset.db); use WorkspaceService.init to create one
Point at one with --workspace, or set VISIONSET_WORKSPACE.
$ echo $?
1
```

Only `VisionSetError` is caught. An `OSError`, a `KeyboardInterrupt` or a bug keeps its traceback,
because folding one into `Error: [Errno 2] ...` would hide the thing that identifies it.

## Stdout is data; stderr is everything a person reads

```bash
TOKEN=$(visionset token create --name ci)     # exactly the secret, nothing else
visionset token list | tail -n +2             # the rows without the header
```

The secret goes to stdout alone; the "shown once" warning goes to stderr, so it survives that
redirection and is still seen. `token list` prints a header even with zero rows, so `tail -n +2` is
stable, and it names its three columns one at a time rather than dumping the model — a field added
to `Token` cannot leak into output nobody re-read.

Plain columns, never `rich.table`: box drawing pads to `$COLUMNS` and wraps, which makes output
width-dependent and neither testable nor `cut`-able.

## `--workspace` comes after the subcommand

`--workspace` / `-w` is declared on **each command**, not on the root callback, and that is a Click
fact rather than a preference. A group's parser stops at the first non-option token, so an option on
the callback would have to *precede* the subcommand — `visionset --workspace X token create --name
ci` would work and `visionset token create --name ci --workspace X` would fail with "No such
option". Nobody types the first one.

Which workspace a command lands in, when the flag is absent, is
[one rule shared by every surface](workspaces.md#which-workspace-when-nobody-said): the flag, then
`VISIONSET_WORKSPACE`, then the nearest workspace at or above the working directory, then the
working directory. **Only that third case walks upward.** A flag and an environment variable are
somebody *stating* which workspace, and trading a stated directory for its parent is how a
credential gets minted into the wrong one.

## `visionset ui`

Starts the server against the resolved workspace, serving the REST API at the root and the compiled
UI bundle at `/ui`; `/` redirects to the app.

```
$ visionset ui
VisionSet 0.0.1.dev0
  workspace   /home/you/datasets/robots
  UI and API  http://127.0.0.1:8000/
  API token   visionset token create --name <name>
Press Ctrl+C to stop.
```

| Flag | Default | |
| --- | --- | --- |
| `--host` | `127.0.0.1` | Loopback, not `0.0.0.0`. VisionSet is local-first and tokens are minted by hand, so a default that exposed a freshly created — and therefore un-tokened — workspace to the local network would be a decision nobody made. |
| `--port` | `8000` | Matches `docker/compose.yaml`. |
| `--reload` | off | Development. Restarts when the installed `visionset` package changes — **not** the working directory, which is uvicorn's own default and which here holds `node_modules/`, `.venv/`, and often the workspace itself. |
| `--workspace` | see above | |

**The workspace is resolved once, here, and then stated.** `create_app()` takes no parameters and
`--reload` runs the application in a separate worker process, so the answer reaches the server as
`VISIONSET_WORKSPACE` — which means this command applies the full four-branch precedence, including
the upward walk, and the server's own resolver then stops at branch 2 and cannot disagree.

**The workspace is opened and closed before uvicorn starts.** Not a check but a real open: it runs
the migration, so a workspace behind the current format is brought forward at a terminal that can
print one sentence and exit 1, rather than inside the first HTTP request as a 500 with an incident
id. That is also what makes "missing workspace produces a clear error, not a stack trace" true.

**Ctrl+C is clean.** uvicorn owns the signal, and the application's lifespan stops the ingest worker
before closing the workspace — a run still in flight holds the store, so the order matters.

No browser is opened. That is the wrong thing on a headless box or over SSH, which is most of where
a dataset tool runs.

### The bundle, and when there is none

The compiled app ships inside the wheel as package data (`src/visionset/_static/`), so `pip install
visionset` needs no second download. In a source checkout it is a build artifact: run
`pnpm -r build && pnpm bundle:static`. Until somebody does, `/` answers a 404 that names that
command — a missing bundle is an ordinary state of a checkout, not a fault — while the API and
`/health` work normally.

Why `/ui` rather than `/`: the API already owns the root, so an app served from `/` could never
claim `/projects/abc` as one of its own client routes. See
[api.md](api.md#where-the-ui-lives).

## `visionset token`

Issuing, listing and revoking per-workspace API tokens. Covered in full — including why only a
digest is stored, and why revocation does not free the name — in [auth.md](auth.md#at-a-terminal).

## `visionset mcp`

A stub. The MCP server is a fourth sibling client of the same SDK; the command that starts it names
its target by import string or subprocess for the same reason `ui` does — import-linter forbids
`visionset.cli` importing `visionset.mcp`.

## For contributors

`cli/_errors.py` owns the exit codes and `domain_errors()`; `cli/_workspace.py` owns
`WorkspaceOption` and `opened_workspace()`. A new command is a module beside them, a function taking
`workspace: WorkspaceOption = None` **last**, and one registration line in `cli/main.py`. Wrap every
kernel call in `opened_workspace()` — it composes the open, the close and the refusal, and it closes
in a `finally` so no `visionset.db-wal` is left behind.

Commands are tested through `typer.testing.CliRunner` against the real `visionset.cli.main:app`, with
`result.stdout` and `result.stderr` asserted separately. There is no `conftest.py` anywhere in this
repository; each module declares its own fixtures, including an autouse one that clears
`VISIONSET_WORKSPACE` so a developer with it exported gets CI's results.
