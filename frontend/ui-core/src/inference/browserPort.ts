/**
 * The browser inference contract: what a host may offer the reusable UI for running a
 * suggestion on this device, beside the data client (`data/port.ts`) and the media runtime
 * (`media/port.ts`).
 *
 * This is a different kind of thing from an `InferenceConnection`, and the distinction is the
 * reason the port exists at all. A connection is a workspace fact — a model the VisionSet
 * server has, with a setup state everyone in the workspace shares. Whether a model can run in
 * *this* browser is a fact about one browser profile on one machine: the same workspace, opened
 * on a laptop and on a desktop, gives two different answers, and there is no honest value a
 * server-side row could take. So a target here is never persisted as a connection, and nothing
 * on this port reaches the server.
 *
 * Narrow on purpose. It names no execution backend, no model format and no acquisition
 * mechanism, because a host that answers these two questions is the whole of what the UI needs
 * and everything else would be this package guessing at an implementation it does not own.
 *
 * The execution members remain narrower than the optional catalog: `listTargets()` says what
 * can answer now, while `modelCatalog` says what this host can acquire, activate, or remove.
 * Keeping those answers separate prevents a downloaded-but-not-running model from becoming a
 * target a click cannot actually use.
 */
import type { RgbPixels } from "@visionset/annotator";
import type { SuggestionExecutor } from "./suggestionExecutor.js";

/** A model this browser can run a suggestion with, right now. */
export interface BrowserSuggestionTarget {
  /** Stable within one runtime. What `executorFor` is given back. */
  readonly id: string;
  /** What a chooser shows. The host's wording, rendered as given. */
  readonly label: string;
  /**
   * The model identity an accepted suggestion is attributed to.
   *
   * Provenance outlives the runtime that produced it, so this is the artifact's own identity
   * and not a description of how it ran. Two browsers running the same model revision by
   * different means attribute an annotation identically.
   */
  readonly modelRef: string;
}

/**
 * A lease on the currently displayed asset's pixels, host-built from `AnnotatorCanvas`'s
 * `onImageReady`. Never persisted — a browser executor reads it once per `suggest()` call
 * and must re-check `assetId` against its own request before trusting anything cached
 * against it, because the active asset can change while a `readRgb`/`prepareImage` is
 * still in flight.
 */
export interface BrowserSuggestionAssetSource {
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
  readRgb(): RgbPixels;
}

/**
 * One model this browser could run, once its bytes are fetched and verified.
 *
 * Deliberately not reactive — no `getState()`/`subscribe()`. Phase F ships exactly one
 * acquirable model; the transient idle/acquiring/failed state around `acquire()` is the
 * UI's own, not this port's.
 */
export interface BrowserModelAcquisition {
  readonly id: string;
  readonly label: string;
  readonly approxBytes: number;
  acquire(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export type BrowserModelCatalogState =
  | "available"
  | "downloading"
  | "installed"
  | "activating"
  | "ready"
  | "failed";

export interface BrowserModelCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly modelRef: string;
  readonly revision: string;
  readonly bytes: number;
  readonly license: string;
  readonly source: { readonly label: string; readonly href: string };
  readonly state: BrowserModelCatalogState;
  /**
   * `session` means verified bytes are usable now but were not saved persistently. `unknown`
   * means an operation could not inspect or clean browser storage, so the host must leave
   * removal available rather than claiming no bytes remain.
   */
  readonly storage: "none" | "persistent" | "session" | "unknown";
  readonly error?: string;
  /** Non-blocking metadata problem; verified local bytes may still be usable. */
  readonly warning?: string;
}

/** A host-owned catalog. Remote metadata is data; implementations never execute values from it. */
export interface BrowserModelCatalog {
  /** Stable by identity until a subscribed change is published; suitable for useSyncExternalStore. */
  snapshot(): readonly BrowserModelCatalogEntry[];
  subscribe(listener: () => void): () => void;
  /** Whether this build admits an ID, including while registry discovery is still pending. */
  isKnown(id: string): boolean;
  acquire(id: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  activate(id: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * Which kind of thing answers a suggestion now: a workspace connection, or a browser
 * target. Never persisted as an `InferenceConnection` — a browser target answers
 * questions a connection cannot ("can this browser run something now"), and the two
 * are not interchangeable rows of the same table.
 */
export type ActiveSuggestionTarget =
  | { readonly kind: "server"; readonly connectionId: string }
  | { readonly kind: "browser"; readonly targetId: string };

export interface VisionSetBrowserInferenceRuntime {
  /**
   * The targets that can answer *now*.
   *
   * Only usable ones. A host with nothing available returns an empty list, which is the whole
   * of "this device has nothing to offer" — there is no half-ready state on this port, because
   * a UI that rendered one would be rendering a control it cannot honour.
   */
  listTargets(): Promise<readonly BrowserSuggestionTarget[]>;
  /** How to ask one of them. The same contract the server path answers through. */
  executorFor(targetId: string): SuggestionExecutor;
  /** Reactive discovery/acquisition state. Additive: Phase F hosts may omit it. */
  readonly modelCatalog?: BrowserModelCatalog;
  /** Models not yet ready, each with its own explicit `acquire()`. Absent hosts offer none. */
  listAcquisitions?(): readonly BrowserModelAcquisition[];
  /** The displayed asset, or `null` between assets. Feeds the executor's race-safety checks. */
  setActiveAsset?(source: BrowserSuggestionAssetSource | null): void;
}
