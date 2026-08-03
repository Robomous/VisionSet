/**
 * The one entry point.
 *
 * ## Why the stylesheet is imported here now
 *
 * #128 kept the design system on a **second Vite entry** because Tailwind ships a
 * preflight — a global reset — and applying it to the annotator showcase, whose
 * fifty-four Playwright scenarios derive their coordinates from the page's real
 * layout, would have been a layout change nobody asked for in the one place this
 * repository has the most tests.
 *
 * That trade expires here. The product needs the stylesheet on every page, and a
 * router cannot scope a global reset — so the reset now applies to the showcase
 * too, and the showcase's scenarios were re-run against it rather than assumed to
 * survive. What made that safe is that the showcase styles itself inline from the
 * same tokens (`demo/theme.ts`), so preflight has almost nothing left to reset: its
 * headings, buttons and panels all carry their own values.
 *
 * ## `BrowserRouter`, and the basename the wheel needs
 *
 * `visionset ui` serves the bundle under `/app` — the API owns the root, which
 * `UI_PREFIX`'s docstring argues is a consequence of an unprefixed API rather than
 * something a later milestone can lift. So the router's basename has to match
 * vite's `base`, and both are read from the same place: `import.meta.env.BASE_URL`
 * is what vite substitutes for the `base` option, so the two cannot disagree.
 */

import { ApiProvider, TooltipProvider, Toaster } from "@visionset/ui-core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { AppRoutes } from "./routes";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root element");

/**
 * Where the API is.
 *
 * Same origin in production: the bundle is at `/app` and the API at the root, so a
 * relative request already lands on it. In development vite owns the origin, and
 * `/api` is proxied — never CORS on the server, which would put a middleware in
 * front of every response in production too. `docs/ui.md` has the argument.
 */
const API_BASE_URL = import.meta.env.DEV ? "/api" : "";

createRoot(container).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ApiProvider baseUrl={API_BASE_URL}>
        <TooltipProvider>
          <AppRoutes />
          <Toaster />
        </TooltipProvider>
      </ApiProvider>
    </BrowserRouter>
  </StrictMode>,
);
