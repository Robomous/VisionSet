# Releasing

This page describes what ships, where it ships, and the required order of operations.

It is a release operator's guide, not a policy document. Each decision includes its rationale
so future maintainers can evaluate it on its merits.

## What ships

**One wheel.** The API, the CLI, the MCP server and the compiled browser app are inside it -
that is the delivery thesis, and [`tests/packaging/`](../../tests/packaging) is what stops a wheel
shipping without the app in it. An sdist is built beside it and published too, so a source build
is possible on a platform without a wheel; there is nothing platform-specific in either, so both
are `py3-none-any`.

**Nothing on npm.** `@visionset/app` is the product shell and is explicitly never published;
`@visionset/annotator` and `@visionset/ui-core` are consumed through the wheel, by the app that
is compiled into it. Publishing them is a decision to support them as libraries, with the
compatibility promises that implies, and nobody has taken it. See [the scope](#the-npm-scope).

## Where the beta ships: **PyPI, as `0.0.1b1`**

Decided for #69, and the argument is short. It is written about the *first* beta because that is
when it was made; the current version is **`0.0.1b2`**, the same beta with the three defects a
manual pass over the wheel found (#164). A published version is never edited in place - a
correction is another release, which is the same rule a VisionSet release itself follows.

**The whole product is designed around `pip install visionset`.** The README opens with it, the
wheel carries the UI so there is nothing else to fetch, and #66 exists to prove the artifact
works from a clean environment. A beta that could only be installed from a GitHub Release asset
would be a beta whose install instruction is *not* the one the product is built around - so the
first real test of the delivery thesis would be deferred to 1.0, which is exactly the wrong place
to discover it was wrong.

**A pre-release does not reach somebody who types the plain command.** Per PEP 440, pip ignores
pre-releases unless you ask: `pip install visionset` on a project whose only release is `0.0.1b1`
reports that no matching distribution was found. Getting it takes `pip install --pre visionset`
or `pip install visionset==0.0.1b1`. That property is what makes shipping a beta to PyPI safe
rather than premature - the audience is people who were told the version number.

**It secures the name with something real.** Defensive registration was the other half of #69;
publishing an actual beta does it without a placeholder package that has to be explained later.

A **GitHub Release** is cut for the same tag, carrying the identical wheel and sdist plus the
changelog. That is not an alternative channel, it is the record: the artifacts a PyPI project
page will not show you a year from now, attached to the commit they came from.

## The npm scope

`@visionset` is unregistered. Reserving it costs nothing and prevents somebody else from
publishing a package that looks official:

```bash
pnpm login --registry https://registry.npmjs.org   # then create the org in the npm web UI
```

pnpm is the only Node package manager this repository uses, and `pnpm login` writes the same
credential `pnpm publish` would later read. Creating the *organisation* is a registry
administration action with no client-side equivalent in any package manager - it is done on the
npmjs.com website, not from a terminal.

Creating the organisation reserves the scope. **No placeholder publishes** - an empty package on
npm is a thing users find, file issues against, and depend on by accident, and un-publishing it
later is a worse problem than the one it was meant to prevent.

If the frontend packages are ever published for real, `pnpm version:sync` already translates
`VERSION` into npm semver (`0.0.1b1` → `0.0.1-beta.1`) and `pnpm version:check` gates the drift.

## Cutting a release

Everything up to the tag is done from a working copy. Publishing is done by a workflow, over
trusted publishing, so no step below asks anybody for a credential.

### 1. Bump the version

`VERSION` at the repository root is the single source of truth - hatchling reads it for the
Python distribution and `pnpm version:sync` propagates it to every `frontend/*` package.

```bash
echo "0.0.1b2" > VERSION
pnpm version:sync
pnpm version:check                                  # must be clean
uv run python scripts/export_openapi.py             # the spec embeds the version
```

`openapi.json` embeds `info.version`, so **a version bump always moves the spec**. The generated
TypeScript client contains only `paths`, `components` and `operations`, so it does *not* move -
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
git tag v0.0.1-beta.2 && git push origin v0.0.1-beta.2
```

Tag names are `v`-prefixed npm-semver (`v0.0.1-beta.2`); the distribution version is PEP 440
(`0.0.1b2`). They are the same version written two ways, and
[CONTRIBUTING.md](../../CONTRIBUTING.md#versioning) has the table.

### 4. Publish

**The publish path is [`.github/workflows/publish-pypi.yml`](../../.github/workflows/publish-pypi.yml),
and it needs no credentials from anybody.** It is `workflow_dispatch` only, so a human starts it
deliberately; run `30801065205` used it to publish `0.0.1b2` on 2026-08-03.

```bash
gh workflow run publish-pypi.yml --ref v0.0.1-beta.2
gh run watch "$(gh run list --workflow=publish-pypi.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

**`--ref` is the whole of what the operator has to get right.** The workflow builds the artifact
itself with `bash scripts/build_dist.sh` rather than downloading one CI produced earlier, so what
reaches PyPI is whatever the ref it was dispatched against contains. Dispatched against the tag,
that is the commit step 3 tagged; dispatched against a branch, it is whatever that branch holds at
the moment somebody pressed the button. Nothing downstream can tell the two apart afterwards.

**No token exists anywhere, and that is the design.** The `pypi` environment plus `id-token: write`
is what PyPI's trusted publisher exchanges for a short-lived upload credential over OIDC — it
authenticates this specific workflow in this specific repository, so there is no secret to leak,
rotate, or accidentally commit. The configuration lives on the PyPI project page and names the
workflow **by filename**; renaming the file breaks the exchange with an opaque error rather than a
missing-file one.

Before dispatching, confirm `VERSION` on the tagged commit is the version you mean to publish and
that PyPI does not already hold it — **a published version is never edited in place**, and a
correction is another release. Afterwards, step 5 is the acceptance criterion; the run going green
is not.

The GitHub Release is separate from the PyPI upload, and it is still made by hand:

```bash
gh release create v0.0.1-beta.2 --title "…" --notes-file notes.md
```

Write `notes.md` from this version's section of [`CHANGELOG.md`](../../CHANGELOG.md). Attaching `dist/*` is optional and mostly
misleading — those would be a *second* build of the same commit rather than the bytes PyPI holds,
and `pip install` is the install path the product is designed around.

**The hand publish is the fallback, for the case where Actions itself is unavailable.** It needs a
PyPI API token, which nothing in this repository holds and which is exactly the long-lived
credential trusted publishing exists to avoid:

```bash
bash scripts/build_dist.sh
uv publish dist/*                # or: python -m twine upload dist/*
```

### 5. Verify it from outside

The acceptance criterion, and it is not satisfied by the upload succeeding:

```bash
cd $(mktemp -d)
uv venv && uv pip install --no-cache "visionset==0.0.1b2"
visionset --version          # the version you tagged
visionset format list        # eleven rows: ultralytics, yolov5-yaml, coco, voc, classification, dummy and the five lane formats
```

`format list` is the useful one: it reads installed entry-point metadata, so a non-empty answer
proves the distribution was assembled correctly and not merely uploaded. Then confirm the other
half of the thesis - `visionset init` somewhere, `visionset server`, and open `/app`.
