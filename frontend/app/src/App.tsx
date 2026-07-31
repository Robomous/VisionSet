import type { JSX } from "react";

import { AnnotatorDemo } from "./demo/AnnotatorDemo";
import { BenchmarkHost } from "./demo/BenchmarkHost";

/**
 * The development shell. Until the product surfaces land (M5), its whole job is
 * to host the annotator demo — which #48 drives with Playwright and #50 polishes
 * into the public showcase.
 *
 * `?scene=bench` swaps in #49's 220-annotation 4K scene, and `?chrome=wire` adds
 * the demo's wire pane to it so the benchmark can price that pane rather than
 * assume it. A query parameter rather than a route: there is no router here, and
 * installing one so two pages can coexist is the wrong trade at M4. The default
 * is byte-for-byte the page it was, which is what keeps the thirty-seven
 * scenarios in `e2e/` untouched.
 */
export function App(): JSX.Element {
  const query = new URLSearchParams(window.location.search);
  const bench = query.get("scene") === "bench";

  return (
    <main
      style={{
        boxSizing: "border-box",
        height: "100vh",
        padding: 16,
        background: "#0b1119",
        color: "#dbe4f0",
        font: "14px/1.45 system-ui, sans-serif",
        display: "grid",
        gridTemplateRows: "auto 1fr",
        gap: 12,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
        Robomous VisionSet — annotator {bench ? "benchmark" : "demo"}
      </h1>
      {bench ? <BenchmarkHost wirePane={query.get("chrome") === "wire"} /> : <AnnotatorDemo />}
    </main>
  );
}
