/**
 * Every URL this application answers, in one table.
 *
 * `@visionset/app` is **shell only** — navigation, layout, composition — and this
 * file is the shell's centre. The rule (#58, the epic's "enterprise rule") is that
 * a capability living here instead of in `@visionset/ui-core` is an architecture
 * bug by definition, because the future enterprise UI cannot reuse it. So a route
 * is allowed to decide *which* screen renders and *what its parameters are*, and
 * nothing else: no fetching, no domain logic, no error interpretation.
 *
 * ## Three regions, and the boundary between them is the token
 *
 * | region | routes | inside `TokenGate`? |
 * | --- | --- | --- |
 * | the product | `/`, `/projects`, `/projects/:projectId`, … | yes |
 * | the annotator showcase | `/demo` | **no** |
 * | the design system | `/styleguide` | **no** |
 *
 * The last two need no server and no credential — the showcase's picture is a
 * `data:` URI and the styleguide is pure CSS — so putting them behind the gate
 * would be asking for a token to look at a page that cannot use one. They are also
 * what lets this repository's browser suite run with no backend at all.
 *
 * ## Why those two stopped being separate Vite entries
 *
 * #49 gave the benchmark a query parameter and #128 gave the styleguide a second
 * HTML entry, both because there was no router to put them behind. There is one
 * now, so both collapse into routes and `rollupOptions.input` goes away — which is
 * what "#58 retires both entries" meant when those files said it.
 *
 * The benchmark keeps its query parameter (`/demo?scene=bench`) rather than
 * gaining a route: it is an instrument, #49's recorded numbers were taken against
 * that exact page, and moving it would change what it measures for no reason
 * anybody asked for.
 *
 * ## Screens land later, and the placeholders say which task owns them
 *
 * #53 through #57 build the screens, in `ui-core`. Until then each route renders an
 * `EmptyState` naming its issue, which is a more honest shell than a route table
 * with commented-out lines: the *navigation* is real and testable today, and a
 * screen arriving is one import.
 */

import { EmptyState } from "@visionset/ui-core";
import { Route, Routes, useSearchParams } from "react-router";
import type { JSX } from "react";

import { AnnotatorDemo } from "./demo/AnnotatorDemo";
import { BenchmarkHost } from "./demo/BenchmarkHost";
import { ShowcaseFrame } from "./demo/ShowcaseFrame";
import { AppShell } from "./shell/AppShell";
import { Gated } from "./shell/Gated";
import { NotFound } from "./shell/NotFound";
import { Styleguide } from "./styleguide/Styleguide";

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      {/* The product. Everything under here needs a workspace token. */}
      <Route element={<Gated />}>
        <Route element={<AppShell />}>
          <Route index element={<Placeholder title="Home" issue={58} />} />
          <Route path="projects" element={<Placeholder title="Projects" issue={53} />} />
          <Route path="projects/:projectId" element={<Placeholder title="Project" issue={53} />} />
          <Route
            path="projects/:projectId/batches/:batchId"
            element={<Placeholder title="Batch" issue={55} />}
          />
          <Route path="jobs/:jobId" element={<Placeholder title="Annotate" issue={56} />} />
          <Route
            path="projects/:projectId/dataset"
            element={<Placeholder title="Dataset" issue={57} />}
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>

      {/* No token, no server. Also what the browser suite drives. */}
      <Route path="demo" element={<Showcase />} />
      <Route path="styleguide" element={<Styleguide />} />
    </Routes>
  );
}

/** The showcase, and #49's benchmark behind its query parameter. */
function Showcase(): JSX.Element {
  const [query] = useSearchParams();
  const bench = query.get("scene") === "bench";
  return (
    <ShowcaseFrame bench={bench}>
      {bench ? <BenchmarkHost wirePane={query.get("chrome") === "wire"} /> : <AnnotatorDemo />}
    </ShowcaseFrame>
  );
}

function Placeholder({
  title,
  issue,
}: {
  readonly title: string;
  readonly issue: number;
}): JSX.Element {
  return (
    <EmptyState
      title={title}
      description={`This screen lands with #${issue}. The shell, the router and the rail are #58's.`}
    />
  );
}
