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
  worktree's file), else the nearest holding `pyproject.toml`, `.venv` or `venv`, else the
  project itself. A submodule's checkout extends to its superproject, and a marker at the
  filesystem root is ignored. For a project below the home directory the walk stops below home,
  so a dotfiles repository does not turn `~/.local/bin` into a project; a project at home is its
  own checkout. Paths are compared without case on macOS and Windows.
- **No binary inside the checkout is run unless the host trusts the project**, whatever tier
  found it: a home, pipx or cache directory inside the checkout is gated too. The launcher
  supplies that verdict. The override is exempt, and an activated environment outside the
  checkout needs no trust.
- **A candidate is accepted after two probes**, `--version` inside the range and `mcp --help`
  exiting 0. Probes take an argument list and no shell, close stdin, drop
  interpreter-steering variables such as `PYTHONPATH` and `PYTHONSTARTUP`, capture and cap output, and are killed at
  a timeout, with their process group on POSIX. On Windows only `visionset.exe` runs, a `.cmd`
  or `.bat` shim is refused because it needs a shell, and a drive-relative `PATH` entry is not
  searched. Every skip reason is redacted: no user's home directory, no value of a secret-named
  variable, and no credential in a URL, header, key-value pair, flag or common token shape.

Known limits. On Windows a timeout kills only the probe process, not its descendants. The
launcher runs a path that was probed moments before, and a binary replaced in between is not
re-checked. The override is trusted, so the launcher work
([#1259](https://github.com/Robomous/VisionSet/issues/1259)) has to confirm that no host lets
project-scoped configuration set `VISIONSET_PLUGIN_EXECUTABLE`.

## Settled by bootstrap

[#1258](https://github.com/Robomous/VisionSet/issues/1258) implemented the last step of the
resolution order in `runtime/bootstrap.py`. Its contract tests hold each rule below. The real
tests run on Linux only.

- **Where state lives.** The data root is `VISIONSET_PLUGIN_DATA` (absolute, or setup fails),
  else `CLAUDE_PLUGIN_DATA`, else `$XDG_DATA_HOME` or `~/.local/share`, `~/Library/Application
  Support` on macOS, or `%LOCALAPPDATA%` on Windows, each followed by `visionset-agent-plugin`.
  A root inside the installed plugin is refused. A runtime lives in
  `runtimes/<version>-py<MAJOR><MINOR>-<tag>/`, where the tag hashes the interpreter's real path,
  implementation and platform, so each plugin version and each interpreter gets its own
  directory. Its lock (`locks/<key>.lock`) and its log (`logs/<key>.log`, mode 0600) sit outside
  it.
- **Which interpreter.** The interpreter running the bootstrap comes first, then `python3.14`
  down to `python3.11`, `python3` and `python` on `PATH`. On Windows the order is `py -3.14` down
  to `py -3.11`, then `python.exe`, and a `WindowsApps` alias is never run. An interpreter needs
  3.11 or newer with both `venv` and `ensurepip`. When none qualifies, the failure says which of
  these was missing.
- **One build at a time, published last.** An exclusive OS file lock (`flock`, or `msvcrt`
  byte locking on Windows) is held with a bounded wait (300 s by default). The sentinel is
  checked before the lock and again after it. The virtual environment is created at its final
  path, after an `.owner` marker. `ready.json` is staged and read back, then renamed into place,
  and only after `pip --version` works and the console script passes discovery's two probes.
  Any failure removes the directory. Two processes starting together install once.
- **Recovery never takes what it does not own.** Under the lock, a directory without
  `ready.json` is removed and rebuilt only when it carries this plugin's marker for that key,
  or is empty (a setup killed before the marker was written). Anything else fails with
  `NOT_OWNED` and is left alone. A ready runtime is rebuilt only when its interpreter can no
  longer be started. One that is merely slow to answer is reused. A new plugin version builds
  beside the old runtime and never modifies it. Nothing prunes old runtimes yet.
- **What pip runs.** The command is exactly
  `<venv python> -I -m pip install --no-input --disable-pip-version-check --progress-bar off
  visionset==<VERSION>`. The requirement must be a bare name pinned with `==`. There is no
  `--user`, no `--upgrade`, no `--pre`, no extra and no elevation. Every child process loses
  `PYTHONPATH`, `PYTHONHOME` and the other interpreter-steering variables, plus the `PIP_*`
  variables that move the install target or the interpreter (`PIP_TARGET`, `PIP_USER`,
  `PIP_PREFIX`, `PIP_ROOT`, `PIP_PYTHON`, `PIP_REQUIRE_VIRTUALENV` and similar). Index, mirror and
  find-links settings pass through, and so do `pip.conf` and netrc. An air-gapped install points
  `PIP_FIND_LINKS` at a wheel directory.
- **Failures are bounded and named.** Creating the environment and installing share one deadline
  (900 s by default). A failure that shows a connection error is retried once, and a resolution
  error is not retried. Each failure raises a `BootstrapError` with a stable code: `OPTED_OUT`,
  `BAD_DATA_DIR`, `NO_PYTHON`, `PYTHON_TOO_OLD`, `NO_VENV`, `NO_PIP`, `LOCK_TIMEOUT`, `NOT_OWNED`,
  `INDEX_UNAVAILABLE`, `INSTALL_FAILED`, `INSTALL_TIMEOUT`, `VALIDATION_FAILED` or
  `INCOMPATIBLE_RESULT`. It also gives the manual command (`pipx install 'visionset==<VERSION>'`).
  Error text, progress lines and the log go through discovery's redaction, so a credential in an
  index URL never reaches them. `ready.json` holds no index setting.
- **Opt-out and output.** A truthy `VISIONSET_PLUGIN_NO_BOOTSTRAP` refuses before anything is
  created. Progress goes to stderr, child output is captured, and stdout is never written.
  `cached_prefixes()` returns the published runtimes, newest first, for `discover(cached=...)`.

Deviations from the plan reviewed for this slice. Four codes were added: `PYTHON_TOO_OLD`,
`NOT_OWNED`, `BAD_DATA_DIR` and `INSTALL_TIMEOUT`. There is no `VISIONSET_PLUGIN_FIND_LINKS`,
because pip's own `PIP_FIND_LINKS` already covers it. An empty directory is recovered without a
marker. The real-process tests (two simultaneous starts, a kill during install, offline reuse, a
second version, an unreachable index) install a minimal stand-in wheel so that each run takes
seconds. Only the clean-install test installs this checkout's own wheel, built with `uv build`,
with its dependencies repacked from the synced environment and installed with `--no-index`.

Known limits. pip's output reaches the log when each step ends, not while it runs. A
`target` or `user` setting in `pip.conf` is not overridden, and it makes validation fail rather
than install elsewhere. A pip configured with zero retries reports an unreachable index without
a connection error, which surfaces as `INSTALL_FAILED`. A dependency without a wheel may build
from source. The two validation probes and `pip --version` have timeouts of their own, outside
the install deadline. The launcher ([#1259](https://github.com/Robomous/VisionSet/issues/1259))
calls none of this yet.
