import { InferenceRuntimeError } from "../errors.js";
import type { PromptableModelDefinition } from "./definition.js";
import { EFFICIENT_SAM_TI_DEFINITION } from "./efficientSam.js";
import type { PixelImage, PointPrompt, RawSegmentation } from "./promptable.js";
import type { ModelSession, ModelSessionFactory, ModelTensor } from "./session.js";

/**
 * Runs a promptable-segmentation model's two graphs against a session an unknown
 * factory supplies, and against the tensor names/arithmetic a `PromptableModelDefinition`
 * supplies -- this file names neither.
 *
 * The whole point: `prepare` runs the encoder once and keeps its output, and every
 * `suggest` afterwards runs only the decoder against that same kept embedding — the
 * large cost gap between the two graphs is the reason this worker exists at all.
 * Internal to `@visionset/browser-inference` — never exported from `src/index.ts`.
 */
export interface ModelHost {
  load(encoder: Uint8Array, decoder: Uint8Array): Promise<void>;
  prepare(image: PixelImage): Promise<{ generation: number; width: number; height: number }>;
  suggest(generation: number, prompt: PointPrompt): Promise<RawSegmentation>;
  /**
   * Drops the held embedding, if any, without touching the loaded graphs. For a caller
   * who asked for a `prepare()` and stopped listening before it answered: the embedding
   * it produced is still installed in this host's one slot, and this is how that slot is
   * emptied again without a second `prepare()` or a full `release()`.
   */
  forget(): void;
  release(): Promise<void>;
}

export function createModelHost(
  factory: ModelSessionFactory,
  definition: PromptableModelDefinition = EFFICIENT_SAM_TI_DEFINITION,
): ModelHost {
  let encoder: ModelSession | null = null;
  let decoder: ModelSession | null = null;
  let prepared: { generation: number; width: number; height: number; embedding: ModelTensor } | null = null;
  let nextGeneration = 1;

  function loaded(): { encoder: ModelSession; decoder: ModelSession } {
    if (encoder === null || decoder === null) {
      throw new InferenceRuntimeError("graph-load-failed", "The model's graphs are not loaded.");
    }
    return { encoder, decoder };
  }

  function forget(): void {
    prepared?.embedding.dispose?.();
    prepared = null;
  }

  // Shared by `load` (a second call must not leak the first pair of sessions or
  // keep serving an embedding that pair produced) and `release` (which is the same
  // teardown with nothing left to load afterwards).
  //
  // Each release is attempted independently: the encoder's `release()` throwing must
  // not skip the decoder's, or the decoder session leaks right alongside the error —
  // the same shape as `worker.ts`'s own best-effort release loops.
  async function releaseLoaded(): Promise<void> {
    forget();
    try {
      await encoder?.release();
    } catch {
      /* the decoder must still get its chance below */
    }
    try {
      await decoder?.release();
    } catch {
      /* the encoder's release was already attempted */
    }
    encoder = null;
    decoder = null;
  }

  return {
    async load(encoderBytes, decoderBytes) {
      await releaseLoaded();
      encoder = await factory.create(encoderBytes);
      decoder = await factory.create(decoderBytes);
    },

    async prepare(image) {
      const sessions = loaded();
      definition.requireUsableImage(image);
      const { data, dims } = definition.encoderInput(image);
      const answer = await sessions.encoder.run({
        [definition.encoderInputName]: { type: "float32", data, dims },
      });
      const embedding = answer[definition.encoderOutputName];
      if (embedding === undefined) {
        throw new InferenceRuntimeError(
          "runtime-execution-failed",
          `The encoder answered without ${definition.encoderOutputName}.`,
        );
      }
      // Replace only once the new one exists: a failed encode leaves the previous
      // image usable rather than leaving the runtime with nothing prepared.
      forget();
      prepared = {
        generation: nextGeneration++,
        width: image.width,
        height: image.height,
        embedding,
      };
      return { generation: prepared.generation, width: prepared.width, height: prepared.height };
    },

    async suggest(generation, prompt) {
      const sessions = loaded();
      if (prepared === null || prepared.generation !== generation) {
        throw new InferenceRuntimeError("image-superseded");
      }
      const { width, height, embedding } = prepared;
      definition.requireAnswerablePrompt(prompt, width, height);
      const { coords, coordsDims, labels, labelsDims } = definition.decoderPrompt(prompt);
      const decoderNames = definition.decoder;
      const sizeTensor: ModelTensor =
        decoderNames.sizeDtype === "int64"
          ? { type: "int64", data: BigInt64Array.from([BigInt(height), BigInt(width)]), dims: [2] }
          : { type: "float32", data: Float32Array.from([height, width]), dims: [2] };
      const feeds: Record<string, ModelTensor> = {
        [decoderNames.embeddings]: embedding,
        [decoderNames.coords]: { type: "float32", data: coords, dims: coordsDims },
        [decoderNames.labels]: { type: "float32", data: labels, dims: labelsDims },
        [decoderNames.size]: sizeTensor,
      };
      // A decoder that takes the SAM-family "previous low-res mask" refinement pair
      // always gets "there is no previous mask" (`hasMaskInput` zeroed) -- see
      // `DecoderTensorNames.maskInput`'s docstring for why this package never threads a
      // real previous mask through instead.
      if (decoderNames.maskInput !== undefined && decoderNames.hasMaskInput !== undefined) {
        if (definition.emptyMaskInput === undefined) {
          throw new InferenceRuntimeError(
            "graph-load-failed",
            `${definition.id} names decoder.maskInput/hasMaskInput but defines no ` +
              "emptyMaskInput().",
          );
        }
        const empty = definition.emptyMaskInput();
        feeds[decoderNames.maskInput] = { type: "float32", data: empty.data, dims: empty.dims };
        feeds[decoderNames.hasMaskInput] = {
          type: "float32",
          data: Float32Array.from([0]),
          dims: [1],
        };
      }
      const answer = await sessions.decoder.run(feeds);
      // The embedding is state and outlives this call; everything the decoder answers
      // with is scratch. `output_masks` alone is three float32 planes at the image's
      // own size -- tens of MB for a large image, allocated again on every refinement --
      // so in a worker that stays alive across a whole annotation session these must be
      // released here rather than left to whenever the GC notices. Disposed by iteration
      // rather than by name so an output this code does not read is still released, and
      // in a `finally` so a decoder that answers without one of them, or a failure in
      // the post-processing below, releases what it did produce.
      try {
        const logits = answer[decoderNames.masks];
        const scores = answer[decoderNames.iou];
        if (logits === undefined || scores === undefined) {
          throw new InferenceRuntimeError(
            "runtime-execution-failed",
            `The decoder answered without ${decoderNames.masks} and ${decoderNames.iou}.`,
          );
        }
        const { index, confidence } = definition.bestCandidate(scores.data as Float32Array);
        // `binaryMask` copies into its own array, so the returned mask survives the
        // disposal below; the tensors it read from do not have to.
        const mask = definition.binaryMask(logits.data as Float32Array, index, width, height);
        return { width, height, mask, confidence };
      } finally {
        for (const tensor of Object.values(answer)) tensor.dispose?.();
      }
    },

    forget,

    async release() {
      await releaseLoaded();
    },
  };
}
