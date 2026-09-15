import type {
  MaterializedFrame,
  VideoRefusal,
  VideoInspection,
  VideoSelection,
} from "../index.js";

/**
 * The main-thread ↔ worker message contract (`browser-video-import.tmp.md` §6.1).
 *
 * Type-only, so importing it adds no runtime edge between the two bundles.
 *
 * The load-bearing rule is `ack`: after every `chunk` the worker stops decoding until
 * the main thread has handed that chunk to the `FrameSink` and acknowledged it. A slow
 * sink therefore stalls the decoder instead of filling the worker heap, which is the
 * only thing bounding memory for a long clip.
 *
 * Nothing here carries a count of frames produced. The worker decodes ahead of
 * delivery by up to one chunk and a cancel throws that lead away, so only the main
 * thread knows what the sink actually took — it announces `expected` once and counts
 * deliveries itself rather than relaying a number the worker would have to guess at.
 */
export type ToWorker =
  | { readonly type: "inspect"; readonly file: File }
  | { readonly type: "materialize"; readonly file: File; readonly selection: VideoSelection }
  | { readonly type: "ack" }
  | { readonly type: "cancel" };

/**
 * A refusal carrying no measurements, for the two cases where there are none to
 * report: the browser lacks the primitives, or the container never parsed.
 */
export function refusedInspection(fileName: string, refusal: VideoRefusal): VideoInspection {
  return {
    fileName,
    container: "",
    codec: "",
    displayWidth: 0,
    displayHeight: 0,
    rotation: 0,
    durationSeconds: 0,
    sourceFps: null,
    decodable: false,
    refusal,
  };
}

export type FromWorker =
  | { readonly type: "inspection"; readonly inspection: VideoInspection }
  | { readonly type: "expected"; readonly expected: number }
  | { readonly type: "chunk"; readonly frames: readonly MaterializedFrame[] }
  | { readonly type: "done"; readonly skipped: number[] }
  | { readonly type: "error"; readonly message: string };
