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

**Two npm packages.** `@visionset/annotator` and `@visionset/ui-core` are published as
libraries, at the same version as the wheel; the app compiled into the wheel consumes the same two
through the workspace. `@visionset/app` is the product shell and is explicitly never published -
it is `private: true`, and its bundle ships inside the wheel. See [the scope](#the-npm-scope).

## Where the beta ships: **PyPI, as `0.0.1b1`**

Decided for #69, and the argument is short. It is written about the *first* beta because that is
when it was made; the current version is **`0.0.1b3`**. A published version is never edited in place - a
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

`@visionset` is a registered npm organisation holding the two published packages.
`pnpm version:sync` translates `VERSION` into npm semver (`0.0.1b3` → `0.0.1-beta.3`) and
`pnpm version:check` gates the drift, so the npm versions are never chosen - they are derived.

**`pnpm publish`, never `npm publish`.** `@visionset/ui-core` declares
`"@visionset/annotator": "workspace:*"`. pnpm rewrites that to the concrete version as it packs;
npm ships the literal `workspace:*` string, and the published package is then uninstallable by
anybody. This is also why the two are published in dependency order - annotator first, so the
version ui-core's rewritten dependency names already exists on the registry.

**`--tag beta` does not keep `latest` clear on a package's first version.** npm sets `latest` on a
first publish whatever tag is asked for, and `latest` cannot be unset afterwards - only repointed.
Both packages therefore carry `latest` from `0.0.1-beta.2` onwards; a stable release will repoint
it.

**A fresh publish 404s for up to about ninety seconds.** `npm view` and `npm install` answer 404
while `npm dist-tag ls` already serves the new version. That is registry replication, not a failed
publish - poll before concluding anything.

## Cutting a release

Everything up to the tag is done from a working copy. Publishing is done by a workflow, over
trusted publishing, so no step below asks anybody for a credential.

### 1. Bump the version

`VERSION` at the repository root is the single source of truth - hatchling reads it for the
Python distribution and `pnpm version:sync` propagates it to every `frontend/*` package.

```bash
echo "0.0.1b3" > VERSION
pnpm version:sync
pnpm version:check                                  # must be clean
uv sync --reinstall-package visionset               # refresh the installed dist metadata
uv run python scripts/export_openapi.py             # the spec embeds the version
```

`openapi.json` embeds `info.version`, so **a version bump always moves the spec**. The generated
TypeScript client contains only `paths`, `components` and `operations`, so it does *not* move -
`pnpm generate:client:check` staying quiet after a bump is correct, not suspicious.

**The reinstall is not optional, and skipping it fails silently.** The version reaches the running
app through the *installed* distribution's metadata, which an editable install wrote at install
time - so an export run straight after editing `VERSION` rewrites the spec with the version the
environment still holds, and the diff is empty. An empty `openapi.json` diff after a bump means the
reinstall was skipped, never that the spec does not carry the version. `uv.lock` records no version
for the editable root, so it does not move and `uv sync --locked` stays clean.

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
git tag v0.0.1-beta.3 && git push origin v0.0.1-beta.3
```

Tag names are `v`-prefixed npm-semver (`v0.0.1-beta.3`); the distribution version is PEP 440
(`0.0.1b3`). They are the same version written two ways, and
[CONTRIBUTING.md](../../CONTRIBUTING.md#versioning) has the table.

### 4. Publish

**The publish path is [`.github/workflows/publish-pypi.yml`](../../.github/workflows/publish-pypi.yml),
and it needs no credentials from anybody.** It is `workflow_dispatch` only, so a human starts it
deliberately; run `30801065205` used it to publish `0.0.1b2` on 2026-08-03.

```bash
gh workflow run publish-pypi.yml --ref v0.0.1-beta.3
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
gh release create v0.0.1-beta.3 --title "…" --notes-file notes.md
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

### 5. Publish the npm packages

**Publishing needs a one-time password, so it is a hand step and cannot be automated.** The npm
account carries two-factor auth on writes; no token in this repository or in CI can answer that
challenge. `pnpm login --registry https://registry.npmjs.org` first if `npm whoami` does not
already name the publishing account.

```bash
bash scripts/build_dist.sh                                  # or: pnpm -r build
pnpm --filter @visionset/annotator publish --access public --tag beta
pnpm --filter @visionset/ui-core   publish --access public --tag beta
```

**The order is load-bearing**, for the reason in [the scope](#the-npm-scope): ui-core's rewritten
dependency on annotator names a version that has to exist already.

Both packages are built by `tsc` before packing, and `pnpm publish` refuses a tree with
uncommitted changes unless told otherwise — so publish from the tagged commit, clean. Check what
is about to leave with `pnpm --filter <pkg> pack` and read the tarball: `dist/` must be in it, and
`workspace:*` must **not** appear in the packed `package.json`.

### 6. Verify it from outside

The acceptance criterion, and it is not satisfied by the upload succeeding:

```bash
cd $(mktemp -d)
uv venv && uv pip install --no-cache "visionset==0.0.1b3"
visionset --version          # the version you tagged
visionset format list        # eleven rows: ultralytics, yolov5-yaml, coco, voc, classification, dummy and the five lane formats
```

And the npm half, which has its own failure mode - a package that installs and then cannot
resolve its own dependency:

```bash
cd $(mktemp -d) && npm init -y >/dev/null
npm install --no-save @visionset/ui-core@0.0.1-beta.3
node -e "console.log(require('./node_modules/@visionset/ui-core/package.json').dependencies['@visionset/annotator'])"
```

The last line must print a concrete version, never `workspace:*`, and the install must have
resolved `@visionset/annotator` alongside it.

`format list` is the useful one: it reads installed entry-point metadata, so a non-empty answer
proves the distribution was assembled correctly and not merely uploaded. Then confirm the other
half of the thesis - `visionset init` somewhere, `visionset server`, and open `/app`.
