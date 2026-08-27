# shadcn canonical snapshots

Each file here is exactly what `shadcn@4.19.0 add <name>` wrote for this
package's `components.json` (radix-nova, preset b2iH), before the import
relativisation `scripts/shadcn_relativize.mjs` applies. `tests/scripts/shadcn_canonical.test.mjs`
holds every `src/primitives/<name>.tsx` to its snapshot plus added lines only.
Regenerate with `pnpm --filter @visionset/ui-core shadcn:add <name>`; never edit by hand.

The gate matches the snapshot as an **ordered subsequence**, so a green run is a
strong signal rather than a proof: an edited line whose original text also appears
further down — including on a line that was added — still satisfies the match, and
the edit goes unreported. Read the diff when a primitive changes; the gate does not
stand in for that.
