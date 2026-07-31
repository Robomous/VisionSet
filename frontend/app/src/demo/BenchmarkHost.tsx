/**
 * The benchmark page: `AnnotatorCanvas` over `benchScene.ts`, and as little else
 * as the measurement allows.
 *
 * ## Why this is not `AnnotatorDemo`
 *
 * The demo's right-hand column is a debug surface, and one panel in it is
 * ruinous at this scale: `<pre data-testid="wire">` runs `JSON.stringify` over
 * every annotation on every snapshot change, and `AnnotatorStore.stage`
 * invalidates the snapshot on **every pointer-move**. At 220 annotations a drag
 * on that page would be measuring the host's own debug pane rather than the
 * engine — the benchmark would report a number that is real and about the wrong
 * thing.
 *
 * That claim is not asserted and left there. `?chrome=wire` renders this same
 * scene *with* the pane, and `bench/annotator.bench.ts` measures both, so the
 * cost of the omission is a recorded number rather than a justification.
 *
 * Everything that remains is what a scenario needs to steer or to read:
 * `counts` is the settled-state barrier every spec in `e2e/` already waits on,
 * and `bench-ready` says the 4K raster has been built. Nothing here is styled
 * beyond what makes the pane large, which is the point — this page is an
 * instrument, and #50 polishes the *demo*, not this.
 *
 * ## The picture arrives after the document
 *
 * `renderBenchImage` draws 8.3 megapixels and encodes a JPEG, which is the one
 * genuinely slow thing on this page. The canvas is therefore not rendered until
 * the URL exists: mounting it against an empty `src` would fit the stage against
 * a broken image and make the first measured frames a layout that no scenario
 * asked for. `frameOf` waits on the canvas being visible, so this is also what
 * makes every harness here wait on state rather than on a clock.
 */

import {
  AnnotatorCanvas,
  annotationsInDrawOrder,
  selectedAnnotations,
  toAnnotationCreate,
  useAnnotatorSnapshot,
  useAnnotatorStore,
} from "@visionset/annotator";
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";

import { BENCH_ASSET, benchAnnotations, renderBenchImage } from "./benchScene";
import { SAMPLE_SCHEMA } from "./sampleSchema";

/**
 * Built once, at import.
 *
 * `benchAnnotations()` is deterministic, so a module-level constant and a call
 * per mount would produce the same 220 objects — but the constant is what makes
 * "the scene is the same in every scenario" structural instead of a property of
 * the generator that somebody could later break.
 */
const BENCH_WIRE = benchAnnotations();

const PANEL: CSSProperties = {
  border: "1px solid #2b3648",
  borderRadius: 8,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

export interface BenchmarkHostProps {
  /**
   * Render the demo's wire pane beside the canvas.
   *
   * Off by default and reached only by `?chrome=wire`. It exists to be measured,
   * not to be used — see the docstring above.
   */
  readonly wirePane?: boolean;
}

export function BenchmarkHost({ wirePane = false }: BenchmarkHostProps): JSX.Element {
  const store = useAnnotatorStore({
    asset: BENCH_ASSET,
    schema: SAMPLE_SCHEMA,
    annotations: BENCH_WIRE,
  });
  const snapshot = useAnnotatorSnapshot(store);
  const [activeClass, setActiveClass] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  useEffect(() => {
    let made: string | null = null;
    let cancelled = false;
    void renderBenchImage().then((url) => {
      made = url;
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      setImageSrc(url);
    });
    return () => {
      cancelled = true;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, []);

  const drawn = annotationsInDrawOrder(snapshot.document);
  const selected = selectedAnnotations(snapshot.document, snapshot.selection);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: wirePane ? "1fr 300px" : "1fr",
        gap: 16,
        height: "100%",
        color: "#dbe4f0",
        font: "14px/1.45 system-ui, sans-serif",
      }}
    >
      <div style={{ position: "relative", border: "1px solid #2b3648", borderRadius: 8 }}>
        {imageSrc === null ? (
          <p style={{ padding: 12 }}>building the 4K asset…</p>
        ) : (
          <AnnotatorCanvas
            store={store}
            imageSrc={imageSrc}
            activeClass={activeClass}
            onActivateClass={setActiveClass}
          />
        )}
        <div
          style={{
            position: "absolute",
            left: 8,
            bottom: 8,
            padding: "4px 8px",
            borderRadius: 6,
            background: "#0b1119cc",
            fontSize: 12,
            pointerEvents: "none",
          }}
        >
          <span data-testid="counts">
            {drawn.length} annotation(s), {selected.length} selected
          </span>
          {imageSrc !== null && <span data-testid="bench-ready" hidden />}
        </div>
      </div>

      {wirePane && (
        <aside style={PANEL}>
          <strong>What would be saved</strong>
          <pre data-testid="wire" style={{ margin: 0, overflow: "auto", fontSize: 11 }}>
            {JSON.stringify(drawn.map(toAnnotationCreate), null, 2)}
          </pre>
        </aside>
      )}
    </div>
  );
}
