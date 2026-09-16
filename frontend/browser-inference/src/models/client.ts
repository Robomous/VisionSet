import { InferenceRuntimeError } from "../errors.js";
import { createOperationCore, type RuntimeConfiguration } from "../operations.js";
import type { WorkerChannel } from "../protocol.js";
import { requireAnswerablePrompt, requireUsableImage } from "./efficientSam.js";
import type { PreparedImage, PromptableSegmentationRuntime, RawSegmentation } from "./promptable.js";

/**
 * The main-thread facade for a promptable-segmentation model, mirroring
 * `createRuntimeClient`'s shape: it says which `ToWorker` message a call becomes and
 * what to transfer, leaving id allocation, reply correlation and lifecycle to
 * `createOperationCore`.
 *
 * `generations` tracks which worker-side embedding a `PreparedImage` handle names,
 * keyed by the handle's own identity rather than any field on it — a caller has no way
 * to forge one, and a handle from a different runtime instance is never mistaken for
 * this one's.
 *
 * Internal. A host obtains a runtime from `createEfficientSamRuntime()` in the browser
 * adapter, which is the only place that knows how to build a real channel and hand it
 * the model's own weights.
 */
export function createModelClient(
  channel: WorkerChannel,
  configuration: RuntimeConfiguration,
  artifacts: { readonly encoder: Uint8Array; readonly decoder: Uint8Array },
): PromptableSegmentationRuntime {
  const core = createOperationCore(channel, configuration);
  const generations = new WeakMap<PreparedImage, number>();

  // Loading is this client's first operation, right after `configure`: every later
  // call waits on it, and it happens exactly once regardless of how many images this
  // runtime ends up preparing.
  const loaded = core.request<undefined>(
    (id) => ({ kind: "model-load", id, encoder: artifacts.encoder, decoder: artifacts.decoder }),
    { transfer: [artifacts.encoder.buffer, artifacts.decoder.buffer] },
  );
  void loaded.catch(() => {});

  return {
    ready: () => core.ready,

    async prepareImage(image, options) {
      // Validated here, synchronously and before any `await`: a malformed image costs
      // a throw, never a round trip to the worker.
      requireUsableImage(image);
      await loaded;
      const answer = await core.request<{ generation: number; width: number; height: number }>(
        (id) => ({ kind: "model-prepare", id, width: image.width, height: image.height, rgb: image.rgb }),
        { signal: options?.signal },
      );
      const prepared: PreparedImage = { width: answer.width, height: answer.height };
      generations.set(prepared, answer.generation);
      return prepared;
    },

    async suggest(image, prompt, options) {
      requireAnswerablePrompt(prompt, image.width, image.height);
      const generation = generations.get(image);
      if (generation === undefined) {
        throw new InferenceRuntimeError(
          "image-superseded",
          "This prepared image was not produced by this runtime.",
        );
      }
      await loaded;
      return core.request<RawSegmentation>(
        (id) => ({ kind: "model-suggest", id, generation, prompt }),
        { signal: options?.signal },
      );
    },

    dispose: () => core.dispose(),
  };
}
