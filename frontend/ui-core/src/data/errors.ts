/**
 * The API's one error body, on the client side of it.
 *
 * `docs/content/api.md` promises exactly one shape at every status — `{code, message,
 * detail?}` — and one rule about reading it: **branch on `code`, never on the
 * status.** The rule is not stylistic. `DESTRUCTIVE_SCHEMA_CHANGE` and
 * `SCHEMA_CHANGE_WOULD_ORPHAN` are both 409 and only the first is retryable with a
 * flag, so a client that branches on 409 reproduces the exact retry loop
 * `SchemaChangeWouldOrphan`'s docstring warns about. `ApiError` therefore carries
 * the code as its first field and the status as an afterthought.
 *
 * ## Why this exists at all, when the port already types the answer
 *
 * The port's `DataResult` never throws: it answers `{ok, data, error, failure,
 * status}` and leaves the branch to the caller. TanStack Query's entire model is
 * the opposite — a query function either resolves or rejects, and "rejected" is
 * what drives `isError`, retries and the error boundary. `unwrap` is the one
 * adapter between the two, and it is the reason no screen in this repository ever
 * writes `if (error)` by hand.
 */

import { firstMismatch, type Check } from "./check";
import type { DataFailure, DataResult } from "./port";

/**
 * The shape every VisionSet error response carries.
 *
 * Structurally identical to the generated `components["schemas"]["ErrorBody"]`, and
 * declared rather than imported because a *parser* has to accept input that might
 * not be one — an HTML error page from a proxy, a truncated body, a network
 * failure with no body at all.
 */
export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly detail?: Record<string, unknown> | null;
}

/** What a 5xx puts in `detail` when the real message is deliberately withheld. */
export interface Incident {
  readonly incidentId?: string;
}

export interface ApiErrorOptions {
  /** Diagnostic only. Absent when the host is not HTTP. */
  readonly status?: number;
  /** The normalized cross-host condition, when the host reported one. */
  readonly failure?: DataFailure;
}

export class ApiError extends Error {
  /** The stable machine-readable code. **This** is what a caller branches on. */
  readonly code: string;
  readonly status: number;
  /**
   * The normalized condition, orthogonal to `code`.
   *
   * The code says what was refused — VisionSet kernel vocabulary, identical under
   * any host. This says the credential is not usable, and is normalized because a
   * host's credential-refusal vocabulary is its own. Neither is derived from the
   * other.
   */
  readonly failure?: DataFailure;
  readonly detail: Record<string, unknown> | null;

  constructor(body: ErrorBody, options: ApiErrorOptions = {}) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = options.status ?? 0;
    if (options.failure !== undefined) this.failure = options.failure;
    this.detail = body.detail ?? null;
  }

  /**
   * The incident id a 5xx carries instead of its message.
   *
   * `docs/content/api.md`: a mapped 5xx is opaque by provenance — the real message and
   * traceback go to the server log and the client gets an id to quote. Reading it
   * off `detail` rather than off a top-level field is the contract's own shape.
   */
  get incidentId(): string | undefined {
    const value = this.detail?.["incident_id"];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * The credential in use is not one.
   *
   * Read off the normalized failure, never off a status and never off a code: the
   * host reports a normalized unauthorized failure for a missing, malformed,
   * unknown or revoked credential — deliberately, so a refusal is never an oracle
   * for which credentials exist — and the reusable UI does not interpret any
   * host's credential vocabulary to tell those cases apart.
   */
  get isUnauthorized(): boolean {
    return this.failure === "unauthorized";
  }
}

/** The code a request that never reached the server is reported under. */
export const NETWORK_ERROR = "NETWORK_ERROR";
/** The code a response that is not the contract's shape is reported under. */
export const MALFORMED_ERROR = "MALFORMED_RESPONSE";

/**
 * Turn anything into an `ApiError`, so a caller has one type to handle.
 *
 * A raw thrown value was never normalized from a `DataResult` — a cancellation, a
 * programming error in the host's client code — and it is the most likely failure
 * of all on a local-first tool whose server the user starts by hand. Giving it a
 * code of its own means the error surface can say "the server is not answering"
 * instead of rendering `undefined`. No `failure` is carried for it: claiming one
 * would be inventing a normalized condition nobody reported.
 */
export function asApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ApiError({ code: NETWORK_ERROR, message }, { status: 0 });
}

/** A response body that is really the contract's error shape. */
function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["code"] === "string" && typeof candidate["message"] === "string";
}

/** What the host said, for a message a bug report can quote. */
function answered(status: number | undefined): string {
  return status === undefined ? "The server answered" : `The server answered ${status}`;
}

/**
 * `DataResult` → the data, or a thrown `ApiError`.
 *
 * The single adapter between the port's answer-or-refusal model and TanStack
 * Query's resolve-or-reject one. Every query and mutation in the product goes
 * through it, which is what makes "no hand-written `if (error)`" true by
 * construction rather than by review.
 *
 * A response that is a refusal but *not* the contract's shape still becomes an
 * `ApiError`, under `MALFORMED_RESPONSE`. That case is a proxy or a gateway
 * answering on the API's behalf, and rendering its HTML in a toast is worse than
 * saying so.
 *
 * ## The `check` argument, and why it is not optional
 *
 * The port types an answer off the contract and verifies nothing at runtime, so
 * this function used to return `result.data` unexamined — a well-formed JSON
 * document of the wrong type reached a screen intact, and one `undefined` in a
 * formatter took the page down with it, three times over one milestone. `check`
 * closes it: pass the generated check for the operation being called, from
 * `../generated/checks`.
 *
 * It is required rather than optional because an optional gate is one every new
 * call site may forget, and the ones that forgot would be the ones that broke.
 * But note what the compiler does and does not buy here: a *missing* check fails
 * to compile, while a *wrong* one does not. The check alone decides what comes
 * back — `result` says nothing about the type, by the deliberate choice argued on
 * `DataResult` — so `unwrap(projectResult, checkDatasetOut)` compiles and returns
 * a `DatasetOut` nobody asked for. Pairing each call with its own operation is
 * therefore enforced by `tests/scripts/checks_wiring.test.mjs`, not by `tsc`, and
 * that gate is what has actually caught mispaired calls.
 */
export function unwrap<T>(result: DataResult, check: Check<T>): T {
  const carry: ApiErrorOptions = {
    ...(result.status === undefined ? {} : { status: result.status }),
    ...(result.failure === undefined ? {} : { failure: result.failure }),
  };

  if (!result.ok) {
    // Nothing answered. On a local-first tool whose server the user starts by
    // hand, this is the likeliest failure of all, and it earns its own code so a
    // surface can say "the server is not answering" rather than render `undefined`.
    if (result.failure === "unreachable") {
      throw new ApiError(
        { code: NETWORK_ERROR, message: "No answer from the server." },
        carry,
      );
    }
    // The contract's own error shape. The code is canonical and passes through
    // untouched; `carry` adds the normalized failure beside it.
    if (isErrorBody(result.error)) throw new ApiError(result.error, carry);
    // A failure that is not the contract's shape: a body-less refusal, or a proxy
    // or gateway answering HTML on the API's behalf. Rendering that in a toast is
    // worse than saying so. No status is needed to recognise it — "the host did
    // not produce a contract answer" is the whole fact.
    throw new ApiError(
      {
        code: MALFORMED_ERROR,
        message: `${answered(result.status)} with a body this client does not recognise.`,
      },
      carry,
    );
  }

  // `result.data` is `undefined` for a 204 — and for a 200 with an empty body,
  // which is why the check is consulted rather than short-circuited. The 204
  // operations pass `checkNoContent`, so "this answer carries nothing" is stated
  // by the contract instead of inferred from the absence of bytes.
  const mismatch = firstMismatch(check, result.data);
  if (mismatch !== null) {
    throw new ApiError(
      {
        code: MALFORMED_ERROR,
        message: `${answered(result.status)} with a body this client does not recognise: ${mismatch}.`,
        detail: { expected: mismatch },
      },
      carry,
    );
  }
  return result.data as T;
}
