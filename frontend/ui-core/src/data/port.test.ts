/**
 * @vitest-environment node
 *
 * The port's one claim: a host with no HTTP in it can satisfy this interface.
 * If this file compiles, a future host can implement the contract; if it stops
 * compiling, the port has grown a transport assumption.
 */
import { describe, expect, it } from "vitest";

import type { DataResult, VisionSetDataClient } from "./port";

/** A client backed by a table, not a network. */
function tableClient(answers: ReadonlyMap<string, DataResult>): VisionSetDataClient {
  const answer = (path: string): Promise<DataResult> =>
    Promise.resolve(answers.get(path) ?? { ok: false, failure: "unreachable" });
  return {
    GET: (path) => answer(String(path)),
    POST: (path) => answer(String(path)),
    PUT: (path) => answer(String(path)),
    PATCH: (path) => answer(String(path)),
    DELETE: (path) => answer(String(path)),
  } as VisionSetDataClient;
}

describe("the data port", () => {
  it("is satisfiable without a transport", async () => {
    const client = tableClient(new Map([["/projects", { ok: true, data: { items: [] } }]]));
    await expect(client.GET("/projects")).resolves.toEqual({ ok: true, data: { items: [] } });
  });

  it("answers a normalized failure rather than a status", async () => {
    const client = tableClient(new Map());
    const result = await client.GET("/projects");
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("unreachable");
  });
});
