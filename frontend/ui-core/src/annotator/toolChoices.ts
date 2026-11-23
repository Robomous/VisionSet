/**
 * What the tool strip lists for a schema, and whether a held class can produce a
 * shape. Plain functions over the schema, kept apart from the strip's component
 * so the component file exports components only.
 */

import {
  drawableGeometries,
  hotkeyForClass,
  type AnnotationSchema,
  type GeometryType,
  type Tool,
} from "@visionset/annotator";

import { geometryLabel } from "../data/geometryCategory";

/**
 * Why a declared geometry has no tool yet, keyed by the geometry.
 *
 * **Empty**, and kept rather than deleted along with its last entry.
 * The mechanism is what earns its place: the day `mask` or `keypoints` is declared
 * in a schema, the strip says so without anyone remembering that it should, and
 * that is a property worth more than the twelve lines it costs.
 *
 * The record is typed on `string` rather than on the geometry union so an entry
 * can name a geometry `drawableGeometries` never returns, which is the case it
 * exists for.
 */
const PENDING_TOOLS: Readonly<Record<string, string>> = {};

/**
 * What each drawing tool is called on the strip.
 *
 * Read off the product's one geometry vocabulary rather than kept here. This used
 * to be a private map saying `Box` while every other surface printed `bbox`, so
 * the same tool had two names depending on which side of the canvas you read it
 * from. `geometryLabel` is now the single source; this only capitalises, because
 * a control label takes a capital and a word inside a sentence does not.
 */
function toolLabel(geometry: GeometryType): string {
  const word = geometryLabel(geometry);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A schema's tools, in the order the strip lists them. */
export interface ToolChoice {
  /** A real `Tool`, or a geometry the strip shows as not-yet-drawable. */
  readonly tool: Tool | keyof typeof PENDING_TOOLS;
  readonly label: string;
  /** The class this button activates — `null` is select mode. */
  readonly labelClass: string | null;
  readonly hotkey: string;
  /**
   * Why this tool cannot be picked, or `null` when it can.
   *
   * Disabled-with-reason rather than hidden: see the module docstring. A button
   * carrying this never calls `onActivateClass`, because activating a class whose
   * tool does not exist would leave the canvas in `select` with a lane class held
   * — inert, and indistinguishable from a canvas with no tool strip at all.
   */
  readonly unavailable: string | null;
}

/**
 * The tools this schema can reach, `select` first.
 *
 * A geometry is represented by the **first** class declaring it, in authored
 * order, which is the same order `classHotkeys` binds the digit row in. Nothing
 * here dedupes by class: two bbox classes are one bbox tool.
 *
 * **`activeClass` narrows it.** With a class selected the strip offers only that
 * class's own geometries, because those are the only shapes a gesture could
 * produce — a bbox button that armed a different class the moment it was pressed
 * would answer "what can I draw here?" with something about somewhere else. With
 * none selected it is the union, which is what the strip has always shown and is
 * still the right answer to "what does this project label?".
 *
 * A class is only narrowed *to* when it can be drawn: selecting a pure tag class
 * leaves the full union rather than emptying the strip, since the tag lives in a
 * panel and the strip would otherwise vanish for a reason nothing on it explains.
 */
export function toolChoices(
  schema: AnnotationSchema,
  activeClass: string | null = null,
): readonly ToolChoice[] {
  const selected = schema.classes.find((declared) => declared.name === activeClass);
  const narrowed =
    selected !== undefined && drawableGeometries(selected).length > 0 ? selected : undefined;
  const offered = narrowed === undefined ? schema.classes : [narrowed];

  const choices: ToolChoice[] = [
    { tool: "select", label: "Select", labelClass: null, hotkey: "V", unavailable: null },
  ];
  for (const declared of offered) {
    for (const geometry of drawableGeometries(declared)) {
      if (choices.some((choice) => choice.tool === geometry)) continue;
      choices.push({
        tool: geometry,
        label: toolLabel(geometry),
        labelClass: declared.name,
        hotkey: hotkeyForClass(schema, declared.name) ?? "—",
        unavailable: null,
      });
    }
  }
  // After the usable tools, never interleaved: the strip reads top to bottom as
  // "what you can do", and a disabled control in the middle of that list reads as
  // a broken one rather than as a coming one.
  //
  // Read off `schema.classes` rather than `offered`, deliberately: a geometry with
  // no tool is a fact about the *project*, and hiding it while a class is selected
  // would make the explanation come and go with the selection.
  for (const declared of schema.classes) {
    for (const geometry of declared.geometries) {
      const pending = PENDING_TOOLS[geometry];
      if (pending === undefined) continue;
      if (choices.some((choice) => choice.tool === geometry)) continue;
      choices.push({
        tool: geometry,
        label: geometry,
        // No class to activate, because there is no tool to activate it for.
        labelClass: null,
        hotkey: "—",
        unavailable: pending,
      });
    }
  }
  return choices;
}

/** Whether the held class can produce this shape. `false` when it holds none. */
export function accepts(
  schema: AnnotationSchema,
  activeClass: string | null,
  tool: ToolChoice["tool"],
): boolean {
  const declared = schema.classes.find((one) => one.name === activeClass);
  return declared !== undefined && drawableGeometries(declared).some((one) => one === tool);
}
