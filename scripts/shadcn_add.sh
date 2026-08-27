#!/usr/bin/env bash
# Runs from frontend/ui-core (pnpm --filter sets the cwd). Writes the CLI's
# pristine output to shadcn/<name>.tsx, then relativises src/primitives/<name>.tsx.
set -euo pipefail
[ "$#" -gt 0 ] || { echo "usage: pnpm shadcn:add <component>..." >&2; exit 2; }
# `pnpm dlx`, not `npx`: pnpm is the only package manager here, and a fetch-and-run
# of an uninstalled package is exactly what the cool-down governs (cooldown.test.mjs).
pnpm dlx shadcn@4.19.0 add "$@" --overwrite --yes
mkdir -p shadcn
for name in "$@"; do
  cp "src/primitives/$name.tsx" "shadcn/$name.tsx"
  node ../../scripts/shadcn_relativize.mjs "src/primitives/$name.tsx"
done
