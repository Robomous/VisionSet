/**
 * The engine's document: an asset, the schema its labels are judged against, and
 * the annotations on it — addressed by UUID and by nothing else.
 *
 * It is called `AnnotationDocument` rather than `Document` on purpose: `Document`
 * is a host global (`@types/react`'s DOM stand-ins declare one too), so a core
 * type by that name would shadow it in every adapter and in every consumer. The
 * headless boundary exists to keep that confusion out; naming is the cheapest
 * place to honour it.
 *
 * ## Immutable, and keyed by a Map
 *
 * `annotations` is a `ReadonlyMap`, not an array and not a `Record`. An array
 * means somebody eventually addresses an annotation by index, which is the
 * epic's named "original sin" from v1; a `Record` means string keys with a
 * prototype and no ordering guarantee. A `Map` gives O(1) lookup by id *and*
 * insertion-ordered iteration, which is the draw order — see
 * `annotationsInDrawOrder`.
 *
 * Every operation returns a **new** document and mutates nothing. That is what
 * lets the log snapshot a document by reference and makes undo a pointer swap
 * rather than a deep copy. Copying a 200-entry Map per edit is 200 pointer copies, which
 * is nothing next to a render.
 *
 * ## What it refuses, and what it deliberately does not
 *
 * It refuses exactly its own invariants — a duplicate id, an unknown id, an
 * annotation belonging to another asset — because nothing else can know them.
 *
 * It does **not** re-check that an annotation's geometry matches its class's
 * declared one, that required attributes are present, or that a box has non-zero
 * area. Those rules have an owner in the kernel, `wire.ts`'s rule 2 already
 * argued the copies would drift, and there is a concrete proof in this
 * repository: the round-trip fixture's four annotations all carry
 * `label_class: "sign"`, whose class declares `bbox`, while three of them carry a
 * polygon or a tag. That is valid wire data the kernel produced. A document that
 * enforced class↔geometry agreement could not load its own fixture.
 *
 * What it offers instead is the lookup — `classNamed` — so the tools refuse at
 * draw time, where a user can be told which class they are holding.
 *
 * ## Draft identity, and why there is no rebase
 *
 * A drawn annotation gets a client-minted uuid v4 in the ordinary `id` field (see
 * `../ids.ts`) and a provisional `schema_version` from the schema in hand.
 * `toAnnotationCreate` drops both, so neither guess ever travels — which is
 * precisely what makes inventing them safe.
 *
 * The service mints its own id on `POST`, so the stored annotation comes back
 * under a different one. There is deliberately **no `rebaseAnnotationId`**: it
 * would move a live selection and a whole undo history out from under the user
 * mid-session, to fix a mismatch only the host can see. The engine is the
 * session's source of truth and its ids are its own; a host that needs to
 * correlate keeps a `Map<localId, AnnotationCreate>` where it builds the payload,
 * which is the boundary the epic means by "annotations leave by events".
 */

import { parseAnnotations, parseAssetDescriptor, parseSchema } from "../wire";
import type {
  Annotation,
  AnnotationSchema,
  AssetDescriptor,
  LabelClass,
} from "../types";

/** A document that would break one of its own invariants. */
export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

/** An asset, its labeling contract, and the annotations on it. */
export interface AnnotationDocument {
  readonly asset: AssetDescriptor;
  readonly schema: AnnotationSchema;
  readonly annotations: ReadonlyMap<string, Annotation>;
}

/** The three inputs a document is assembled from, each still `unknown`. */
export interface WireDocument {
  readonly asset: unknown;
  readonly schema: unknown;
  readonly annotations: unknown;
}

function requireOwnAsset(
  asset: AssetDescriptor,
  annotation: Annotation,
  what: string,
): void {
  if (annotation.asset_id !== asset.id) {
    throw new DocumentError(
      `cannot ${what} annotation ${annotation.id}: it belongs to asset ` +
        `${annotation.asset_id}, and this document holds ${asset.id}`,
    );
  }
}

/**
 * Build a document, refusing a duplicate id or an annotation from another asset.
 *
 * Order is the order given, and it is the draw order.
 */
export function createDocument(
  asset: AssetDescriptor,
  schema: AnnotationSchema,
  annotations: Iterable<Annotation> = [],
): AnnotationDocument {
  const byId = new Map<string, Annotation>();
  for (const annotation of annotations) {
    requireOwnAsset(asset, annotation, "load");
    if (byId.has(annotation.id)) {
      throw new DocumentError(
        `two annotations share the id ${annotation.id} — ids are the document's ` +
          `only handle on an annotation, so a repeat is a lost one`,
      );
    }
    byId.set(annotation.id, annotation);
  }
  return { asset, schema, annotations: byId };
}

/**
 * Build a document straight from what three API responses contain.
 *
 * The boundary a generated API client plugs into: everything arrives as
 * `unknown` and leaves typed, so a payload that does not match the contract is
 * refused here rather than surfacing as a rendering bug later.
 */
export function documentFromWire(payload: WireDocument): AnnotationDocument {
  return createDocument(
    parseAssetDescriptor(payload.asset),
    parseSchema(payload.schema),
    parseAnnotations(payload.annotations),
  );
}

/** Add one annotation at the end of the draw order. Refuses a used id. */
export function addAnnotation(
  document: AnnotationDocument,
  annotation: Annotation,
): AnnotationDocument {
  requireOwnAsset(document.asset, annotation, "add");
  if (document.annotations.has(annotation.id)) {
    throw new DocumentError(
      `annotation ${annotation.id} is already in this document — an edit is ` +
        `replaceAnnotation, and a new annotation needs a fresh id`,
    );
  }
  const byId = new Map(document.annotations);
  byId.set(annotation.id, annotation);
  return { ...document, annotations: byId };
}

/**
 * Replace one annotation whole, **keeping its place in the draw order**.
 *
 * `Map.set` on a key that is already present does not move it, which is the
 * behaviour this relies on and `document.test.ts` pins: nudging a box must not
 * send it behind every other one, and an editor where editing changes z-order is
 * an editor that fights its user.
 *
 * Refuses an unknown id, because an update that silently created would turn a
 * stale id — the one case worth catching — into a duplicate annotation.
 */
export function replaceAnnotation(
  document: AnnotationDocument,
  annotation: Annotation,
): AnnotationDocument {
  requireOwnAsset(document.asset, annotation, "replace");
  if (!document.annotations.has(annotation.id)) {
    throw new DocumentError(
      `no annotation ${annotation.id} in this document — replaceAnnotation ` +
        `never creates, so this id is stale or was never minted here`,
    );
  }
  const byId = new Map(document.annotations);
  byId.set(annotation.id, annotation);
  return { ...document, annotations: byId };
}

/**
 * Remove annotations by id. All or nothing, and a repeated id counts once.
 *
 * All-or-nothing matches the kernel's own bulk delete, which refuses the whole
 * call rather than leaving a caller to work out how far it got.
 */
export function removeAnnotations(
  document: AnnotationDocument,
  ids: Iterable<string>,
): AnnotationDocument {
  const wanted = new Set(ids);
  const missing = [...wanted].filter((id) => !document.annotations.has(id));
  if (missing.length > 0) {
    throw new DocumentError(
      `no annotation ${missing.join(", ")} in this document, so nothing was removed`,
    );
  }
  if (wanted.size === 0) {
    return document;
  }
  const byId = new Map(document.annotations);
  for (const id of wanted) {
    byId.delete(id);
  }
  return { ...document, annotations: byId };
}

/**
 * The annotations in draw order: first is painted first, last is on top.
 *
 * Insertion order, which a `Map` guarantees. A renderer wants the array; a hit
 * test wants it reversed, since the topmost shape is the one a click means.
 */
export function annotationsInDrawOrder(
  document: AnnotationDocument,
): readonly Annotation[] {
  return [...document.annotations.values()];
}

/** One annotation, or `undefined`. The only way to reach one. */
export function annotationById(
  document: AnnotationDocument,
  id: string,
): Annotation | undefined {
  return document.annotations.get(id);
}

/**
 * The class an annotation names, or `undefined` if the schema does not declare it.
 *
 * `undefined` rather than a throw: an annotation naming a class this version
 * removed is a real state — it is what `SCHEMA_CHANGE_WOULD_ORPHAN` is about — and
 * a document that refused to load one would leave a labeller unable to see, let
 * alone fix, the annotation at fault.
 */
export function classNamed(
  document: AnnotationDocument,
  name: string,
): LabelClass | undefined {
  return document.schema.classes.find((declared) => declared.name === name);
}
