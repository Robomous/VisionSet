/**
 * @vitest-environment node
 *
 * The host's half of the video import: what a `FrameSink.append` actually puts on
 * the wire. Three things are only true here and nowhere a type can see them — the
 * per-request bound, the snake_case descriptor parallel to the file parts, and
 * `encode: "multipart"` — and each of them fails as a 422 from a running server
 * rather than as a compile error.
 *
 * ## Why the node environment, and do not remove it
 *
 * The same realm problem `ossClient.test.ts` documents at length: vitest's jsdom
 * environment swaps `FormData`, `Blob` and `File` for jsdom's while leaving `fetch`
 * and `Request` as undici's, and a jsdom `FormData` handed to an undici `Request`
 * stringifies instead of becoming multipart — so the body this file asserts on would
 * not be a multipart body at all.
 */
import { describe, expect, it } from "vitest";

import type { MaterializedFrame } from "@visionset/media";

import { createLocalApiFrameSink } from "./frameSink";
import { createOssDataClient } from "./ossClient";

const BASE = "http://visionset.test";
const TARGET = { projectId: "p", importId: "i" };

/** The bound the sink slices at, restated so a change to it fails here loudly. */
const FRAMES_PER_REQUEST = 32;

const IMPORT = {
  id: "i",
  project_id: "p",
  source_id: "s",
  batch_id: null,
  state: "open",
  expected_frame_count: 100,
  received_frame_count: 1,
  started_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:01Z",
};

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function frame(ordinal: number): MaterializedFrame {
  return {
    ordinal,
    requestedTimestamp: ordinal / 4,
    // `null` for at least one, because the descriptor must carry the absence rather
    // than quietly substitute the requested time for a frame that had no sample.
    sourceTimestamp: ordinal === 0 ? null : ordinal / 4 + 0.01,
    width: 64,
    height: 32,
    format: "png",
    bytes: new Blob([`frame-${ordinal}`], { type: "image/png" }),
  };
}

function recording(reply: (request: Request) => Response = () => json(IMPORT, 200)) {
  const seen: Request[] = [];
  const client = createOssDataClient({
    baseUrl: BASE,
    fetch: (input) => {
      seen.push(input.clone());
      return Promise.resolve(reply(input));
    },
  });
  return { seen, sink: createLocalApiFrameSink(client, TARGET) };
}

interface Descriptor {
  ordinal: number;
  requested_timestamp: number;
  source_timestamp: number | null;
  width: number;
  height: number;
}

async function partsOf(request: Request): Promise<{ files: number; descriptors: Descriptor[] }> {
  const body = await request.formData();
  return {
    files: body.getAll("files").length,
    descriptors: JSON.parse(String(body.get("descriptors"))) as Descriptor[],
  };
}

describe("what one append puts on the wire", () => {
  it("posts the frames to the session the screen opened, as real parts", async () => {
    const { seen, sink } = recording();
    await sink.append([frame(0), frame(1)]);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(new URL(seen[0]!.url).pathname).toBe("/video-imports/i/frames");
    // One part per frame, repeated under the same name — a single part holding an
    // array is one file with a stringified name, which the server refuses by count.
    const { files, descriptors } = await partsOf(seen[0]!);
    expect(files).toBe(2);
    expect(seen[0]!.headers.get("content-type")).toMatch(/^multipart\/form-data/);
    expect(descriptors).toEqual([
      { ordinal: 0, requested_timestamp: 0, source_timestamp: null, width: 64, height: 32 },
      { ordinal: 1, requested_timestamp: 0.25, source_timestamp: 0.26, width: 64, height: 32 },
    ]);
  });

  it("splits at the server's bound, and the descriptors follow the same slice", async () => {
    const { seen, sink } = recording();
    const frames = Array.from({ length: FRAMES_PER_REQUEST + 5 }, (_, at) => frame(at));
    await sink.append(frames);

    expect(seen).toHaveLength(2);
    const first = await partsOf(seen[0]!);
    const second = await partsOf(seen[1]!);
    expect([first.files, second.files]).toEqual([FRAMES_PER_REQUEST, 5]);
    // The parallel array is the whole contract of this route: a descriptor list that
    // did not slice with its files would attach every frame's metadata to the wrong
    // frame, and every part would still be well-formed.
    expect(first.descriptors).toHaveLength(FRAMES_PER_REQUEST);
    expect(second.descriptors.map((one) => one.ordinal)).toEqual([32, 33, 34, 35, 36]);
  });

  it("sends nothing at all for an empty chunk", async () => {
    const { seen, sink } = recording();
    await sink.append([]);
    expect(seen).toHaveLength(0);
  });
});

describe("what the materializer is told", () => {
  it("a refusal from the route stops the import with the contract's own code", async () => {
    const { sink } = recording(() => json({ code: "VIDEO_IMPORT_NOT_OPEN", message: "no" }, 409));
    await expect(sink.append([frame(0)])).rejects.toMatchObject({
      code: "VIDEO_IMPORT_NOT_OPEN",
    });
  });

  it("an unreachable server is a refusal too, not a silently dropped frame", async () => {
    const client = createOssDataClient({
      baseUrl: BASE,
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await expect(
      createLocalApiFrameSink(client, TARGET).append([frame(0)]),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("carries the materializer's signal down to the transfer", async () => {
    const seen: Request[] = [];
    const client = createOssDataClient({
      baseUrl: BASE,
      fetch: (input) => {
        seen.push(input);
        return Promise.resolve(json(IMPORT, 200));
      },
    });
    const controller = new AbortController();
    await createLocalApiFrameSink(client, TARGET).append([frame(0)], controller.signal);
    // A cancel that stopped the decoder but left the upload running would keep
    // staging frames for an import that is being thrown away.
    expect(seen[0]!.signal.aborted).toBe(false);
    controller.abort();
    expect(seen[0]!.signal.aborted).toBe(true);
  });
});
