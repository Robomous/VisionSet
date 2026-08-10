/**
 * Copy and paste: the annotator's own clipboard, and the two transformations that
 * turn a selection into it and it back into annotations.
 *
 * Four questions had to be answered before this could exist, and three of them
 * were about *where a decision lives* rather than about difficulty.
 *
 * ## 1. Who owns a clipboard — not the store, and that is still true
 *
 * `AnnotatorStore` is one per open asset, and `ui-core`'s annotation page makes
 * that structural: `Workspace` is remounted with `key={asset.id}`, precisely so
 * `mod+z` cannot walk into the previous frame's edits. A clipboard inside the
 * store would therefore die on every navigation, which is worse than not having
 * one — and cross-frame paste, the whole of the founder's decision, would be
 * unreachable.
 *
 * So the clipboard is a **session object**: declared here as an interface,
 * implemented here as a five-line holder, and *held* by whoever outlives the
 * asset. The annotation page holds one per job; `AnnotatorCanvas` makes its own
 * when a host does not supply one, so in-frame duplication works with no wiring
 * at all and only the surviving-navigation half needs a host to opt in.
 *
 * The interface and the implementation both live in `core/` and both are pure
 * TypeScript. **It is never the system clipboard.** `navigator.clipboard` is a
 * DOM global this directory may not name, is asynchronous where a keystroke is
 * not, and is permission-gated — but the deciding reason is smaller: what is
 * copied here is a geometry in *this asset's* pixel frame, which is meaningless
 * to any other application and would be silently wrong if pasted into one.
 *
 * ## 2. Identity — re-minted, and `draftAnnotation` is not the factory
 *
 * A pasted annotation is a new annotation: fresh `id` from `IdFactory`, so the
 * document's key, the selection's key and a renderer's element key are all
 * distinct from the source's. What it must *not* do is take
 * `draftAnnotation`'s attribute seeding — that fills in the class's declared
 * **defaults**, which is right for a shape somebody just drew and wrong for a
 * copy, whose whole point is that it carries what the source carried. So the two
 * factories sit side by side and neither calls the other.
 *
 * ## 3. The offset's frame — screen pixels, converted by the one module allowed to
 *
 * `PASTE_OFFSET_PX` is 20 screen pixels, v1's number, and it reaches this file as
 * `Tolerances.pasteOffset` — already divided by the zoom, already in asset
 * pixels. Nothing here names a viewport. The argument for screen rather than
 * asset pixels is in `tolerance.ts`.
 *
 * ## 4. Pasting a tag — refused locally, structurally, and before the wire
 *
 * `tags.ts` holds *at most one tag per class* by making a second tag
 * unrepresentable rather than by refusing one. This does the same: an entry whose
 * class the asset already carries as a tag is **dropped**, so pasting a selection
 * of three boxes and an already-present tag pastes the three boxes. The kernel
 * refuses a duplicate outright (`DuplicateClassificationTag`), which makes
 * the local rule matter *more* rather than less — without it a paste would look
 * like it worked and the whole save would refuse minutes later, blaming an index.
 *
 * ## Repeated paste cascades, and it is derived rather than counted
 *
 * `mod+v mod+v` must not stack two identical shapes on one spot: what a user sees
 * is one shape, what the dataset gets is two, and nothing on screen says so. The
 * rule is stated in terms of the document rather than in terms of a counter the
 * clipboard would have to keep: **offset by one delta; if that lands on an
 * annotation this document already carries with the same class and the same
 * geometry, offset again.** So the second paste is two deltas out, the third
 * three, an undo frees the slot it took, and a paste into a *different* asset
 * starts at one delta again — all with no state anywhere, which is what makes it
 * survive undo and navigation without coordinating with either.
 *
 * Two consequences, stated rather than discovered. A shape pinned against the
 * asset edge cannot move, so the search stops and copies do stack there. And the
 * comparison is exact equality on numbers the same arithmetic produced, which is
 * the only case where comparing floats is sound — it is asking *did this paste
 * already happen*, not *are these two shapes near each other*.
 */

import type { IdFactory } from "../ids";
import { moveBbox } from "../geometry/bbox";
import { polygonBbox, translatePolygon, translatePolyline } from "../geometry/polygon";
import type { Bounds } from "../geometry/primitives";
import { annotationsInDrawOrder } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { Annotation, AttributeValue, Geometry } from "../types";

/**
 * One copied annotation, with everything that identifies the original removed.
 *
 * Three fields, and the absences are the design. No `id` and no `asset_id`,
 * because a paste mints one and reads the other off the document it is pasting
 * into — which is what makes the same entry paste onto a different frame. No
 * `schema_version`, `job_id`, `model_ref` or `confidence`: the first is the
 * target document's answer and the last three are the *service's*, so a client
 * carrying them across would be claiming provenance it does not have.
 *
 * `provenance` is deliberately not carried either. A human pressing `mod+v` is
 * authoring, so the copy is `"human"` even when the source was a model's — the
 * same call `draftAnnotation` makes, and the reason `tags.ts` gives for untag
 * clearing a model's tag: the user is making the statement now.
 */
export interface ClipboardEntry {
  readonly label_class: string;
  readonly geometry: Geometry;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
}

/**
 * Somewhere to keep what was copied, for as long as the host wants it kept.
 *
 * Two methods, both synchronous, neither of which can fail. A host that wants
 * copy and paste to survive navigation creates one above the boundary the store
 * is remounted at and hands it in; a host that does not gets the canvas's own.
 */
export interface Clipboard {
  /** What was last copied. Empty until something is. Never `null`. */
  read(): readonly ClipboardEntry[];
  /** Replace the contents. Copying nothing is not a call anybody makes — see `runAction`. */
  write(entries: readonly ClipboardEntry[]): void;
}

/** Nothing copied yet. Shared, and safe to share because it is never mutated. */
const NOTHING_COPIED: readonly ClipboardEntry[] = [];

/**
 * A clipboard. One line of state, and the reason it is a factory rather than a
 * module-level singleton is that a singleton is one clipboard per *bundle* —
 * two annotators on one page would silently share it.
 */
export function createClipboard(entries: readonly ClipboardEntry[] = NOTHING_COPIED): Clipboard {
  let held = entries;
  return {
    read: () => held,
    write: (next) => {
      held = next;
    },
  };
}

/**
 * The selection, as clipboard entries — the copy half.
 *
 * A read: it takes the annotations and touches neither the document nor the
 * selection, which is what makes copy legal in read-only mode.
 *
 * Everything is rebuilt rather than referenced. The attribute map is a fresh
 * object (its values are primitives, so one level is the whole copy) and the
 * geometry is rebuilt by `copiedGeometry`, so a clipboard entry shares no object
 * with the annotation it came from — and a later edit to the source cannot
 * reach through the clipboard into a paste made before it.
 */
export function copiedEntries(
  annotations: readonly Annotation[],
): readonly ClipboardEntry[] {
  return annotations.map((annotation) => ({
    label_class: annotation.label_class,
    geometry: copiedGeometry(annotation.geometry),
    attributes: { ...annotation.attributes },
  }));
}

/** A geometry with no structure shared with the one it was read from. */
function copiedGeometry(geometry: Geometry): Geometry {
  switch (geometry.type) {
    case "bbox":
      return { ...geometry };
    case "polygon":
      return { type: "polygon", points: geometry.points.map(([x, y]) => [x, y] as const) };
    case "polyline":
      return { type: "polyline", points: geometry.points.map(([x, y]) => [x, y] as const) };
    case "classification_tag":
      return { type: "classification_tag" };
  }
}

/**
 * The entries as fresh annotations on this document's asset — the paste half.
 *
 * Pure: it builds annotations and writes nothing. The caller turns them into one
 * command and selects them, because both of those are the store's business and
 * this file has no store.
 *
 * `offset` is in **asset pixels** — `Tolerances.pasteOffset`, which is
 * `PASTE_OFFSET_PX` divided by the zoom. Nothing here names a viewport.
 *
 * Entries are accumulated against a document that grows as it goes, so pasting
 * two copies of one shape in a single press cascades them against each other
 * exactly as two presses would, and two copies of one tag collapse to one.
 */
export function pastedAnnotations(
  document: AnnotationDocument,
  entries: readonly ClipboardEntry[],
  offset: number,
  mint: IdFactory,
): readonly Annotation[] {
  const pasted: Annotation[] = [];
  // Grows with each entry, so the free-slot search below sees the copies this
  // very call has already placed. `annotationsInDrawOrder` is read once per
  // entry rather than once overall for the same reason.
  const placed: Annotation[] = [...annotationsInDrawOrder(document)];
  for (const entry of entries) {
    if (entry.geometry.type === "classification_tag") {
      // `tags.ts`'s invariant, held the way that module holds it: the second one
      // is not refused, it is never created. `mint` is not reached either, so a
      // repeated paste burns no ids.
      if (placed.some((one) => isTagOf(one, entry.label_class))) continue;
    }
    const annotation: Annotation = {
      id: mint(),
      asset_id: document.asset.id,
      label_class: entry.label_class,
      // The target document's schema, not the source's: a paste is a new
      // annotation judged against the contract the page is open under.
      schema_version: document.schema.version,
      geometry: freePlacement(placed, entry, offset, document.asset),
      attributes: { ...entry.attributes },
      // A person pressed the key, whatever made the original — see the note on
      // `ClipboardEntry`.
      provenance: "human",
      job_id: null,
      model_ref: null,
      confidence: null,
    };
    pasted.push(annotation);
    placed.push(annotation);
  }
  return pasted;
}

/** Whether this annotation is a tag carrying this class. Geometry first, as `tags.ts` insists. */
function isTagOf(annotation: Annotation, labelClass: string): boolean {
  return (
    annotation.geometry.type === "classification_tag" &&
    annotation.label_class === labelClass
  );
}

/**
 * One delta out, then another for as long as the slot is taken. See the cascade
 * note at the top.
 *
 * Bounded by the number of annotations already there, which is the most times a
 * collision can happen: each step is a distinct placement, so a document holding
 * *n* annotations can block at most *n* of them. It also stops early when a step
 * produced no movement, which is what a shape pinned against the asset edge does.
 */
function freePlacement(
  placed: readonly Annotation[],
  entry: ClipboardEntry,
  offset: number,
  bounds: Bounds,
): Geometry {
  let previous: Geometry | null = null;
  for (let step = 1; step <= placed.length + 1; step += 1) {
    const candidate = displaced(entry.geometry, offset * step, bounds);
    if (previous !== null && sameGeometry(candidate, previous)) return candidate;
    if (!placed.some((one) => one.label_class === entry.label_class && sameGeometry(one.geometry, candidate))) {
      return candidate;
    }
    previous = candidate;
  }
  return displaced(entry.geometry, offset * (placed.length + 1), bounds);
}

/**
 * The geometry moved down and right by `delta`, rigid, clamped inside `bounds`.
 *
 * Every arm is `moveBbox`/`translatePolygon`/`translatePolyline` — the same calls
 * a *drag* makes, which is what makes a paste into a smaller asset behave the way
 * dragging into the edge does: the shape shifts as far as it can and never
 * deforms, and one wider than the frame pins at 0 on that axis. A tag has no
 * coordinates, so there is nothing to move.
 */
function displaced(geometry: Geometry, delta: number, bounds: Bounds): Geometry {
  switch (geometry.type) {
    case "bbox":
      return moveBbox(geometry, [geometry.x + delta, geometry.y + delta], bounds);
    case "polygon": {
      const extent = polygonBbox(geometry);
      return translatePolygon(geometry, [extent.x + delta, extent.y + delta], bounds);
    }
    case "polyline": {
      const extent = polygonBbox(geometry);
      return translatePolyline(geometry, [extent.x + delta, extent.y + delta], bounds);
    }
    case "classification_tag":
      return { type: "classification_tag" };
  }
}

/**
 * Whether two geometries are the same shape in the same place.
 *
 * Exact number equality on purpose: the question is *has this paste already
 * happened*, and both sides come out of `displaced`, so they are the same
 * arithmetic on the same inputs. A tolerance here would answer a different
 * question — whether two shapes are near each other — and would make a genuine
 * near-duplicate undetectable to a user who wanted one.
 */
function sameGeometry(a: Geometry, b: Geometry): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "bbox" && b.type === "bbox") {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }
  if ((a.type === "polygon" || a.type === "polyline") && "points" in b) {
    return (
      a.points.length === b.points.length &&
      a.points.every((point, at) => point[0] === b.points[at][0] && point[1] === b.points[at][1])
    );
  }
  // Two tags. They carry nothing else, so being the same type is the whole answer.
  return true;
}
