# VisionSet examples

Runnable SDK examples. Never commit example media — every image here is generated at runtime,
and `**/workspace-data/` is git-ignored by design.

| Example | What it shows |
| --- | --- |
| [`sdk_end_to_end.py`](sdk_end_to_end.py) | The whole cycle in one pass: workspace → project → schema → synthetic frames → batch → jobs → annotations → curated trunk → verified release |

## Running the end-to-end example

```bash
uv run python examples/sdk_end_to_end.py            # into examples/workspace-data/sdk-e2e
uv run python examples/sdk_end_to_end.py ./scratch  # or wherever you like
```

It needs nothing but the package: no server, no CLI, no file the repository had to ship. The
six 64×48 frames come from a short PNG encoder built out of `zlib` and `struct`, because M1 has
no image library to lean on (Pillow arrives with the media processor in M2, #16).

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

[`docs/examples.md`](../docs/examples.md) walks through what each stage does and why.
