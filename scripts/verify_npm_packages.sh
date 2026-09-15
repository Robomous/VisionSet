#!/usr/bin/env bash
# Verifies the actual `@visionset/annotator` and `@visionset/ui-core` npm
# tarballs — not the workspace `dist/`, which every other check reaches through
# a pnpm symlink and an already-built declaration file. #839: `tsc` with
# `moduleResolution: "bundler"` emitted extensionless relative specifiers that
# only a bundler resolves; Node's own ESM resolver does not. This packs both
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
pnpm --filter @visionset/annotator build >/dev/null
pnpm --filter @visionset/ui-core build >/dev/null
pnpm --filter @visionset/annotator pack --pack-destination "$work" >/dev/null
pnpm --filter @visionset/ui-core pack --pack-destination "$work" >/dev/null

annotator_tgz=$(ls "$work"/visionset-annotator-*.tgz)
ui_core_tgz=$(ls "$work"/visionset-ui-core-*.tgz)

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
# `pnpm` key as of pnpm 10 — the root one uses the same field) forces
# ui-core's own `@visionset/annotator` dependency (pnpm rewrote
# `workspace:*` to a concrete version when it packed) onto the same tarball,
# rather than letting resolution reach that version on the real registry —
# the point is testing what was just built, not what is already published.
cat > pnpm-workspace.yaml <<YAML
packages:
  - "."
overrides:
  "@visionset/annotator": "file:$annotator_tgz"
YAML

pnpm install --no-frozen-lockfile --reporter=silent

cat > esm-check.mjs <<'JS'
import "@visionset/annotator";
import "@visionset/ui-core";
console.log("Node ESM import OK: @visionset/annotator, @visionset/ui-core");
JS
node esm-check.mjs

# `moduleResolution: "nodenext"` here is correct for this fixture — it *is* a
# plain Node consumer — and unrelated to what our own source tree uses.
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
TS

pnpm exec tsc -p tsconfig.json
echo "TypeScript consumer resolved both packages under nodenext OK"
