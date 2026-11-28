# An agent plugin wraps the installed CLI

Status: **accepted** ([#1256](https://github.com/Robomous/VisionSet/issues/1256), the foundation
of the agent-plugin epic [#1255](https://github.com/Robomous/VisionSet/issues/1255)).

## The rule

**An agent plugin is a thin, generated adapter around one canonical bundle, and the bundle does
one thing: find or provision a compatible `visionset` and run `visionset mcp` over stdio.** It
adds no tool, no business rule and no transport of its own. Six consequences hold together:

- **One subtree, one direction.** Everything lives under `agent-plugins/`. Provider directories
  depend on `packages/visionset/`, which depends on nothing but the `visionset` command line.
  Nothing there imports a `visionset` Python module, and nothing under `src/visionset/` refers to
  `agent-plugins/`, so the kernel-purity contracts are untouched and the subtree can be removed
  without touching the distribution. These are not Python entry-point plugins
  (`visionset.formats`); the two share a word and nothing else.
- **One metadata file, no hand-written version.** `agent-plugins/metadata.json` holds the name,
  description, license, repository, publisher and compatibility range. Provider manifests and
  marketplace entries are generated from it and from the repo-root `VERSION`, which stays the
  only place a version is edited. A drift check re-renders and fails on any difference.
- **Resolution order is fixed.** An explicit operator override; a compatible user installation;
  a compatible project installation; a plugin-owned cached runtime; and only then a bootstrap
  into a private virtual environment, built from a local Python 3.11 or newer with that
  environment's own `python -m pip`. A compatible install is one whose version falls inside the
  range in `metadata.json`.
- **The runtime never reaches past its own directory.** It does not modify an existing
  environment, install GPU extras, use elevated privileges, relocate a created virtual
  environment, send telemetry or serve MCP remotely. State lives in a per-version directory under
  the provider's plugin-data location, or the user's data directory when none is given; never in
  a workspace and never in the installed plugin directory.
- **The server's posture is the CLI's.** The launcher passes the workspace through and leaves
  precedence (`--workspace`, `$VISIONSET_WORKSPACE`, nearest workspace) to `visionset mcp`. It
  adds no `--allow-destructive`; a user opts in through the same flag or variable as without a
  plugin.
- **Support is claimed per client, from evidence.** Claude Code and Codex (CLI and local
  desktop) are the primary targets. Copilot and Gemini are adopted only if a thin adapter
  suffices. Cursor and OpenCode get a documented MCP-only fallback, never a native claim. A
  client or platform without a passing conformance run is documented as untested.

## What it rules out

- A second implementation of any tool, resolver or workspace rule inside a plugin.
- A version typed into a manifest, or a manifest edited by hand under a provider directory.
- Installing into, upgrading or repairing an environment the plugin did not create.
- A compiled launcher before the simplest portable approach has been shown not to work.
- Generated manifests that are not validated against a pinned schema; a provider's schema moving
  is a deliberate re-vendor, never a silent fetch.
- Shipping the maintainer skills in `.agents/skills/` to users. Workflow and setup skills for
  users live in the bundle and are separate.
- Advertising a client, platform or provider feature that no test exercised.

## Why

A plugin that carries its own logic forks the product: the MCP contract, the workspace rules and
the safe defaults already have an owner, and a second copy drifts from it silently. A plugin
that mutates the environment it finds trades a convenient install for a broken data-science
setup. Fixing the direction and the order here lets the discovery, bootstrap, launcher, skills
and provider packages be built and reviewed independently against one contract, and lets the
release gate say exactly what was proven.

## Settled here, left to later work

The tree, the metadata source and the dependency direction are decided. The compatibility range
and the minimum client versions are recorded when the provider packages observe real behaviour,
and are not guessed here. The legal publisher string is taken from package metadata
(`Robomous Inc.`) and confirmed before it reaches a manifest. The launcher shape is decided by
its own work package, and external directory submissions are a later, non-blocking step.

## Settled by the spike

Checked on 2026-11-27 with Claude Code 2.1.332 and Codex CLI 0.155.1 on Linux x86_64. A stub
plugin with this layout was installed through each client's own marketplace commands and
answered a real MCP call. Where this section and the rule above differ, this section holds.

- **The manifests sit in the bundle root.** Both clients copy a plugin into their own cache and
  load only that copy. A symlink leading out of the root is dropped from the copy, and
  `claude plugin validate` refuses a `..` path. A provider directory therefore cannot depend on
  a sibling package. `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` are generated
  into `agent-plugins/packages/visionset/`, which is the one plugin root.
  `agent-plugins/tools/validate_manifests.py` refuses a symlink in the root, and refuses any path
  a generated file names that does not exist inside the root.
- **One server declaration per client.** Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in a
  server's arguments and starts the server in the project directory. Codex substitutes no
  variable and resolves `cwd` against its cached copy of the root. The generator writes
  `.mcp.json` for Claude Code and `codex.mcp.json` (with `cwd: "."`) for Codex. No generated
  declaration contains `--allow-destructive`.
- **Codex starts the server in the plugin root, not the project.** The launcher cannot take
  the workspace from its working directory there.
- **Version spelling.** Both clients accepted any version string, including `0.0.1b4`.
  Manifests carry `VERSION` in the frontend packages' semver spelling (`0.0.1-beta.4`). The
  compatibility range in `metadata.json` is written `=={VERSION}`, so for now it is exactly the
  current version. The generator renders it into `runtime/bundle.json`, because the clients do
  not copy `metadata.json`, which sits outside the root.
- **Schemas.** Neither client publishes a schema for the files this bundle emits. The published
  Agent Plugins schema describes a root `plugin.json` that this bundle does not write. The
  pinned schemas are therefore hand-written under `agent-plugins/schemas/`, and each one names
  its source.
- **Plugin data and startup.** Claude Code gives the server `${CLAUDE_PLUGIN_DATA}`, while Codex
  0.155.1 gives it no data directory. Codex waits 30 seconds for a server by default and honours
  `startup_timeout_sec` in the plugin's declaration. Claude Code reads `MCP_TIMEOUT`, which the
  user sets.

`layout` means only the stub check above passed. VisionSet itself has not been launched
through any client.

| Client | Linux x86_64 | Linux arm64 | macOS arm64 | macOS x86_64 | Windows x86_64 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | layout | untested | untested | untested | untested |
| Codex CLI | layout | untested | untested | untested | untested |
| Codex desktop | untested | untested | untested | untested | untested |
| Copilot CLI and VS Code | untested | untested | untested | untested | untested |
| Gemini CLI | untested | untested | untested | untested | untested |
| Cursor, OpenCode (MCP-only) | untested | untested | untested | untested | untested |

Several things are left to later work: the data directory used when a client gives none, the
version a plugin-created runtime installs, how the launcher finds the project under Codex, and
the interpreter command on macOS and Windows.

## Settled by discovery

[#1257](https://github.com/Robomous/VisionSet/issues/1257) implemented the first four steps of
the resolution order in `runtime/discover.py`, and its contract tests hold each rule below.

- **The override is `VISIONSET_PLUGIN_EXECUTABLE`**, an absolute path to the console script.
  An empty value counts as unset. It is checked like any candidate, and when it fails discovery
  reports why and tries nothing else.
- **A candidate's tier comes from where it was found**, never from where a link resolves. A
  `PATH` directory is a project one when it lies inside the checkout or is the scripts directory
  of an active `VIRTUAL_ENV`, a non-base `CONDA_PREFIX` or `UV_PROJECT_ENVIRONMENT`; every other
  absolute `PATH` directory, and the pipx, uv tool and `pip --user` locations, is a user one. A
  user install therefore wins with a project environment first on `PATH`. Relative `PATH`
  entries are not searched.
- **The checkout** is the nearest directory above the project holding `.git` (a directory or a
  worktree's file), else the nearest holding `pyproject.toml`, `.venv` or `venv`. The walk stops
  below the home directory, so a dotfiles repository does not turn `~/.local/bin` into a project.
- **A binary inside the checkout is not run unless the host trusts the project**; the launcher
  supplies that verdict. The override is exempt, and an activated environment outside the
  checkout needs no trust.
- **A candidate is accepted after two probes**, `--version` inside the range and `mcp --help`
  exiting 0. Probes take an argument list and no shell, close stdin, capture and cap output, and
  are killed at a timeout, with their process group on POSIX. On Windows only `visionset.exe` runs; a
  `.cmd` or `.bat` shim needs a shell and is refused. Every skip reason is redacted: no home
  directory, secret-named variable values, credentials in URLs or common token shapes.
