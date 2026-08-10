/**
 * The API's one error body, on the client side of it.
 *
 * `docs/api.md` promises exactly one shape at every status — `{code, message,
 * detail?}` — and one rule about reading it: **branch on `code`, never on the
 * status.** The rule is not stylistic. `DESTRUCTIVE_SCHEMA_CHANGE` and
 * `SCHEMA_CHANGE_WOULD_ORPHAN` are both 409 and only the first is retryable with a
 * flag, so a client that branches on 409 reproduces the exact retry loop
 * `SchemaChangeWouldOrphan`'s docstring warns about. `ApiError` therefore carries
 * the code as its first field and the status as an afterthought.
 *
 * ## Why this exists at all, when `openapi-fetch` already types the error
 *
 * `openapi-fetch` never throws: it answers `{data, error, response}` and leaves the
 * branch to the caller. TanStack Query's entire model is the opposite — a query
 * function either resolves or rejects, and "rejected" is what drives `isError`,
 * retries and the error boundary. `unwrap` is the one adapter between the two, and
 * it is the reason no screen in this repository ever writes `if (error)` by hand.
 */

import { firstMismatch, type Check } from "./check";

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

export class ApiError extends Error {
  /** The stable machine-readable code. **This** is what a caller branches on. */
  readonly code: string;
  readonly status: number;
  readonly detail: Record<string, unknown> | null;

  constructor(body: ErrorBody, status: number) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.detail = body.detail ?? null;
  }

  /**
   * The incident id a 5xx carries instead of its message.
   *
   * `docs/api.md`: a mapped 5xx is opaque by provenance — the real message and
   * traceback go to the server log and the client gets an id to quote. Reading it
   * off `detail` rather than off a top-level field is the contract's own shape.
   */
  get incidentId(): string | undefined {
    const value = this.detail?.["incident_id"];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * The credential was missing, malformed, unknown or revoked — the API answers
   * one identical 401 for all four, deliberately, so that a refusal is never an
   * oracle for which credentials exist.
   */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/** The code a request that never reached the server is reported under. */
export const NETWORK_ERROR = "NETWORK_ERROR";
/** The code a response that is not the contract's shape is reported under. */
export const MALFORMED_ERROR = "MALFORMED_RESPONSE";

/**
 * Turn anything into an `ApiError`, so a caller has one type to handle.
 *
 * A `TypeError` from `fetch` (server down, DNS, a cancelled request) has no body
 * and no status, and it is the most likely failure of all on a local-first tool
 * whose server the user starts by hand. Giving it a code of its own means the
 * error surface can say "the server is not answering" instead of rendering
 * `undefined`.
 */
export function asApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ApiError({ code: NETWORK_ERROR, message }, 0);
}

/** A response body that is really the contract's error shape. */
function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["code"] === "string" && typeof candidate["message"] === "string";
}

/** What `openapi-fetch` hands back, narrowed to what `unwrap` needs. */
export interface FetchResult<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: { readonly status: number };
}

/**
 * `{data, error}` → the data, or a thrown `ApiError`.
 *
 * The single adapter between `openapi-fetch`'s branch-on-a-field model and
 * TanStack Query's resolve-or-reject one. Every query and mutation in the product
 * goes through it, which is what makes "no hand-written `if (error)`" true by
 * construction rather than by review.
 *
 * A response that is an error but *not* the contract's shape still becomes an
 * `ApiError`, under `MALFORMED_RESPONSE`. That case is a proxy or a gateway
 * answering on the API's behalf, and rendering its HTML in a toast is worse than
 * saying so.
 *
 * ## The `check` argument, and why it is not optional
 *
 * `openapi-fetch` types a response off the contract and verifies nothing at
 * runtime, so this function used to return `result.data` unexamined — a
 * well-formed JSON document of the wrong type reached a screen intact, and one
 * `undefined` in a formatter took the page down with it, three times over one
 * milestone. `check` closes it: pass the generated check for the
 * operation being called, from `../generated/checks`.
 *
 * It is required rather than optional because an optional gate is one every new
 * call site may forget, and the ones that forgot would be the ones that broke.
 * But note what the compiler does and does not buy here: a *missing* check fails
 * to compile, while a *wrong* one does not — a type predicate is assignable
 * whenever its asserted type is, so `unwrap(projectResult, checkDatasetOut)`
 * compiles and silently re-narrows. Pairing each call with its own operation is
 * therefore enforced by `tests/scripts/checks_wiring.test.mjs`, not by `tsc`.
 */
export function unwrap<T>(result: FetchResult<T>, check: Check<T>): T {
  if (result.error !== undefined) {
    if (isErrorBody(result.error)) throw new ApiError(result.error, result.response.status);
    throw new ApiError(
      {
        code: MALFORMED_ERROR,
        message: `The server answered ${result.response.status} with a body this client does not recognise.`,
      },
      result.response.status,
    );
  }

  // A failure that carried no body at all. `openapi-fetch` reports one as
  // `{error: undefined}` — see its `Content-Length: 0` branch — which the check
  // above cannot see, so without this a 500 saying nothing would fall through to
  // the data branch and read as a successful empty answer.
  if (result.response.status < 200 || result.response.status >= 300) {
    throw new ApiError(
      {
        code: MALFORMED_ERROR,
        message: `The server answered ${result.response.status} with no body at all.`,
      },
      result.response.status,
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
        message: `The server answered ${result.response.status} with a body this client does not recognise: ${mismatch}.`,
        detail: { expected: mismatch },
      },
      result.response.status,
    );
  }
  return result.data as T;
}
