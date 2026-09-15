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

**Three npm packages.** `@visionset/annotator`, `@visionset/media` and `@visionset/ui-core` are
published as libraries, at the same version as the wheel; the app compiled into the wheel consumes
the same three through the workspace. `@visionset/app` is the product shell and is explicitly
never published - it is `private: true`, and its bundle ships inside the wheel. See
[the scope](#the-npm-scope).

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

`@visionset` is a registered npm organisation holding the three published packages.
`pnpm version:sync` translates `VERSION` into npm semver (`0.0.1b3` → `0.0.1-beta.3`) and
`pnpm version:check` gates the drift, so the npm versions are never chosen - they are derived.

`@visionset/media` is the video-import core plus a mediabunny-backed browser adapter: sampling
policy and grid arithmetic in a plain, framework-free entrypoint (`@visionset/media`), and the
concrete decoder behind a `./mediabunny` subpath so a host chooses the adapter rather than having
one forced on it. It bundles its own module worker (`dist/mediabunny/worker.js`) so the adapter
has no bare specifier to resolve at runtime, and it redistributes mediabunny (MPL-2.0, unmodified)
under [`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md), carried into its own tarball.

**`pnpm publish`, never `npm publish`.** `@visionset/ui-core` declares both
`"@visionset/annotator": "workspace:*"` and `"@visionset/media": "workspace:*"`. pnpm rewrites
those to the concrete versions as it packs; npm ships the literal `workspace:*` string, and the
published package is then uninstallable by anybody. This is also why the packages are published in
dependency order - **annotator, then media, then ui-core** - so the versions ui-core's rewritten
dependencies name already exist on the registry. annotator and media are independent leaves
(neither depends on the other or on ui-core); ui-core is the one package that depends on both, so
it is always published last.

**Publish under `latest`, not `beta`, for as long as every published version is a prerelease.**
The usual advice is the opposite, and the reason it does not apply here is worth stating. That
convention exists so a bare `npm install` does not hand somebody a prerelease when a stable release
exists. No stable release exists: `0.0.1-beta.1` onward is the entire history. Publishing under
`beta` therefore protects nobody, and because npm sets `latest` on a first publish whatever tag is
asked for and `latest` can only be repointed afterwards, it leaves `latest` stuck on an *older*
beta - `npm install @visionset/ui-core` then resolves to the previous release while the newer one
is unreachable without naming a tag. `pip install visionset` already resolves to the newest, since
pip falls back to prereleases when no stable exists, so the two registries disagreed about what
"the current release" means.

**Change back to `--tag beta` the day a stable version ships**, when `latest` must mean the stable
line and the convention starts protecting someone.

**A tag can only be chosen at publish time.** npm's trusted publishing authorises `npm publish` and
nothing else, so `npm dist-tag add` cannot repoint a tag from the workflow (npm/cli#8547). Fixing a
tag after the fact needs an authenticated human - `npm login`, then
`npm dist-tag add <pkg>@<version> latest` - which is the whole reason to get it right at dispatch.

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

**The publish path is [`.github/workflows/publish-npm.yml`](../../.github/workflows/publish-npm.yml),
and like the PyPI one it needs no credentials from anybody.** It is `workflow_dispatch` only, so a
human starts it deliberately, and it is dispatched against the tag for the same reason:

```bash
gh workflow run publish-npm.yml --ref v0.0.1-beta.3 -f dist-tag=latest
gh run watch "$(gh run list --workflow=publish-npm.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

**No token exists anywhere, and that is the design.** `id-token: write` lets the job mint an OIDC
token that npm exchanges for a short-lived upload credential. The configuration lives on each
package's npm settings page and names the workflow **by filename**, exactly as PyPI's names
`publish-pypi.yml`; it also carries a separate *allow `npm publish`* permission, without which the
exchange succeeds and the upload is refused. A wrong field there surfaces only when a publish is
attempted — there is nothing that validates it beforehand.

**The order inside the workflow is load-bearing**, for the reason in
[the scope](#the-npm-scope): ui-core's rewritten dependencies on annotator and media name versions
that have to exist on the registry already, so it publishes last. The workflow also packs all
three tarballs and fails if any still declares a `workspace:` dependency, because a published
version cannot be replaced.

**This needs pnpm 11 or newer, and the repository is on 12.** pnpm 10 could not perform the OIDC
exchange, and npm cannot do the `workspace:*` rewrite — so before pnpm 11 the two requirements
pulled in opposite directions and this step had to be done by hand with a one-time password.

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
node -e "console.log(require('./node_modules/@visionset/ui-core/package.json').dependencies)"
```

The printed dependencies must name concrete versions for `@visionset/annotator` and
`@visionset/media`, never `workspace:*`, and the install must have resolved both alongside
`ui-core`. `scripts/verify_npm_packages.sh` runs the same shape of check locally, before a
tag exists, against the packed tarballs rather than the published registry - including an
explicit assertion that `@visionset/media`'s tarball still carries `dist/mediabunny/worker.js`
and `THIRD-PARTY-NOTICES.md`, since neither failure would otherwise surface before a consumer hits
it at runtime.

`format list` is the useful one: it reads installed entry-point metadata, so a non-empty answer
proves the distribution was assembled correctly and not merely uploaded. Then confirm the other
half of the thesis - `visionset init` somewhere, `visionset server`, and open `/app`.
