#!/usr/bin/env bash
# Verifies the actual `@visionset/annotator`, `@visionset/media` and `@visionset/ui-core`
# npm tarballs — not the workspace `dist/`, which every other check reaches through
# a pnpm symlink and an already-built declaration file. #839: `tsc` with
# `moduleResolution: "bundler"` emitted extensionless relative specifiers that
# only a bundler resolves; Node's own ESM resolver does not. This packs all three
# tarballs and installs them in a lone project outside the workspace — no
# `pnpm-workspace.yaml` above it, so nothing here can resolve a package any way
# other than how installing these tarballs for real would.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$root"
# Built here rather than assumed fresh: a stale or missing `dist/` would let
# `pnpm pack` package yesterday's build and this script report a false pass —
# the one failure mode that would defeat the point of it.
#
# Dependency order — annotator and media are independent leaves, ui-core depends
# on both (`workspace:*`) and so is built and packed last.
pnpm --filter @visionset/annotator build >/dev/null
pnpm --filter @visionset/media build >/dev/null
pnpm --filter @visionset/ui-core build >/dev/null
pnpm --filter @visionset/annotator pack --pack-destination "$work" >/dev/null
pnpm --filter @visionset/media pack --pack-destination "$work" >/dev/null
pnpm --filter @visionset/ui-core pack --pack-destination "$work" >/dev/null

annotator_tgz=$(ls "$work"/visionset-annotator-*.tgz)
media_tgz=$(ls "$work"/visionset-media-*.tgz)
ui_core_tgz=$(ls "$work"/visionset-ui-core-*.tgz)

# `new URL('./worker.js', import.meta.url)` in the mediabunny adapter fails silently
# at runtime if a packaging change ever drops the worker file from the tarball —
# there is no import error to catch it, just a browser that never starts decoding.
# Asserted on the packed bytes, not the workspace `dist/`, for the same reason the
# whole script exists.
media_listing=$(tar -tzf "$media_tgz")
for wanted in "package/dist/mediabunny/worker.js" "package/THIRD-PARTY-NOTICES.md"; do
  if ! grep -qx "$wanted" <<<"$media_listing"; then
    echo "error: @visionset/media tarball is missing $wanted" >&2
    exit 1
  fi
done
echo "@visionset/media tarball carries dist/mediabunny/worker.js and THIRD-PARTY-NOTICES.md"

consumer="$work/consumer"
mkdir -p "$consumer"
cd "$consumer"

cat > package.json <<JSON
{
  "name": "visionset-package-consumer",
  "private": true,
  "type": "module",
  "dependencies": {
    "@visionset/annotator": "file:$annotator_tgz",
    "@visionset/media": "file:$media_tgz",
    "@visionset/ui-core": "file:$ui_core_tgz",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "tailwindcss": "^4.3.3"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "@types/react": "^19.3.0"
  }
}
JSON

# A lone `pnpm-workspace.yaml` (`overrides:` moved out of package.json's
# `pnpm` key as of pnpm 10 — the root one uses the same field) forces ui-core's
# own `@visionset/annotator` and `@visionset/media` dependencies (pnpm rewrote
# `workspace:*` to a concrete version when it packed) onto the same two
# tarballs, rather than letting resolution reach those versions on the real
# registry — the point is testing what was just built, not what is already
# published.
cat > pnpm-workspace.yaml <<YAML
packages:
  - "."
overrides:
  "@visionset/annotator": "file:$annotator_tgz"
  "@visionset/media": "file:$media_tgz"
YAML

pnpm install --no-frozen-lockfile --reporter=silent

# `ui-core` reaching back into the workspace for `@visionset/media` (or
# `@visionset/annotator`) instead of the tarball just installed would still pass
# every other check here — the import would resolve, just to the wrong bytes.
# `realpath` catches that: none of the three may resolve inside this repository.
for pkg in "@visionset/annotator" "@visionset/media" "@visionset/ui-core"; do
  resolved=$(node -e "console.log(require('node:fs').realpathSync(require('node:path').join('node_modules', process.argv[1])))" "$pkg")
  case "$resolved" in
    "$root"/*)
      echo "error: $pkg resolved into the workspace at $resolved instead of its tarball" >&2
      exit 1
      ;;
  esac
done
echo "no dependency resolved back into the workspace"

cat > esm-check.mjs <<'JS'
import "@visionset/annotator";
import "@visionset/ui-core";
// The core entrypoint on its own: plain Node has no browser globals, so an
// import that touches one (window, document, self, …) throws here rather than
// merely at type-check time.
import "@visionset/media";
console.log("Node ESM import OK: @visionset/annotator, @visionset/ui-core, @visionset/media (core)");
JS
node esm-check.mjs

# `moduleResolution: "nodenext"` here is correct for this fixture — it *is* a
# plain Node consumer — and unrelated to what our own source tree uses. Both
# `@visionset/media` entrypoints are checked: the core (`.`) and the browser
# adapter subpath (`./mediabunny`, type-only here — it is never imported at
# runtime by a plain Node consumer).
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "jsx": "react-jsx",
    "types": ["react"],
    "noEmit": true
  },
  "include": ["ts-check.ts"]
}
JSON

cat > ts-check.ts <<'TS'
import "@visionset/annotator";
import "@visionset/ui-core";
import "@visionset/media";
import type { MediabunnyVideoMaterializer } from "@visionset/media/mediabunny";
export type { MediabunnyVideoMaterializer };
TS

pnpm exec tsc -p tsconfig.json
echo "TypeScript consumer resolved @visionset/annotator, @visionset/ui-core, @visionset/media and @visionset/media/mediabunny under nodenext OK"
