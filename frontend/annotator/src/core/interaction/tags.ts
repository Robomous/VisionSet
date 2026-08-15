/**
 * The classification tag tool: a whole-asset label, with no coordinates.
 *
 * The third of the three geometries an annotation can carry, and the only one
 * that never touches the canvas. `tool.ts` says so from the other end — a
 * `classification_tag` class is cause 3 of `select`, and belongs to a panel — and
 * this is that panel's engine. There is no new interaction state, no new event and no
 * `TRANSITIONS` row: a tag is applied by a keystroke or a checkbox, both of which
 * `events.ts` deliberately keeps out of the machine, on the same grounds as undo
 * and delete-selection. A host calls `store.execute(...)` directly.
 *
 * It lives in `interaction/` rather than `state/` because this directory is the
 * *authoring* layer, not the canvas layer — it already holds `tool.ts`, which
 * decides what a class means, and `draft.ts`, which assembles a new annotation,
 * neither of which is the state machine. `state/` owns the document, the log and
 * the four generic command factories; `commands.ts` says what a tool does with
 * them: *"a tool with a transformation these four do not cover uses it directly
 * rather than growing a fifth factory."* `documentCommand` is what a tool reaches
 * for, and the tools are here. Putting this in `state/` would also make it the
 * first module inverting the package's one-way `interaction/ → state/ → root`
 * layering, which nothing on the frontend enforces and therefore nothing would
 * catch a second time.
 *
 * ## At most one tag per class is THIS package's invariant, not the kernel's
 *
 * The kernel does not enforce it and it is worth being exact about how thoroughly:
 * `AnnotationService._validate` never reads the store, so nothing compares a
 * proposed annotation against the ones already on the asset; `AnnotationRow`
 * carries no unique index and no migration adds one; no route and no MCP tool
 * dedupes. Two identical classification annotations in a single `add` call are
 * stored as two rows. So there is no idempotent add to lean on and no error to
 * catch — the invariant has to live somewhere, and this module is the only place
 * in the annotator that can author a tag.
 *
 * It is enforced **structurally rather than by refusal**: `tagCommand` on a class
 * the asset already carries returns a command that changes nothing, and
 * `CommandLog.execute` records nothing when `after === before`. Nothing throws,
 * nothing is reported, and there is no second tag. `mint` is not called on that
 * branch either, so a repeated keypress burns no ids.
 *
 * The consequence runs the other way too: a document loaded from the server may
 * legitimately carry duplicates, so `untagCommand` removes **every** tag of the
 * class in one command. Removing one would leave the checkbox checked and cost N
 * presses and N undo entries. A full tag → untag → tag cycle therefore heals a
 * duplicated tag; nothing heals passively, and `taggedClassNames` cannot show the
 * duplication, which is one of the reasons `tagsFor` returns the array.
 *
 * Untag also removes tags of every `provenance`, so a human untag clears a
 * model-produced tag. That is the decision and not an oversight: the user is
 * asserting *this asset is not weather*, and a surviving model tag would leave the
 * checkbox checked with no affordance to clear it.
 *
 * ## The predicate is the geometry, never the class name alone
 *
 * `state/document.ts` deliberately does not enforce that an annotation's geometry
 * matches its class's declared one, and there is proof in this repository: the
 * kernel-written round-trip fixture carries an annotation whose `label_class` is
 * `"sign"` — a class declared `bbox` — with a `classification_tag` geometry. A
 * predicate matching on the name alone would make `untagCommand` delete boxes.
 *
 * ## Refusal is `null`, and it is asymmetric on purpose
 *
 * `tagCommand` answers `null` for a class the schema does not declare and for one
 * whose geometry is not `classification_tag`. `untagCommand` never refuses.
 *
 * `null` rather than a throw, because that is what this package does everywhere
 * else — `classNamed` answers `undefined`, `toolFor` answers `"select"`,
 * `drawableGeometry` and `removePolygonVertex` both answer `null` — and because
 * the caller is a keybinding. The key registry is remappable, so a binding can
 * outlive the class it names, and an exception out of a keydown handler is an
 * exception into the host's error boundary: a refusal loses a keystroke, a throw
 * loses the session. `null` rather than a silent identity command, because under
 * `strict` it puts the refusal at the call site where a panel can say *this class
 * cannot be tagged here* — which is the information `drawableGeometry` returning
 * `null` for both a tag class and a `polyline` class cannot supply on its own.
 * `isTaggableClass` is the half that completes that partition.
 *
 * The asymmetry is load-bearing rather than tidy. The gate exists to stop
 * *authoring* data the schema does not sanction; **removing** data it no longer
 * sanctions has to stay reachable, or the fixture's `"sign"` tag — and every
 * orphan a schema version leaves behind when a class changes geometry — draws a
 * checked checkbox that can never be cleared. `toggleTagCommand` inherits exactly
 * that: it refuses only when the class is *not* currently tagged.
 *
 * ## What is decided when
 *
 * The add-or-remove decision and the `mint` both happen **at construction**, from
 * the document the caller passes. `commandLog.ts` is why: redo replays a snapshot
 * and never re-runs `apply`, so an id minted inside `apply` would give redo a
 * different annotation from the one undo removed. `removeAnnotationsCommand` made
 * the same call for the same reason (*"materialized at construction"*).
 *
 * What is *not* frozen is the transformation. `apply` re-runs `addAnnotation` /
 * `removeAnnotations` against whatever document it is handed, rather than
 * returning a precomputed one, so a document that moved underneath fails loudly
 * with the document's own `DocumentError` instead of being clobbered. Every
 * invariant stays in `state/document.ts`, which has one owner.
 *
 * Build from the store's **committed** document, never from `rendered` — the rule
 * `machine.ts` states for `InteractionContext.document`, for the same reason: a
 * preview is a projection of the committed document and is dropped by
 * `store.execute` anyway.
 *
 * ## Two things it deliberately does not do
 *
 * **It does not select the new tag.** `finishDrawing` pairs its `add` with a
 * `select`, and copying that here would be a trap: a tag is unhittable, so a
 * selected tag can never be deselected by clicking it, and a host's
 * delete-selection binding would then remove it through a path that is not
 * `untagCommand` — with the wrong undo label and no duplicate-healing. Two
 * removal paths for one concept.
 *
 * **It does not stage.** A toggle is instantaneous, so it goes straight to
 * `store.execute` and never through `stage`/`commit`. One consequence worth
 * stating so it is not filed as a bug: `execute` drops the staged preview
 * unconditionally, so tagging mid-drag discards an in-flight preview frame. It is
 * harmless — a rubber band lives in the interaction state rather than in the
 * store, and `moving`/`resizing`/`moving-vertex` re-project from the committed
 * document on the next pointer-move.
 */

import type { IdFactory } from "../ids";
import type { Command } from "../state/commandLog";
import { documentCommand } from "../state/commands";
import {
  addAnnotation,
  annotationsInDrawOrder,
  classNamed,
  removeAnnotations,
} from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { Annotation, LabelClass } from "../types";
import { draftAnnotation } from "./draft";

/**
 * Whether this class can be tagged — that is, whether it accepts a tag at all.
 *
 * `drawableGeometries`' missing half: that one answers `[]` for a tag class and
 * for a `mask` class alike, so a palette holding only it cannot tell "usable,
 * just not on the canvas" from "not usable here at all". Takes a `LabelClass`
 * rather than a name, to match `drawableGeometries` — a palette iterating
 * `schema.classes` already holds one, and a caller holding only a name uses
 * `tagCommand`, which resolves it internally.
 *
 * The two are no longer exclusive: a class accepting both a tag and a box is
 * taggable *and* drawable, so a caller must ask both questions rather than
 * treating one as the negation of the other.
 */
export function isTaggableClass(labelClass: LabelClass): boolean {
  return labelClass.geometries.includes("classification_tag");
}

/** Whether this annotation is a tag carrying this class. Geometry first. */
function isTagOf(annotation: Annotation, labelClass: string): boolean {
  return (
    annotation.geometry.type === "classification_tag" &&
    annotation.label_class === labelClass
  );
}

/**
 * Every classification tag on this asset carrying this class, in draw order.
 *
 * Usually zero or one. It returns the array rather than a boolean because it is
 * the only export that hands a host the annotation itself — which is what an
 * attributes panel needs, and the only way a caller can see that a document
 * arrived carrying duplicates.
 */
export function tagsFor(
  document: AnnotationDocument,
  labelClass: string,
): readonly Annotation[] {
  return annotationsInDrawOrder(document).filter((annotation) =>
    isTagOf(annotation, labelClass),
  );
}

/**
 * The classes this asset is tagged with.
 *
 * For `.has`, not for iteration — the same shape and the same use as `Selection`
 * and `isSelected`. A panel calls this once and asks it per row, rather than
 * calling `tagsFor` N times and allocating N arrays to answer N booleans. It
 * iterates in *annotation* order; a palette renders from
 * `schema.classes.filter(isTaggableClass)`, which keeps the authored order.
 *
 * A class the schema no longer declares still appears here, because a tag is
 * what the annotation carries and not what the schema currently says about it.
 */
export function taggedClassNames(document: AnnotationDocument): ReadonlySet<string> {
  const names = new Set<string>();
  for (const annotation of document.annotations.values()) {
    if (annotation.geometry.type === "classification_tag") {
      names.add(annotation.label_class);
    }
  }
  return names;
}

/**
 * Tag the asset with this class.
 *
 * `null` when the class is not one the schema declares as a tag class — the only
 * refusal in this module. When the asset already carries the tag the command is
 * the identity, so the log records nothing and no second tag can exist.
 */
export function tagCommand(
  document: AnnotationDocument,
  labelClass: string,
  mint: IdFactory,
): Command | null {
  const declared = classNamed(document, labelClass);
  if (declared === undefined || !isTaggableClass(declared)) return null;
  const label = `tag ${labelClass}`;
  // Already tagged: identity, and `mint` is not reached, so a repeated keypress
  // neither grows the history nor burns an id.
  if (tagsFor(document, labelClass).length > 0) {
    return documentCommand(label, (current) => current);
  }
  const drawn = draftAnnotation(
    document,
    labelClass,
    { type: "classification_tag" },
    mint,
  );
  return documentCommand(label, (current) => addAnnotation(current, drawn));
}

/**
 * Remove every tag of this class from the asset. Never refuses.
 *
 * Untagged is the identity for free: `removeAnnotations` returns the document
 * unchanged for an empty id list, so there is no special case here.
 */
export function untagCommand(
  document: AnnotationDocument,
  labelClass: string,
): Command {
  const ids = tagsFor(document, labelClass).map((annotation) => annotation.id);
  return documentCommand(`untag ${labelClass}`, (current) =>
    removeAnnotations(current, ids),
  );
}

/**
 * Whichever of the two this asset's current state calls for.
 *
 * The keyboard-first flow: one binding per class, pressed twice to undo itself.
 * `null` only on the tagging arm, which is what keeps an orphaned tag clearable.
 */
export function toggleTagCommand(
  document: AnnotationDocument,
  labelClass: string,
  mint: IdFactory,
): Command | null {
  return tagsFor(document, labelClass).length > 0
    ? untagCommand(document, labelClass)
    : tagCommand(document, labelClass, mint);
}
