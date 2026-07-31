/**
 * The frame around the annotator showcase and around #49's benchmark.
 *
 * This is the old `App.tsx`, moved rather than rewritten. Fifty-four Playwright
 * scenarios measure the page inside it — `e2e/_frame.ts` derives every coordinate
 * from the real layout, `polygon.spec.ts` asserts the heading text, and
 * `perf.spec.ts` counts DOM mutations — so the markup and the inline styling are
 * deliberately byte-for-byte what they were. #58 moved the *route*; it did not
 * touch the page.
 *
 * ## Why it still uses inline styles under a design system
 *
 * `theme.ts` argues it in full: Tailwind ships a preflight, a global reset that
 * removes the `body` margin and unstyles headings, buttons and tables. The
 * showcase's suite is built on the page having no reset — its own docstring says
 * so — and a reset applied as a side effect of adding a router would be a layout
 * change in the one place this repository has the most tests. The values are
 * imported from `@visionset/ui-core` either way, so the contract has one home.
 *
 * The benchmark keeps the older dark chrome on purpose: it is an instrument, and
 * #49's recorded numbers were taken against it as it stands.
 */

import type { JSX, ReactNode } from "react";

import { COLOR, FONT_STACK, SPACE, TEXT } from "./theme";

export interface ShowcaseFrameProps {
  /** #49's 220-annotation 4K scene, which takes none of the light chrome. */
  readonly bench: boolean;
  readonly children: ReactNode;
}

export function ShowcaseFrame({ bench, children }: ShowcaseFrameProps): JSX.Element {
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
            The headless annotation engine, embedded. No backend — the canvas takes a store
            and gives back callbacks.
          </p>
        )}
      </header>
      {children}
    </main>
  );
}
