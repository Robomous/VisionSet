/**
 * Minting an annotation id — a port, because core cannot mint one itself.
 *
 * A uuid v4 needs randomness, and randomness in a browser or in Node is
 * `crypto`, which is a host global the headless boundary forbids: naming it
 * inside `src/core/` fails `tsconfig.core.json`, where there is no DOM `lib` and
 * no ambient `@types`. So the capability arrives as a function, and the
 * implementation lives outside — `adapters/ids.ts` has the one every host wants.
 *
 * That is the boundary being productive rather than obstructive, and it is the
 * kernel's own shape: a port declared where it is used, an adapter at the edge,
 * and a test double that needs no host at all. A test injects a counter and gets
 * a deterministic document; nothing has to stub a global.
 *
 * Why an id at all, when `AnnotationCreate` has none: a drawn annotation needs
 * identity from the first click — it is what selection keys on, what the command
 * log addresses, and what a renderer keys its elements by. The service mints its
 * own on `POST`, and `toAnnotationCreate` drops the local one, so the two never
 * meet. See `state/document.ts` on why there is deliberately no rebase.
 */

/**
 * Produces a fresh annotation id. Ids must be unique within a document and are
 * never interpreted — the engine compares them and nothing else.
 */
export type IdFactory = () => string;
