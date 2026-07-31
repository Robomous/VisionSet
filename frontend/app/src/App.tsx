import type { JSX } from "react";

import { AnnotatorDemo } from "./demo/AnnotatorDemo";

/**
 * The development shell. Until the product surfaces land (M5), its whole job is
 * to host the annotator demo — which #48 drives with Playwright and #50 polishes
 * into the public showcase.
 */
export function App(): JSX.Element {
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
        Robomous VisionSet — annotator demo
      </h1>
      <AnnotatorDemo />
    </main>
  );
}
