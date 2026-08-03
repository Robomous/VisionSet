# The command line

`visionset` is a thin client of the SDK, exactly like the REST API and the MCP server. It calls
the kernel in-process — there is no HTTP hop, and no command reaches a capability the SDK does not
already have.

Every command below takes `[--json]` and `[--workspace]` unless the table says otherwise, and both
are omitted from this listing to keep it readable.

```
visionset --version
visionset init [PATH] [--name NAME]                      # neither --json nor --workspace

visionset project create NAME [--description TEXT]
visionset project list
visionset schema apply FILE --project P [--allow-destructive]
visionset schema list --project P

visionset ingest PATH --project P [--fps N] [--batch-name NAME]
visionset batch list --project P
visionset batch approve BATCH_ID [--jobs-of N]
visionset batch start|complete|promote BATCH_ID

visionset job list --batch BATCH_ID
visionset job next JOB_ID [-n COUNT]
visionset job progress|start|complete JOB_ID
visionset job mark JOB_ID ASSET_ID --progress STATE

visionset release publish --tag T --project P [--split TRAIN,VAL,TEST] [--seed N]
visionset release list --project P
visionset release verify TAG --project P
visionset export --project P --release TAG --format F --out DIR [--allow-lossy]
visionset export --project P --release TAG --format F --check   # writes nothing; exit 1 = it loses something
visionset format list                                    # no --workspace: it opens nothing

visionset backfill-thumbnails --project P
visionset token create --name NAME
visionset token list
visionset token revoke NAME [--yes]
visionset ui  [--host] [--port] [--reload]               # no --json
visionset mcp                                            # stdio; no --json
```

## The cycle, as a script

```bash
WS=$(visionset init ./datasets/robots)
export VISIONSET_WORKSPACE="$WS"          # say it once; no command needs -w after this

visionset project create road-signs
visionset schema apply schema.json --project road-signs
BATCH=$(visionset ingest ./incoming --project road-signs)

visionset batch approve "$BATCH" --jobs-of 100
visionset batch start "$BATCH"
# …annotate, in the app or through `visionset job mark`…
visionset batch complete "$BATCH"
visionset batch promote "$BATCH"

visionset release publish --tag v1.0 --project road-signs --split 0.7,0.15,0.15
visionset release verify v1.0 --project road-signs && \
  visionset export --project road-signs --release v1.0 --format dummy --out ./out
```

[`examples/cli_end_to_end.sh`](../examples/cli_end_to_end.sh) is that walk with its assertions
still in it, and it runs in CI on every change.

## Three exit codes, and no others

| | Meaning |
| --- | --- |
| **0** | the command did what it said |
| **1** | a domain refusal — one sentence on stderr, no traceback — **or the answer is no** |
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
because folding one into `Error: [Errno 2] ...` would hide the thing that identifies it. Where a
kernel call refuses with something outside that family — a non-positive `--fps`, a `--split` whose
fractions do not add up, a schema file that is not JSON — the CLI catches it **before** the call and
raises Click's own usage error, so it lands at 2 rather than as a traceback.

**Code 1 also means "the answer is no".** `visionset release verify` runs, finds damage, and exits 1
with one sentence naming it; nothing refused, and nothing about the command failed. That is what
`grep` and `diff` already mean by a non-zero exit, and it is the only way a script branches on the
result without parsing output:

```bash
visionset release verify v1.0 --project road-signs && ./train.sh
```

A malformed UUID is a **2**, not a 1 — Click's own type refuses it, and the request could not have
named anything. That is the same call [the REST surface](api.md#the-two-shapes-of-422) makes when it
answers 422 rather than 404. A *name* that matches nothing is a 1, because it could have.

## Stdout is data; stderr is everything a person reads

```bash
TOKEN=$(visionset token create --name ci)     # exactly the secret, nothing else
WS=$(visionset init ./datasets/robots)        # exactly the resolved workspace root
BATCH=$(visionset ingest ./incoming -p road)  # exactly the batch id
visionset token list | tail -n +2             # the rows without the header
```

A command whose result is one thing puts that one thing on stdout and everything else on stderr:
`init` the workspace root, `project create` the new id, `ingest` the batch id, `schema apply` the
new version number. The "shown once" warning, the per-file ingest report and every "created …" line
go to stderr, so they survive the redirection that most needs them.

Every listing prints a header even with zero rows, so `tail -n +2` is stable, and **the first column
of every listing is the id**, so `awk '{print $1}'` is too:

```bash
visionset job list --batch "$BATCH" | tail -n +2 | awk '{print $1}'
```

That rule matters because a name may hold internal whitespace — `normalize_name` strips the outside
and deliberately preserves the middle — so a name-first column would break the moment somebody typed
`road signs east`. `token list` is the one listing that leads with a name, because a token has no id
anybody types; use `--json` there instead.

Every listing names its columns one at a time rather than dumping a model, for the reason
`token list` established: a field added to a domain model cannot leak into output nobody re-read.

Plain columns, never `rich.table`: box drawing pads to `$COLUMNS` and wraps, which makes output
width-dependent and neither testable nor `cut`-able.

## `--json`, and what it promises

Columns are for a person. `--json` is for a program, and it is available on every command that
prints anything:

```bash
visionset release list --project road-signs --json | jq '.items[] | .tag'
visionset batch list --project road-signs --json | jq '.items[] | select(.progress.unannotated > 0)'
```

The contract:

- **One JSON document per invocation**, on stdout, indented, with a trailing newline. Not
  JSON-lines — a listing is a single value, so a partial read is never mistaken for a whole one.
- **A listing is `{"items": [...], "total": n}`**, never a bare array, and an empty one is
  `{"items": [], "total": 0}` rather than an error. The same envelope, and the same argument for it,
  as [the REST API's](api.md#conventions).
- **A single resource or report is the bare object.**
- `--json` changes what stdout *is*. It does not silence stderr: a warning is still a warning.

**The shapes deliberately agree, key for key, with the REST API's**, so a script moves between
`curl | jq` and `visionset --json | jq` without relearning field names. That agreement is not a
convention anybody remembers — `tests/cli/test_json_contract.py` asserts, for fifteen resources,
that the CLI's projection has exactly the wire model's fields *and* that the wire model validates
it, which catches a timestamp in the wrong format that a key comparison would miss.

Two shapes have no REST counterpart, because no route publishes them, and the CLI defines them
first: `export`'s report (`release_id`, `format`, `directory`, `file_count`, `total_bytes`) and
`backfill-thumbnails`' (`project_id`, `examined`, `filled`, `missing`, `unreadable`).

Three fields are deliberately **never** published, in either surface: an asset's `uri` and a
source's `path`, which are absolute paths on this machine, and a batch's `asset_ids`, which for
fifty thousand frames must not travel on every read of its name. A source publishes `name` — the
last component of its path — instead.

## `--workspace` comes after the subcommand

`--workspace` / `-w` is declared on **each command**, not on the root callback, and that is a Click
fact rather than a preference. A group's parser stops at the first non-option token, so an option on
the callback would have to *precede* the subcommand — `visionset --workspace X token create --name
ci` would work and `visionset token create --name ci --workspace X` would fail with "No such
option". Nobody types the first one.

`--json` is per command for the identical reason, and so is every other option here. The two
commands without `--workspace` are the ones that need none: `visionset format list` reads installed
distributions, which is a fact about the process; `visionset init` takes a positional `PATH`,
because it names where to *make* a workspace rather than which one to use — and for that reason it
never walks, never reads `$VISIONSET_WORKSPACE`, and never trades the directory you named for its
parent.

Which workspace a command lands in, when the flag is absent, is
[one rule shared by every surface](workspaces.md#which-workspace-when-nobody-said): the flag, then
`VISIONSET_WORKSPACE`, then the nearest workspace at or above the working directory, then the
working directory. **Only that third case walks upward.** A flag and an environment variable are
somebody *stating* which workspace, and trading a stated directory for its parent is how a
credential gets minted into the wrong one.

## `visionset init`

Creates a workspace, which every other command needs and none of them makes.

```
$ visionset init ./datasets/robots
Created workspace 'robots' at /home/you/datasets/robots.
/home/you/datasets/robots
Next: visionset token create --name <name>, then visionset ui.
```

The root is the only thing on stdout, so `WS=$(visionset init ./robots)` is exactly the path — and
it is the *resolved* path, which is the useful answer when you typed `.`.

| | |
| --- | --- |
| `PATH` | Where to create it. Defaults to the working directory. Missing or empty are both fine; anything else is refused, so a typo cannot turn a home directory into a workspace. |
| `--name` | The workspace's name. Defaults to the directory's own. |

Creating one where a workspace already sits is refused too — the remedy is to use it, not to make a
second. Both refusals are one sentence at exit 1.

Deliberately **not** folded into `visionset ui`, which would have to create a workspace when the
directory looked empty: that breaks "`init` creates, `open` never does" and means a mistyped path
silently becomes a new empty workspace instead of an error. See
[workspaces.md](workspaces.md#at-a-terminal).

## `visionset ui`

Starts the server against the resolved workspace, serving the REST API at the root and the compiled
UI bundle at `/ui`; `/` redirects to the app.

```
$ visionset ui
VisionSet 0.0.1.dev0
  workspace   /home/you/datasets/robots
  UI and API  http://127.0.0.1:8000/
  browser     signed in automatically
  API clients visionset token create --name <name>
Press Ctrl+C to stop.
```

| Flag | Default | |
| --- | --- | --- |
| `--host` | `127.0.0.1` | Loopback, not `0.0.0.0`. VisionSet is local-first and tokens are minted by hand, so a default that exposed a freshly created — and therefore un-tokened — workspace to the local network would be a decision nobody made. Widening it stays safe: a browser is signed in automatically only when it is *on this machine*, so a LAN client still needs a token. See [auth.md](auth.md#the-browser-session). |
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

## The flow commands

One command, one SDK call, with the rationale in the topic doc rather than here.

### `visionset project`

`create NAME [--description TEXT]` → `ProjectService.create`, which writes the project and its one
dataset in a single transaction. `list` → `ProjectService.list`.

Everything downstream takes `--project` / `-p`, which accepts **a name or an id**. A name matches
case-insensitively, the way the unique index compares. There is no `rename` and no `delete`: both
are administration rather than flow, and both want the cascade explained. See
[projects.md](projects.md#at-a-terminal).

### `visionset schema`

`apply FILE --project P [--allow-destructive]` → `SchemaService.create_version`. The file is JSON
and is **the same document** `POST /projects/{id}/schema/versions` takes. `list --project P` →
`SchemaService.list_versions`; the last one is active.

Versions are 1..N and none of them changes, so `apply` always *adds* one. A change that removes or
narrows something is refused until `--allow-destructive`; one that would orphan existing annotations
has no override at all. See [schemas.md](schemas.md#at-a-terminal).

### `visionset ingest`

`PATH --project P [--fps N] [--batch-name NAME]` — **the one command that is two SDK calls**:
`SourceService.register_images` or `register_video`, dispatched on whether the path is a directory,
then `IngestService.ingest`. Registration is idempotent, so re-running the same line registers once;
content addressing means it also creates no asset it created before, which is the remedy for an
interrupted run. The batch id goes to stdout.

`--fps` is video-only and a usage error on a folder. The run is **synchronous**, and there is no
`--resume`: polling needs a second process, which is what `visionset ui` and
`GET /ingest-jobs/{id}` are for. See [ingest.md](ingest.md#at-a-terminal).

### `visionset batch`

`list --project P`, then the one-way walk `approve [--jobs-of N]` → `start` → `complete`, then
`promote`. Each maps to the `BatchService` method of the same name, except `promote`, which is
`DatasetService.promote` — it takes a *batch* id and derives the dataset, which is why it lives here.

`--jobs-of N` is the `BySize` partition; with no flag the batch becomes one job. There is no
`batch create` and no membership editing: a batch is born from an ingest. See
[batches.md](batches.md#at-a-terminal).

### `visionset job`

`list --batch B`, `next JOB [-n N]`, `progress JOB`, `start JOB`, `mark JOB ASSET --progress STATE`,
`complete JOB`. Each is one `JobService` call.

**`--progress annotated` records that somebody labeled an asset, and the CLI writes no labels** —
geometry comes from a canvas or a model, not from typing. A release published off a batch driven
this way reports `annotation_count: 0`, and its manifest says so. These commands exist because the
lifecycle must be drivable from a script, not because this is how labelling happens. See
[jobs.md](jobs.md#at-a-terminal).

### `visionset release` and `visionset export`

`release publish --tag T --project P [--split TRAIN,VAL,TEST] [--seed N]` → `ReleaseService.publish`.
`release list --project P`, and `release verify TAG --project P`, whose **exit code is the answer**.

`export --project P --release TAG --format F --out DIR [--allow-lossy]` resolves the format through
the plugin registry and hands the instance to `ReleaseService.export` — the kernel is forbidden from
finding a plugin itself. `format list` says which are installed.

A release tag is **case-sensitive** where a project name is not: a tag is an identifier, not a label
somebody reads. `--allow-lossy` is a third gate word beside `--yes` and `--allow-destructive`, never
merged with either. See [releases.md](releases.md#at-a-terminal).

**`export --check` asks the question without committing to it.** It prints the per-class
compatibility report — one row per class: name, geometry, what happens to it, how many annotations
and assets, and why — and writes nothing. `--out` is not required under it; `--allow-lossy` is
accepted and does nothing, because consent has nothing to apply to and refusing the combination
would break the one property the flag was chosen for, that both invocations take the same arguments.

It is a flag rather than a `release compatibility` command because the arguments that decide the
answer are exactly `export`'s, and a second command would restate every one of them.

**It exits 1 when the answer is no**, on `release verify`'s precedent — the check ran, and it found
loss — using the same `EXIT_ANSWER_IS_NO`. The predicate is the one `ReleaseService.export` itself
gates on, `plugin.lossy or not report.compatible`, and **not** `compatible` alone: a format that
declares itself lossy asks for consent even over a release whose every class it can carry, because
that declaration covers attributes, confidence and provenance — none of which is a class, and none
of which the per-class table can show. So:

```bash
visionset export --check -p road-signs --release v1.0 -f yolo && \
  visionset export -p road-signs --release v1.0 -f yolo --out ./out
```

means what it looks like. The table is on **stdout** and the summary on stderr, so `| cut` gets
classes and nothing else; `--json` prints `visionset.wire.export_compatibility`, the same document
the REST route and the MCP tool publish.

### `visionset backfill-thumbnails`

`--project P` → `IngestService.backfill_thumbnails`. Renders the previews of assets that have none —
a preview is a cache, not an identity, so an asset whose bytes will not render keeps a null one and
is reported here rather than having failed its ingest. Idempotent. See
[ingest.md](ingest.md#the-backfill).

## `visionset token`

Issuing, listing and revoking per-workspace API tokens. Covered in full — including why only a
digest is stored, and why revocation does not free the name — in [auth.md](auth.md#at-a-terminal).

## `visionset mcp`

Starts the MCP server on stdio, serving this workspace to an agent. Thirty-five tools covering
the whole cycle; [mcp.md](mcp.md) has the list, how to configure a client, and what a tool refusal
looks like.

```
visionset mcp [--workspace PATH]
```

Normally a client spawns it rather than a person running it. Like `ui`, it resolves the workspace
with the full precedence and then **states** the answer in `VISIONSET_WORKSPACE`, so the server it
starts cannot disagree with it, and it opens the workspace first so that `NotAWorkspace` is one
sentence at exit 1 rather than a refusal inside the agent's first tool call.

The target is named as a module for a subprocess rather than imported, for the reason `ui` names
uvicorn's app by import string — import-linter forbids `visionset.cli` importing `visionset.mcp`.
The subprocess inherits stdin and stdout, because those two streams *are* the transport, which is
also why this is the one command that prints **nothing at all** on stdout: a stray line would
corrupt the JSON-RPC stream before the first message.

## For contributors

Four private modules and one shared package carry everything a command needs:

| | |
| --- | --- |
| `cli/_errors.py` | the exit codes and `domain_errors()` |
| `cli/_workspace.py` | `WorkspaceOption` and `opened_workspace()` |
| `cli/_output.py` | `JsonOption`, the column formatter, `document()`, `note()` |
| `cli/_resolve.py` | `ProjectOption`, and turning a name or a tag into the thing it names |
| `visionset/wire/` | one hand-written projection per resource — **shared with the MCP surface**, which publishes the same shapes (see `docs/mcp.md`) |

A new command is a module beside them and one registration line in `cli/main.py` — groups by
`add_typer`, bare commands by `app.command("name")(fn)`, which is where they are registered rather
than at their definition site because a decorator there would import `main` and `main` imports them.
The signature ends `json_out: JsonOption = False, workspace: WorkspaceOption = None`, with
`workspace` **last**. Wrap every kernel call in `opened_workspace()` — it composes the open, the
close and the refusal, and it closes in a `finally` so no `visionset.db-wal` is left behind.

**A command maps to exactly one service call, and says so in its docstring when it does not.**
`ingest` is the only one that does not, and its module explains why.

**Never `model_dump()` a domain model into `--json`.** Write the projection in `visionset/wire/`
and add the pair to `tests/cli/test_json_contract.py`, which asserts key-for-key parity with the
REST wire model. That test may import both `visionset.wire` and `visionset.server` because `tests/`
is outside the package the independence contract governs — the packages themselves must not. A
projection added there is published by the CLI **and** by MCP, which is why it is a package of its
own rather than a private module under `cli/`.

**A bound the domain enforces with a pydantic `Field` has to be mirrored in the Typer option**, or
the refusal arrives as a traceback: a pydantic `ValidationError` and a bare `ValueError` are not
`VisionSetError`s and `domain_errors()` deliberately does not catch either. `--jobs-of` carries
`min=1`, `--fps` is checked in the body (Typer has no `min_open`), and `--split` is parsed into a
`SplitRecipe` inside a `try`.

Commands are tested through `typer.testing.CliRunner` against the real `visionset.cli.main:app`, with
`result.stdout` and `result.stderr` asserted separately. There is no `conftest.py` anywhere in this
repository; each module declares its own fixtures, including an autouse one that clears
`VISIONSET_WORKSPACE` so a developer with it exported gets CI's results. **Use
`monkeypatch.setenv(VAR, "")` if any command the module exercises can write `os.environ`, and
`delenv(VAR, raising=False)` otherwise** — `delenv` records no undo when the variable was already
absent, so a written one leaks into every later module. Only `ui` writes it today.

**A test module's basename must be unique across the whole suite.** With no `__init__.py` anywhere,
pytest imports a test module under its bare basename, so `tests/cli/test_batches.py` beside
`tests/server/test_batches.py` is a collection error rather than two modules — which is why the CLI
ones are `test_<noun>_commands.py`. Private helpers are exempt: `tests/cli/_flow.py` and
`tests/server/_flow.py` coexist because they are imported by their full dotted path, which PEP 420
namespace packages resolve.

`tests/cli/_flow.py` walks the CLI up to a given rung *by invoking the CLI*, so the ladder is itself
under test on the way up; `tests/cli/test_full_cycle.py` uses none of it, because the point there is
that the whole walk is readable in one function.
