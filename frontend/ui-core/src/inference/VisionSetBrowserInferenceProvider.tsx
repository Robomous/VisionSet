/**
 * The browser inference shell: a third host-injected runtime beside the data client and the
 * media runtime, for answering a suggestion on this device.
 *
 * Optional, for the reason video import is optional and navigation callbacks are optional:
 * **a host that cannot honour a control passes no runtime and gets no control, rather than a
 * dead one.** So this hook answers "absent" as a plain, renderable `null` and never throws, and
 * a build with no browser inference renders no local target — the same way a screen with no
 * `onOpenProject` renders no link. Absence is the ordinary case, not a composition bug.
 *
 * One hook, nullable, and no second asserting variant, for the reason
 * `media/VisionSetMediaProvider.tsx` gives at length: no caller here has "this one is
 * definitely present" to assert, because no screen in this package requires a browser runtime
 * to function.
 */
import { createContext, useContext, type JSX, type ReactNode } from "react";

import type { VisionSetBrowserInferenceRuntime } from "./browserPort.js";

const BrowserInferenceContext = createContext<VisionSetBrowserInferenceRuntime | null>(null);

export interface VisionSetBrowserInferenceProviderProps {
  /** The host's runtime. Omitted (or `undefined`) when this build runs no model locally. */
  readonly runtime?: VisionSetBrowserInferenceRuntime;
  readonly children: ReactNode;
}

export function VisionSetBrowserInferenceProvider({
  runtime,
  children,
}: VisionSetBrowserInferenceProviderProps): JSX.Element {
  return (
    <BrowserInferenceContext.Provider value={runtime ?? null}>
      {children}
    </BrowserInferenceContext.Provider>
  );
}

/** The host's browser inference runtime, or `null` when none was supplied — never throws. */
export function useBrowserInferenceRuntime(): VisionSetBrowserInferenceRuntime | null {
  return useContext(BrowserInferenceContext);
}
