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

const ok = { ok: true as const, data: { total: 0, items: [] }, status: 200 };

describe("unwrap", () => {
  it("returns the body of a successful answer", () => {
    expect(unwrap(ok, page)).toEqual({ total: 0, items: [] });
  });

  it("throws the contract's error as an ApiError carrying its code", () => {
    const thrown = (): unknown =>
      unwrap(
        {
          ok: false,
          error: { code: "PROJECT_NOT_FOUND", message: "No project with that id." },
          status: 404,
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
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "Something went wrong.",
            detail: { incident_id: "7f1c9a2e" },
          },
          status: 500,
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
      unwrap({ ok: false, error: "<html>502 Bad Gateway</html>", status: 502 }, page);
      expect.unreachable();
    } catch (cause) {
      expect((cause as ApiError).code).toBe(MALFORMED_ERROR);
      expect((cause as ApiError).status).toBe(502);
    }
  });

  it("passes a 204 through as undefined rather than treating it as a failure", () => {
    // `delete_project` and `delete_annotations` both answer 204 with no body, and
    // say so through the contract rather than by the absence of bytes.
    expect(unwrap({ ok: true, status: 204 }, checkNoContent)).toBeUndefined();
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
      unwrap({ ok: true, data: wrongDocument, status: 200 }, stats);
      expect.unreachable();
    } catch (cause) {
      const failure = cause as ApiError;
      expect(failure.code).toBe(MALFORMED_ERROR);
      expect(failure.message).toContain("/annotated_asset_count should be present");
      expect(failure.detail?.["expected"]).toBe("/annotated_asset_count should be present");
    }
  });

  it("refuses a failure that carried no body at all", () => {
    // A non-2xx with no recognisable error body — the contract's error shape is
    // absent, so `unwrap` reports it as malformed rather than reading it as data.
    try {
      unwrap({ ok: false, status: 500 }, checkNoContent);
      expect.unreachable();
    } catch (cause) {
      expect((cause as ApiError).code).toBe(MALFORMED_ERROR);
      expect((cause as ApiError).status).toBe(500);
    }
  });

  it("refuses a 200 whose body never arrived", () => {
    // Same branch from the other side: an empty 200 is not a page of zero projects.
    expect(() => unwrap({ ok: true, status: 200 }, page)).toThrow(ApiError);
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
    const original = new ApiError({ code: "WORKSPACE_BUSY", message: "busy" }, { status: 503 });
    expect(asApiError(original)).toBe(original);
  });
});

describe("the reading rule", () => {
  it("tells two 409s apart by code, which the status cannot do", () => {
    const retryable = new ApiError(
      { code: "DESTRUCTIVE_SCHEMA_CHANGE", message: "…" },
      { status: 409 },
    );
    const hopeless = new ApiError({ code: "SCHEMA_CHANGE_WOULD_ORPHAN", message: "…" }, { status: 409 });

    expect(retryable.status).toBe(hopeless.status);
    expect(retryable.code).not.toBe(hopeless.code);
  });

  it("is unauthorized only when the normalized failure says so, never from status or code alone", () => {
    // Missing, malformed, unknown, revoked — one identical refusal, deliberately, so a
    // refusal is never an oracle for which credentials exist. What makes them the same
    // is the `failure`, not the status: a bare 401 with no `failure` is not unauthorized.
    expect(
      new ApiError({ code: "UNAUTHORIZED", message: "…" }, { status: 401, failure: "unauthorized" })
        .isUnauthorized,
    ).toBe(true);
    expect(new ApiError({ code: "UNAUTHORIZED", message: "…" }, { status: 401 }).isUnauthorized).toBe(false);
    expect(new ApiError({ code: "PROJECT_NOT_FOUND", message: "…" }, { status: 404 }).isUnauthorized).toBe(
      false,
    );
  });
});

describe("a refused credential", () => {
  it("keeps the contract's code and is unauthorized — both, from one answer", () => {
    const thrown = (() => {
      try {
        unwrap(
          {
            ok: false,
            error: { code: "UNAUTHORIZED", message: "That credential is not one." },
            failure: "unauthorized",
            status: 401,
          },
          checkListProjects,
        );
        return null;
      } catch (cause) {
        return cause;
      }
    })();
    expect(thrown).toBeInstanceOf(ApiError);
    const failure = thrown as ApiError;
    // The code says what was refused. The failure says the credential is unusable.
    // Neither is derived from the other, and a host may spell the code its own way.
    expect(failure.code).toBe("UNAUTHORIZED");
    expect(failure.isUnauthorized).toBe(true);
  });

  it("is unauthorized whatever the code says, because the failure is what carries it", () => {
    try {
      unwrap(
        { ok: false, error: { code: "SESSION_EXPIRED", message: "again please" }, failure: "unauthorized" },
        checkListProjects,
      );
      expect.unreachable();
    } catch (cause) {
      expect((cause as ApiError).code).toBe("SESSION_EXPIRED");
      expect((cause as ApiError).isUnauthorized).toBe(true);
    }
  });

  it("a domain refusal is not unauthorized, however it is coded", () => {
    try {
      unwrap({ ok: false, error: { code: "SCHEMA_DRAFT_NOT_FOUND", message: "none" } }, checkListProjects);
      expect.unreachable();
    } catch (cause) {
      expect((cause as ApiError).code).toBe("SCHEMA_DRAFT_NOT_FOUND");
      expect((cause as ApiError).isUnauthorized).toBe(false);
    }
  });

  it("a server that never answered reads as a network failure", () => {
    try {
      unwrap({ ok: false, failure: "unreachable" }, checkListProjects);
      expect.unreachable();
    } catch (cause) {
      expect((cause as ApiError).code).toBe(NETWORK_ERROR);
      expect((cause as ApiError).isUnauthorized).toBe(false);
    }
  });
});
