# VisionSet examples

Runnable examples. Never commit example media — every image here is generated at runtime,
and `**/workspace-data/` is git-ignored by design.

The first two drive the SDK. The last three drive the same cycle over each of the three
surfaces, which is M3's exit criterion: one kernel, reachable three ways.

| Example | What it shows |
| --- | --- |
| [`sdk_end_to_end.py`](sdk_end_to_end.py) | The whole cycle in one pass: workspace → project → schema → synthetic frames → batch → jobs → annotations → curated trunk → verified release |
| [`ingest_end_to_end.py`](ingest_end_to_end.py) | Where assets come from: a generated 10 s clip → source at 5 fps → 50 deduplicated assets → approved batch of 2 jobs, plus a re-run that creates nothing, the same clip at a second rate, and a folder of stills with one unreadable file. **Needs ffmpeg.** |
| [`http_end_to_end.py`](http_end_to_end.py) | The same cycle over HTTP, against a real server on a real port with a bearer token — including the multipart upload and the launch-and-poll ingest. `urllib` only: no `httpx`, no `requests`, no `curl`. |
| [`cli_end_to_end.sh`](cli_end_to_end.sh) | The same cycle from a shell, using nothing but the `visionset` command: init → project → schema → ingest → batch → jobs → release → export, with the `--json` shapes asserted and one deliberate refusal. No ffmpeg, no `jq`, no server. |
| [`mcp_end_to_end.py`](mcp_end_to_end.py) | The same cycle over MCP stdio, spawning `visionset mcp` and speaking JSON-RPC down its pipe — including looking at a preview and scaling the box back into the asset's own pixels. |

## Running the SDK end-to-end example

```bash
uv run python examples/sdk_end_to_end.py            # into examples/workspace-data/sdk-e2e
uv run python examples/sdk_end_to_end.py ./scratch  # or wherever you like
```

It needs nothing but the package: no server, no CLI, no file the repository had to ship. The
six 64×48 frames come from a short PNG encoder built out of `zlib` and `struct` — fixed bytes,
so the release's split folds are the same on every machine.

With no argument it writes into `examples/workspace-data/sdk-e2e` and clears a previous run
first — but only after confirming that directory holds nothing except a workspace. A
destination you name yourself is never removed automatically.

The workspace is left on disk when the run ends, so you can open it again and look around:

```python
from visionset.kernel.services import ProjectService, ReleaseService, WorkspaceService

with WorkspaceService.open("examples/workspace-data/sdk-e2e") as workspace:
    projects = ProjectService(workspace)
    dataset = projects.get_dataset(projects.list()[0].id)
    for release in ReleaseService(workspace).list(dataset.id):
        print(release.tag, release.asset_count, release.manifest_hash)
```

## Running the ingest example

```bash
uv run python examples/ingest_end_to_end.py            # into examples/workspace-data/ingest-e2e
uv run python examples/ingest_end_to_end.py ./scratch  # or wherever you like
```

Same destination rules as above, with one extra requirement: **ffmpeg must be on `PATH`**, because
this one generates its own ten-second clip. A video is a container wrapped around a codec, and the
only honest way to write one is the tool that reads it — so the example checks for the binary
before it writes anything and exits with an install hint if it is missing:

```bash
brew install ffmpeg              # macOS
sudo apt-get install ffmpeg      # Debian/Ubuntu
```

It leaves a project holding 53 assets: 50 frames cut from the clip at 5 fps into an approved batch
of two jobs, and three stills from `incoming/` — where a fourth file is deliberately not an image,
so the run's per-file report has something in it.

```python
from visionset.kernel.services import IngestService, ProjectService, SourceService, WorkspaceService

with WorkspaceService.open("examples/workspace-data/ingest-e2e") as workspace:
    project = ProjectService(workspace).list()[0]
    ingest = IngestService(workspace)
    for source in SourceService(workspace).list(project.id):
        for job in ingest.list(source.id):
            print(source.kind.value, job.state.value, job.processed, job.total, job.failures)
```

## Running the HTTP end-to-end example

```bash
uv run python examples/http_end_to_end.py            # into examples/workspace-data/http-e2e
uv run python examples/http_end_to_end.py ./scratch  # or wherever you like
```

Same destination rules as above. It creates a workspace, mints one token, then starts
`visionset ui` on an unused loopback port and does everything else through `urllib` — four
images uploaded as multipart, an ingest launched with 202 and polled to completion, two jobs
annotated, a release published and verified, an archive downloaded, and one request sent
without the token to prove it is refused.

It leaves a workspace at `<destination>/ws` and two downloads at `<destination>/downloads/`:
the release manifest, whose bytes hash to the release's own `manifest_hash`, and the export
archive. Serve it again yourself and keep going:

```bash
visionset ui --workspace examples/workspace-data/http-e2e/ws
curl -s -H "Authorization: Bearer $(visionset token create --name scratch \
  --workspace examples/workspace-data/http-e2e/ws)" localhost:8000/projects
```

## Running the CLI end-to-end example

```bash
uv run bash examples/cli_end_to_end.sh            # into examples/workspace-data/cli-e2e
uv run bash examples/cli_end_to_end.sh ./scratch  # or wherever you like
```

Same destination rules as above. `uv run bash` rather than plain `bash` is the one requirement: it
puts the virtualenv's `bin/` on `PATH`, so `visionset` and `python3` are the same installation.

It leaves a workspace at `<destination>/ws` — beside its inputs rather than over them, because
`init` refuses a directory that already holds something — with one project, one schema version, six
assets in a completed batch, and a verified `v1.0` release carrying no annotations.

```bash
export VISIONSET_WORKSPACE=examples/workspace-data/cli-e2e/ws
visionset release list --project road-signs --json | python3 -m json.tool
visionset release verify v1.0 --project road-signs && echo "still intact"
```

## Running the MCP end-to-end example

```bash
uv run python examples/mcp_end_to_end.py            # into examples/workspace-data/mcp-e2e
uv run python examples/mcp_end_to_end.py ./scratch  # or wherever you like
```

Same destination rules as above, and the same one requirement as the CLI example: `visionset`
has to be on `PATH`, because this spawns `visionset mcp --workspace <root>` — the exact command
you would put in an MCP client's configuration — and talks to it over its stdin and stdout.

The frames are 640×480 on purpose. `get_asset_image` sends a preview capped at 256 pixels on
its long edge, so what the client sees is 256×192 and the `scale` it gets back is 2.5. Every
box the example submits is multiplied by it; a client that skipped that step would write
annotations that are individually plausible and uniformly wrong.

It leaves a workspace at `<destination>/ws`, its inputs at `<destination>/incoming/` and the
export at `<destination>/export/`. Point a real agent at it:

```bash
visionset mcp --workspace examples/workspace-data/mcp-e2e/ws
```

[`docs/examples.md`](../docs/examples.md) walks through what each stage of all five examples does
and why.
