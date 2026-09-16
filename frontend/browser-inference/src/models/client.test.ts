import { describe, expect, it } from "vitest";

import { isInferenceRuntimeError, type InferenceRuntimeError } from "../errors.js";
import type { FromWorker, OperationId, ToWorker, WorkerChannel } from "../protocol.js";
import { createModelClient } from "./client.js";
import { EFFICIENT_SAM_TI } from "./efficientSam.js";
import type { PixelImage, PointPrompt, PreparedImage, PromptableSegmentationRuntime } from "./promptable.js";

const ENCODER = Uint8Array.from([1, 2, 3]);
const DECODER = Uint8Array.from([4, 5, 6, 7]);

function validImage(width = 4, height = 4): PixelImage {
  return { width, height, rgb: new Uint8Array(width * height * 3) };
}

function pointPrompt(points: ReadonlyArray<readonly [number, number]>): PointPrompt {
  return { positive: points, negative: [] };
}

/** One tick, enough for the `await loaded` a model-layer call makes before it posts. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Posted {
  readonly message: ToWorker;
  readonly transfer: readonly unknown[] | undefined;
}

interface Harness {
  readonly runtime: PromptableSegmentationRuntime;
  /** Everything the client has posted, configure included, in order. */
  readonly posted: readonly Posted[];
  /** The ids the client minted for messages of one kind, in the order it posted them. */
  idsOf(kind: ToWorker["kind"]): OperationId[];
  reply(message: FromWorker): void;
  failChannel(error: unknown): void;
}

/**
 * The model client against a worker that does exactly what the test says. Unlike
 * `client.test.ts`'s fake channel, this one records the transfer list too, because
 * that is the whole point of the test requirement it exists to satisfy.
 */
function harness(): Harness {
  const posted: Posted[] = [];
  let deliver: ((message: unknown) => void) | undefined;
  let failChannel: ((error: unknown) => void) | undefined;

  const channel: WorkerChannel = {
    worker: {
      postMessage(message, transfer) {
        posted.push({ message: message as ToWorker, transfer });
      },
      terminate() {},
    },
    onMessage(handler) {
      deliver = handler;
    },
    onError(handler) {
      failChannel = handler;
    },
  };

  const runtime = createModelClient(
    channel,
    { providers: ["wasm"], wasmThreads: 1 },
    { encoder: ENCODER, decoder: DECODER },
  );

  return {
    runtime,
    posted,
    idsOf: (kind) => posted.filter((entry) => entry.message.kind === kind).map((entry) => entry.message.id),
    reply: (message) => {
      if (deliver === undefined) throw new Error("the client registered no message handler");
      deliver(message);
    },
    failChannel: (error) => {
      if (failChannel === undefined) throw new Error("the client registered no error handler");
      failChannel(error);
    },
  };
}

/** The rejection an operation produced, typed, or a failure naming what happened instead. */
async function rejection(promise: Promise<unknown>): Promise<InferenceRuntimeError> {
  let settled: unknown;
  try {
    settled = await promise;
  } catch (error) {
    if (isInferenceRuntimeError(error)) return error;
    throw error;
  }
  throw new Error(`expected a rejection, the operation resolved with ${String(settled)}`);
}

/** Answers the load the client posts on construction, so `prepareImage`/`suggest` may post. */
async function readyRuntime(h: Harness): Promise<void> {
  const [modelLoadId] = h.idsOf("model-load");
  h.reply({ kind: "model-loaded", id: modelLoadId });
  await tick();
}

/** Runs `prepareImage` to completion against a hand-delivered `prepared` reply. */
async function prepared(h: Harness, image: PixelImage, generation: number): Promise<PreparedImage> {
  const promise = h.runtime.prepareImage(image);
  await tick();
  const prepareId = h.idsOf("model-prepare").at(-1);
  if (prepareId === undefined) throw new Error("prepareImage did not post model-prepare");
  h.reply({ kind: "prepared", id: prepareId, generation, width: image.width, height: image.height });
  return promise;
}

describe("asking the worker for a model answer", () => {
  it("loads both graphs once, as its first operation after configure", async () => {
    const h = harness();

    expect(h.posted[0]?.message.kind).toBe("configure");
    expect(h.posted[1]?.message.kind).toBe("model-load");
    expect(h.posted[1]?.transfer).toEqual([ENCODER.buffer, DECODER.buffer]);

    await readyRuntime(h);
    await prepared(h, validImage(), 1);
    await prepared(h, validImage(), 2);

    // Loading is a one-time construction step, not something each prepare repeats.
    expect(h.idsOf("model-load")).toHaveLength(1);

    // Pixel bytes are cloned, not transferred — a caller may prepare the same image
    // twice, and detaching its buffer on the first call would break the second.
    const prepareMessage = h.posted.find((entry) => entry.message.kind === "model-prepare");
    expect(prepareMessage?.transfer).toBeUndefined();
  });

  it("gives prepare and suggest distinct ids and routes each answer to its own caller", async () => {
    const h = harness();
    await readyRuntime(h);
    const image = await prepared(h, validImage(), 7);

    const suggestion = h.runtime.suggest(image, pointPrompt([[1, 1]]));
    const secondPrepare = h.runtime.prepareImage(validImage());
    await tick();

    const [suggestId] = h.idsOf("model-suggest");
    const prepareIds = h.idsOf("model-prepare");
    const secondPrepareId = prepareIds.at(-1);
    expect(suggestId).toBeDefined();
    expect(secondPrepareId).toBeDefined();
    expect(suggestId).not.toBe(secondPrepareId);

    // Answer the prepare first; the still-outstanding suggest must not notice.
    h.reply({ kind: "prepared", id: secondPrepareId!, generation: 8, width: 4, height: 4 });
    let suggestSettled = false;
    void suggestion.then(() => {
      suggestSettled = true;
    });
    await tick();
    expect(suggestSettled).toBe(false);

    h.reply({
      kind: "segmentation",
      id: suggestId!,
      width: 4,
      height: 4,
      mask: new Uint8Array(16),
      confidence: 0.5,
    });
    expect((await suggestion).confidence).toBe(0.5);
    await secondPrepare;
  });

  it("drops a reply whose id is not outstanding", async () => {
    const h = harness();
    await readyRuntime(h);
    const image = await prepared(h, validImage(), 1);

    const suggestion = h.runtime.suggest(image, pointPrompt([[1, 1]]));
    await tick();
    const [suggestId] = h.idsOf("model-suggest");

    expect(() =>
      h.reply({
        kind: "segmentation",
        id: suggestId + 500,
        width: 4,
        height: 4,
        mask: new Uint8Array(16),
        confidence: 0.9,
      }),
    ).not.toThrow();

    h.reply({
      kind: "segmentation",
      id: suggestId,
      width: 4,
      height: 4,
      mask: new Uint8Array(16),
      confidence: 0.3,
    });
    expect((await suggestion).confidence).toBe(0.3);
  });

  it("refuses a seventh point without posting anything to the worker", async () => {
    const h = harness();
    await readyRuntime(h);
    const before = h.posted.length;

    const points: Array<readonly [number, number]> = Array.from(
      { length: EFFICIENT_SAM_TI.maxPoints + 1 },
      (_, index) => [index, index] as const,
    );
    const image: PreparedImage = { width: 100, height: 100 };

    const error = await rejection(h.runtime.suggest(image, pointPrompt(points)));
    expect(error.code).toBe("prompt-rejected");
    expect(h.posted.length).toBe(before);
  });

  it("refuses an image whose bytes do not match its size without posting anything", async () => {
    const h = harness();
    await readyRuntime(h);
    const before = h.posted.length;

    const badImage: PixelImage = { width: 4, height: 4, rgb: new Uint8Array(4 * 4 * 3 - 1) };

    const error = await rejection(h.runtime.prepareImage(badImage));
    expect(error.code).toBe("prompt-rejected");
    expect(h.posted.length).toBe(before);
  });

  it("settles a cancelled suggest immediately and drops the worker's late answer", async () => {
    const h = harness();
    await readyRuntime(h);
    const image = await prepared(h, validImage(), 1);
    const controller = new AbortController();

    const cancelled = h.runtime.suggest(image, pointPrompt([[1, 1]]), { signal: controller.signal });
    await tick();
    const [suggestId] = h.idsOf("model-suggest");
    controller.abort();

    expect((await rejection(cancelled)).code).toBe("cancelled");
    expect(h.idsOf("cancel")).toEqual([suggestId]);

    expect(() =>
      h.reply({
        kind: "segmentation",
        id: suggestId,
        width: 4,
        height: 4,
        mask: new Uint8Array(16),
        confidence: 1,
      }),
    ).not.toThrow();
  });

  it("stays usable after a cancelled suggest", async () => {
    const h = harness();
    await readyRuntime(h);
    const image = await prepared(h, validImage(), 1);
    const controller = new AbortController();

    const cancelled = h.runtime.suggest(image, pointPrompt([[1, 1]]), { signal: controller.signal });
    await tick();
    controller.abort();
    expect((await rejection(cancelled)).code).toBe("cancelled");

    const again = h.runtime.suggest(image, pointPrompt([[2, 2]]));
    await tick();
    const laterId = h.idsOf("model-suggest").at(-1);
    expect(laterId).toBeDefined();
    h.reply({
      kind: "segmentation",
      id: laterId!,
      width: 4,
      height: 4,
      mask: new Uint8Array(16),
      confidence: 0.9,
    });
    expect((await again).confidence).toBe(0.9);
  });

  it("rejects everything pending, and every later call, once the worker crashes", async () => {
    const h = harness();
    await readyRuntime(h);
    const image = await prepared(h, validImage(), 1);

    const suggestion = h.runtime.suggest(image, pointPrompt([[1, 1]]));
    await tick();

    const cause = new Error("worker thread died");
    h.failChannel(cause);

    expect((await rejection(suggestion)).code).toBe("worker-crashed");

    const before = h.posted.length;
    const laterPrepare = await rejection(h.runtime.prepareImage(validImage()));
    const laterSuggest = await rejection(h.runtime.suggest(image, pointPrompt([[1, 1]])));
    expect(laterPrepare.code).toBe("worker-crashed");
    expect(laterSuggest.code).toBe("worker-crashed");
    expect(h.posted.length).toBe(before);
  });

  it("settles everything as disposed, and posts one shutdown", async () => {
    const h = harness();
    await readyRuntime(h);
    const image = await prepared(h, validImage(), 1);

    const suggestion = h.runtime.suggest(image, pointPrompt([[1, 1]]));
    await tick();

    h.runtime.dispose();

    expect((await rejection(suggestion)).code).toBe("disposed");
    expect(h.idsOf("shutdown")).toHaveLength(1);

    const before = h.posted.length;
    expect((await rejection(h.runtime.prepareImage(validImage()))).code).toBe("disposed");
    expect((await rejection(h.runtime.suggest(image, pointPrompt([[1, 1]])))).code).toBe("disposed");
    expect(h.posted.length).toBe(before);
  });
});
