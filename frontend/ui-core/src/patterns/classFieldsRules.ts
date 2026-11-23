/**
 * What the class fields show about a class, as plain functions and constants: the
 * sentence under the shape group, a class's swatch colour, the `#rrggbb` a colour
 * input takes, and the palette the colour popover offers. Kept apart from the
 * fields' components so that file exports components only.
 */

import type { GeometryType, LabelClassBody } from "../screens/queries";
import { classColor, hexColor } from "../palette";

/**
 * What the chosen set means, said once under the group.
 *
 * The hint used to read *"Singular — picking a class picks a tool"*, which is no
 * longer true: a class accepts a set, and picking one narrows the tool strip
 * rather than deciding it. Naming the count rather than restating the rule keeps
 * the sentence useful in the case somebody is most likely to have got wrong —
 * having ticked one box and not realised a second was allowed.
 */
export function describeGeometries(geometries: readonly GeometryType[]): string {
  if (geometries.length <= 1) {
    return "One shape for now. Tick another and this class accepts both.";
  }
  return `An annotation of this class may be any of the ${geometries.length}.`;
}

/**
 * `classColor`'s answer for one drafted class.
 *
 * `classColor` takes the annotator's `LabelClass`; the wire's `LabelClassBody` is
 * the same four fields with `attributes` shaped differently. Rebuilt rather than
 * cast or spread, so the two shapes stay two shapes: the wire mirror and the
 * engine's model are deliberately separate types, and the *one* place they meet
 * should be an explicit projection.
 *
 * The index stands in for an unnamed class, so a row created a second ago has a
 * stable colour instead of every empty name deriving the same hue.
 */
export function swatchOf(declared: LabelClassBody, index: number): string {
  return classColor(
    {
      name: declared.name,
      geometries: declared.geometries,
      color: declared.color ?? null,
      attributes: [],
    },
    declared.name || `class-${index}`,
  );
}

/**
 * A colour input needs `#rrggbb` and nothing else.
 *
 * This used to answer a flat `#888888` for anything that was not already a hex,
 * which meant **every derived class showed grey** — `classColor`'s derived branch
 * returns `hsl(...)`. The dot beside the class name shows the real colour and the
 * annotator draws the real colour, so a grey input is the one control whose entire
 * job is to show what colour something is disagreeing with both.
 *
 * `hexColor` converts instead, so the preview is the truth. The neutral survives
 * for the case it was always right about: a schema authored elsewhere may hold any
 * CSS spelling — `rgb(255 0 0)`, `rebeccapurple` — and shipping a CSS colour parser
 * to fill in one input is not worth it. The dot still shows the real thing.
 */
export function hexOf(color: string): string {
  return hexColor(color) ?? "#888888";
}

/**
 * The class palette: twelve hues the class sheet's colour offers before the
 * custom picker. Suggestions for a *declared* colour and nothing more — a class with
 * none still takes `classColor`'s hue derived from its name, and **From the
 * name** goes back to it. Far enough apart to tell labels apart at the
 * canvas's fill, and saturated enough to read on a night-shift frame.
 */
export const CLASS_PALETTE = [
  "#DB2777",
  "#2563EB",
  "#D97706",
  "#059669",
  "#0D9488",
  "#7C3AED",
  "#0891B2",
  "#65A30D",
  "#EA580C",
  "#C026D3",
  "#0284C7",
  "#4F46E5",
] as const;
