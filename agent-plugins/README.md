# Agent plugins

This tree packages VisionSet as a plugin for coding-agent clients. The plugin starts the
local `visionset mcp` server and ships end-user skills; it holds no dataset logic. The rule,
and what it rules out, is
[An agent plugin wraps the installed CLI](../docs/content/architecture/decisions/an-agent-plugin-wraps-the-installed-cli.md).

## Three things called "plugin" or "skill"

| What | Where | Who it is for |
| --- | --- | --- |
| Entry-point plugins: `visionset.formats`, `visionset.preprocessing`, `visionset.providers` | `pyproject.toml`, installed Python distributions | VisionSet itself, at runtime |
| Maintainer skills | `.agents/skills/`, linked per tool by `scripts/setup_agents.sh` | agents working on this repository |
| The agent plugin and its end-user skills | this tree | people using VisionSet from an agent client |

`setup_agents.sh` never links a skill from this tree, and nothing here is loaded by the
Python distribution.

## Layout

| Path | What it is |
| --- | --- |
| `metadata.json` | The one hand-edited source of the plugin's metadata, including the compatibility range `=={VERSION}` |
| `packages/visionset/` | The plugin root. Every client installs this directory, and nothing outside it |
| `packages/visionset/.claude-plugin/plugin.json`, `.mcp.json` | Claude Code manifest and server declaration, **generated** |
| `packages/visionset/.codex-plugin/plugin.json`, `codex.mcp.json` | Codex manifest and server declaration, **generated** |
| `packages/visionset/runtime/` | The launcher, standard library only; `bundle.json` in it is **generated** and carries the rendered compatibility range |
| `packages/visionset/runtime/discover.py` | Finds a compatible installed `visionset`: the `VISIONSET_PLUGIN_EXECUTABLE` override, then user, project and plugin-cached installs |
| `packages/visionset/runtime/bootstrap.py` | Builds the plugin-owned runtime when discovery finds nothing: a private virtual environment under the plugin's data directory, populated by its own pip with the pinned `visionset` |
| `packages/visionset/skills/` | End-user skills, shared by every client |
| `schemas/` | Hand-written schemas for the files the generator emits, each citing its source |
| `tools/` | `render_manifests.py` (generator), `validate_manifests.py` (schema and containment check) |
| `tests/` | Contract tests; they run on a bare interpreter and never import `visionset` |

## Working on it

The version is never written here. It is the repository `VERSION`, mapped to semver the
way the frontend packages map it (`0.0.1b4` is `0.0.1-beta.4`).

```bash
python3 agent-plugins/tools/render_manifests.py          # after editing metadata.json or VERSION
python3 agent-plugins/tools/render_manifests.py --check  # exit 1 when a generated file is stale
python3 agent-plugins/tools/validate_manifests.py
bash scripts/check.sh agent-plugins                      # the tests, ruff and mypy, as CI runs them
```

Never edit a generated file by hand; change `metadata.json` or the generator and render again.

## The plugin-owned runtime

`bootstrap.py` keeps its state under one data root: `VISIONSET_PLUGIN_DATA`, else
`CLAUDE_PLUGIN_DATA`, else the user's data directory followed by `visionset-agent-plugin`.

| Path under the data root | What it is |
| --- | --- |
| `runtimes/<version>-py<MAJOR><MINOR>-<tag>/venv/` | The virtual environment, created in place and never moved |
| `runtimes/<key>/.owner`, `runtimes/<key>/ready.json` | The ownership marker, written first, and the readiness sentinel, written last |
| `locks/<key>.lock` | The cross-process lock |
| `logs/<key>.log` | Redacted output of every setup step, mode 0600 |

| Variable | Effect |
| --- | --- |
| `VISIONSET_PLUGIN_DATA` | Absolute data root, for operators and tests |
| `VISIONSET_PLUGIN_NO_BOOTSTRAP` | Any value except `0`, `false`, `no` or `off` refuses to create a runtime and prints the manual `pipx install` command instead |
| `PIP_INDEX_URL`, `PIP_FIND_LINKS`, `PIP_NO_INDEX`, `pip.conf`, netrc | Honoured as pip honours them. `PIP_TARGET`, `PIP_USER`, `PIP_PREFIX` and the other variables that would move the install are dropped |

The rules, and what the tests prove, are in the decision record's "Settled by bootstrap"
section. The real-install tests run on Linux, and one of them builds this checkout's wheel with
`uv build`.
