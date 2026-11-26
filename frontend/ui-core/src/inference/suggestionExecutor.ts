/**
 * Asking for a suggestion, with nothing in it about who answers.
 *
 * `AnnotationPage` owns a suggestion session — accumulated points, a serial, and the rule that
 * a slow first answer may not overwrite a fast second one. None of that is transport, and
 * until this seam existed none of it could be reused either: the ask went straight into a
 * mutation whose body requires a `connection_id`, so the question "could something other than
 * the server answer this?" had no shape to be asked in.
 *
 * `SuggestionRequest` is deliberately `SuggestInput` minus that connection. Where an answer is
 * routed is the executor's own business, closed over when the executor is built; what is being
 * asked is the same question either way. One implementation ships, and it posts to
 * `/inference/suggest` exactly as before.
 */
import { useMemo } from "react";
import type { Adjustments, GeometryType } from "@visionset/annotator";

import {
  useDetectInstances,
  useSuggestRegion,
  type DetectionOut,
  type SuggestionOut,
} from "../data/inferenceQueries";

export interface SuggestionRequest {
  readonly projectId: string;
  readonly assetId: string;
  /** Every positive click so far, in placement order. */
  readonly positive: readonly (readonly [number, number])[];
  readonly negative: readonly (readonly [number, number])[];
  /** The kinds this ask will accept, every one of them a kind the class admits. */
  readonly allowedGeometries: readonly GeometryType[];
  /** Where the settings stand. Sent on every ask, echoed by every answer. */
  readonly adjustments: Adjustments;
}

export interface SuggestionExecutor {
  /**
   * Answer one ask, or reject.
   *
   * A rejection is passed to `refusalProse` by the caller, so an implementation rejects with a
   * cause that function can read rather than with prose of its own.
   *
   * `signal` is honoured where an implementation can honour it. The server one does not: a
   * react-query mutation already owns its request's lifetime, and the session's serial is what
   * keeps a late answer off the screen.
   */
  suggest(request: SuggestionRequest, signal?: AbortSignal): Promise<SuggestionOut>;
}

/**
 * The server executor, or `null` when there is no connection to send through.
 *
 * `null` rather than an executor that always refuses, because "there is nowhere to send this"
 * is the state `usableConnection()` already reports through its `blocker`, and the panel
 * renders that blocker rather than a refusal. An executor that existed only to fail would put
 * a second spelling of the same fact in front of the user.
 */
export function useServerSuggestionExecutor(connectionId: string | null): SuggestionExecutor | null {
  const suggestRegion = useSuggestRegion();
  return useMemo(() => {
    if (connectionId === null) return null;
    return {
      suggest: (request) =>
        suggestRegion.mutateAsync({
          projectId: request.projectId,
          assetId: request.assetId,
          connectionId,
          positive: request.positive,
          negative: request.negative,
          allowedGeometries: request.allowedGeometries,
          adjustments: request.adjustments,
        }),
    };
  }, [connectionId, suggestRegion]);
}

/** Every instance of one class on one asset — `DetectInput` minus the connection. */
export interface DetectionRequest {
  readonly projectId: string;
  readonly assetId: string;
  readonly labelClass: string;
  readonly allowedGeometries: readonly GeometryType[];
  readonly phrase?: string;
}

/**
 * Asking for every instance of a class, apart from asking about a point.
 *
 * Its own interface rather than a method every executor carries, because only the
 * server answers it: a browser executor runs a point segmenter and has no text
 * detector, so it does not implement this — there is nothing to fall back to, and
 * a local request is never sent to a server in its place.
 */
export interface DetectionExecutor {
  detect(request: DetectionRequest): Promise<DetectionOut>;
}

/** The server's detection executor, or `null` with no text-detection connection to send through. */
export function useServerDetectionExecutor(connectionId: string | null): DetectionExecutor | null {
  const detectInstances = useDetectInstances();
  return useMemo(() => {
    if (connectionId === null) return null;
    return {
      detect: (request) =>
        detectInstances.mutateAsync({
          projectId: request.projectId,
          assetId: request.assetId,
          connectionId,
          labelClass: request.labelClass,
          allowedGeometries: request.allowedGeometries,
          ...(request.phrase === undefined ? {} : { phrase: request.phrase }),
        }),
    };
  }, [connectionId, detectInstances]);
}
