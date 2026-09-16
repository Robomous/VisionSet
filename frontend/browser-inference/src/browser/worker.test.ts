import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PointPrompt } from "../models/promptable.js";
import type { FromWorker, TensorLike, ToWorker } from "../protocol.js";

/**
 * What a test wants ORT to do inside the two calls the worker awaits. Each hook runs at
 * the exact moment the worker is suspended in that call, which is how a `cancel` is made
 * to arrive *during* the work rather than before or after it — no timers, no deferred
 * promises, and no ordering left to chance.
 */
const ortBehaviour = vi.hoisted(() => ({
  duringCreate: null as null | (() => void),
  duringRun: null as null | (() => void),
  /** How many fake tensors have had `dispose()` called, for the model tests below. */
  disposals: 0,
}));

/**
 * A fake ORT that never touches WebAssembly or a GPU: `create` and `run` resolve on the
 * microtask queue, which is enough to drive the worker's real message-handling and
 * cancellation logic without a browser. `run` answers `y = x + 1` for the plain
 * `load-graph`/`run` tests, so a caller can tell two calls apart by their numbers alone;
 * it also recognises EfficientSAM-Ti's real encoder and decoder feed names, so the model
 * tests below can drive `createModelHost`'s `prepare`/`suggest` to a genuine success
 * rather than only ever exercising their failure paths.
 */
vi.mock("onnxruntime-web/webgpu", () => {
  class FakeTensor {
    readonly type = "float32";
    constructor(
      _type: string,
      readonly data: Float32Array | BigInt64Array,
      readonly dims: readonly number[],
    ) {}
    dispose(): void {
      ortBehaviour.disposals += 1;
    }
  }

  const create = vi.fn(async () => {
    ortBehaviour.duringCreate?.();
    return {
      outputNames: ["y", "image_embeddings", "output_masks", "iou_predictions"],
      run: vi.fn(async (feeds: Record<string, InstanceType<typeof FakeTensor>>) => {
        ortBehaviour.duringRun?.();
        if ("batched_images" in feeds) {
          // The encoder: a fixed, tiny "embedding". Its value never matters — it is
          // only ever fed straight back into the decoder branch below.
          return {
            image_embeddings: new FakeTensor("float32", Float32Array.from([1, 2, 3, 4]), [1, 4]),
          };
        }
        if ("orig_im_size" in feeds) {
          // The decoder: one candidate, lit, with a fixed confidence.
          return {
            output_masks: new FakeTensor("float32", Float32Array.from([1]), [1, 1, 1, 1, 1]),
            iou_predictions: new FakeTensor("float32", Float32Array.from([0.75]), [1, 1]),
          };
        }
        const x = feeds.x as InstanceType<typeof FakeTensor>;
        return {
          y: new FakeTensor(
            "float32",
            Float32Array.from(x.data as Float32Array, (value) => value + 1),
            x.dims,
          ),
        };
      }),
      release: vi.fn(async () => undefined),
    };
  });

  return {
    InferenceSession: { create },
    Tensor: FakeTensor,
    env: { wasm: {} as { wasmPaths?: string; numThreads?: number } },
  };
});

function tensor(...values: number[]): TensorLike {
  return { data: Float32Array.from(values), dims: [values.length] };
}

/**
 * A fresh worker module against a fake `self`. `vi.resetModules()` plus a new dynamic
 * import gives every test its own `known`/`cancelled`/`sessions` state, the same way a
 * real persistent worker starts clean and a real test file starts clean.
 */
async function openWorker(): Promise<{
  dispatch(message: ToWorker): void;
  messages: readonly FromWorker[];
  /**
   * The reply to the request minted with this id, ignoring everything announced before
   * `from`. Not "the next message of a kind", so two `run`s in the same test cannot be
   * confused; not "the first message with this id", so a test that deliberately reuses
   * an id is not answered with the previous operation's reply.
   */
  replyTo(id: number, from?: number): Promise<FromWorker>;
}> {
  const messages: FromWorker[] = [];
  const listeners: ((event: { data: ToWorker }) => void)[] = [];
  const waiters: { id: number; resolve: (message: FromWorker) => void }[] = [];

  function announce(message: FromWorker): void {
    messages.push(message);
    const at = waiters.findIndex((waiter) => waiter.id === message.id);
    if (at !== -1) waiters.splice(at, 1)[0]!.resolve(message);
  }

  (globalThis as { self?: unknown }).self = {
    addEventListener(type: string, handler: (event: { data: ToWorker }) => void) {
      if (type === "message") listeners.push(handler);
    },
    postMessage(message: FromWorker) {
      announce(message);
    },
    close: vi.fn(),
  };

  vi.resetModules();
  await import("./worker.js");

  return {
    dispatch(message) {
      for (const listener of listeners) listener({ data: message });
    },
    messages,
    replyTo(id, from = 0) {
      const already = messages.slice(from).find((message) => message.id === id);
      if (already !== undefined) return Promise.resolve(already);
      return new Promise((resolve) => waiters.push({ id, resolve }));
    },
  };
}

/** A configured worker with one graph loaded, which is where the interesting tests start. */
async function openLoadedWorker(): Promise<{
  worker: Awaited<ReturnType<typeof openWorker>>;
  graphId: string;
}> {
  const worker = await openWorker();
  worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
  await worker.replyTo(1);
  worker.dispatch({ kind: "load-graph", id: 2, bytes: Uint8Array.from([0]) });
  const loaded = await worker.replyTo(2);
  return { worker, graphId: (loaded as Extract<FromWorker, { kind: "loaded" }>).graphId };
}

describe("worker cancellation bookkeeping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ortBehaviour.duringCreate = null;
    ortBehaviour.duringRun = null;
  });

  afterEach(() => {
    delete (globalThis as { self?: unknown }).self;
  });

  it("ignores a cancel for an id the worker never received work for", async () => {
    const worker = await openWorker();

    expect(() => worker.dispatch({ kind: "cancel", id: 4242 })).not.toThrow();

    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);
    expect(worker.messages).toHaveLength(1);
  });

  it(
    "ignores a cancel that arrives after the operation it names has already completed, " +
      "and does not affect the run that follows it",
    async () => {
      const { worker, graphId } = await openLoadedWorker();

      worker.dispatch({ kind: "run", id: 3, graphId, inputs: { x: tensor(10) } });
      const firstResult = await worker.replyTo(3);
      expect([...(firstResult as Extract<FromWorker, { kind: "result" }>).outputs.y.data]).toEqual([
        11,
      ]);

      // The race this guards against: the main thread's `cancel` for an id the worker
      // has already finished with — and, on a real persistent worker, gone on finishing
      // many more operations since. `known` no longer has id 3, so this is a no-op.
      expect(() => worker.dispatch({ kind: "cancel", id: 3 })).not.toThrow();
      expect(worker.messages.filter((message) => message.kind === "error")).toEqual([]);

      worker.dispatch({ kind: "run", id: 4, graphId, inputs: { x: tensor(20) } });
      const secondResult = await worker.replyTo(4);
      expect([
        ...(secondResult as Extract<FromWorker, { kind: "result" }>).outputs.y.data,
      ]).toEqual([21]);
    },
  );

  it("leaves nothing behind when a run is cancelled while ORT is working and then fails", async () => {
    const { worker, graphId } = await openLoadedWorker();

    // The exact race: the abort reaches the worker while `session.run()` is suspended,
    // so the cancellation *is* recorded — and then the run throws, so none of the
    // `cancelled.delete(id)` checks on the success path is ever reached.
    ortBehaviour.duringRun = () => {
      worker.dispatch({ kind: "cancel", id: 3 });
      throw new Error("[ONNXRuntimeError] execution failed");
    };
    worker.dispatch({ kind: "run", id: 3, graphId, inputs: { x: tensor(10) } });

    const failure = await worker.replyTo(3);
    expect(failure.kind).toBe("error");
    expect((failure as Extract<FromWorker, { kind: "error" }>).code).toBe(
      "runtime-execution-failed",
    );
    // The cancelled caller was settled on the main thread at the moment it aborted, and
    // this reply is dropped there by the routing rule. No *result* was produced for it.
    expect(worker.messages.filter((message) => message.kind === "result")).toEqual([]);

    // Reusing an id is something only a test does — production mints each one once — and
    // it is precisely what makes a leftover cancellation marker observable from outside:
    // if id 3 were still in `cancelled`, this operation would be silently swallowed and
    // no reply would ever arrive.
    ortBehaviour.duringRun = null;
    const from = worker.messages.length;
    worker.dispatch({ kind: "run", id: 3, graphId, inputs: { x: tensor(20) } });

    const afterwards = await worker.replyTo(3, from);
    expect([...(afterwards as Extract<FromWorker, { kind: "result" }>).outputs.y.data]).toEqual([
      21,
    ]);
  });

  it("leaves nothing behind when a graph load is cancelled while ORT is creating and then fails", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    ortBehaviour.duringCreate = () => {
      worker.dispatch({ kind: "cancel", id: 2 });
      throw new Error("[ONNXRuntimeError] invalid protobuf");
    };
    worker.dispatch({ kind: "load-graph", id: 2, bytes: Uint8Array.from([0]) });

    const failure = await worker.replyTo(2);
    expect(failure.kind).toBe("error");
    expect((failure as Extract<FromWorker, { kind: "error" }>).code).toBe("graph-load-failed");

    ortBehaviour.duringCreate = null;
    const from = worker.messages.length;
    worker.dispatch({ kind: "load-graph", id: 2, bytes: Uint8Array.from([0]) });

    const loaded = await worker.replyTo(2, from);
    expect(loaded.kind).toBe("loaded");

    // And the graph that load produced is usable, so nothing about the failed attempt
    // leaked into the session table either.
    const graphId = (loaded as Extract<FromWorker, { kind: "loaded" }>).graphId;
    worker.dispatch({ kind: "run", id: 3, graphId, inputs: { x: tensor(30) } });
    const result = await worker.replyTo(3);
    expect([...(result as Extract<FromWorker, { kind: "result" }>).outputs.y.data]).toEqual([31]);
  });
});

describe("the model operations join the same bookkeeping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ortBehaviour.duringCreate = null;
    ortBehaviour.duringRun = null;
    ortBehaviour.disposals = 0;
  });

  afterEach(() => {
    delete (globalThis as { self?: unknown }).self;
  });

  it("replies to model-suggest with the fake decoder's own width, height, mask and confidence", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);
    worker.dispatch({
      kind: "model-load",
      id: 2,
      encoder: Uint8Array.from([1]),
      decoder: Uint8Array.from([2]),
    });
    await worker.replyTo(2);

    // A 2x1 image, not the 1x1 every other model test in this file uses: with every
    // fixture square, a reply that transposed width and height, or that answered with
    // the request's numbers instead of the fake decoder's, would look identical.
    worker.dispatch({
      kind: "model-prepare",
      id: 3,
      width: 2,
      height: 1,
      rgb: Uint8Array.from([1, 2, 3, 4, 5, 6]),
    });
    await worker.replyTo(3);

    worker.dispatch({
      kind: "model-suggest",
      id: 4,
      generation: 1,
      prompt: { positive: [[0, 0]], negative: [] },
    });
    const reply = (await worker.replyTo(4)) as Extract<FromWorker, { kind: "segmentation" }>;

    expect(reply.kind).toBe("segmentation");
    expect(reply.width).toBe(2);
    expect(reply.height).toBe(1);
    // The fake decoder's one candidate has exactly one lit logit: `binaryMask` reads it
    // as pixel 0, and reads past the end of the fake's single-element array for pixel 1,
    // which is 0 rather than lit.
    expect([...reply.mask]).toEqual([1, 0]);
    expect(reply.confidence).toBe(0.75);
  });

  it("drops a model-suggest whose id was cancelled before it ran", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    const prompt: PointPrompt = { positive: [[1, 1]], negative: [] };

    // Posted and cancelled in the same synchronous turn, exactly as the client's abort
    // listener does: `known.add` runs before the id is even enqueued behind `queue`, so
    // this `cancel` finds it there and the queued handler's own `cancelled.delete(id)`
    // check at entry is what turns it into a no-op — `modelSuggest` never calls
    // `requireHost()`, and no model was even loaded to call it against.
    worker.dispatch({ kind: "model-suggest", id: 2, generation: 1, prompt });
    worker.dispatch({ kind: "cancel", id: 2 });

    // A trailing operation on the same serial queue: once *its* reply arrives, id 2 has
    // already run its course, silently or not. It fails (no model is loaded), which is
    // exactly the point — the failure proves the queue kept moving.
    worker.dispatch({ kind: "model-suggest", id: 3, generation: 1, prompt });
    const marker = await worker.replyTo(3);
    expect(marker.kind).toBe("error");

    expect(worker.messages.some((message) => message.id === 2)).toBe(false);

    // Reusable: a fresh operation under the same id now actually runs — it reaches
    // `requireHost()` and fails loudly — rather than being swallowed a second time by a
    // leftover cancellation marker.
    const from = worker.messages.length;
    worker.dispatch({ kind: "model-suggest", id: 2, generation: 1, prompt });
    const afterwards = await worker.replyTo(2, from);
    expect(afterwards.kind).toBe("error");
    expect((afterwards as Extract<FromWorker, { kind: "error" }>).code).toBe("graph-load-failed");
  });

  it("releases the model when the worker is shut down", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    worker.dispatch({
      kind: "model-load",
      id: 2,
      encoder: Uint8Array.from([1]),
      decoder: Uint8Array.from([2]),
    });
    const loaded = await worker.replyTo(2);
    expect(loaded.kind).toBe("model-loaded");

    // Fetched after the worker module (and the mocked ORT it imports) has already been
    // (re)loaded for this test, rather than imported once at file scope, so this binds
    // to the exact module instance `worker.js` is using regardless of how
    // `vi.resetModules()` in `openWorker()` treats a mocked module's cache.
    const { InferenceSession } = await import("onnxruntime-web/webgpu");
    const create = vi.mocked(InferenceSession.create);
    expect(create.mock.results).toHaveLength(2);
    const encoderSession = await create.mock.results[0]!.value;
    const decoderSession = await create.mock.results[1]!.value;

    worker.dispatch({ kind: "shutdown", id: 3 });
    const disposed = await worker.replyTo(3);
    expect(disposed.kind).toBe("disposed");

    expect(encoderSession.release).toHaveBeenCalledTimes(1);
    expect(decoderSession.release).toHaveBeenCalledTimes(1);
  });

  it("drops a model-load whose id was cancelled before it ran", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    const encoder = Uint8Array.from([1]);
    const decoder = Uint8Array.from([2]);

    worker.dispatch({ kind: "model-load", id: 2, encoder, decoder });
    worker.dispatch({ kind: "cancel", id: 2 });

    worker.dispatch({ kind: "model-load", id: 3, encoder, decoder });
    const marker = await worker.replyTo(3);
    expect(marker.kind).toBe("model-loaded");

    expect(worker.messages.some((message) => message.id === 2)).toBe(false);

    const from = worker.messages.length;
    worker.dispatch({ kind: "model-load", id: 2, encoder, decoder });
    const afterwards = await worker.replyTo(2, from);
    expect(afterwards.kind).toBe("model-loaded");
  });

  it("drops a model-prepare whose id was cancelled before it ran", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    const rgb = Uint8Array.from([1, 2, 3]);

    worker.dispatch({ kind: "model-prepare", id: 2, width: 1, height: 1, rgb });
    worker.dispatch({ kind: "cancel", id: 2 });

    // No model is loaded in this test at all: the entry check must reject the id before
    // `modelPrepare` ever reaches `requireHost()`.
    worker.dispatch({ kind: "model-prepare", id: 3, width: 1, height: 1, rgb });
    const marker = await worker.replyTo(3);
    expect(marker.kind).toBe("error");

    expect(worker.messages.some((message) => message.id === 2)).toBe(false);

    const from = worker.messages.length;
    worker.dispatch({ kind: "model-prepare", id: 2, width: 1, height: 1, rgb });
    const afterwards = await worker.replyTo(2, from);
    expect(afterwards.kind).toBe("error");
    expect((afterwards as Extract<FromWorker, { kind: "error" }>).code).toBe("graph-load-failed");
  });

  it(
    "abandons a model-load's freshly created sessions when cancelled after both graphs " +
      "finished loading",
    async () => {
      const worker = await openWorker();
      worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
      await worker.replyTo(1);

      // Fires during both the encoder's and the decoder's `InferenceSession.create()`;
      // dispatching `cancel` twice for the same id is harmless (it is a `Set`), and by
      // the time `host.load()` resolves both sessions exist and the id is marked
      // cancelled — the exact race the post-await check in `modelLoad` exists for.
      ortBehaviour.duringCreate = () => {
        worker.dispatch({ kind: "cancel", id: 2 });
      };
      worker.dispatch({
        kind: "model-load",
        id: 2,
        encoder: Uint8Array.from([1]),
        decoder: Uint8Array.from([2]),
      });

      // Trailing marker: no model was ever installed, so this fails "no model is loaded".
      worker.dispatch({ kind: "model-prepare", id: 3, width: 1, height: 1, rgb: Uint8Array.from([1, 2, 3]) });
      const marker = await worker.replyTo(3);
      expect(marker.kind).toBe("error");
      expect((marker as Extract<FromWorker, { kind: "error" }>).code).toBe("graph-load-failed");

      expect(worker.messages.some((message) => message.id === 2)).toBe(false);

      const { InferenceSession } = await import("onnxruntime-web/webgpu");
      const create = vi.mocked(InferenceSession.create);
      const encoderSession = await create.mock.results[0]!.value;
      const decoderSession = await create.mock.results[1]!.value;
      expect(encoderSession.release).toHaveBeenCalledTimes(1);
      expect(decoderSession.release).toHaveBeenCalledTimes(1);
    },
  );

  it("releases the encoder session a failed decoder create would otherwise leak", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    let createCalls = 0;
    ortBehaviour.duringCreate = () => {
      createCalls += 1;
      // The encoder (first call) succeeds; the decoder (second) is the realistic
      // failure — a corrupt artifact, an OOM — after a session already exists.
      if (createCalls === 2) throw new Error("[ONNXRuntimeError] corrupt decoder artifact");
    };

    worker.dispatch({
      kind: "model-load",
      id: 2,
      encoder: Uint8Array.from([1]),
      decoder: Uint8Array.from([2]),
    });
    const failure = await worker.replyTo(2);
    expect(failure.kind).toBe("error");
    expect((failure as Extract<FromWorker, { kind: "error" }>).code).toBe("graph-load-failed");

    const { InferenceSession } = await import("onnxruntime-web/webgpu");
    const create = vi.mocked(InferenceSession.create);
    expect(create.mock.results).toHaveLength(2);
    const encoderSession = await create.mock.results[0]!.value;
    // The bug this guards against: `created` (holding the live encoder session) was
    // simply dropped on the failure path, so nothing ever released it.
    expect(encoderSession.release).toHaveBeenCalledTimes(1);

    // The worker is not left holding a broken half-loaded model.
    worker.dispatch({ kind: "model-prepare", id: 3, width: 1, height: 1, rgb: Uint8Array.from([1, 2, 3]) });
    const afterFailure = await worker.replyTo(3);
    expect((afterFailure as Extract<FromWorker, { kind: "error" }>).code).toBe("graph-load-failed");

    // And a retry is not blocked by anything the failed attempt left behind.
    ortBehaviour.duringCreate = null;
    const from = worker.messages.length;
    worker.dispatch({
      kind: "model-load",
      id: 4,
      encoder: Uint8Array.from([1]),
      decoder: Uint8Array.from([2]),
    });
    const retried = await worker.replyTo(4, from);
    expect(retried.kind).toBe("model-loaded");
  });

  it("keeps the newly loaded model in place when releasing the model it replaces throws", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    worker.dispatch({
      kind: "model-load",
      id: 2,
      encoder: Uint8Array.from([1]),
      decoder: Uint8Array.from([2]),
    });
    const firstLoad = await worker.replyTo(2);
    expect(firstLoad.kind).toBe("model-loaded");

    const { InferenceSession } = await import("onnxruntime-web/webgpu");
    const create = vi.mocked(InferenceSession.create);
    const firstEncoder = await create.mock.results[0]!.value;
    firstEncoder.release.mockRejectedValueOnce(new Error("stuck GPU buffer"));

    worker.dispatch({
      kind: "model-load",
      id: 3,
      encoder: Uint8Array.from([3]),
      decoder: Uint8Array.from([4]),
    });
    const secondLoad = await worker.replyTo(3);
    // The bug this guards against: the old release throwing here used to propagate out
    // of `modelLoad` as a `graph-load-failed` error, even though the new model's two
    // sessions had already been created successfully — orphaning them.
    expect(secondLoad.kind).toBe("model-loaded");

    const secondEncoder = await create.mock.results[2]!.value;
    const secondDecoder = await create.mock.results[3]!.value;

    worker.dispatch({ kind: "shutdown", id: 4 });
    const disposed = await worker.replyTo(4);
    expect(disposed.kind).toBe("disposed");

    // Proof that `host` really was swapped to the second model rather than left pointing
    // at the first (which would leave these two never released).
    expect(secondEncoder.release).toHaveBeenCalledTimes(1);
    expect(secondDecoder.release).toHaveBeenCalledTimes(1);
  });

  it("forgets the embedding a prepare produced after its caller was cancelled", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    worker.dispatch({
      kind: "model-load",
      id: 2,
      encoder: Uint8Array.from([1]),
      decoder: Uint8Array.from([2]),
    });
    await worker.replyTo(2);

    // Fires during the encoder's `session.run()`, i.e. after `host.prepare()` has
    // committed the new embedding to its one slot but before `modelPrepare` has replied.
    ortBehaviour.duringRun = () => {
      worker.dispatch({ kind: "cancel", id: 3 });
    };
    worker.dispatch({ kind: "model-prepare", id: 3, width: 1, height: 1, rgb: Uint8Array.from([1, 2, 3]) });

    // Trailing marker and a second proof at once: `prepare()` is this host's first ever
    // call, so its generation is deterministically 1. If `forget()` had not run, this
    // `suggest` would succeed instead of failing "image-superseded".
    worker.dispatch({
      kind: "model-suggest",
      id: 4,
      generation: 1,
      prompt: { positive: [[0, 0]], negative: [] },
    });
    const marker = await worker.replyTo(4);
    expect(marker.kind).toBe("error");
    expect((marker as Extract<FromWorker, { kind: "error" }>).code).toBe("image-superseded");

    expect(worker.messages.some((message) => message.id === 3)).toBe(false);
    // The embedding itself — not just the bookkeeping around it — was released.
    expect(ortBehaviour.disposals).toBe(1);
  });

  it("omits detail rather than sending an empty string when a model error carries no cause", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    // No model is loaded: `requireHost()` throws an `InferenceRuntimeError` with no
    // `cause` at all, which is the case `failFromModel` must not turn into `detail: ""`.
    worker.dispatch({
      kind: "model-suggest",
      id: 2,
      generation: 1,
      prompt: { positive: [[0, 0]], negative: [] },
    });
    const failure = await worker.replyTo(2);
    expect(failure.kind).toBe("error");
    expect((failure as Extract<FromWorker, { kind: "error" }>).detail).toBeUndefined();
  });

  it("drops a model-suggest's segmentation when cancelled while the decoder is running", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    worker.dispatch({
      kind: "model-load",
      id: 2,
      encoder: Uint8Array.from([1]),
      decoder: Uint8Array.from([2]),
    });
    await worker.replyTo(2);

    worker.dispatch({ kind: "model-prepare", id: 3, width: 1, height: 1, rgb: Uint8Array.from([1, 2, 3]) });
    const prepared = await worker.replyTo(3);
    expect(prepared.kind).toBe("prepared");
    const generation = (prepared as Extract<FromWorker, { kind: "prepared" }>).generation;
    const prompt: PointPrompt = { positive: [[0, 0]], negative: [] };

    // Fires during the decoder's `session.run()` — after `host.suggest()` has a real
    // answer computed but before `modelSuggest` has checked for cancellation again. This
    // is the same race the pre-existing `run` cancellation tests exercise, for the one
    // model operation that was missing it. Self-clearing, because both id 4 and the
    // trailing id 5 below are queued *before* either one actually runs — the hook must
    // fire only for the first `session.run()` it sees (id 4's), not id 5's too.
    ortBehaviour.duringRun = () => {
      ortBehaviour.duringRun = null;
      worker.dispatch({ kind: "cancel", id: 4 });
    };
    worker.dispatch({ kind: "model-suggest", id: 4, generation, prompt });

    // Trailing marker on the same serial queue: this one must succeed, proving the queue
    // kept moving rather than id 4 wedging it.
    worker.dispatch({ kind: "model-suggest", id: 5, generation, prompt });
    const marker = await worker.replyTo(5);
    expect(marker.kind).toBe("segmentation");

    expect(worker.messages.some((message) => message.id === 4)).toBe(false);
  });

  it("ignores a stray cancel for a model-load that has already completed, and the id stays usable", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    const encoder = Uint8Array.from([1]);
    const decoder = Uint8Array.from([2]);

    worker.dispatch({ kind: "model-load", id: 2, encoder, decoder });
    const firstLoad = await worker.replyTo(2);
    expect(firstLoad.kind).toBe("model-loaded");

    // A cancel for an id this worker has already finished with — and, on a real
    // persistent worker, may have finished with long ago. This is exactly what
    // `known.delete(id)` in `modelLoad`'s `finally` exists to make safe: without it,
    // `known` still has this id forever, and this `cancel` would be wrongly recorded.
    expect(() => worker.dispatch({ kind: "cancel", id: 2 })).not.toThrow();

    // Reusing the id is the only way to observe a wrongly-recorded marker from outside:
    // if the stray cancel above had been recorded, this fresh operation under the same
    // id would be silently swallowed by the entry check instead of actually running.
    const from = worker.messages.length;
    worker.dispatch({ kind: "model-load", id: 2, encoder, decoder });
    const secondLoad = await worker.replyTo(2, from);
    expect(secondLoad.kind).toBe("model-loaded");
  });

  it("ignores a stray cancel for a model-prepare that has already completed, and the id stays usable", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    worker.dispatch({
      kind: "model-load",
      id: 2,
      encoder: Uint8Array.from([1]),
      decoder: Uint8Array.from([2]),
    });
    await worker.replyTo(2);

    const rgb = Uint8Array.from([1, 2, 3]);
    worker.dispatch({ kind: "model-prepare", id: 3, width: 1, height: 1, rgb });
    const firstPrepare = await worker.replyTo(3);
    expect(firstPrepare.kind).toBe("prepared");

    expect(() => worker.dispatch({ kind: "cancel", id: 3 })).not.toThrow();

    const from = worker.messages.length;
    worker.dispatch({ kind: "model-prepare", id: 3, width: 1, height: 1, rgb });
    const secondPrepare = await worker.replyTo(3, from);
    expect(secondPrepare.kind).toBe("prepared");
  });

  it("ignores a stray cancel for a model-suggest that has already completed, and the id stays usable", async () => {
    const worker = await openWorker();
    worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
    await worker.replyTo(1);

    worker.dispatch({
      kind: "model-load",
      id: 2,
      encoder: Uint8Array.from([1]),
      decoder: Uint8Array.from([2]),
    });
    await worker.replyTo(2);

    worker.dispatch({ kind: "model-prepare", id: 3, width: 1, height: 1, rgb: Uint8Array.from([1, 2, 3]) });
    const prepared = await worker.replyTo(3);
    const generation = (prepared as Extract<FromWorker, { kind: "prepared" }>).generation;
    const prompt: PointPrompt = { positive: [[0, 0]], negative: [] };

    worker.dispatch({ kind: "model-suggest", id: 4, generation, prompt });
    const firstSuggest = await worker.replyTo(4);
    expect(firstSuggest.kind).toBe("segmentation");

    expect(() => worker.dispatch({ kind: "cancel", id: 4 })).not.toThrow();

    const from = worker.messages.length;
    worker.dispatch({ kind: "model-suggest", id: 4, generation, prompt });
    const secondSuggest = await worker.replyTo(4, from);
    expect(secondSuggest.kind).toBe("segmentation");
  });
});
