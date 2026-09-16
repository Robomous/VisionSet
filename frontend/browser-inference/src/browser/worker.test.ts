import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FromWorker, TensorLike, ToWorker } from "../protocol.js";

/**
 * A fake ORT that never touches WebAssembly or a GPU: `create` and `run` resolve on
 * the microtask queue, which is enough to drive the worker's real message-handling and
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

  const create = vi.fn(async () => ({
    outputNames: ["y"],
    run: vi.fn(async (feeds: Record<string, InstanceType<typeof FakeTensor>>) => {
      const x = feeds.x;
      return { y: new FakeTensor("float32", Float32Array.from(x.data, (value) => value + 1), x.dims) };
    }),
    release: vi.fn(async () => undefined),
  }));

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
  /** The reply to the request minted with this id — not "the next message of a kind", so two `run`s in the same test cannot be confused. */
  replyTo(id: number): Promise<FromWorker>;
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
    replyTo(id) {
      const already = messages.find((message) => message.id === id);
      if (already !== undefined) return Promise.resolve(already);
      return new Promise((resolve) => waiters.push({ id, resolve }));
    },
  };
}

describe("worker cancellation bookkeeping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      const worker = await openWorker();

      worker.dispatch({ kind: "configure", id: 1, providers: ["wasm"], wasmThreads: 1 });
      await worker.replyTo(1);

      worker.dispatch({ kind: "load-graph", id: 2, bytes: Uint8Array.from([0]) });
      const loaded = await worker.replyTo(2);
      const graphId = (loaded as Extract<FromWorker, { kind: "loaded" }>).graphId;

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

      // A black-box test cannot see `known`'s size directly without a diagnostic API
      // this design deliberately does not ship. What it proves instead: a cancel for a
      // finished id raises nothing and poisons nothing that runs after it. The bound
      // itself is the code-level invariant in `worker.ts` — every path through
      // `loadGraph`/`run` removes its own id from `known` in a `finally`, so at any
      // instant `cancelled.size <= known.size`, which is the count of operations this
      // worker currently has in flight, not the count it has ever seen.
    },
  );
});
