/**
 * The suggest gesture's state: points placed, an answer pending, a preview
 * showing — and none of it in the document or in the command log (D4 on #424).
 *
 * ## Why this is beside `machine.ts` and not inside it
 *
 * `InteractionState` is what the *pointer* is in the middle of, and `machine.ts`
 * types its table as total over that union: every state owes a row, and every row
 * answers a pointer event synchronously. A suggestion is neither. It outlives the
 * press that asked for it, it is resolved by a server rather than by a
 * pointer-up, and it survives pointer-cancel, blur and a hundred pointer-moves.
 * A variant there would have to answer eight events it has no opinion about, and
 * the one event it *does* care about — an answer arriving — is not a pointer
 * event at all.
 *
 * So it is a second, small state machine living beside the first, in the same
 * directory for the same reason: interaction state that is not document state.
 * `AnnotatorCanvas` holds `InteractionState` in a `useState` and this is held the
 * same way, one layer further out — see "who holds it" below.
 *
 * ## Nothing here is in the undo stack, and that is structural rather than a rule
 *
 * The only way into `AnnotatorStore` is an `Effect`, and this module produces
 * none. It cannot add, stage, replace or commit; it has no store, no
 * `IdFactory` and no `Annotation`. Accepting is a separate, ordinary
 * `draftAnnotation` + `add`, which is one history entry like any other drawn
 * shape — `acceptedAnnotation` below is that one function, and it is the only
 * thing here that has ever heard of the document.
 *
 * Escape is the preview's undo, and it is `cleared()`: a pure transition back to
 * armed-with-nothing. `canUndo` never moves for a suggestion nobody accepted.
 *
 * ## Who holds it, and why not the adapter
 *
 * The **host** holds it. `AnnotatorCanvas` deliberately never fetches anything
 * ("the adapter never fetches anything, which is the 'no HTTP' half of the
 * embeddable contract"), and every transition here except `withPoint` is driven
 * by a response. A canvas holding this state would need a channel to ask for the
 * answer and a second to receive it, which is a host prop in both directions and
 * an extra copy of the state in between.
 *
 * What the adapter does own is the two things it is uniquely able to do: turning
 * a client position into an asset pixel, and drawing the preview. Both take the
 * state as a prop.
 *
 * ## `serial`, and the answer that arrives too late
 *
 * Clicks refine, so a second click leaves while the first answer is still in
 * flight — and a slow first answer landing after a fast second one would replace
 * a three-point preview with a one-point one. Every ask stamps a serial, and
 * `answered`/`refused` drop anything that does not name the current one.
 *
 * It is a plain counter rather than a timestamp because `Date.now` is a host
 * global this package cannot name, and because a counter is what makes a test
 * assert staleness by construction instead of by sleeping.
 *
 * ## What the server is asked, and what it is not
 *
 * The **accumulated** points go every time, never a diff: the route is stateless
 * by design, so "the model already knows about my first click" is not a thing
 * that can be true. `promptOf` is the projection, and it is here rather than in
 * the host so that the ordering rule — positives and negatives in the order they
 * were placed, each list on its own — has one owner.
 */

import { classNamed } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { IdFactory } from "../ids";
import type { Annotation, AnnotationSchema, Geometry, GeometryType, LabelClass, Point } from "../types";
import { draftAnnotation } from "./draft";

/**
 * The kinds a segmenter's answer can be narrowed into, and therefore the classes
 * the tool is offered for (D3).
 *
 * A mask becomes an outline or its extent, and nothing else: a `polyline` is an
 * open path, and answering one from a closed region would be inventing a lane
 * out of a silhouette. A `classification_tag` has no coordinates at all.
 *
 * The server holds the same list from the other end — a region it cannot express
 * in the kinds it was given comes back as `region: null` — so this is what stops
 * the product asking a question whose only honest answer is "nothing".
 */
export const SUGGESTIBLE_GEOMETRY_TYPES = ["bbox", "polygon"] as const satisfies readonly GeometryType[];

/** One of the two kinds a suggestion can be answered in. */
export type SuggestibleGeometryType = (typeof SUGGESTIBLE_GEOMETRY_TYPES)[number];

/** Whether a class can hold anything a segmenter is able to propose. */
export function isSuggestibleClass(labelClass: LabelClass): boolean {
  return (SUGGESTIBLE_GEOMETRY_TYPES as readonly string[]).includes(labelClass.geometry);
}

/**
 * The kinds the answer may come back in, for the class a suggestion will carry.
 *
 * A **list of one** for every class this build has, because `LabelClass.geometry`
 * is singular — `types.ts`: *"`geometry` is singular, and that is the rule an
 * annotator is built around"*. It is still a list, because that is the shape the
 * route takes and because the day a class declares a set, this function is the
 * only thing that changes.
 *
 * Empty for a class that can hold neither, which is the same fact
 * `isSuggestibleClass` reports and the reason the tool is not offered there.
 */
export function allowedGeometriesFor(
  labelClass: LabelClass,
): readonly SuggestibleGeometryType[] {
  return isSuggestibleClass(labelClass) ? [labelClass.geometry as SuggestibleGeometryType] : [];
}

/**
 * The class a press on the suggest tool should arm, or `null` when this schema
 * has none.
 *
 * The tool strip's own rule, applied: a press activates the class that derives
 * the tool asked for, and a press whose tool is already reachable moves nothing.
 * So an active class that can already hold a suggestion is kept — swapping it for
 * the schema's first suggestible class would silently change what the next shape
 * is labelled, which is `ToolPalette`'s consequence (1) exactly.
 */
export function suggestClassFor(
  schema: AnnotationSchema,
  activeClass: string | null,
): string | null {
  const held = schema.classes.find((declared) => declared.name === activeClass);
  if (held !== undefined && isSuggestibleClass(held)) return held.name;
  return schema.classes.find(isSuggestibleClass)?.name ?? null;
}

/** Whether this schema can reach the tool at all — what the strip button asks. */
export function schemaCanSuggest(schema: AnnotationSchema): boolean {
  return schema.classes.some(isSuggestibleClass);
}

/** What a click told the model: this is the thing, or this is not the thing. */
export type Polarity = "positive" | "negative";

/** One click, in asset pixels, and what it meant. */
export interface PromptPoint {
  readonly point: Point;
  readonly polarity: Polarity;
}

/** What the model proposed, already narrowed to a kind the class can hold. */
export interface Suggestion {
  readonly geometry: Geometry;
  /** `null` when the model reported none — a real answer, not a missing field. */
  readonly confidence: number | null;
  /** The model that proposed it, carried onto the annotation if it is accepted. */
  readonly modelRef: string;
}

/**
 * Where the session is.
 *
 * Five, and each is a different thing on screen: `idle` is an armed tool nobody
 * has clicked with, `asking` is a request in flight, `shown` has a preview,
 * `none` is a successful answer with nothing to propose, and `refused` is a
 * server refusal with prose to render.
 *
 * `none` is deliberately not folded into `idle`. They differ in exactly the way a
 * user cares about: one has been asked and answered, the other has not been
 * asked. Folding them would make a click on a patch of sky look like a click that
 * never happened.
 */
export type SuggestionStatus = "idle" | "asking" | "shown" | "none" | "refused";

/** The whole of a suggest session. `null`, in a host, is a tool that is not armed. */
export interface SuggestionState {
  /** The class the accepted annotation will carry. Fixed for the session. */
  readonly labelClass: string;
  /** Every click so far, in the order they were placed. */
  readonly points: readonly PromptPoint[];
  readonly status: SuggestionStatus;
  /** The preview, when there is one. Kept across `asking` so it does not flicker. */
  readonly suggestion: Suggestion | null;
  /** What the server refused with, in prose. Non-null only while `refused`. */
  readonly refusal: string | null;
  /** Which ask the state is waiting on — see the module note on staleness. */
  readonly serial: number;
}

/** What the route is sent: the accumulated points, split by what they meant. */
export interface Prompt {
  readonly positive: readonly Point[];
  readonly negative: readonly Point[];
}

/** A freshly armed session: this class, no points, nothing asked. */
export function armed(labelClass: string): SuggestionState {
  return {
    labelClass,
    points: [],
    status: "idle",
    suggestion: null,
    refusal: null,
    serial: 0,
  };
}

/**
 * A click: one more point, and a new ask.
 *
 * The previous `suggestion` is **kept** while the next answer is in flight. A
 * refine click that blanked the canvas and then repainted it would flicker on
 * every press, and the shape on screen is still the best answer anyone has until
 * a better one arrives.
 *
 * A previous refusal is dropped, because it was about the ask that is now
 * superseded. A person who clicks again is retrying, and leaving the old sentence
 * up would make the retry look like it had failed too.
 */
export function withPoint(
  state: SuggestionState,
  point: Point,
  polarity: Polarity,
): SuggestionState {
  return {
    ...state,
    points: [...state.points, { point, polarity }],
    status: "asking",
    refusal: null,
    serial: state.serial + 1,
  };
}

/** The points as the route wants them: two lists, each in placement order. */
export function promptOf(state: SuggestionState): Prompt {
  const positive: Point[] = [];
  const negative: Point[] = [];
  for (const placed of state.points) {
    (placed.polarity === "positive" ? positive : negative).push(placed.point);
  }
  return { positive, negative };
}

/**
 * An answer arrived. `null` is a successful answer with nothing to propose.
 *
 * A `serial` that is not the one being waited on is **dropped whole**, state
 * returned by identity — so a caller can compare with `toBe` and a slow first
 * answer cannot overwrite a fast second one.
 */
export function answered(
  state: SuggestionState,
  serial: number,
  suggestion: Suggestion | null,
): SuggestionState {
  if (serial !== state.serial) return state;
  if (suggestion === null) {
    return { ...state, status: "none", suggestion: null, refusal: null };
  }
  return { ...state, status: "shown", suggestion, refusal: null };
}

/**
 * The ask refused. The prose is the server's; this module invents no sentences.
 *
 * The stale preview goes with it. A refusal beside a shape from two clicks ago
 * would invite somebody to accept a suggestion the points on screen no longer
 * describe.
 */
export function refused(
  state: SuggestionState,
  serial: number,
  prose: string,
): SuggestionState {
  if (serial !== state.serial) return state;
  return { ...state, status: "refused", suggestion: null, refusal: prose };
}

/**
 * Escape: the preview's undo.
 *
 * Back to armed-with-nothing rather than off, and the serial **keeps counting**.
 * A cleared session is still a session, and an answer to the ask that was in
 * flight when Escape was pressed must not be able to repaint the preview that was
 * just discarded — which is exactly what resetting the serial to zero would
 * allow the next click to do.
 */
export function cleared(state: SuggestionState): SuggestionState {
  return { ...state, points: [], status: "idle", suggestion: null, refusal: null };
}

/** Whether there is anything for Escape to take back. */
export function hasPending(state: SuggestionState): boolean {
  return state.points.length > 0 || state.status !== "idle";
}

/** Whether Enter would commit something. Only a shown suggestion can be accepted. */
export function isAcceptable(state: SuggestionState): boolean {
  return state.status === "shown" && state.suggestion !== null;
}

/**
 * The annotation an accepted suggestion becomes: an ordinary drawn shape,
 * carrying where it came from.
 *
 * Built on `draftAnnotation` rather than beside it, so a suggestion inherits the
 * class's attribute defaults, the document's asset and the provisional
 * `schema_version` exactly as a hand-drawn shape does — and so the two cannot
 * come to disagree about what a new annotation is. What it overrides is the three
 * fields that make it a model's proposal a human accepted (D4): `provenance`,
 * `model_ref` and `confidence`.
 *
 * `draftAnnotation` keeps its own `provenance: "human"` and its docstring's claim
 * that *"every caller is a gesture or a keystroke"* stays true: this is a
 * keystroke, and the acceptance is the human act the provenance records.
 *
 * `null` when there is nothing to accept, so a caller cannot commit a preview
 * that is not showing. The class is looked up only to fail honestly: a schema
 * that lost the class mid-session has nothing to write.
 */
export function acceptedAnnotation(
  document: AnnotationDocument,
  state: SuggestionState,
  mint: IdFactory,
): Annotation | null {
  if (!isAcceptable(state) || state.suggestion === null) return null;
  if (classNamed(document, state.labelClass) === undefined) return null;
  const drawn = draftAnnotation(document, state.labelClass, state.suggestion.geometry, mint);
  return {
    ...drawn,
    provenance: "model",
    model_ref: state.suggestion.modelRef,
    confidence: state.suggestion.confidence,
  };
}
