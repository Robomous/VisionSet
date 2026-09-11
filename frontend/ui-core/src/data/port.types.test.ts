/**
 * The port's typing, asserted by compilation.
 *
 * Five claims, and the last is the one that keeps the boundary honest: a host is
 * asked for VisionSet's contract, never for a transport library's options. Every
 * negative case is a `@ts-expect-error`, which fails the build the day it stops
 * erring — that is the point of writing them this way rather than as comments.
 */
import { describe, expectTypeOf, it } from "vitest";

import type { DataResult, VisionSetDataClient } from "./port";

/**
 * The subjects, as **runtime** values rather than `declare const`.
 *
 * Every claim in this file is a compile-time one, and `tsc` is what enforces it —
 * but the file is an ordinary `describe`/`it` suite that vitest *executes*, and an
 * ambient `declare const` is erased by the transform. Declaring them that way
 * makes every `it` body throw `ReferenceError: client is not defined` while the
 * typecheck passes, which is the worst of both: a red suite that proves nothing
 * and a green typecheck nobody is reading. Real values cost three lines and leave
 * the five `@ts-expect-error` cases exactly as enforced as before.
 *
 * `expectTypeOf` is a no-op at runtime; the assertion it makes is `tsc`'s.
 */
const noop = (): Promise<DataResult> => Promise.resolve({ ok: true });
const client = { GET: noop, POST: noop, PUT: noop, PATCH: noop, DELETE: noop } as unknown as VisionSetDataClient;
const serialize = (body: unknown): string => JSON.stringify(body);

describe("what the port accepts", () => {
  it("1. omits init entirely when the operation requires nothing", () => {
    expectTypeOf(client.GET("/projects")).toEqualTypeOf<Promise<DataResult>>();
  });

  it("2. requires a path param the operation declares", () => {
    void client.GET("/projects/{project_id}", { params: { path: { project_id: "p" } } });
    // @ts-expect-error -- init is required: this operation has a path parameter
    void client.GET("/projects/{project_id}");
    // @ts-expect-error -- `params.path` is required and is missing
    void client.GET("/projects/{project_id}", { params: {} });
  });

  it("3. requires a body the operation declares", () => {
    void client.POST("/projects", { body: { name: "n" } });
    // @ts-expect-error -- the body is required and is missing
    void client.POST("/projects", {});
  });

  it("4. refuses a path the generated contract does not declare", () => {
    // @ts-expect-error -- not a path the generated contract declares
    void client.GET("/not-a-visionset-route");
  });

  it("5. refuses every transport option — this is what proves the narrowing held", () => {
    // @ts-expect-error -- `parseAs` is openapi-fetch's word; the port's is `accept`
    void client.GET("/projects", { parseAs: "blob" });
    // @ts-expect-error -- a header is the host's business, not the reusable UI's
    void client.GET("/projects", { headers: {} });
    // @ts-expect-error -- where the data lives is the host's business
    void client.GET("/projects", { baseUrl: "http://x" });
    // @ts-expect-error -- how a body is encoded is the host's; the port says `encode`
    void client.POST("/projects", { body: { name: "n" }, bodySerializer: serialize });
    // @ts-expect-error -- `keepalive` is a platform flag; the port says `survivesUnload`
    void client.PUT("/projects/{project_id}/schema/drafts/{kind}", { params: { path: { project_id: "p", kind: "curated" } }, body: { classes: [], note: "", based_on: null }, keepalive: true });
  });

  it("accepts VisionSet's own intent", () => {
    void client.GET("/projects", { accept: "blob", signal: new AbortController().signal });
  });
});
