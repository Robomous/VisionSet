import type { JSX } from "react";

import { AnnotatorDemo } from "./demo/AnnotatorDemo";
import { BenchmarkHost } from "./demo/BenchmarkHost";
import { COLOR, FONT_STACK, SPACE, TEXT } from "./demo/theme";

/**
 * The development shell. Until the product surfaces land (M5), its whole job is
 * to host the annotator showcase — which #48 drives with Playwright and #50
 * polished into the public one.
 *
 * `?scene=bench` swaps in #49's 220-annotation 4K scene, and `?chrome=wire` adds
 * the demo's wire pane to it so the benchmark can price that pane rather than
 * assume it. A query parameter rather than a route: there is no router here, and
 * installing one so two pages can coexist is the wrong trade at M4. The default
 * page's *structure* is byte-for-byte the page it was — only its styling moved —
 * which is what keeps the thirty-seven behavioural scenarios in `e2e/` untouched.
 *
 * ## The bench page keeps the old chrome, deliberately
 *
 * `BenchmarkHost` is an instrument and takes none of this. Restyling it would
 * change what its frame times are measuring for no reason anybody asked for, and
 * #49's numbers were recorded against the page as it stands.
 */
export function App(): JSX.Element {
  const query = new URLSearchParams(window.location.search);
  const bench = query.get("scene") === "bench";

  return (
    <main
      style={{
        boxSizing: "border-box",
        height: "100vh",
        padding: bench ? SPACE.md : SPACE.lg,
        background: bench ? "#0b1119" : COLOR.background,
        color: bench ? "#dbe4f0" : COLOR.foreground,
        fontFamily: FONT_STACK,
        ...TEXT.body,
        display: "grid",
        gridTemplateRows: "auto 1fr",
        gap: SPACE.md,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: SPACE.sm,
          paddingBottom: bench ? 0 : SPACE.sm,
          borderBottom: bench ? "none" : `1px solid ${COLOR.border}`,
        }}
      >
        <h1 style={{ margin: 0, ...(bench ? { fontSize: 18, fontWeight: 600 } : TEXT.pageTitle) }}>
          Robomous VisionSet — annotator {bench ? "benchmark" : "demo"}
        </h1>
        {!bench && (
          <p style={{ margin: 0, color: COLOR.mutedForeground, ...TEXT.meta }}>
            The headless annotation engine, embedded. No backend, no router — the canvas
            takes a store and gives back callbacks.
          </p>
        )}
      </header>
      {bench ? <BenchmarkHost wirePane={query.get("chrome") === "wire"} /> : <AnnotatorDemo />}
    </main>
  );
}
