/**
 * The media shell: a second host-injected runtime beside the data client
 * (`data/VisionSetDataProvider.tsx`), for browser video import.
 *
 * Unlike the data client, this runtime is optional. Video import is a capability
 * a host may not offer at all — an enterprise UI with its own materializer and
 * upload path, or an OSS build running somewhere `VideoDecoder` does not exist —
 * and the rule that already runs `docs/content/architecture/frontend/ui-core.md`'s
 * navigation callbacks runs here too: **a host that cannot honour a control passes
 * no callback and gets no control, rather than a dead one.** So `useMediaRuntime()`
 * answers "absent" as a plain, renderable `null` — never a thrown error — and a
 * screen with no runtime renders no video control, the same way a screen with no
 * `onOpenProject` renders no link.
 *
 * This is deliberately the *only* shape: one hook, nullable, no second
 * `useOptionalMediaRuntime`. `useApiClient` throws on absence because every screen
 * in this package assumes a data client exists — there is no code path where it is
 * legitimately missing. A media runtime has no such unconditional caller: it is
 * absent whenever a host does not support browser video import, which is an
 * ordinary, expected state rather than a composition bug. A second hook would only
 * exist to let a caller assert "this one is definitely present", and no caller
 * here has that assumption to make.
 */
import { createContext, useContext, type JSX, type ReactNode } from "react";

import type { VisionSetMediaRuntime } from "./port.js";

const MediaContext = createContext<VisionSetMediaRuntime | null>(null);

export interface VisionSetMediaProviderProps {
  /** The host's media runtime. Omitted (or `undefined`) when the host offers no video import. */
  readonly runtime?: VisionSetMediaRuntime;
  readonly children: ReactNode;
}

export function VisionSetMediaProvider({ runtime, children }: VisionSetMediaProviderProps): JSX.Element {
  return <MediaContext.Provider value={runtime ?? null}>{children}</MediaContext.Provider>;
}

/** The host's media runtime, or `null` when none was supplied — never throws. */
export function useMediaRuntime(): VisionSetMediaRuntime | null {
  return useContext(MediaContext);
}
