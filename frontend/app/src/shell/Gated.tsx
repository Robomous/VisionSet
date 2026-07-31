/**
 * The credential boundary, as a layout route.
 *
 * `TokenGate` already decides whether there is a token; this exists so the router
 * can say *which routes it wraps* declaratively rather than every product page
 * remembering to nest itself inside one. `/demo` and `/styleguide` sit outside it,
 * which is the whole reason the boundary is expressed here and not in `main.tsx`.
 */

import { TokenGate } from "@visionset/ui-core";
import type { JSX } from "react";
import { Outlet } from "react-router";

export function Gated(): JSX.Element {
  return (
    <TokenGate>
      <Outlet />
    </TokenGate>
  );
}
