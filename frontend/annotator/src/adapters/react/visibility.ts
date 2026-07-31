/**
 * Hiding an annotation, which is a **view** decision and never a document one.
 *
 * #126 puts an eye on every row of the objects panel. The core document has no
 * `hidden` flag and must not grow one: hiding is per viewer, per session, undoable
 * by nothing, and a field in the document would travel to the API, land in a
 * release manifest and change a hash. It lives beside the store the way the
 * adapter's `skipId` and `hotId` do.
 *
 * ## Both halves, or neither
 *
 * A shape you cannot see must not swallow a press. So a hidden annotation is
 * removed from what the canvas *draws* **and** from the document the machine hit
 * tests against — `resolveTarget` reads `context.document`, so filtering only the
 * render layer would leave an invisible shape catching every click over it, which
 * is worse than not hiding it at all.
 *
 * ## Returning the same object when nothing is hidden is the whole performance story
 *
 * #49 measured that a drag costs the committed layer **3 DOM writes whatever its
 * length**, and that holds because `AnnotationLayer` is `memo`'d on inputs that do
 * not change during a gesture. A projection that allocated a new document on every
 * render would defeat that bail-out before it was consulted — the same trap as
 * passing a freshly built `Set` — so the empty case is identity, and a caller
 * memoizes the rest.
 */

import { removeAnnotations } from "../../core/state/document";
import type { AnnotationDocument } from "../../core/state/document";

/**
 * `document` without the hidden annotations, or `document` itself when none are.
 *
 * `removeAnnotations` is the core's own operation rather than a second filter: it
 * already knows that the annotation map is keyed by id and that draw order is a
 * separate list, and a hand-rolled projection would be a second place that has to
 * stay true.
 */
export function withoutHidden(
  document: AnnotationDocument,
  hidden: ReadonlySet<string> | undefined,
): AnnotationDocument {
  if (hidden === undefined || hidden.size === 0) return document;
  const present = [...hidden].filter((id) => document.annotations.has(id));
  // Also identity when every hidden id names something already gone — an object
  // deleted while hidden, which is reachable in one keystroke.
  if (present.length === 0) return document;
  return removeAnnotations(document, present);
}
