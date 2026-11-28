# Agent plugins

This tree packages VisionSet as a plugin for coding-agent clients. The plugin starts the
local `visionset mcp` server and ships end-user skills; it holds no dataset logic. The rule,
and what it rules out, is
[An agent plugin only launches the MCP server](../docs/content/architecture/decisions/an-agent-plugin-only-launches-the-mcp-server.md).

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
| `packages/visionset/` | The plugin root. Every client installs this directory, and nothing outside it |
| `packages/visionset/bundle.toml` | The one hand-edited source of the plugin's metadata |
| `packages/visionset/.claude-plugin/plugin.json`, `.mcp.json` | Claude Code manifest and server declaration, **generated** |
| `packages/visionset/.codex-plugin/plugin.json`, `codex.mcp.json` | Codex manifest and server declaration, **generated** |
| `packages/visionset/runtime/` | The launcher, standard library only |
| `packages/visionset/skills/` | End-user skills, shared by every client |
| `schemas/` | Hand-written schemas for the files the generator emits, each citing its source |
| `tools/` | `render_manifests.py` (generator), `validate_manifests.py` (schema and containment check) |
| `tests/` | Contract tests; they run on a bare interpreter and never import `visionset` |

## Working on it

The version is never written here. It is the repository `VERSION`, mapped to semver the
way the frontend packages map it (`0.0.1b4` is `0.0.1-beta.4`).

```bash
python3 agent-plugins/tools/render_manifests.py          # after editing bundle.toml or VERSION
python3 agent-plugins/tools/render_manifests.py --check  # exit 1 when a generated file is stale
python3 agent-plugins/tools/validate_manifests.py
bash scripts/check.sh agent-plugins                      # the tests, ruff and mypy, as CI runs them
```

Never edit a generated file by hand; change `bundle.toml` or the generator and render again.
