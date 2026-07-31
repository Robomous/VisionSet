# Releasing

What ships, where it ships, and the order the steps have to happen in.

This page is for whoever cuts a release. It is not a policy document: every decision below is
recorded with the reason it was taken, so the next person can disagree with it on the merits.

## What ships

**One wheel.** The API, the CLI, the MCP server and the compiled browser app are inside it —
that is the delivery thesis, and [`tests/packaging/`](../tests/packaging) is what stops a wheel
shipping without the app in it. An sdist is built beside it and published too, so a source build
is possible on a platform without a wheel; there is nothing platform-specific in either, so both
are `py3-none-any`.

**Nothing on npm.** `@visionset/app` is the product shell and is explicitly never published;
`@visionset/annotator` and `@visionset/ui-core` are consumed through the wheel, by the app that
is compiled into it. Publishing them is a decision to support them as libraries, with the
compatibility promises that implies, and nobody has taken it. See [the scope](#the-npm-scope).

## Where the beta ships: **PyPI, as `0.0.1b1`**

Decided for #69, and the argument is short.

**The whole product is designed around `pip install visionset`.** The README opens with it, the
wheel carries the UI so there is nothing else to fetch, and #66 exists to prove the artifact
works from a clean environment. A beta that could only be installed from a GitHub Release asset
would be a beta whose install instruction is *not* the one the product is built around — so the
first real test of the delivery thesis would be deferred to 1.0, which is exactly the wrong place
to discover it was wrong.

**A pre-release does not reach somebody who types the plain command.** Per PEP 440, pip ignores
pre-releases unless you ask: `pip install visionset` on a project whose only release is `0.0.1b1`
reports that no matching distribution was found. Getting it takes `pip install --pre visionset`
or `pip install visionset==0.0.1b1`. That property is what makes shipping a beta to PyPI safe
rather than premature — the audience is people who were told the version number.

**It secures the name with something real.** Defensive registration was the other half of #69;
publishing an actual beta does it without a placeholder package that has to be explained later.

A **GitHub Release** is cut for the same tag, carrying the identical wheel and sdist plus the
changelog. That is not an alternative channel, it is the record: the artifacts a PyPI project
page will not show you a year from now, attached to the commit they came from.

## The npm scope

`@visionset` is unregistered. Reserving it costs nothing and prevents somebody else from
publishing a package that looks official:

```bash
npm org create visionset      # or: npm login && npm access …
```

Creating the organisation reserves the scope. **No placeholder publishes** — an empty package on
npm is a thing users find, file issues against, and depend on by accident, and un-publishing it
later is a worse problem than the one it was meant to prevent.

If the frontend packages are ever published for real, `pnpm version:sync` already translates
`VERSION` into npm semver (`0.0.1b1` → `0.0.1-beta.1`) and `pnpm version:check` gates the drift.

## Cutting a release

Everything up to the tag is in this repository. Everything after it needs credentials, and this
page does not have them.

### 1. Bump the version

`VERSION` at the repository root is the single source of truth — hatchling reads it for the
Python distribution and `pnpm version:sync` propagates it to every `frontend/*` package.

```bash
echo "0.0.1b1" > VERSION
pnpm version:sync
pnpm version:check                                  # must be clean
uv run python scripts/export_openapi.py             # the spec embeds the version
```

`openapi.json` embeds `info.version`, so **a version bump always moves the spec**. The generated
TypeScript client contains only `paths`, `components` and `operations`, so it does *not* move —
`pnpm generate:client:check` staying quiet after a bump is correct, not suspicious.

### 2. Green, all of it

```bash
uv run pytest && uv run lint-imports && uv run mypy src/visionset
pnpm -r build && pnpm test && pnpm -r lint
pnpm --filter @visionset/app e2e
pnpm --filter @visionset/app cycle
bash scripts/build_dist.sh
VISIONSET_REQUIRE_WHEEL=1 uv run pytest tests/packaging
uv run python examples/thirty_minute_flow.py
```

The last two are the ones that matter for a release specifically: they check the **artifact**
rather than the source tree, and the flow drives it from an empty environment.

### 3. Tag

```bash
git tag v0.0.1-beta.1 && git push origin v0.0.1-beta.1
```

Tag names are `v`-prefixed npm-semver (`v0.0.1-beta.1`); the distribution version is PEP 440
(`0.0.1b1`). They are the same version written two ways, and
[CONTRIBUTING.md](../CONTRIBUTING.md#versioning) has the table.

### 4. Publish

**This is the step that needs credentials, and nothing in the repository holds any.**

The wheel and sdist to publish are the ones CI already built — every build uploads `dist/*` as an
artifact — or a local `bash scripts/build_dist.sh`.

```bash
uv publish dist/*                # or: python -m twine upload dist/*
gh release create v0.0.1-beta.1 dist/* --title "…" --notes-file CHANGELOG-excerpt.md
```

**Prefer PyPI Trusted Publishing** over a long-lived API token: it authenticates a specific
GitHub Actions workflow in a specific repository through OIDC, so there is no secret to leak,
rotate, or accidentally commit. It is configured on the PyPI project page and needs no value
stored here. A release workflow is worth adding the first time this is done by hand and found
tedious — not before, because a publish workflow nobody has ever run is a thing that fails on the
day it matters.

### 5. Verify it from outside

The acceptance criterion, and it is not satisfied by the upload succeeding:

```bash
cd $(mktemp -d)
uv venv && uv pip install --no-cache "visionset==0.0.1b1"
visionset --version          # the version you tagged
visionset format list        # coco, dummy, voc, yolo
```

`format list` is the useful one: it reads installed entry-point metadata, so a non-empty answer
proves the distribution was assembled correctly and not merely uploaded. Then confirm the other
half of the thesis — `visionset init` somewhere, `visionset ui`, and open `/ui`.
