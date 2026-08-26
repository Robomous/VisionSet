# shadcn canonical snapshots

Each file here is exactly what `shadcn@4.19.0 add <name>` wrote for this
package's `components.json` (radix-nova, preset b2iH), before the import
relativisation `scripts/shadcn_relativize.mjs` applies. `tests/scripts/shadcn_canonical.test.mjs`
holds every `src/primitives/<name>.tsx` to its snapshot plus added lines only.
Regenerate with `pnpm --filter @visionset/ui-core shadcn:add <name>`; never edit by hand.
