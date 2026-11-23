/**
 * One open frame: the document somebody is editing, and what the server holds
 * of it.
 *
 * ## Why this exists: a save must never take back work made while it ran
 *
 * The page used to rebuild its store from the annotation query every time that
 * query answered something new — and every save answers something new, because
 * the kernel mints its own ids and the page refetched to learn them. That was
 * harmless while a save only happened when somebody pressed a button and then
 * left the frame. With autosave it is not: a save sent at 10.0s and answered at
 * 10.4s would rebuild the document from the server's copy of the 10.0s state, and
 * the box drawn at 10.2s would vanish. It also threw the undo history away on
 * every save, which an autosave every second or two would have made useless.
 *
 * So the store is built **once** per frame, from the first read, and nothing a
 * read answers later rebuilds it while it holds work. What changes after a save
 * is this object's record of the server (`server`) and which local id the server
 * knows by which of its own (`minted`) — both taken from the kernel's own answer
 * to the save (`settledSave`), never from a refetch that might have been issued
 * before the save landed. The next plan is the document against that record, so
 * a shape drawn while a save was out is simply the next save's work.
 *
 * ## When a read is taken in
 *
 * `receive` is told every answer the annotation query gives, and takes one in —
 * rebuilding the store from it — only when three things are all true at the
 * moment it arrives: the page holds no unsaved work, no save is out, and no
 * gesture or suggestion is in progress. That is the one state in which there is
 * nothing a rebuild could take back. It is also exactly the state a stale cached
 * read is corrected in: returning to a frame shows the cache at once, and the
 * fresh read a moment later replaces it. A read that arrives while somebody is
 * working is noted and left: what this page writes is a diff against what it
 * knows the server holds, so a row somebody else added is never deleted from
 * here and a row they changed is overwritten only if it is edited here too.
 *
 * ## A scan holds two documents
 *
 * A point-cloud asset is edited in two stores: the image document (a scan's
 * whole-scan tags and 2D-shaped labels, when it has any) and the scan document,
 * which holds its cuboids. Both are built here, from the same read, and both
 * are rebuilt by the same rules — so a save of a cuboid is kept exactly like a
 * save of a box. The two plans are disjoint by geometry and travel as one;
 * `minted` maps local ids from either, since a local id is unique across both.
 *
 * ## Plain TypeScript with a subscription
 *
 * The rules are a handful of moves on three values, and they have to be
 * readable at the moment a save is sent, not at the last render — a save queued
 * behind another must plan against the record the first one left. So the state
 * lives here, behind `subscribe` / `getSnapshot` (`useSyncExternalStore`'s
 * contract, the same shape `AnnotatorStore` has), and the page renders from it.
 */

import {
  AnnotatorStore,
  documentFromWire,
  parseAssetDescriptor,
  scanDocumentFromWire,
  type Annotation,
  type AssetDescriptor,
  type ScanAnnotation,
  type ScanDocument,
} from "@visionset/annotator";

import {
  mergePlans,
  planSave,
  planScanSave,
  sameAnnotations,
  settledSave,
  type SavePlan,
  type SaveResult,
  type WireAnnotation,
} from "./jobQueries";

/** What the page renders from. One identity per change. */
export interface FrameState {
  /** The document and its history. Replaced only by `receive` and `repin`. */
  readonly store: AnnotatorStore;
  /** A scan's cuboids, in their own store; `null` on an image. Replaced with `store`. */
  readonly scanStore: AnnotatorStore<ScanDocument> | null;
  /** The frame's rows as the server holds them, as far as this page knows. */
  readonly server: readonly WireAnnotation[];
  /** Local id → the server's id, for each shape created here and stored. */
  readonly minted: ReadonlyMap<string, string>;
}

function storeOf(asset: AssetDescriptor, schema: unknown, annotations: readonly unknown[]): AnnotatorStore {
  return new AnnotatorStore(documentFromWire({ asset, schema, annotations }));
}

function scanStoreOf(
  asset: AssetDescriptor,
  schema: unknown,
  annotations: readonly unknown[],
): AnnotatorStore<ScanDocument> | null {
  return asset.modality === "point_cloud"
    ? new AnnotatorStore<ScanDocument>(scanDocumentFromWire({ asset, schema, annotations }))
    : null;
}

/** Both stores, from one read or one document's worth of annotations. */
function storesOf(
  asset: AssetDescriptor,
  schema: unknown,
  annotations: readonly unknown[],
): Pick<FrameState, "store" | "scanStore"> {
  return { store: storeOf(asset, schema, annotations), scanStore: scanStoreOf(asset, schema, annotations) };
}

export class FrameSession {
  private state: FrameState;
  /** The last read `receive` was told about, taken in or not. */
  private seen: readonly WireAnnotation[];
  private schema: unknown;
  private readonly listeners = new Set<() => void>();

  constructor(asset: unknown, schema: unknown, loaded: readonly WireAnnotation[]) {
    this.schema = schema;
    this.seen = loaded;
    this.state = {
      ...storesOf(parseAssetDescriptor(asset), schema, loaded),
      server: loaded,
      minted: new Map(),
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): FrameState => this.state;

  /** What a save sent now would carry — read live, never from a render. */
  plan(): SavePlan<Annotation | ScanAnnotation> {
    const { store, scanStore, server, minted } = this.state;
    const image = planSave(store.document, server, minted);
    return scanStore === null ? image : mergePlans(image, planScanSave(scanStore.document, server, minted));
  }

  /** A save landed: the server holds what it answered. The document is untouched. */
  saved(plan: SavePlan<Annotation | ScanAnnotation>, result: SaveResult): void {
    const { server, minted } = settledSave(this.state.server, this.state.minted, plan, result);
    this.set({ ...this.state, server, minted });
  }

  /**
   * The annotation query answered.
   *
   * Taken in only when `quiet` — no unsaved work, no save out, nothing in
   * progress on the canvas — and only when it says something this page does not
   * already know. Either way it is noted, so a read is judged once, when it
   * arrives, and never later against a moment it did not belong to.
   */
  receive(loaded: readonly WireAnnotation[], quiet: boolean): void {
    if (loaded === this.seen) return;
    this.seen = loaded;
    if (!quiet || sameAnnotations(loaded, this.state.server)) return;
    this.set({
      ...storesOf(this.state.store.document.asset, this.schema, loaded),
      server: loaded,
      minted: new Map(),
    });
  }

  /**
   * The batch's pin moved under an open frame. The document is rebuilt against
   * the new schema from its own current annotations — never from a read — so
   * nothing unsaved is lost; only the history goes, since its entries were judged
   * against the old contract.
   */
  repin(schema: unknown): void {
    if (schema === this.schema) return;
    this.schema = schema;
    const { document } = this.state.store;
    const scanAnnotations = [...(this.state.scanStore?.document.annotations.values() ?? [])];
    this.set({
      ...this.state,
      store: storeOf(document.asset, schema, [...document.annotations.values()]),
      scanStore: scanStoreOf(document.asset, schema, scanAnnotations),
    });
  }

  private set(next: FrameState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
