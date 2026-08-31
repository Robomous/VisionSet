# VisionSet design foundations

The design system — the shadcn Nova foundation, its tokens, the primitive governance, the
status palette, and the gates that hold all of it — lives in
[Robomous/ui-core](https://github.com/Robomous/ui-core), consumed here as `@robomous/ui-core`.
That repository's `DESIGN.md` is the governing document; what follows is only what is
VisionSet's own: the extension registry, where the brand paints, and which gate holds each
rule in this repo.

## VisionSet extensions

Everything VisionSet owns above the foundation, each following shadcn's extension convention —
a value in `:root`, a dark counterpart in `.dark`, exposure through `@theme inline` — in
`frontend/ui-core/src/styles.css`, mirrored by `src/tokens.ts`:

| Extension | Rule |
| --- | --- |
| `stage` | The annotator's surround — the neutral a photograph is judged against. Its own role: not `muted`'s subtle fill, not `card`'s surface, distinguishable from `background` so a white asset edge still shows where it ends. Usage: [`docs/content/ui/annotator.md`](docs/content/ui/annotator.md#the-stage) |
| `origin-hub` / `origin-custom` / `origin-robomous` | A model's provenance, as a card's accent edge. A mark: never a surface, never ink, and an origin is a kind rather than a state, so these never stand in for a status. Theme-stable, like the chart palette |
| `--spacing-sidebar` / `--spacing-sidebar-collapsed` | 240px and 48px, consumed by `AppShell`, its collapse toggle and the content offset, which must agree or the layout jumps on collapse. The collapsed width is the preset's own icon-sidebar width, so with the rail's `p-2` it holds exactly one `size-8` control per row |
| `--spacing-project-nav` / `--container-page` | 180px project-nav column; the 96rem page cap |

An extension that turns out to be universal is a candidate to move into the package — that is
a design decision and a PR against Robomous/ui-core, with the justification written into its
`DESIGN.md`.

## Where the brand is

Robomous coral is identity: the `AppShell` wordmark and its styleguide swatch. Two sites,
enumerated in `tests/scripts/design_tokens.test.mjs`. A functional control reaching for `brand`
is a semantic-colour violation however many other sites already use it correctly, and the gate
and this section move together or not at all.

## Verification

| Gate | Holds |
| --- | --- |
| `frontend/ui-core/src/tokens.test.ts` | The extension stylesheet and token module agree declaration for declaration; no extension shadows a foundation name; the merged `LIGHT_THEME`/`DARK_THEME` view lost nothing |
| `tests/scripts/design_system.test.mjs` | Vocabulary discipline over VisionSet's own sources: no retired shapes, no status colour outside the packaged Badge/statusTone, no rival palette, no retired token utilities, `menuSurface` on every menu |
| `tests/scripts/design_tokens.test.mjs` | No colour in a class string; `brand` confined to its two identity sites; no retired declaration in the extension stylesheet; one icon library; no `tailwind.config.js` |

The scan helpers those gates run come from `@robomous/ui-core/gates`, versioned with the
primitives they describe. A rule no gate holds is a rule under review, not an exemption.
