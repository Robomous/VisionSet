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
}));

/**
 * A fake ORT that never touches WebAssembly or a GPU: `create` and `run` resolve on the
 * microtask queue, which is enough to drive the worker's real message-handling and
 * cancellation logic without a browser. `run` answers `y = x + 1`, so a caller can tell
 * two calls apart by their numbers alone.
 */
vi.mock("onnxruntime-web/webgpu", () => {
  class FakeTensor {
    readonly type = "float32";
    constructor(
      _type: string,
      readonly data: Float32Array,
      readonly dims: readonly number[],
    ) {}
  }

  const create = vi.fn(async () => {
    ortBehaviour.duringCreate?.();
    return {
      outputNames: ["y"],
      run: vi.fn(async (feeds: Record<string, InstanceType<typeof FakeTensor>>) => {
        ortBehaviour.duringRun?.();
        const x = feeds.x;
        return {
          y: new FakeTensor("float32", Float32Array.from(x.data, (value) => value + 1), x.dims),
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
  });

  afterEach(() => {
    delete (globalThis as { self?: unknown }).self;
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
});
