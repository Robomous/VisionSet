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
