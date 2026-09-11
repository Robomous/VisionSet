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

// Read as text, deliberately. `port.test.ts` runs in the node environment, and
// importing `../index` there would load every screen module — lucide, the
// foundation's components — to answer a question about names. The repo-level gate
// in `tests/scripts/ui_core_boundary.test.mjs` asks the same question; this one
// keeps the package's own suite able to answer it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INDEX = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");

describe("the reusable package's public surface", () => {
  it("offers no OSS authentication, session or transport concept", () => {
    for (const gone of [
      "createApiClient",
      "ApiProvider",
      "ApiSession",
      "useApiSession",
      "TokenGate",
      "TokenForm",
      "readToken",
      "writeToken",
      "clearToken",
      "RAIL_COLLAPSED_BY_DEFAULT",
      "readRailCollapsed",
      "writeRailCollapsed",
    ]) {
      expect(
        new RegExp(`\\b${gone}\\b`).test(INDEX),
        `${gone} is the host's concern, not the reusable UI's`,
      ).toBe(false);
    }
  });

  it("offers the data contract and the cache it owns", () => {
    for (const kept of ["VisionSetDataProvider", "useApiClient", "unwrap", "ApiError"]) {
      expect(new RegExp(`\\b${kept}\\b`).test(INDEX), `${kept} must stay public`).toBe(true);
    }
  });
});
