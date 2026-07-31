/**
 * The class palette — one spelling, and it is **not written here**.
 *
 * ## Why this module re-exports instead of implementing
 *
 * #128 was filed asking for v1's `getClassPalette` to be ported: a schema colour
 * when there is one, else `hash = hash * 31 + charCode` over the lowercased name,
 * `hsl(hue 75% 48%)` for the stroke and a separate fill, selected and label hue.
 *
 * That port would have been a **second** spelling. `classColor` already shipped
 * with the React adapter (#47), is unit-tested there, and is what the canvas
 * actually draws with — so porting v1's formula would have given a side panel
 * whose swatches disagree with the shapes beside them, which is precisely the
 * failure the "one spelling" acceptance criterion exists to prevent. `DESIGN.md`
 * was corrected to record the shipped rule; this module is that correction in
 * code.
 *
 * The shipped rule, for the record:
 *
 * - a class **with** `LabelClass.color` uses it — the kernel's own docstring
 *   settles the precedence;
 * - a class **without** one falls back to FNV-1a over the name →
 *   `hsl(hash % 360 72% 58%)`, stable per class, per session, per machine.
 *
 * The fill is that colour at an opacity the *shape* applies rather than a second
 * value baked in here, because the kernel accepts any CSS spelling of a colour and
 * `#ff0000` and `rgb(255 0 0)` are both legal — so alpha cannot be composed
 * without parsing. v1's four-value palette is not ported for the same reason: the
 * three extra values were an alpha and two hue shifts a renderer can apply itself.
 *
 * The panel swatches (#126) and the gallery badges (#55) import from here. The
 * canvas imports from `@visionset/annotator` directly. Both reach the same
 * function.
 */

export { classColor } from "@visionset/annotator";
export type { LabelClass } from "@visionset/annotator";

/**
 * The opacity a filled shape applies to `classColor`'s answer.
 *
 * v1 baked `0.20` into its palette; the annotator's shapes apply it at render.
 * Naming it here is what lets a swatch, a badge and a canvas shape agree on how
 * strong a fill is without any of them knowing how the colour was chosen.
 */
export const CLASS_FILL_OPACITY = 0.2;
