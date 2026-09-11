/**
 * The VisionSet frontend data contract: what a host owes the reusable UI.
 *
 * Every screen and every query hook in this package reaches the product's data
 * through this interface and through nothing else. It is deliberately shaped like
 * the generated contract — a path key, an init object, an answer — because that
 * contract is generated from `openapi.json` and is the one description of what
 * VisionSet can be asked. It is deliberately *not* shaped like HTTP: there is no
 * base URL here, no header, no credential, no status to branch on, and no
 * `Response`. A host may satisfy it with `fetch`, with a gateway, or with a bridge
 * to something that is not a network at all.
 *
 * `openapi-fetch` appears here in **type position only**. Its generic machinery is
 * the most accurate available description of "the request shapes this contract
 * declares", and re-deriving sixty of them by hand would duplicate the contract
 * and put a class of conditional-type bug into this repository permanently. Type
 * imports are erased from emitted JavaScript: the package ships no runtime
 * reference to it. Its emitted declarations intentionally retain type-only
 * references, so `openapi-fetch` remains a consumer-resolvable dependency;
 * `tests/scripts/ui_core_boundary.test.mjs` holds the runtime boundary.
 *
 * ## Two clauses beyond the result shape
 *
 * **A request cancelled through its `signal` rejects.** The gallery and the
 * annotator cancel transfers they no longer need, and they tell a cancellation
 * apart from a failure by catching it — a host that reported an abort as
 * `unreachable` would paint every scrolled-past tile as broken. Cancellation is
 * not a failure of the request; it is the caller changing its mind.
 *
 * **An unexpected fault in the host's own client code rejects too.** A serializer
 * bug or a programming error is not an answer about the product, and reporting one
 * as `unreachable` sends somebody to check whether their server is running when
 * the fault is in the client. What resolves as a `DataResult` is every *expected*
 * outcome of asking a host a question: an answer, a refusal, and a host that could
 * not be reached. `unreachable` means specifically that the host was contacted and
 * produced no response — not that something threw.
 */
import type { Client, ClientPathsWithMethod, MaybeOptionalInit } from "openapi-fetch";

import type { paths } from "../generated/api.js";

export type DataFailure = "unauthorized" | "unreachable";

/**
 * What a host answers. A discriminated union, so an impossible answer — a success
 * carrying a failure — does not type-check.
 *
 * `unreachable` is the request that produced no answer at all, so there is no body
 * to hold a code; on a local-first tool whose server the user starts by hand, it is
 * the likeliest failure of all. `unauthorized` is a credential that is not usable,
 * normalized because the vocabulary for a *credential* refusal belongs to whichever
 * host authenticates. **Nothing else belongs in `DataFailure`** — a condition a
 * VisionSet `ErrorBody` code can express is expressed as that code, which is what
 * keeps `SCHEMA_CHANGE_WOULD_ORPHAN` and `DESTRUCTIVE_SCHEMA_CHANGE` distinguishable.
 *
 * `data` is `unknown` rather than the operation's static type: that is the honest
 * signature for a value whose type is decided by the check `unwrap` runs one line
 * later. `status` is diagnostic only — carried into messages and logs so a bug
 * report can quote it, **never branched on**, and `ui_core_boundary.test.mjs`
 * proves it: a host that is not HTTP leaves it undefined.
 */
export type DataResult =
  | {
      readonly ok: true;
      readonly data?: unknown;
      readonly status?: number;
      readonly error?: never;
      readonly failure?: never;
    }
  | {
      readonly ok: false;
      readonly error?: unknown;
      readonly failure?: DataFailure;
      readonly status?: number;
      readonly data?: never;
    };

type HttpClient = Client<paths>;

/** The paths the generated contract declares for one method. Lowercase, as openapi-fetch types it. */
export type PathsFor<M extends "get" | "put" | "post" | "delete" | "patch"> =
  ClientPathsWithMethod<HttpClient, M>;

/** Keys of `T` that cannot be omitted. Three lines, and not a second spelling of the contract. */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

/**
 * The contract's own two request concepts, with their requiredness intact and every
 * transport option dropped.
 *
 * `MaybeOptionalInit` is borrowed for what it knows — whether this operation requires
 * params or a body — and then narrowed by `Pick` to the only two keys VisionSet's
 * contract actually has. Without the `Pick`, `FetchOptions` would drag `baseUrl`,
 * `headers`, `fetch`, `middleware`, `querySerializer`, `bodySerializer`, `parseAs` and
 * the whole of `RequestInit` into this package's public surface, and a host would be
 * told to implement a library's options rather than VisionSet's contract.
 */
type ContractInit<P extends keyof paths, M extends keyof paths[P]> = Pick<
  NonNullable<MaybeOptionalInit<paths[P], M>>,
  Extract<keyof NonNullable<MaybeOptionalInit<paths[P], M>>, "params" | "body">
>;

/**
 * VisionSet's own request intent — what the reusable UI needs to say about a request,
 * in its own words rather than a transport library's.
 *
 * Each member exists because a call site needs it today, and none is a transport option:
 * a host satisfies them however its transport works.
 */
export interface VisionSetRequestIntent {
  /**
   * Cancel the request.
   *
   * The gallery and the annotator abandon transfers they no longer need. A cancelled
   * request **rejects** — see the contract clause below — so a caller can tell "I changed
   * my mind" from "this failed".
   */
  readonly signal?: AbortSignal;
  /** What the answer is expected to be. `"blob"` for binary content. Defaults to `"json"`. */
  readonly accept?: "json" | "blob";
  /**
   * How the body travels. `"multipart"` carries files; the host owns the encoding.
   * Defaults to `"json"`.
   */
  readonly encode?: "json" | "multipart";
  /**
   * This write must still be delivered if the page is going away.
   *
   * A schema draft saved a keystroke before a reload is lost otherwise, with no error to
   * show for it. What a host does to honour it is the host's business.
   */
  readonly survivesUnload?: boolean;
}

/** Distributive, so a path constrained by `PathsFor` needs no further proof it is a path. */
type InitFor<P extends string, M extends string> = P extends keyof paths
  ? M extends keyof paths[P]
    ? ContractInit<P, M> & VisionSetRequestIntent
    : never
  : never;

/** Required when the operation requires params or a body; omittable otherwise. */
type InitArg<I> = RequiredKeys<I> extends never ? [init?: I] : [init: I];

export interface VisionSetDataClient {
  GET<P extends PathsFor<"get">>(path: P, ...init: InitArg<InitFor<P, "get">>): Promise<DataResult>;
  POST<P extends PathsFor<"post">>(path: P, ...init: InitArg<InitFor<P, "post">>): Promise<DataResult>;
  PUT<P extends PathsFor<"put">>(path: P, ...init: InitArg<InitFor<P, "put">>): Promise<DataResult>;
  PATCH<P extends PathsFor<"patch">>(path: P, ...init: InitArg<InitFor<P, "patch">>): Promise<DataResult>;
  DELETE<P extends PathsFor<"delete">>(path: P, ...init: InitArg<InitFor<P, "delete">>): Promise<DataResult>;
}
