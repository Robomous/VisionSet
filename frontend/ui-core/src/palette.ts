/**
 * The class palette — one spelling, and it is **not written here**.
 *
 * ## Why this module re-exports instead of implementing
 *
 * Porting v1's `getClassPalette` — a schema colour when there is one, else
 * `hash = hash * 31 + charCode` over the lowercased name, `hsl(hue 75% 48%)` for
 * the stroke — would be a **second** spelling. `classColor` ships with the React
 * adapter, is unit-tested there, and is what the canvas actually draws with, so a
 * second formula would give a side panel whose swatches disagree with the shapes
 * beside them.
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
 * The panel swatches and the gallery badges import from here. The
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

/**
 * `classColor`'s answer as `#rrggbb`, or `null` when it cannot be one.
 *
 * `<input type="color">` accepts **only** `#rrggbb`. Anything else — including a
 * perfectly valid CSS colour — leaves the control on its own default, which is
 * black in every browser and reads as grey through the design system's border.
 * The failure it prevents: a class with no declared colour showing its derived
 * hue in the dot beside its name and **grey** in the swatch two inches to the
 * right, in the one control whose whole job is to show what colour something is.
 *
 * So this converts rather than gives up, and the derived branch is exactly the
 * case it has to handle: `classColor` answers `hsl(h 72% 58%)` there, which is a
 * closed form this module produced and can therefore convert without parsing CSS
 * in general.
 *
 * **It is a conversion, never a second palette.** `classColor` stays the one
 * spelling of the rule, and the reason this module re-exports rather than
 * re-implements; this only changes the notation.
 *
 * `null` for anything else, and that is honest rather than lazy: the kernel
 * accepts any CSS spelling in `LabelClass.color`, so a schema authored elsewhere
 * may legitimately hold `rgb(255 0 0)` or `rebeccapurple`. Guessing a hex for
 * those would mean shipping a CSS colour parser to fill in one input. A caller
 * shows its own neutral and the dot beside it still shows the truth.
 */
export function hexColor(color: string): string | null {
  const trimmed = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  // `#abc` is legal CSS and is not what the input takes.
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(trimmed);
  if (short !== null) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  }
  // Space-separated is what `classColor` emits; commas are accepted too, because
  // a schema stored by something else may well use the older spelling and the
  // conversion costs one character in the pattern.
  const hsl = /^hsl\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*\)$/.exec(trimmed);
  if (hsl === null) return null;
  return hslToHex(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
}

/** The CSS Color 4 conversion, written out rather than pulled in. */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const [red, green, blue] = (
    [
      [chroma, second, 0],
      [second, chroma, 0],
      [0, chroma, second],
      [0, second, chroma],
      [second, 0, chroma],
      [chroma, 0, second],
    ] as const
  )[Math.floor(sector) % 6];
  const base = lightness - chroma / 2;
  const channel = (value: number): string =>
    Math.round((value + base) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}
