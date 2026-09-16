import { beforeEach, describe, expect, it } from "vitest";

import { isInferenceRuntimeError } from "../errors.js";
import { createModelHost } from "./host.js";
import type { ModelSession, ModelSessionFactory, ModelTensor } from "./session.js";

const WIDTH = 4;
const HEIGHT = 3;
const PLANE = WIDTH * HEIGHT;

function image(fill = 7) {
  return { width: WIDTH, height: HEIGHT, rgb: new Uint8Array(PLANE * 3).fill(fill) };
}

class FakeSession implements ModelSession {
  runs = 0;
  released = 0;
  lastFeeds: Readonly<Record<string, ModelTensor>> = {};
  // Mutable so a test can make a later run fail without recreating the session
  // the host is already holding a reference to.
  constructor(public answer: (feeds: Readonly<Record<string, ModelTensor>>) => Record<string, ModelTensor>) {}
  run(feeds: Readonly<Record<string, ModelTensor>>) {
    this.runs += 1;
    this.lastFeeds = feeds;
    return Promise.resolve(this.answer(feeds));
  }
  release() {
    this.released += 1;
    return Promise.resolve();
  }
}

/** Counts how many embeddings were handed out and how many were disposed. */
class Embeddings {
  made = 0;
  disposed = 0;
  /** The exact tensor object handed out most recently, for identity assertions. */
  last: ModelTensor | null = null;
  next(): ModelTensor {
    this.made += 1;
    const serial = this.made;
    const tensor: ModelTensor = {
      type: "float32",
      data: new Float32Array([serial]),
      dims: [1, 256, 64, 64],
      dispose: () => {
        this.disposed += 1;
      },
    };
    this.last = tensor;
    return tensor;
  }
}

/** A tensor that counts its own disposals, so a leak is a number a test can read. */
interface Counted extends ModelTensor {
  disposals: number;
}

function counted(tensor: Omit<ModelTensor, "dispose">): Counted {
  const tracked: Counted = {
    ...tensor,
    disposals: 0,
    dispose: () => {
      tracked.disposals += 1;
    },
  };
  return tracked;
}

function masks(): Counted {
  // Three candidates over PLANE pixels; candidate 1 is the highest-scoring one below.
  const data = new Float32Array(3 * PLANE).fill(-1);
  for (let pixel = 0; pixel < PLANE; pixel += 1) data[PLANE + pixel] = pixel % 2 === 0 ? 5 : -5;
  return counted({ type: "float32", data, dims: [1, 1, 3, HEIGHT, WIDTH] });
}

function iou(): Counted {
  return counted({ type: "float32", data: new Float32Array([0.1, 0.8, 0.3]), dims: [1, 1, 3] });
}

let embeddings: Embeddings;
let encoder: FakeSession;
let decoder: FakeSession;
/** Every answer the fake decoder has given, in order, still carrying its counters. */
let decoderAnswers: Record<string, Counted>[];
let created: number;
let createdBytes: Uint8Array[];
let factory: ModelSessionFactory;

beforeEach(() => {
  embeddings = new Embeddings();
  encoder = new FakeSession(() => ({ image_embeddings: embeddings.next() }));
  decoderAnswers = [];
  decoder = new FakeSession(() => {
    const answer = { output_masks: masks(), iou_predictions: iou() };
    decoderAnswers.push(answer);
    return answer;
  });
  created = 0;
  createdBytes = [];
  factory = {
    create: (bytes) => {
      createdBytes.push(bytes);
      created += 1;
      return Promise.resolve(created === 1 ? encoder : decoder);
    },
  };
});

const PROMPT = { positive: [[1, 1]] as const, negative: [] as const };

describe("loading the model", () => {
  it("creates one session per graph, and no more", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    expect(created).toBe(2);
  });

  it("hands each graph's own bytes to the factory, not the other's", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    expect(createdBytes.map((bytes) => [...bytes])).toEqual([[1], [2]]);
  });

  it("releases a previous pair of sessions when loaded a second time", async () => {
    const sessions: FakeSession[] = [];
    const localFactory: ModelSessionFactory = {
      create: () => {
        const session = new FakeSession(() => ({}));
        sessions.push(session);
        return Promise.resolve(session);
      },
    };
    const host = createModelHost(localFactory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const [firstEncoder, firstDecoder] = sessions;
    await host.load(new Uint8Array([3]), new Uint8Array([4]));
    expect(firstEncoder.released).toBe(1);
    expect(firstDecoder.released).toBe(1);
    expect(sessions).toHaveLength(4);
  });
});

describe("encode once, decode many", () => {
  it("runs the encoder exactly once for one prepared image", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    await host.prepare(image());
    expect(encoder.runs).toBe(1);
    expect(decoder.runs).toBe(0);
  });

  it("answers three refinements with three decodes and no second encode", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());

    await host.suggest(prepared.generation, PROMPT);
    await host.suggest(prepared.generation, { positive: [[1, 1], [2, 2]], negative: [] });
    await host.suggest(prepared.generation, { positive: [[1, 1], [2, 2], [3, 1]], negative: [] });

    expect(decoder.runs).toBe(3);
    expect(encoder.runs).toBe(1);
  });

  it("hands the decoder the embedding it kept, not a new one", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());
    await host.suggest(prepared.generation, PROMPT);
    await host.suggest(prepared.generation, PROMPT);
    expect(embeddings.made).toBe(1);
    // Identity, not just equal data: a copy of the embedding would also read back
    // as `[1]` but would be a distinct object from what the encoder actually produced.
    expect(decoder.lastFeeds.image_embeddings).toBe(embeddings.last);
  });
});

describe("holding exactly one image", () => {
  it("encodes once more for a replacement, and releases the one it held", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    await host.prepare(image(7));
    await host.prepare(image(9));
    expect(encoder.runs).toBe(2);
    expect(embeddings.made).toBe(2);
    expect(embeddings.disposed).toBe(1);
  });

  it("refuses a handle for an image it has replaced", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const first = await host.prepare(image(7));
    await host.prepare(image(9));
    await expect(host.suggest(first.generation, PROMPT)).rejects.toSatisfy(
      (error: unknown) => isInferenceRuntimeError(error) && error.code === "image-superseded",
    );
  });

  it("gives each prepared image a distinct generation", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const first = await host.prepare(image(7));
    const second = await host.prepare(image(9));
    expect(second.generation).not.toBe(first.generation);
  });

  it("leaves the prepared image usable when a later encode fails", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const first = await host.prepare(image(7));
    encoder.answer = () => {
      throw new Error("the encoder fell over");
    };
    await expect(host.prepare(image(9))).rejects.toThrow();
    expect(embeddings.disposed).toBe(0);
    await expect(host.suggest(first.generation, PROMPT)).resolves.toBeDefined();
  });
});

describe("what the decoder is fed", () => {
  it("states the original size as int64, height first, as a flat pair", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());
    await host.suggest(prepared.generation, PROMPT);
    const size = decoder.lastFeeds.orig_im_size;
    expect(size.type).toBe("int64");
    expect([...size.dims]).toEqual([2]);
    expect([...(size.data as BigInt64Array)]).toEqual([BigInt(HEIGHT), BigInt(WIDTH)]);
  });

  it("shapes the points as the graph declares them", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());
    await host.suggest(prepared.generation, PROMPT);
    expect([...decoder.lastFeeds.batched_point_coords.dims]).toEqual([1, 1, 6, 2]);
    expect([...decoder.lastFeeds.batched_point_labels.dims]).toEqual([1, 1, 6]);
    // Counter-intuitive but graph-declared: the labels are float32, not an integer type.
    expect(decoder.lastFeeds.batched_point_labels.type).toBe("float32");
    // Dims alone would pass a feed carrying the wrong prompt entirely -- PROMPT's one
    // positive point must actually reach the coords/labels the decoder is fed.
    const coords = decoder.lastFeeds.batched_point_coords.data as Float32Array;
    const labels = decoder.lastFeeds.batched_point_labels.data as Float32Array;
    expect([coords[0], coords[1]]).toEqual([1, 1]);
    expect(labels[0]).toBe(1);
  });
});

describe("the answer", () => {
  it("is the highest-scoring candidate, thresholded, at the image's own size", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());
    const answer = await host.suggest(prepared.generation, PROMPT);
    expect(answer.width).toBe(WIDTH);
    expect(answer.height).toBe(HEIGHT);
    // The fixture's own Float32Array round-trips 0.8 to 0.800000011920929, so a
    // precision beyond ~7 digits would fail regardless of the implementation.
    expect(answer.confidence).toBeCloseTo(0.8, 6);
    expect(answer.mask).toHaveLength(PLANE);
    expect([...answer.mask.slice(0, 4)]).toEqual([1, 0, 1, 0]);
  });
});

describe("when the graph answers without its output", () => {
  it("refuses an encoder answer missing image_embeddings", async () => {
    encoder.answer = () => ({});
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    await expect(host.prepare(image())).rejects.toSatisfy(
      (error: unknown) => isInferenceRuntimeError(error) && error.code === "runtime-execution-failed",
    );
  });

  it("refuses a decoder answer missing its outputs", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());
    decoder.answer = () => ({});
    await expect(host.suggest(prepared.generation, PROMPT)).rejects.toSatisfy(
      (error: unknown) => isInferenceRuntimeError(error) && error.code === "runtime-execution-failed",
    );
  });
});

describe("what a suggestion leaves behind", () => {
  it("releases the decoder's outputs, and keeps the embedding it was fed", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());
    await host.suggest(prepared.generation, PROMPT);

    const [answer] = decoderAnswers;
    expect(answer.output_masks.disposals).toBe(1);
    expect(answer.iou_predictions.disposals).toBe(1);
    // The embedding is the state the worker exists to hold: releasing it alongside the
    // scratch it was decoded into would make the next refinement re-encode the image.
    expect(embeddings.disposed).toBe(0);
    await expect(host.suggest(prepared.generation, PROMPT)).resolves.toBeDefined();
  });

  it("releases every refinement's outputs, not only the last", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());

    await host.suggest(prepared.generation, PROMPT);
    await host.suggest(prepared.generation, { positive: [[1, 1], [2, 2]], negative: [] });
    await host.suggest(prepared.generation, { positive: [[1, 1], [2, 2], [3, 1]], negative: [] });

    expect(encoder.runs).toBe(1);
    expect(decoder.runs).toBe(3);
    expect(decoderAnswers).toHaveLength(3);
    expect(decoderAnswers.map((answer) => Object.values(answer).map((tensor) => tensor.disposals))).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    expect(embeddings.disposed).toBe(0);
  });

  it("releases an output the host never reads", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());
    const spare = counted({ type: "float32", data: new Float32Array([0]), dims: [1] });
    decoder.answer = () => ({ output_masks: masks(), iou_predictions: iou(), onnx_Shape_1830: spare });

    await host.suggest(prepared.generation, PROMPT);

    // Named cleanup would have left this one behind; the graph may grow an output.
    expect(spare.disposals).toBe(1);
  });

  it("releases the mask when the decoder answers without an IoU", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());
    const orphan = masks();
    decoder.answer = () => ({ output_masks: orphan });

    await expect(host.suggest(prepared.generation, PROMPT)).rejects.toSatisfy(
      (error: unknown) => isInferenceRuntimeError(error) && error.code === "runtime-execution-failed",
    );
    expect(orphan.disposals).toBe(1);
  });

  it("releases the IoU when the decoder answers without a mask", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());
    const orphan = iou();
    decoder.answer = () => ({ iou_predictions: orphan });

    await expect(host.suggest(prepared.generation, PROMPT)).rejects.toSatisfy(
      (error: unknown) => isInferenceRuntimeError(error) && error.code === "runtime-execution-failed",
    );
    expect(orphan.disposals).toBe(1);
  });

  it("releases both outputs when reading them throws", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    const prepared = await host.prepare(image());
    const mask = masks();
    // An IoU head the real graph would never produce: `bestCandidate` clamps with
    // `Math.max`, which refuses a BigInt outright. The run succeeded; what follows it
    // did not, and the tensors that run allocated are still owed a release.
    const wrong = counted({ type: "int64", data: new BigInt64Array([1n]), dims: [1, 1, 1] });
    decoder.answer = () => ({ output_masks: mask, iou_predictions: wrong });

    await expect(host.suggest(prepared.generation, PROMPT)).rejects.toThrow(TypeError);
    expect(mask.disposals).toBe(1);
    expect(wrong.disposals).toBe(1);
    expect(embeddings.disposed).toBe(0);
  });
});

describe("letting go", () => {
  it("releases both sessions and the embedding", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    await host.prepare(image());
    await host.release();
    expect(encoder.released).toBe(1);
    expect(decoder.released).toBe(1);
    expect(embeddings.disposed).toBe(1);
  });

  it("can be released twice without complaining, and does not dispose twice", async () => {
    const host = createModelHost(factory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    await host.prepare(image());
    await host.release();
    await expect(host.release()).resolves.toBeUndefined();
    expect(embeddings.disposed).toBe(1);
  });

  it("still releases the decoder when the encoder's own release throws", async () => {
    const throwingEncoder = new FakeSession(() => ({ image_embeddings: embeddings.next() }));
    throwingEncoder.release = () => Promise.reject(new Error("encoder release blew up"));
    let created = 0;
    const localFactory: ModelSessionFactory = {
      create: () => Promise.resolve(created++ === 0 ? throwingEncoder : decoder),
    };
    const host = createModelHost(localFactory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));

    await expect(host.release()).resolves.toBeUndefined();
    expect(decoder.released).toBe(1);
  });

  it("still releases the new pair when the previous encoder's release throws on a second load", async () => {
    const throwingEncoder = new FakeSession(() => ({ image_embeddings: embeddings.next() }));
    throwingEncoder.release = () => Promise.reject(new Error("encoder release blew up"));
    let created = 0;
    const sessions: FakeSession[] = [];
    const localFactory: ModelSessionFactory = {
      create: () => {
        if (created++ === 0) return Promise.resolve(throwingEncoder);
        if (created === 2) return Promise.resolve(decoder);
        const session = new FakeSession(() => ({}));
        sessions.push(session);
        return Promise.resolve(session);
      },
    };
    const host = createModelHost(localFactory);
    await host.load(new Uint8Array([1]), new Uint8Array([2]));
    await expect(host.load(new Uint8Array([3]), new Uint8Array([4]))).resolves.toBeUndefined();

    // The previous pair's decoder must still have been released, despite the encoder's
    // release throwing right beside it.
    expect(decoder.released).toBe(1);
    expect(sessions).toHaveLength(2);
  });
});
