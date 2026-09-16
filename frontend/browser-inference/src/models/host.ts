import { InferenceRuntimeError } from "../errors.js";
import {
  bestCandidate,
  binaryMask,
  decoderPrompt,
  EFFICIENT_SAM_TI,
  encoderInput,
  requireAnswerablePrompt,
  requireUsableImage,
} from "./efficientSam.js";
import type { PixelImage, PointPrompt, RawSegmentation } from "./promptable.js";
import {
  DECODER_COORDS,
  DECODER_EMBEDDINGS,
  DECODER_IOU,
  DECODER_LABELS,
  DECODER_MASKS,
  DECODER_SIZE,
  ENCODER_INPUT,
  ENCODER_OUTPUT,
} from "./session.js";
import type { ModelSession, ModelSessionFactory, ModelTensor } from "./session.js";

/**
 * Runs EfficientSAM-Ti's two graphs against a session an unknown factory supplies.
 *
 * The whole point: `prepare` runs the encoder once and keeps its output, and every
 * `suggest` afterwards runs only the decoder against that same kept embedding — the
 * ~30x cost gap between the two graphs is the reason this worker exists at all.
 * Internal to `@visionset/browser-inference` — never exported from `src/index.ts`.
 */
export interface ModelHost {
  load(encoder: Uint8Array, decoder: Uint8Array): Promise<void>;
  prepare(image: PixelImage): Promise<{ generation: number; width: number; height: number }>;
  suggest(generation: number, prompt: PointPrompt): Promise<RawSegmentation>;
  release(): Promise<void>;
}

export function createModelHost(factory: ModelSessionFactory): ModelHost {
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
  async function releaseLoaded(): Promise<void> {
    forget();
    await encoder?.release();
    await decoder?.release();
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
      requireUsableImage(image);
      const { data, dims } = encoderInput(image);
      const answer = await sessions.encoder.run({
        [ENCODER_INPUT]: { type: "float32", data, dims },
      });
      const embedding = answer[ENCODER_OUTPUT];
      if (embedding === undefined) {
        throw new InferenceRuntimeError(
          "runtime-execution-failed",
          `The encoder answered without ${ENCODER_OUTPUT}.`,
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
      requireAnswerablePrompt(prompt, width, height);
      const { coords, labels } = decoderPrompt(prompt);
      const answer = await sessions.decoder.run({
        [DECODER_EMBEDDINGS]: embedding,
        [DECODER_COORDS]: { type: "float32", data: coords, dims: [1, 1, EFFICIENT_SAM_TI.maxPoints, 2] },
        [DECODER_LABELS]: { type: "float32", data: labels, dims: [1, 1, EFFICIENT_SAM_TI.maxPoints] },
        [DECODER_SIZE]: {
          type: "int64",
          data: BigInt64Array.from([BigInt(height), BigInt(width)]),
          dims: [2],
        },
      });
      const logits = answer[DECODER_MASKS];
      const scores = answer[DECODER_IOU];
      if (logits === undefined || scores === undefined) {
        throw new InferenceRuntimeError(
          "runtime-execution-failed",
          `The decoder answered without ${DECODER_MASKS} and ${DECODER_IOU}.`,
        );
      }
      const { index, confidence } = bestCandidate(scores.data as Float32Array);
      return { width, height, mask: binaryMask(logits.data as Float32Array, index, width, height), confidence };
    },

    async release() {
      await releaseLoaded();
    },
  };
}
