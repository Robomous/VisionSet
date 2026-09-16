import { describe, expect, it } from "vitest";

import { createRuntimeClient, type BrowserInferenceRuntime } from "./client.js";
import { InferenceRuntimeError, isInferenceRuntimeError } from "./errors.js";
import type {
  FromWorker,
  OperationId,
  RunOutputs,
  TensorLike,
  ToWorker,
  WorkerChannel,
} from "./protocol.js";

function tensor(...values: number[]): TensorLike {
  return { data: Float32Array.from(values), dims: [values.length] };
}

interface Harness {
  readonly runtime: BrowserInferenceRuntime;
  /** Everything the client has posted, configure included, in order. */
  readonly posted: readonly ToWorker[];
  /** The ids the client minted for messages of one kind, in the order it posted them. */
  idsOf(kind: ToWorker["kind"]): OperationId[];
  reply(message: FromWorker): void;
  failChannel(error: unknown): void;
  terminations(): number;
}

/**
 * The client against a worker that does exactly what the test says and nothing else.
 * Every reply is delivered by hand, so "out of order" and "late" are things a test
 * states rather than things it has to provoke.
 */
function harness(): Harness {
  const posted: ToWorker[] = [];
  let terminated = 0;
  let deliver: ((message: unknown) => void) | undefined;
  let failChannel: ((error: unknown) => void) | undefined;

  const channel: WorkerChannel = {
    worker: {
      postMessage(message) {
        posted.push(message as ToWorker);
      },
      terminate() {
        terminated += 1;
      },
    },
    onMessage(handler) {
      deliver = handler;
    },
    onError(handler) {
      failChannel = handler;
    },
  };

  const runtime = createRuntimeClient(channel, { providers: ["wasm"], wasmThreads: 1 });

  return {
    runtime,
    posted,
    idsOf: (kind) => posted.filter((message) => message.kind === kind).map((message) => message.id),
    reply: (message) => {
      if (deliver === undefined) throw new Error("the client registered no message handler");
      deliver(message);
    },
    failChannel: (error) => {
      if (failChannel === undefined) throw new Error("the client registered no error handler");
      failChannel(error);
    },
    terminations: () => terminated,
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

describe("operation ids", () => {
  it("mints a distinct id per request and routes each reply by it", async () => {
    const { runtime, reply, idsOf } = harness();

    const first = runtime.run("graph", { x: tensor(1) });
    const second = runtime.run("graph", { x: tensor(2) });
    const [firstId, secondId] = idsOf("run");

    expect(firstId).not.toBe(secondId);
    reply({ kind: "result", id: firstId, outputs: { y: tensor(10) } });
    reply({ kind: "result", id: secondId, outputs: { y: tensor(20) } });

    expect([...(await first).y.data]).toEqual([10]);
    expect([...(await second).y.data]).toEqual([20]);
  });

  it("drops a reply whose id was never minted", async () => {
    const { runtime, reply, idsOf } = harness();

    const outstanding = runtime.run("graph", { x: tensor(1) });
    const [runId] = idsOf("run");

    expect(() => reply({ kind: "result", id: runId + 500, outputs: { y: tensor(99) } })).not.toThrow();

    reply({ kind: "result", id: runId, outputs: { y: tensor(3) } });
    expect([...(await outstanding).y.data]).toEqual([3]);
  });
});

describe("out-of-order replies", () => {
  it("settles each caller with its own result, whatever order the answers arrive in", async () => {
    const { runtime, reply, idsOf } = harness();

    let firstSettled = false;
    const first = runtime.run("graph", { x: tensor(1) }).then((outputs: RunOutputs) => {
      firstSettled = true;
      return outputs;
    });
    const second = runtime.run("graph", { x: tensor(2) });
    const [firstId, secondId] = idsOf("run");

    // The second request is answered first, and the first caller must not notice.
    reply({ kind: "result", id: secondId, outputs: { y: tensor(200) } });
    expect([...(await second).y.data]).toEqual([200]);
    expect(firstSettled).toBe(false);

    reply({ kind: "result", id: firstId, outputs: { y: tensor(100) } });
    expect([...(await first).y.data]).toEqual([100]);
    expect(firstSettled).toBe(true);
  });
});

describe("cancellation", () => {
  it("settles the caller at the moment of the abort and tells the worker afterwards", async () => {
    const { runtime, reply, idsOf } = harness();
    const controller = new AbortController();

    const cancelled = runtime.run("graph", { x: tensor(1) }, { signal: controller.signal });
    const [runId] = idsOf("run");
    controller.abort();

    expect((await rejection(cancelled)).code).toBe("cancelled");
    expect(idsOf("cancel")).toEqual([runId]);

    // The worker's answer arrives anyway — ORT cannot be interrupted mid-run — and is
    // dropped by the routing rule rather than by a check that knows about cancellation.
    expect(() => reply({ kind: "result", id: runId, outputs: { y: tensor(1) } })).not.toThrow();

    const afterwards = runtime.run("graph", { x: tensor(2) });
    const laterId = idsOf("run")[1];
    reply({ kind: "result", id: laterId, outputs: { y: tensor(7) } });
    expect([...(await afterwards).y.data]).toEqual([7]);
  });

  it("posts nothing at all for a signal that was already aborted", async () => {
    const { runtime, posted } = harness();
    const controller = new AbortController();
    controller.abort();

    const before = posted.length;
    const refused = runtime.run("graph", { x: tensor(1) }, { signal: controller.signal });

    expect((await rejection(refused)).code).toBe("cancelled");
    expect(posted.length).toBe(before);
  });
});

describe("worker failures", () => {
  it("rebuilds an error reply into an InferenceRuntimeError with its cause intact", async () => {
    const { runtime, reply, idsOf } = harness();

    const loading = runtime.loadGraph(Uint8Array.from([1, 2, 3]));
    const [loadId] = idsOf("load-graph");
    reply({
      kind: "error",
      id: loadId,
      code: "graph-load-failed",
      message: "the graph could not be loaded",
      detail: "Error: [ONNXRuntimeError] invalid protobuf",
    });

    const error = await rejection(loading);
    expect(error.code).toBe("graph-load-failed");
    expect(error.message).toBe("the graph could not be loaded");
    expect(error.cause).toBe("Error: [ONNXRuntimeError] invalid protobuf");
  });

  it("fails every outstanding operation when the worker itself never started", async () => {
    const { runtime, failChannel } = harness();

    const ready = runtime.ready();
    const loading = runtime.loadGraph(Uint8Array.from([1]));
    const running = runtime.run("graph", { x: tensor(1) });

    failChannel(new Error("Failed to construct 'Worker'"));

    for (const operation of [ready, loading, running]) {
      expect((await rejection(operation)).code).toBe("worker-initialization-failed");
    }
  });
});

describe("dispose", () => {
  it("settles everything outstanding, refuses everything after, and stops the worker", async () => {
    const { runtime, reply, posted, idsOf, terminations } = harness();

    const loading = runtime.loadGraph(Uint8Array.from([1]));
    const running = runtime.run("graph", { x: tensor(1) });
    const [runId] = idsOf("run");

    runtime.dispose();

    expect((await rejection(loading)).code).toBe("disposed");
    expect((await rejection(running)).code).toBe("disposed");
    expect(idsOf("shutdown")).toHaveLength(1);
    expect(terminations()).toBe(1);

    const postedAtDispose = posted.length;
    expect((await rejection(runtime.run("graph", { x: tensor(1) }))).code).toBe("disposed");
    expect((await rejection(runtime.loadGraph(Uint8Array.from([1])))).code).toBe("disposed");
    expect(posted.length).toBe(postedAtDispose);

    // A reply for an operation that was rejected at dispose finds no entry, so it
    // settles nothing and posts nothing — the same rule, a third situation.
    expect(() => reply({ kind: "result", id: runId, outputs: { y: tensor(5) } })).not.toThrow();
    expect((await rejection(running)).code).toBe("disposed");
    expect(posted.length).toBe(postedAtDispose);
  });

  it("is idempotent", () => {
    const { runtime, posted, terminations } = harness();

    runtime.dispose();
    const postedAtDispose = posted.length;
    runtime.dispose();

    expect(posted.length).toBe(postedAtDispose);
    expect(terminations()).toBe(1);
  });
});

describe("configuration", () => {
  it("posts configure as an ordinary operation and answers ready from its reply", async () => {
    const { runtime, posted, reply, idsOf } = harness();

    const configure = posted[0];
    expect(configure.kind).toBe("configure");

    const [configureId] = idsOf("configure");
    reply({ kind: "ready", id: configureId, providers: ["wasm"] });

    expect(await runtime.ready()).toEqual(["wasm"]);
  });

  it("reports a configuration failure as an ordinary error reply", async () => {
    const { runtime, reply, idsOf } = harness();

    const [configureId] = idsOf("configure");
    reply({
      kind: "error",
      id: configureId,
      code: "worker-initialization-failed",
      message: "no WASM artifact at the configured base URL",
    });

    expect((await rejection(runtime.ready())).code).toBe("worker-initialization-failed");
  });
});
