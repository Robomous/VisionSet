# An agent plugin only launches the MCP server

The agent plugin in [`agent-plugins/`](../../../../agent-plugins/README.md) reaches VisionSet in
one way: it runs the `visionset` console script as a subprocess and passes MCP over stdio
between the client and [`visionset mcp`](../../mcp.md). It carries no dataset logic and imports
nothing from the Python distribution, and the distribution never reads the plugin tree.

Every surface is a thin client of the SDK. The plugin is not even a surface: it is a way to
start one. A capability an agent needs is added to the SDK and reaches the plugin as an MCP
tool. It is never written into a skill or the launcher.

## One plugin root, generated adapters

`agent-plugins/packages/visionset/` is the plugin root for every client. Clients copy a plugin
into their own cache and load only that copy, so anything the plugin needs lives inside the
root. A client adapter is a generated manifest and a generated server declaration in the same
root. `bundle.toml` is the one hand-edited source, and the version comes from the repository
`VERSION`.

## What is enforced, and where

| Rule | Gate |
| --- | --- |
| Nothing under `agent-plugins/` imports `visionset` | `agent-plugins/tests/test_dependency_direction.py` |
| Nothing in `src/visionset/` names the plugin tree | `tests/architecture/test_agent_plugins_boundary.py` |
| `runtime/` uses only the standard library and parses at Python 3.11 | `agent-plugins/tests/test_dependency_direction.py`, and the suite runs under `python -I -S` |
| The launcher writes nothing to stdout except the protocol | `agent-plugins/tests/test_dependency_direction.py` |
| Client files are generated from `bundle.toml` and `VERSION`, and the committed bytes match | `agent-plugins/tests/test_tree.py`, `render_manifests.py --check` |
| The plugin version is `VERSION` in the frontend packages' semver spelling | `agent-plugins/tests/test_metadata.py` |
| Publisher, licence, homepage and Python floor equal `pyproject.toml`'s | `agent-plugins/tests/test_metadata.py` |
| Generated files match their schemas, every path they name exists inside the root, and the root holds no symlink | `agent-plugins/tools/validate_manifests.py` |
| `scripts/setup_agents.sh` never links a bundle skill | `agent-plugins/tests/test_isolation.py` |
| Neither the wheel nor the sdist carries `agent-plugins/` | `agent-plugins/tests/test_isolation.py` |

`bash scripts/check.sh agent-plugins` runs these, and CI runs them as `agent plugins`.

## What this forbids

- dataset, annotation or release logic in the plugin, in a skill or in the launcher;
- importing `visionset` from the plugin, or reading the plugin from the distribution;
- telemetry of any kind;
- a remote MCP server: the plugin declares only stdio servers it starts on the user's machine;
- changing a Python environment the plugin did not create, running anything with elevated
  privileges, or installing a GPU extra without being asked;
- `--allow-destructive` in a generated server declaration;
- moving a virtual environment after creating it, because its scripts hold absolute paths;
- writing inside a project or a workspace, or keeping state in the plugin root;
- typing a version anywhere but `VERSION`, or editing a generated file by hand.

## Version compatibility

While the project is `0.0.x`, an existing VisionSet installation is compatible only at exactly
the plugin's own version: `compatibility = "exact"` in `bundle.toml`, the one value the
generator accepts. A plugin-created runtime pins the same version. Allowing a wider range is a
change to this page and to the accepted values, never an edit to `bundle.toml` alone.

## Where plugin state lives

Plugin-owned state, such as a created runtime and its locks, goes in the client's plugin-data
directory when the client provides one to the server process. Otherwise it goes in one per-OS
data root:

| Platform | Data root |
| --- | --- |
| Linux | `$XDG_DATA_HOME/visionset-agent-plugin`, or `~/.local/share/visionset-agent-plugin` |
| macOS | `~/Library/Application Support/visionset-agent-plugin` |
| Windows | `%LOCALAPPDATA%\visionset-agent-plugin` |

State never goes in the plugin root, which a client replaces on update, or in a project.
Workspaces and datasets are never stored in either location.

## Client behaviour this layout relies on

These facts were checked on 2026-11-27 with Claude Code 2.1.332 and Codex CLI 0.155.1 on Linux
x86_64. A stub plugin with this layout was installed through each client's marketplace commands
and answered a real MCP call. Nothing else is claimed.

| Question | Claude Code | Codex CLI |
| --- | --- | --- |
| Manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` |
| Server declaration | `.mcp.json` at the root | the file the manifest's `mcpServers` names |
| One root holding both manifests | accepted | accepted |
| Install from a git source | copied to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` | copied to `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, local sources included |
| Install from a local path | read in place | copied |
| A symlink leaving the root | dropped from the copy | dropped from the copy |
| A `..` path in a manifest | refused by `claude plugin validate` | not checked |
| Root reference in server arguments | `${CLAUDE_PLUGIN_ROOT}` substituted | no variable substituted |
| Server working directory | the project directory | the thread's directory, or `cwd` resolved against the cached root |
| Plugin data directory | `${CLAUDE_PLUGIN_DATA}`, created on first use | none given to the server |
| Version string | any string, including `0.0.1b4` | any string, used as the cache directory name |
| Startup timeout | `MCP_TIMEOUT`, set by the user | 30 s by default; `startup_timeout_sec` in the server declaration is honoured |
| Manifest validator | `claude plugin validate` | none |

Under Codex, the server starts in the plugin root rather than the project. The launcher
therefore cannot take the project from its working directory there.

## Support matrix

Nothing is advertised as supported until its cell says so. `layout` means a stub plugin with
this layout installed and answered an MCP call. It does not mean VisionSet itself was launched.

| Client | Priority | Linux x86_64 | Linux arm64 | macOS arm64 | macOS x86_64 | Windows x86_64 | Minimum version |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | P0 | layout | unverified | unverified | unverified | unverified | unverified (layout on 2.1.332) |
| Codex CLI | P0 | layout | unverified | unverified | unverified | unverified | unverified (layout on 0.155.1) |
| Codex desktop | P0 | unverified | unverified | unverified | unverified | unverified | unverified |
| Copilot CLI and VS Code | P1, if a thin adapter suffices | unverified | unverified | unverified | unverified | unverified | unverified |
| Gemini CLI | P1, if a thin adapter suffices | unverified | unverified | unverified | unverified | unverified | unverified |
| Cursor, OpenCode | MCP-only fallback; native plugin pending | unverified | unverified | unverified | unverified | unverified | unverified |
