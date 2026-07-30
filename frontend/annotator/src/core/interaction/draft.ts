/**
 * A newly drawn annotation, assembled from the gesture that produced it.
 *
 * One function, and it is here rather than in `state/document.ts` because the
 * document deliberately mints nothing: ids arrive from the `IdFactory` port and
 * a `schema_version` is a guess only somebody holding a schema can make.
 *
 * ## Both invented fields are provisional, and neither travels
 *
 * `id` is a client-minted uuid — the document's key, the selection's key and a
 * renderer's element key for the life of the session. `schema_version` is the
 * version of the schema in hand, which is the only honest answer available; the
 * kernel stamps whatever its batch pinned. `toAnnotationCreate` drops both, which
 * is exactly what makes inventing them safe. `state/document.ts` argues at length
 * why there is deliberately no rebase when the server's id comes back.
 *
 * ## What it does not do, and who does
 *
 * `attributes` is `{}` and `provenance` is `"human"`. Filling defaults from
 * `LabelClass.attributes` is #43's — a required attribute with a default is the
 * kind of thing a tool offers and a panel edits, and `document.ts` is explicit
 * that required-attribute rules stay the kernel's while *"the tools refuse at
 * draw time, where a user can be told"*.
 *
 * It also does not check that the class it was given declares this geometry.
 * `toolFor` has already answered that question from the other end — a bbox
 * gesture only exists while the active class draws boxes — and re-checking here
 * would be the second spelling `wire.ts`'s rule 2 argues against.
 */

import type { IdFactory } from "../ids";
import type { AnnotationDocument } from "../state/document";
import type { Annotation, Geometry } from "../types";

/**
 * A fresh annotation on this document's asset, carrying this class and this
 * geometry.
 *
 * `mint` is called **once, here** — never inside a projection. `AnnotatorStore`
 * runs a projection on every pointer-move, so a mint in one would give the
 * committed annotation a different id from every id the preview rendered under,
 * which breaks a renderer's keys and the selection at the same time.
 * `commandLog.ts` documents the same trap from the redo side.
 */
export function draftAnnotation(
  document: AnnotationDocument,
  labelClass: string,
  geometry: Geometry,
  mint: IdFactory,
): Annotation {
  return {
    id: mint(),
    asset_id: document.asset.id,
    label_class: labelClass,
    schema_version: document.schema.version,
    geometry,
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
  };
}
