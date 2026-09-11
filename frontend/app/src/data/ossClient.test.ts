/**
 * @vitest-environment node
 *
 * The adapter's whole job, as a table: what happened, and what the reusable UI is
 * told. One test per row of the seam's classification, plus the two request
 * intents the port renames — because `encode: "multipart"` and
 * `survivesUnload: true` are translations, and an untested translation is a guess.
 *
 * The distinction the failure half of this file defends: **`unreachable` means the
 * transport was invoked and produced no `Response`**. A body that arrived and would
 * not parse, a gateway's HTML, a body-less 500 — every one of those is something
 * answering, and reporting them as an absent server sends somebody to restart a
 * server that is already running. A fault raised *before* the transport was reached
 * is neither: it is a bug in this client, and it rethrows.
 *
 * ## Why the node environment, and do not remove it
 *
 * This file touches no DOM, and it must run in **one realm**. `frontend/app`'s
 * vitest config sets `environment: "jsdom"`, and vitest's jsdom environment
 * replaces `FormData`, `Blob` and `File` with jsdom's classes while leaving
 * `fetch`, `Request` and `Response` as Node's (undici). The two do not recognise
 * each other: a jsdom `FormData` handed to an undici `Request` silently
 * **stringifies** to `"[object FormData]"`, so the multipart test asserts on a
 * body that never became multipart, and `expect(result.data).toBeInstanceOf(Blob)`
 * compares undici's `Blob` to jsdom's and fails on a correct adapter.
 * `frontend/ui-core/vitest.setup.ts` reconciles those realms by hand;
 * `frontend/app/vitest.setup.ts` is `cleanup()` and nothing else. One pragma fixes
 * multipart, blob and `File` at once, which is why it is here rather than a
 * third copy of that reconciliation.
 */
import { describe, expect, it } from "vitest";

import { createOssDataClient } from "./ossClient";

const BASE = "http://visionset.test";

function answering(reply: (request: Request) => Response | Promise<Response>) {
  return createOssDataClient({ baseUrl: BASE, token: "t", fetch: (input) => Promise.resolve(reply(input)) });
}

/**
 * A client whose transport is invoked and then rejects with whatever is handed in.
 *
 * Note what this helper can and cannot express. The transport **was** called, so
 * every rejection from it — whatever class — is `unreachable` by the adapter's
 * classification, and that is correct: in a browser `fetch` rejects only for
 * transport reasons or for an abort. A fault raised *before* the transport is
 * reached cannot be produced this way; test 2b produces that one through the real
 * code path.
 */
function throwing(cause: unknown) {
  return createOssDataClient({ baseUrl: BASE, fetch: () => Promise.reject(cause) });
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("what the adapter tells the reusable UI", () => {
  it("a 200 is ok, and carries the body", async () => {
    const client = answering(() => json({ items: [], total: 0 }, 200));
    const result = await client.GET("/projects");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ items: [], total: 0 });
  });

  it("a 204 is ok and carries nothing", async () => {
    const client = answering(() => new Response(null, { status: 204 }));
    const result = await client.DELETE("/projects/{project_id}", {
      params: { path: { project_id: "p" } },
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it("a 401 is unauthorized AND keeps the contract's code", async () => {
    const client = answering(() => json({ code: "UNAUTHORIZED", message: "no" }, 401));
    const result = await client.GET("/projects");
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("unauthorized");
    expect(result.error).toEqual({ code: "UNAUTHORIZED", message: "no" });
  });

  it("a domain refusal is not a failure kind — its code is the whole answer", async () => {
    const client = answering(() => json({ code: "SCHEMA_DRAFT_NOT_FOUND", message: "none" }, 404));
    const result = await client.GET("/projects/{project_id}/schema/drafts/{kind}", {
      params: { path: { project_id: "p", kind: "curated" } },
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBeUndefined();
    expect(result.error).toEqual({ code: "SCHEMA_DRAFT_NOT_FOUND", message: "none" });
  });

  it("the token rides as a bearer header", async () => {
    const seen: Request[] = [];
    const client = createOssDataClient({
      baseUrl: BASE,
      token: "secret",
      fetch: (input) => {
        seen.push(input);
        return Promise.resolve(json({ items: [], total: 0 }, 200));
      },
    });
    await client.GET("/projects");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer secret");
  });
});

describe("the outcomes the seam distinguishes, one test each", () => {
  it("1. a cancelled request REJECTS — with the platform's own abort reason", async () => {
    // A real AbortController, and the transport rejects with whatever the platform
    // actually produces (`signal.reason`, a DOMException in a browser). The adapter
    // must not depend on that shape: it asks the signal first, which is true
    // whatever the runtime throws.
    const client = createOssDataClient({
      baseUrl: BASE,
      fetch: (input) =>
        new Promise<Response>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => {
            reject(input.signal?.reason ?? new Error("aborted"));
          });
        }),
    });
    const controller = new AbortController();
    const pending = client.GET("/projects", { signal: controller.signal });
    controller.abort();
    // The real shape, not merely "rejects with something": a fixture that fell
    // back to `signal.reason ?? new Error("aborted")` would still pass a looser
    // assertion even if a runtime stopped populating `signal.reason`.
    await expect(pending).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  });

  it("1b. …and also when only the thrown value says so, with no signal in hand", async () => {
    // The other half of the same guarantee: a runtime that rejects with an
    // AbortError the adapter never handed a signal to is still a cancellation.
    const client = throwing(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(client.GET("/projects")).rejects.toThrow(/abort/i);
  });

  it("2. a transport that was INVOKED and produced no response is unreachable", async () => {
    // The seam saw fetch called and saw no Response come back. That, and only that,
    // is what `unreachable` claims.
    const result = await throwing(new TypeError("Failed to fetch")).GET("/projects");
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("unreachable");
  });

  it("2c. two concurrent requests classify independently — one's Attempt must not leak onto the other", async () => {
    // The regression this test exists for: hoisting `Attempt` out of `verb`, or
    // lifting `fetch: instrument(attempt)` up into `createClient`'s options, both
    // read as a harmless tidy-up and both turn the seam into one record shared by
    // every in-flight call. Every other test in this file issues one request at a
    // time and cannot catch that — this one fires two and settles them out of
    // order: B (a plain 200) resolves first, then A's transport rejects. If the
    // two calls shared an `Attempt`, A would be read back with B's `invoked: true`
    // and `response` already set, and would resolve `{ ok: false, status: 200 }`
    // instead of `unreachable` — a server that just died reported to the user as
    // "the client is broken".
    let releaseA: (() => void) | undefined;
    const client = createOssDataClient({
      baseUrl: BASE,
      fetch: (input) => {
        if (input.url.includes("/projects")) {
          // Request A: invoked, but held open until B has already settled, then
          // fails with a transport error — never a Response.
          return new Promise<Response>((_resolve, reject) => {
            releaseA = () => reject(new TypeError("Failed to fetch"));
          });
        }
        // Request B: a distinct route, resolved immediately.
        return Promise.resolve(json({ classes: [], revision: 1 }, 200));
      },
    });

    const a = client.GET("/projects");
    const b = client.GET("/home");

    const resultB = await b;
    expect(resultB.ok).toBe(true);

    releaseA?.();
    const resultA = await a;

    expect(resultA.ok).toBe(false);
    expect(resultA.failure).toBe("unreachable");
    // The leak this test catches: A classified from B's record would carry B's
    // 200 status instead of none at all.
    expect(resultA.status).toBeUndefined();
  });

  it("2b. a fault thrown BEFORE fetch is reached RETHROWS — it is not unreachable", async () => {
    // The test that separates a correct adapter from one branching on
    // `instanceof TypeError`. A serializer bug throws the same class the Fetch
    // standard rejects with, and it throws it without ever reaching the transport.
    // The seam never saw a call, so this is a client bug, not an absent server.
    //
    // No test-only hook is needed to produce it: `encode: "multipart"` runs the
    // adapter's own encoder over the body, and a property that throws when read
    // faults there — before a Request object exists.
    let called = false;
    const client = createOssDataClient({
      baseUrl: BASE,
      fetch: () => {
        called = true;
        return Promise.resolve(json({ id: "s", name: "n" }, 201));
      },
    });
    const bug = new TypeError("Cannot read properties of undefined");
    const body = {
      files: [],
      get name(): string {
        throw bug;
      },
    };
    await expect(
      client.POST("/projects/{project_id}/sources/images", {
        params: { path: { project_id: "p" } },
        body: body as unknown as { files: string[]; name: string },
        encode: "multipart",
      }),
    ).rejects.toThrow(bug);
    // The whole claim of this test: the transport was never reached.
    expect(called).toBe(false);
  });

  it("3. a parse failure after a response arrived is malformed, NOT unreachable — and keeps the status", async () => {
    const client = answering(
      () => new Response("<!doctype html><p>hi", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const result = await client.GET("/projects");
    expect(result.ok).toBe(false);
    // The server answered. Calling this `unreachable` would send somebody to check
    // whether it is running.
    expect(result.failure).toBeUndefined();
    // And the status the response actually carried survives, because it is the one
    // diagnostic saying whether the gateway or the application answered.
    expect(result.status).toBe(200);
  });

  it("3b. …and the preserved status is the response's OWN, not a value hardcoded to pass row 3", async () => {
    // A distinct 2xx from row 3's 200. `openapi-fetch` only reaches this adapter's
    // `catch` — and the parse-failure branch that reads `attempt.response.status` —
    // on its *success* path (`response.ok`); its error path reads the body with a
    // swallowed `JSON.parse` and never throws, so a non-2xx status here would
    // exercise that other branch instead and prove nothing about this one. A
    // 201 that survives unparsed pins the adapter to echoing whatever status the
    // response actually carried rather than one written into the client by hand.
    const client = answering(
      () => new Response("<html>not json", { status: 201, headers: { "content-type": "application/json" } }),
    );
    const result = await client.GET("/projects");
    expect(result.ok).toBe(false);
    expect(result.failure).toBeUndefined();
    expect(result.status).toBe(201);
  });

  it("4a. a body-less 500 is not ok and carries no error body", async () => {
    const result = await answering(() => new Response(null, { status: 500 })).GET("/projects");
    expect(result.ok).toBe(false);
    expect(result.failure).toBeUndefined();
    expect(result.status).toBe(500);
  });

  it("4b. a gateway answering HTML is not ok, and is still not unreachable", async () => {
    const client = answering(
      () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
    );
    const result = await client.GET("/projects");
    expect(result.ok).toBe(false);
    expect(result.failure).toBeUndefined();
  });

  it("4c. a 401 with no contract body keeps unauthorized anyway", async () => {
    // The failure is read off the status, not off a body that never arrived — the
    // cache policy has to act on it either way.
    const result = await answering(() => new Response(null, { status: 401 })).GET("/projects");
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("unauthorized");
  });

  it.each([
    ["SyntaxError", new SyntaxError("bad JSON")],
    ["TypeError", new TypeError("body stream failed")],
    ["RangeError", new RangeError("arbitrary body-reader failure")],
  ])(
    "5. a %s while reading an arrived response body is malformed, not a rethrow",
    async (_name, bodyFailure) => {
      const client = answering(() => {
        const response = json({ items: [], total: 0 }, 201);
        // With no Content-Length, openapi-fetch reads an ok JSON response through
        // `.text()`. The *place* the error happens, not its class, decides this
        // outcome.
        Object.defineProperty(response, "text", { value: () => Promise.reject(bodyFailure) });
        return response;
      });

      await expect(client.GET("/projects")).resolves.toEqual({ ok: false, status: 201 });
    },
  );

  it("6. an unrelated fault after a response arrived RETHROWS", async () => {
    const bug = new RangeError("not a body failure");
    const client = answering(() => {
      const response = json({ items: [], total: 0 }, 200);
      // This is read before openapi-fetch asks a response reader to consume the
      // body, so it is deliberately outside the marked seam.
      Object.defineProperty(response, "ok", { get: () => { throw bug; } });
      return response;
    });

    await expect(client.GET("/projects")).rejects.toThrow(bug);
  });

  it("6b. an adapter fault after a valid body is consumed RETHROWS", async () => {
    const bug = new RangeError("normalization bug");
    const client = answering(() => {
      const response = json({ items: [], total: 0 }, 200);
      const status = response.status;
      let reads = 0;
      // `openapi-fetch` first reads this while deciding how to consume the valid
      // body. The next read is this adapter's `normalize` step, after `.text()`
      // and JSON parsing have completed. It must not be caught as a body failure.
      Object.defineProperty(response, "status", {
        get: () => {
          reads += 1;
          if (reads === 2) throw bug;
          return status;
        },
      });
      return response;
    });

    await expect(client.GET("/projects")).rejects.toThrow(bug);
  });

  it("7. concurrent responses do not share the body-consumption marker", async () => {
    let releaseA: (() => void) | undefined;
    const postResponseBug = new RangeError("outside body consumption");
    const client = createOssDataClient({
      baseUrl: BASE,
      fetch: (input) => {
        if (input.url.endsWith("/projects")) {
          return new Promise<Response>((resolve) => {
            releaseA = () => {
              const response = json({ items: [], total: 0 }, 200);
              Object.defineProperty(response, "ok", { get: () => { throw postResponseBug; } });
              resolve(response);
            };
          });
        }
        return Promise.resolve(json({ classes: [], revision: 1 }, 200));
      },
    });

    const a = client.GET("/projects");
    const b = client.GET("/home");
    await expect(b).resolves.toMatchObject({ ok: true });

    releaseA?.();
    // B consumed its body first. If this state were shared with A, A's unrelated
    // response fault would incorrectly be normalized as a malformed body.
    await expect(a).rejects.toThrow(postResponseBug);
  });
});

describe("the request intents the port renames", () => {
  it("accept: blob asks for bytes, not JSON", async () => {
    const client = answering(() => new Response(new Blob(["x"]), { status: 200 }));
    const result = await client.GET("/projects/{project_id}/assets/{asset_id}/thumbnail", {
      params: { path: { project_id: "p", asset_id: "a" } },
      accept: "blob",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeInstanceOf(Blob);
  });

  it("encode: multipart sends real files as FormData, one part per file", async () => {
    const seen: Request[] = [];
    const client = createOssDataClient({
      baseUrl: BASE,
      fetch: (input) => {
        seen.push(input.clone());
        return Promise.resolve(json({ id: "s", name: "n" }, 201));
      },
    });
    const files = [
      new File([new Blob(["a"])], "a.png", { type: "image/png" }),
      new File([new Blob(["b"])], "b.png", { type: "image/png" }),
    ];
    await client.POST("/projects/{project_id}/sources/images", {
      params: { path: { project_id: "p" } },
      body: { files: files as unknown as string[], name: "batch" },
      encode: "multipart",
    });
    const body = await seen[0]!.formData();
    // One part per image, repeated under the same name — a single part holding an
    // array is silently one file with a stringified name.
    expect(body.getAll("files")).toHaveLength(2);
    expect((body.getAll("files")[0] as File).name).toBe("a.png");
    expect(body.get("name")).toBe("batch");
    // And the adapter did not also send JSON.
    expect(seen[0]!.headers.get("content-type")).not.toBe("application/json");
  });

  it("survivesUnload: true asks the platform to deliver the write anyway", async () => {
    const seen: Request[] = [];
    const client = createOssDataClient({
      baseUrl: BASE,
      fetch: (input) => {
        seen.push(input);
        return Promise.resolve(json({ classes: [], revision: 1 }, 200));
      },
    });
    await client.PUT("/projects/{project_id}/schema/drafts/{kind}", {
      // `kind` is a SchemaProvenance — "curated" | "annotation". "publish" is a
      // segment of the sibling route `…/drafts/{kind}/publish`, not a kind. And
      // `note` is a required, non-nullable string.
      params: { path: { project_id: "p", kind: "curated" } },
      body: { classes: [], note: "", based_on: null },
      survivesUnload: true,
    });
    expect(seen[0]?.keepalive).toBe(true);
  });

  it("a request that asks for nothing special carries nothing special", async () => {
    const seen: Request[] = [];
    const client = createOssDataClient({
      baseUrl: BASE,
      fetch: (input) => {
        seen.push(input);
        return Promise.resolve(json({ items: [], total: 0 }, 200));
      },
    });
    await client.GET("/projects");
    expect(seen[0]?.keepalive).toBe(false);
  });
});
