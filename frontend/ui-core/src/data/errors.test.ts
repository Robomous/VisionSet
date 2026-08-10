/**
 * The error envelope, and the rule the whole client layer turns on: **branch on
 * the code, never on the status.**
 *
 * The last test is the one that matters. Two 409s exist in this API and only one
 * of them is retryable with a flag, so a client that keys on the status is a
 * client that will loop forever on `SCHEMA_CHANGE_WOULD_ORPHAN` — the exact
 * failure `SchemaChangeWouldOrphan`'s kernel docstring warns about. It is pinned
 * here because there is no other place in the frontend where the claim can be made
 * without a server.
 */

import { describe, expect, it } from "vitest";

import { ApiError, MALFORMED_ERROR, NETWORK_ERROR, asApiError, unwrap } from "./errors";
import { checkNoContent } from "./check";
import type { components } from "../generated/api";
import { checkGetProjectStats, checkListProjects } from "../generated/checks";

type ProjectStats = components["schemas"]["ProjectStatsOut"];

// The real generated checks, not stand-ins: the claim under test is that `unwrap`
// and the contract agree, and a hand-written guard here would only test itself.
const page = checkListProjects;
const stats = checkGetProjectStats;

const ok = { data: { total: 0, items: [] }, response: { status: 200 } };

describe("unwrap", () => {
  it("returns the body of a successful answer", () => {
    expect(unwrap(ok, page)).toEqual({ total: 0, items: [] });
  });

  it("throws the contract's error as an ApiError carrying its code", () => {
    const thrown = (): unknown =>
      unwrap(
        {
          error: { code: "PROJECT_NOT_FOUND", message: "No project with that id." },
          response: { status: 404 },
        },
        page,
      );
    expect(thrown).toThrow(ApiError);
    try {
      thrown();
    } catch (cause) {
      const failure = cause as ApiError;
      expect(failure.code).toBe("PROJECT_NOT_FOUND");
      expect(failure.status).toBe(404);
      expect(failure.message).toBe("No project with that id.");
    }
  });

  it("carries the incident id a 5xx puts in detail instead of its message", () => {
    try {
      unwrap(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "Something went wrong.",
            detail: { incident_id: "7f1c9a2e" },
          },
          response: { status: 500 },
        },
        page,
      );
      expect.unreachable();
    } catch (cause) {
      expect((cause as ApiError).incidentId).toBe("7f1c9a2e");
    }
  });

  it("names a body that is not the contract's shape rather than rendering it", () => {
    // A proxy or a gateway answering on the API's behalf. Its HTML in a toast is
    // worse than saying the answer was unrecognisable.
    try {
      unwrap({ error: "<html>502 Bad Gateway</html>", response: { status: 502 } }, page);
      expect.unreachable();
    } catch (cause) {
      expect((cause as ApiError).code).toBe(MALFORMED_ERROR);
      expect((cause as ApiError).status).toBe(502);
    }
  });

  it("passes a 204 through as undefined rather than treating it as a failure", () => {
    // `delete_project` and `delete_annotations` both answer 204 with no body, and
    // say so through the contract rather than by the absence of bytes.
    expect(unwrap({ response: { status: 204 } }, checkNoContent)).toBeUndefined();
  });

  it("refuses a well-formed document of the wrong type, and says where", () => {
    // This exact body — the empty-collection envelope answered for `/stats` —
    // reached three surfaces intact and white-screened each of them in a
    // formatter. It is now an error with a path.
    // The cast is the whole problem in one expression: at compile time `data` is a
    // `ProjectStatsOut` because the contract says so, and at runtime it is whatever
    // actually arrived. That gap is what the check closes.
    const wrongDocument = { items: [], total: 0 } as unknown as ProjectStats;
    try {
      unwrap({ data: wrongDocument, response: { status: 200 } }, stats);
      expect.unreachable();
    } catch (cause) {
      const failure = cause as ApiError;
      expect(failure.code).toBe(MALFORMED_ERROR);
      expect(failure.message).toContain("/annotated_asset_count should be present");
      expect(failure.detail?.["expected"]).toBe("/annotated_asset_count should be present");
    }
  });

  it("refuses a failure that carried no body at all", () => {
    // `openapi-fetch` reports a non-2xx with `Content-Length: 0` as
    // `{error: undefined}`, which used to fall through to the empty-body branch —
    // so a 500 saying nothing read as a successful empty answer.
    try {
      unwrap({ response: { status: 500 } }, checkNoContent);
      expect.unreachable();
    } catch (cause) {
      expect((cause as ApiError).code).toBe(MALFORMED_ERROR);
      expect((cause as ApiError).status).toBe(500);
    }
  });

  it("refuses a 200 whose body never arrived", () => {
    // Same branch from the other side: an empty 200 is not a page of zero projects.
    expect(() => unwrap({ response: { status: 200 } }, page)).toThrow(ApiError);
  });
});

describe("asApiError", () => {
  it("gives a request that never reached the server a code of its own", () => {
    // The most likely failure on a local-first tool whose server is started by
    // hand — and the one where "check your token" sends somebody the wrong way.
    const failure = asApiError(new TypeError("Failed to fetch"));
    expect(failure.code).toBe(NETWORK_ERROR);
    expect(failure.status).toBe(0);
    expect(failure.isUnauthorized).toBe(false);
  });

  it("leaves an ApiError alone", () => {
    const original = new ApiError({ code: "WORKSPACE_BUSY", message: "busy" }, 503);
    expect(asApiError(original)).toBe(original);
  });
});

describe("the reading rule", () => {
  it("tells two 409s apart by code, which the status cannot do", () => {
    const retryable = new ApiError(
      { code: "DESTRUCTIVE_SCHEMA_CHANGE", message: "…" },
      409,
    );
    const hopeless = new ApiError({ code: "SCHEMA_CHANGE_WOULD_ORPHAN", message: "…" }, 409);

    expect(retryable.status).toBe(hopeless.status);
    expect(retryable.code).not.toBe(hopeless.code);
  });

  it("treats every 401 the same, because the API refuses to distinguish them", () => {
    // Missing, malformed, unknown, revoked — one identical 401, deliberately, so a
    // refusal is never an oracle for which credentials exist.
    for (const code of ["UNAUTHORIZED"]) {
      expect(new ApiError({ code, message: "…" }, 401).isUnauthorized).toBe(true);
    }
    expect(new ApiError({ code: "PROJECT_NOT_FOUND", message: "…" }, 404).isUnauthorized).toBe(
      false,
    );
  });
});
