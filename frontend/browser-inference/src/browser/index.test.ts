import { afterEach, describe, expect, it, vi } from "vitest";

import { isInferenceRuntimeError } from "../errors.js";
import { createEfficientSamRuntime } from "./index.js";

interface PostedMessage {
  readonly message: unknown;
  readonly transfer: unknown;
}

/**
 * The smallest thing that behaves like a browser `Worker` from `channelOver`'s point of
 * view: `postMessage`, `terminate`, and `addEventListener` for `"message"`/`"error"`.
 * There is no real worker script behind it — `startWorker` never reads one, it only
 * constructs a `Worker` and posts to it — so this is enough to drive
 * `createEfficientSamRuntime` end to end without a browser.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly posted: PostedMessage[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  terminated = 0;

  constructor(
    readonly url: string | URL,
    readonly options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown, transfer?: unknown): void {
    this.posted.push({ message, transfer });
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  terminate(): void {
    this.terminated += 1;
  }
}

function modelLoadOf(worker: FakeWorker): { encoder: Uint8Array; decoder: Uint8Array } {
  const entry = worker.posted.find(
    (posted): posted is PostedMessage & { message: { kind: "model-load" } } =>
      typeof posted.message === "object" &&
      posted.message !== null &&
      (posted.message as { kind?: unknown }).kind === "model-load",
  );
  if (entry === undefined) throw new Error("no model-load message was posted");
  return entry.message as unknown as { encoder: Uint8Array; decoder: Uint8Array };
}

afterEach(() => {
  FakeWorker.instances.length = 0;
  vi.unstubAllGlobals();
});

describe("createEfficientSamRuntime", () => {
  it("loads the encoder and decoder into their own slots, transferred and not transposed", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const encoder = Uint8Array.from([1, 2, 3]);
    const decoder = Uint8Array.from([9, 9]);

    createEfficientSamRuntime({ policy: "wasm-only", encoder, decoder });

    expect(FakeWorker.instances).toHaveLength(1);
    const [worker] = FakeWorker.instances as [FakeWorker];
    const loaded = modelLoadOf(worker);
    expect(loaded.encoder).toEqual(encoder);
    expect(loaded.decoder).toEqual(decoder);

    const transferEntry = worker.posted.find(
      (posted) =>
        typeof posted.message === "object" &&
        posted.message !== null &&
        (posted.message as { kind?: unknown }).kind === "model-load",
    );
    expect(transferEntry?.transfer).toEqual([encoder.buffer, decoder.buffer]);
  });

  it("refuses require-webgpu synchronously, before a worker is ever constructed", () => {
    vi.stubGlobal("Worker", FakeWorker);

    let error: unknown;
    try {
      createEfficientSamRuntime({
        policy: "require-webgpu",
        encoder: Uint8Array.from([1]),
        decoder: Uint8Array.from([2]),
      });
    } catch (caught) {
      error = caught;
    }

    expect(isInferenceRuntimeError(error) && error.code).toBe("webgpu-unavailable");
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
