# Releasing

## What ships

PyPI receives a wheel and source distribution. The wheel includes the Python SDK, CLI, REST API,
MCP server, and compiled browser app. The [packaging tests](../../tests/packaging) verify that the
installed wheel serves the app.

The npm release contains `@visionset/annotator`, `@visionset/media`, and `@visionset/ui-core`.
`@visionset/app` is private and its bundle ships in the Python wheel. The browser inference package
ships with the app bundle. The agent plugin has its own manifests, generated from the same
repository version.

Use the [PyPI release history](https://pypi.org/project/visionset/#history) to find published versions
and [GitHub Releases](https://github.com/Robomous/VisionSet/releases) for the notes tied to each tag.
A published version is immutable. Publish a new version to make a correction.

## The npm scope

Publish with pnpm so it rewrites `workspace:*` dependencies to concrete versions during packing.
Publish annotator and media before ui-core, which depends on both. The media package includes its
browser decoding worker and [third-party notices](../../THIRD-PARTY-NOTICES.md).

Use the `latest` dist-tag while every published version is a prerelease. Once a stable release
exists, use `beta` for prereleases and keep `latest` on the stable line. Trusted publishing can
publish a package, but changing a dist-tag after publication requires an authenticated npm session.

## Cutting a release

### 1. Bump the version

Edit the repository's [`VERSION`](../../VERSION) file. Use the [versioning guide](../../CONTRIBUTING.md#versioning)
to map the Python version to npm semver and the Git tag.

```bash
pnpm version:sync
pnpm version:check
python3 agent-plugins/tools/render_manifests.py
uv sync --locked --reinstall-package visionset
uv run python scripts/export_openapi.py
```

Reinstalling refreshes the editable package metadata used by the OpenAPI generator. A version-only
bump updates `info.version` in `openapi.json`. The generated TypeScript client can stay unchanged
because it consumes the API operations and schemas.

### 2. Run the release checks

Follow the [release gate](../../CONTRIBUTING.md#the-release-gate) and make sure CI is green for the
commit you will tag. Exercise the built artifacts locally:

```bash
bash scripts/build_dist.sh
VISIONSET_REQUIRE_WHEEL=1 uv run pytest tests/packaging
uv run python examples/thirty_minute_flow.py
bash scripts/verify_npm_packages.sh
```

### 3. Tag the release

Set `release_tag` to the `v`-prefixed npm version produced by `pnpm version:sync`. Confirm the tagged
commit contains the intended `VERSION` before pushing.

```bash
release_tag="v$(node -p 'require("./frontend/ui-core/package.json").version')"
git tag "$release_tag"
git show "$release_tag:VERSION"
git push origin "$release_tag"
```

### 4. Publish to PyPI and GitHub

Dispatch [the PyPI workflow](../../.github/workflows/publish-pypi.yml) against the release tag. The
workflow builds the wheel and source distribution from that ref and uploads them through PyPI
Trusted Publishing.

```bash
gh workflow run publish-pypi.yml --ref "$release_tag"
```

After the workflow succeeds, create the GitHub Release for the same tag. Prepare `notes.md` from the
corresponding section of [CHANGELOG.md](../../CHANGELOG.md). Include `--prerelease` for a beta.

```bash
gh release create "$release_tag" --verify-tag --prerelease \
  --title "VisionSet $(cat VERSION)" --notes-file notes.md
```

### 5. Publish the npm packages

Dispatch [the npm workflow](../../.github/workflows/publish-npm.yml) against the same tag. The workflow
packs the packages, checks that their dependencies resolve to concrete versions, and publishes them
in dependency order using npm Trusted Publishing.

```bash
gh workflow run publish-npm.yml --ref "$release_tag" -f dist-tag=latest
```

### 6. Verify it from outside

Use fresh directories so local workspace packages and editable installs cannot mask a packaging
problem. Run these commands from the tagged checkout after both workflows finish:

```bash
python_version=$(cat VERSION)
npm_version=$(node -p 'require("./frontend/ui-core/package.json").version')

(
  cd "$(mktemp -d)"
  uv venv
  uv pip install --no-cache "visionset==$python_version"
  .venv/bin/visionset --version
  .venv/bin/visionset format list
  .venv/bin/visionset init ./workspace
  .venv/bin/visionset server --workspace ./workspace
)

(
  cd "$(mktemp -d)"
  npm init -y >/dev/null
  npm install --no-save "@visionset/ui-core@$npm_version"
  node -p 'require("./node_modules/@visionset/ui-core/package.json").dependencies'
)
```

While the server runs, open `http://127.0.0.1:8000/app` and confirm the browser app loads. Stop the
server to continue to the npm check. The installed ui-core package should list concrete versions
of annotator and media. If npm returns a 404 immediately after publishing, retry after registry
replication has had time to complete.
