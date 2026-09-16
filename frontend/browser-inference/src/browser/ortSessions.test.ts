import { beforeEach, describe, expect, it, vi } from "vitest";

import { ortSessions } from "./ortSessions.js";

/**
 * What the last `create`/`run` call received, and what the next `run` should answer —
 * enough to drive `ortSessions` without ever touching real ONNX Runtime.
 */
const ortState = vi.hoisted(() => ({
  lastCreateOptions: null as null | { executionProviders: readonly string[] },
  lastFeeds: null as null | Record<string, { type: string; data: unknown; dims: readonly number[] }>,
  runAnswer: {} as Record<string, unknown>,
}));

vi.mock("onnxruntime-web/webgpu", () => {
  class FakeOrtTensor {
    constructor(
      readonly type: string,
      readonly data: Float32Array | BigInt64Array,
      readonly dims: readonly number[],
    ) {}
  }

  const create = vi.fn(
    async (_bytes: Uint8Array, options: { executionProviders: readonly string[] }) => {
      ortState.lastCreateOptions = options;
      return {
        // "also-kept" is declared here but never answered by `run` in most tests, which
        // is what proves the output loop filters on this list rather than on the answer.
        outputNames: ["kept", "also-kept"],
        run: vi.fn(
          async (feeds: Record<string, { type: string; data: unknown; dims: readonly number[] }>) => {
            ortState.lastFeeds = feeds;
            return ortState.runAnswer;
          },
        ),
        release: vi.fn(async () => undefined),
      };
    },
  );

  return {
    InferenceSession: { create },
    Tensor: FakeOrtTensor,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  ortState.lastCreateOptions = null;
  ortState.lastFeeds = null;
  ortState.runAnswer = {};
});

describe("ortSessions", () => {
  it("creates an ORT session with exactly the given execution providers", async () => {
    await ortSessions(["webgpu", "wasm"]).create(Uint8Array.from([1, 2, 3]));
    expect(ortState.lastCreateOptions?.executionProviders).toEqual(["webgpu", "wasm"]);
  });

  it("wraps a float32 feed as an ORT float32 tensor, values and dims intact", async () => {
    const session = await ortSessions(["wasm"]).create(Uint8Array.from([0]));
    await session.run({ x: { type: "float32", data: Float32Array.from([1, 2, 3]), dims: [3] } });

    const wrapped = ortState.lastFeeds!.x!;
    expect(wrapped.type).toBe("float32");
    expect([...(wrapped.data as Float32Array)]).toEqual([1, 2, 3]);
    expect(wrapped.dims).toEqual([3]);
  });

  it("wraps an int64 feed as an ORT int64 tensor without copying its data", async () => {
    const session = await ortSessions(["wasm"]).create(Uint8Array.from([0]));
    const data = BigInt64Array.from([2n, 3n]);
    await session.run({ size: { type: "int64", data, dims: [2] } });

    const wrapped = ortState.lastFeeds!.size!;
    expect(wrapped.type).toBe("int64");
    // Same reference, not a copy: `orig_im_size` is two integers, not a tensor size that
    // would ever justify one, and this pins that `toOrt` never allocates for it.
    expect(wrapped.data).toBe(data);
  });

  it("refuses an int64 ModelTensor whose data is not a BigInt64Array", async () => {
    const session = await ortSessions(["wasm"]).create(Uint8Array.from([0]));

    // `ModelTensor` is not a discriminated union — `type` and `data` are independent —
    // so this combination type-checks. It must still fail loudly rather than handing ORT
    // a float32 buffer under an int64 tag.
    await expect(
      session.run({ size: { type: "int64", data: Float32Array.from([2, 3]), dims: [2] } }),
    ).rejects.toThrow(TypeError);
  });

  it("filters run() outputs to the names ORT's session actually declares and answers", async () => {
    ortState.runAnswer = {
      kept: { type: "float32", data: Float32Array.from([1, 2]), dims: [2], dispose: () => undefined },
      // Present in the answer but not in `outputNames`: must not surface either.
      unnamed: { type: "float32", data: Float32Array.from([9]), dims: [1], dispose: () => undefined },
    };
    const session = await ortSessions(["wasm"]).create(Uint8Array.from([0]));
    const outputs = await session.run({});

    expect(Object.keys(outputs)).toEqual(["kept"]);
    expect([...outputs.kept!.data]).toEqual([1, 2]);
  });

  it("does not copy an output tensor's data — the array ORT produced is handed back as-is", async () => {
    const embeddingData = Float32Array.from([1, 2, 3, 4]);
    ortState.runAnswer = {
      kept: { type: "float32", data: embeddingData, dims: [1, 4], dispose: () => undefined },
    };
    const session = await ortSessions(["wasm"]).create(Uint8Array.from([0]));
    const outputs = await session.run({});

    // Deliberately not `Float32Array.from(...)`, unlike `worker.ts`'s `fromTensor`: this
    // array can be a 4 MB embedding that never leaves the worker and is fed straight back
    // into the decoder, so a copy here would be pure waste. Identity, not just equal
    // contents, is the thing this test has to pin — a `.slice()` "fix" would still pass
    // a `toEqual` check and would still allocate 4 MB for nothing.
    expect(outputs.kept!.data).toBe(embeddingData);
    // `dims` is load-bearing, not decoration: this same `ModelTensor` is fed straight back
    // as `image_embeddings`, whose shape the decoder graph checks.
    expect(outputs.kept!.dims).toEqual([1, 4]);
    expect(outputs.kept!.type).toBe("float32");
  });

  it("forwards a ModelTensor's dispose() to the ORT tensor it wraps", async () => {
    const dispose = vi.fn();
    ortState.runAnswer = {
      kept: { type: "float32", data: Float32Array.from([1]), dims: [1], dispose },
    };
    const session = await ortSessions(["wasm"]).create(Uint8Array.from([0]));
    const outputs = await session.run({});

    outputs.kept!.dispose?.();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("delegates release() to the underlying ORT session", async () => {
    const { InferenceSession } = await import("onnxruntime-web/webgpu");
    const create = vi.mocked(InferenceSession.create);

    const session = await ortSessions(["wasm"]).create(Uint8Array.from([0]));
    const raw = await create.mock.results[0]!.value;

    await session.release();
    expect(raw.release).toHaveBeenCalledTimes(1);
  });
});
