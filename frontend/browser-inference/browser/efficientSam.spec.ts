/**
 * EfficientSAM-Ti, the real ONNX graphs, in a real browser.
 *
 * Everything here runs against `dist/` — the worker the build emitted and the ONNX
 * Runtime WebAssembly it carries — loading `model-artifacts/efficientsam-ti/*.onnx`
 * exactly as `browser/serve.mjs` serves this package's own directory. The vitest suite
 * under `src/` proves the host/client protocol against a fake session; nothing short of
 * a browser can say whether the exported graphs actually run, and whether onnxruntime-web
 * agrees with the Python ONNX Runtime side of the same export in `reference.json`.
 *
 * Skipped whole-file when the artifacts are absent — a 41 MB checkpoint export is not
 * something a contributor is expected to have on disk by default. `VISIONSET_REQUIRE_BROWSER_MODELS=1`
 * inverts that: in the job whose entire purpose is exercising the real graphs, absent artifacts
 * are a failure, because a suite that skips itself and exits 0 is indistinguishable from one
 * that proved something. That flag is the same bargain `tests/browser_models/` strikes on the
 * Python side, and the same one `VISIONSET_REQUIRE_LOCAL_INFERENCE` strikes one subsystem over.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { modelArgument, openHarness, workersStarted } from "./_support.ts";
import { REFERENCE_IMAGE_SHA256, referenceImage } from "./fixtureImage.ts";

const HERE = import.meta.dirname;
const ARTIFACTS_DIR = path.resolve(HERE, "..", "model-artifacts", "efficientsam-ti");
const ENCODER_PATH = path.join(ARTIFACTS_DIR, "encoder.onnx");
const DECODER_PATH = path.join(ARTIFACTS_DIR, "decoder.onnx");
const REFERENCE_PATH = path.join(ARTIFACTS_DIR, "reference.json");

const HAS_ARTIFACTS =
  existsSync(ENCODER_PATH) && existsSync(DECODER_PATH) && existsSync(REFERENCE_PATH);

const REQUIRE_ENV = "VISIONSET_REQUIRE_BROWSER_MODELS";
const ARTIFACTS_REQUIRED = process.env[REQUIRE_ENV] === "1";

const MISSING_ARTIFACTS_MESSAGE =
  "model-artifacts/efficientsam-ti/{encoder.onnx,decoder.onnx,reference.json} are not on disk. " +
  "Build them with:\n" +
  "  uv sync --locked --group browser-models\n" +
  "  uv run python scripts/browser_models/efficientsam/export.py\n" +
  "  uv run python scripts/browser_models/efficientsam/parity.py";

interface ReferenceCase {
  readonly name: string;
  readonly positive_points: readonly (readonly [number, number])[];
  readonly selected_index: number;
  readonly confidence: number;
  readonly mask_sha256: string;
  readonly lit_pixels: number;
  readonly total_pixels: number;
}

interface ReferenceFile {
  readonly image: { readonly width: number; readonly height: number; readonly sha256: string };
  readonly mask_threshold: number;
  readonly cases: readonly ReferenceCase[];
}

// Read only when the file exists; a missing artifacts directory must not throw at
// collection time — every test below that dereferences this is itself skipped.
const REFERENCE: ReferenceFile | null = HAS_ARTIFACTS
  ? (JSON.parse(readFileSync(REFERENCE_PATH, "utf8")) as ReferenceFile)
  : null;

const ENCODER_URL = "/model-artifacts/efficientsam-ti/encoder.onnx";
const DECODER_URL = "/model-artifacts/efficientsam-ti/decoder.onnx";

const ADAPTER = "/dist/browser/index.js";
const CORE = "/dist/index.js";
type Adapter = typeof import("../src/browser/index.ts");
type Core = typeof import("../src/index.ts");
type Runtime = import("../src/models/promptable.ts").PromptableSegmentationRuntime;
type PreparedHandle = import("../src/models/promptable.ts").PreparedImage;

/** `<= 5e-3`: two ONNX Runtime builds, two backends — see the design's tolerance table. */
const CONFIDENCE_TOLERANCE = 5e-3;

/**
 * `reference.json` carries `lit_pixels` and `mask_sha256`, never the raw mask, so this
 * suite cannot compute an actual Jaccard index against Python's mask — there is nothing
 * to intersect it with. What it can check, from the count alone, is a bound implied by
 * the design's own floor: if `IoU >= 0.999`, the symmetric difference between the two
 * masks is at most 0.1% of their union, so `||ours| - |python||` cannot exceed roughly
 * that share of the pixel count either. This is deliberately looser than "0 pixels
 * different" — which is what every case actually measured on this machine, logged
 * below — because demanding bit-identical WASM-vs-native output would fail this suite
 * on a future browser or ORT build that legitimately drifts by a few boundary pixels
 * while staying well inside the real correctness gate.
 */
function litPixelsTolerance(totalPixels: number): number {
  return Math.ceil(totalPixels * 0.002);
}

/** Nowhere near the circle (170,192, r=90) or the rectangle ([300,460) x [90,300)). */
const BACKGROUND_PIXEL: readonly [number, number] = [5, 5];

// Before any `test()` is registered, so this is a file-level collection error rather than a
// failure inside one test: with the flag set there is no meaningful suite to run at all, and
// the run should say so once instead of eleven times.
if (ARTIFACTS_REQUIRED && !HAS_ARTIFACTS) {
  throw new Error(
    `${MISSING_ARTIFACTS_MESSAGE}\n\n${REQUIRE_ENV}=1 is set, so missing artifacts are an ` +
      "error rather than a skip — this is the run that was supposed to build them.",
  );
}

test.describe("EfficientSAM-Ti in a real browser", () => {
  test.skip(!HAS_ARTIFACTS, MISSING_ARTIFACTS_MESSAGE);

  /**
   * Two module constants with, until this test, zero readers: `REFERENCE_IMAGE_SHA256`
   * in `fixtureImage.ts` and its Python twin in `scripts/browser_models/efficientsam/
   * fixture.py`. This is what actually proves them equal, and it is deliberately Node-side
   * and before any `page.evaluate`: it is what lets every later assertion say "the browser
   * saw the same pixels Python did" rather than assuming it.
   */
  test("confirms the fixture image both languages draw is the same image", () => {
    const image = referenceImage();
    const measured = createHash("sha256").update(image.rgb).digest("hex");
    expect(measured).toBe(REFERENCE_IMAGE_SHA256);
    expect(measured).toBe(REFERENCE!.image.sha256);
  });

  /**
   * One embedding, three refinements, one worker.
   *
   * `test.describe.serial` plus a page opened once in `beforeAll` (not the per-test
   * `page` fixture) is what lets `globalThis.__runtime`/`__prepared`, set inside one
   * test's `page.evaluate`, still be there for the next: the whole point is proving the
   * *same* worker answers every one of these, which a fresh page per test could not ask.
   */
  test.describe.serial("one embedding, three refinements, one worker", () => {
    let page: Page;
    let firstAnswer!: { readonly maskLength: number; readonly confidence: number };
    let secondAnswer!: { readonly maskLength: number; readonly confidence: number };
    let thirdAnswer!: { readonly maskLength: number; readonly confidence: number };

    test.beforeAll(async ({ browser }) => {
      page = await browser.newPage();
      await openHarness(page);
    });

    test.afterAll(async () => {
      await page.close();
    });

    test("loads EfficientSAM-Ti and answers a positive click", async () => {
      const image = referenceImage();
      const rectangleCase = REFERENCE!.cases[1]!;
      const fixture = {
        adapterUrl: ADAPTER,
        encoderUrl: ENCODER_URL,
        decoderUrl: DECODER_URL,
        width: image.width,
        height: image.height,
        rgb: modelArgument(image.rgb),
        point: rectangleCase.positive_points[0]!,
        background: BACKGROUND_PIXEL,
      };

      const result = await page.evaluate(async (fx) => {
        const { createEfficientSamRuntime } = (await import(fx.adapterUrl)) as Adapter;
        const [encoderBuf, decoderBuf] = await Promise.all([
          fetch(fx.encoderUrl).then((response) => response.arrayBuffer()),
          fetch(fx.decoderUrl).then((response) => response.arrayBuffer()),
        ]);

        const t0 = performance.now();
        const runtime = createEfficientSamRuntime({
          policy: "wasm-only",
          encoder: new Uint8Array(encoderBuf),
          decoder: new Uint8Array(decoderBuf),
        });
        const providers = await runtime.ready();
        const t1 = performance.now();

        const prepared = await runtime.prepareImage({
          width: fx.width,
          height: fx.height,
          rgb: Uint8Array.from(fx.rgb),
        });
        const t2 = performance.now();

        const segmentation = await runtime.suggest(prepared, { positive: [fx.point], negative: [] });
        const t3 = performance.now();

        let lit = 0;
        for (const value of segmentation.mask) lit += value;

        (globalThis as unknown as { __runtime: Runtime }).__runtime = runtime;
        (globalThis as unknown as { __prepared: PreparedHandle }).__prepared = prepared;

        return {
          providers,
          readyMs: t1 - t0,
          prepareMs: t2 - t1,
          suggestMs: t3 - t2,
          width: segmentation.width,
          height: segmentation.height,
          maskLength: segmentation.mask.length,
          confidence: segmentation.confidence,
          lit,
          maskAtPoint: segmentation.mask[fx.point[1] * segmentation.width + fx.point[0]],
          maskAtBackground: segmentation.mask[fx.background[1] * segmentation.width + fx.background[0]],
        };
      }, fixture);

      console.log(
        `[efficientsam] ready ${result.readyMs.toFixed(1)}ms, prepareImage (encoder) ` +
          `${result.prepareMs.toFixed(1)}ms, first suggest (decode) ${result.suggestMs.toFixed(1)}ms, ` +
          `providers=${JSON.stringify(result.providers)}`,
      );

      expect(result.providers).toEqual(["wasm"]);
      expect(result.width).toBe(image.width);
      expect(result.height).toBe(image.height);
      expect(result.maskLength).toBe(image.width * image.height);
      expect(Number.isFinite(result.confidence)).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      // The clicked point must be inside the mask it produced, and a corner nowhere near
      // either shape must not be — a real spatial check, not only a pixel count. A browser
      // that answered with an inverted or unrelated mask could still report a plausible
      // `lit` count while failing exactly these two.
      expect(result.maskAtPoint).toBe(1);
      expect(result.maskAtBackground).toBe(0);

      firstAnswer = { maskLength: result.maskLength, confidence: result.confidence };
    });

    test("refines that answer with a second positive point, on the same worker", async () => {
      const refinedCase = REFERENCE!.cases[2]!;
      const fixture = { points: refinedCase.positive_points, background: BACKGROUND_PIXEL };

      const result = await page.evaluate(async (fx) => {
        const runtime = (globalThis as unknown as { __runtime: Runtime }).__runtime;
        const prepared = (globalThis as unknown as { __prepared: PreparedHandle }).__prepared;

        const t0 = performance.now();
        const segmentation = await runtime.suggest(prepared, { positive: fx.points, negative: [] });
        const t1 = performance.now();

        let lit = 0;
        for (const value of segmentation.mask) lit += value;

        return {
          suggestMs: t1 - t0,
          width: segmentation.width,
          height: segmentation.height,
          maskLength: segmentation.mask.length,
          confidence: segmentation.confidence,
          lit,
          maskAtBackground: segmentation.mask[fx.background[1] * segmentation.width + fx.background[0]],
        };
      }, fixture);

      console.log(`[efficientsam] warm decode (refine 1, 2 points) ${result.suggestMs.toFixed(1)}ms`);

      expect(result.maskLength).toBe(refinedCase.total_pixels);
      expect(Math.abs(result.confidence - refinedCase.confidence)).toBeLessThanOrEqual(
        CONFIDENCE_TOLERANCE,
      );
      expect(result.maskAtBackground).toBe(0);

      secondAnswer = { maskLength: result.maskLength, confidence: result.confidence };
    });

    test("answers a third refinement without re-encoding the image", async () => {
      const refinedCase = REFERENCE!.cases[2]!;
      const circleCase = REFERENCE!.cases[0]!;
      const fixture = { points: [...refinedCase.positive_points, ...circleCase.positive_points] };

      const result = await page.evaluate(async (fx) => {
        const runtime = (globalThis as unknown as { __runtime: Runtime }).__runtime;
        const prepared = (globalThis as unknown as { __prepared: PreparedHandle }).__prepared;

        const t0 = performance.now();
        // The *same* handle `prepareImage` returned in the first test, two suggest calls
        // ago. If anything along the way had silently re-encoded, the worker's own
        // generation counter would have moved on and this handle would be refused with
        // `image-superseded` — so a bare resolve here is itself the proof that this
        // suite's "one embedding" claim holds, not only an assumption behind it.
        const segmentation = await runtime.suggest(prepared, { positive: fx.points, negative: [] });
        const t1 = performance.now();
        return {
          suggestMs: t1 - t0,
          width: segmentation.width,
          height: segmentation.height,
          maskLength: segmentation.mask.length,
          confidence: segmentation.confidence,
        };
      }, fixture);

      console.log(`[efficientsam] warm decode (refine 2, 3 points) ${result.suggestMs.toFixed(1)}ms`);

      expect(result.maskLength).toBe(result.width * result.height);
      expect(Number.isFinite(result.confidence)).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);

      thirdAnswer = { maskLength: result.maskLength, confidence: result.confidence };
    });

    test("counts exactly one Worker for the whole session", async () => {
      expect(await workersStarted(page)).toBe(1);
    });

    test("returns a mask the size of the image, and a finite confidence in [0, 1]", () => {
      const image = referenceImage();
      for (const answer of [firstAnswer, secondAnswer, thirdAnswer]) {
        expect(answer.maskLength).toBe(image.width * image.height);
        expect(Number.isFinite(answer.confidence)).toBe(true);
        expect(answer.confidence).toBeGreaterThanOrEqual(0);
        expect(answer.confidence).toBeLessThanOrEqual(1);
      }
    });

    /**
     * The real parity test: every case in `reference.json`, read at runtime rather than
     * hard-coded, run fresh against the one embedding this whole block shares.
     *
     * `RawSegmentation` carries `confidence` and the winning candidate's own binary mask,
     * never a raw candidate index — `bestCandidate` picking a *different* index would
     * almost always show up as a confidence far outside `CONFIDENCE_TOLERANCE` (the three
     * candidates' IoU scores are not close together in any of these cases), so the
     * confidence check is this suite's only available proxy for "the same candidate was
     * chosen" and is reported as such rather than as a direct index comparison.
     */
    test("agrees with the Python reference on candidate, confidence and mask", async () => {
      const fixture = { cases: REFERENCE!.cases, background: BACKGROUND_PIXEL };

      const results = await page.evaluate(async (fx) => {
        function hexOf(buffer: ArrayBuffer): string {
          return Array.from(new Uint8Array(buffer))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        }

        const runtime = (globalThis as unknown as { __runtime: Runtime }).__runtime;
        const prepared = (globalThis as unknown as { __prepared: PreparedHandle }).__prepared;

        const answers = [];
        for (const referenceCase of fx.cases) {
          const t0 = performance.now();
          const segmentation = await runtime.suggest(prepared, {
            positive: referenceCase.positive_points,
            negative: [],
          });
          const t1 = performance.now();

          let lit = 0;
          for (const value of segmentation.mask) lit += value;
          const digest = hexOf(await crypto.subtle.digest("SHA-256", new Uint8Array(segmentation.mask)));
          const atPoints = referenceCase.positive_points.every(
            ([x, y]) => segmentation.mask[y * segmentation.width + x] === 1,
          );

          answers.push({
            name: referenceCase.name,
            suggestMs: t1 - t0,
            confidence: segmentation.confidence,
            lit,
            maskSha256: digest,
            atPoints,
            atBackground: segmentation.mask[fx.background[1] * segmentation.width + fx.background[0]],
          });
        }
        return answers;
      }, fixture);

      for (const [index, referenceCase] of REFERENCE!.cases.entries()) {
        const answer = results[index]!;
        const confidenceError = Math.abs(answer.confidence - referenceCase.confidence);
        const shaMatches = answer.maskSha256 === referenceCase.mask_sha256;
        console.log(
          `[efficientsam] case "${referenceCase.name}": confidence ${answer.confidence.toFixed(6)} ` +
            `vs ${referenceCase.confidence.toFixed(6)} (abs error ${confidenceError.toExponential(3)}), ` +
            `lit ${answer.lit} vs ${referenceCase.lit_pixels}, mask sha256 ${shaMatches ? "MATCHES" : "differs"} ` +
            `(browser ${answer.maskSha256.slice(0, 16)}..., python ${referenceCase.mask_sha256.slice(0, 16)}...), ` +
            `decode ${answer.suggestMs.toFixed(1)}ms`,
        );

        expect(confidenceError).toBeLessThanOrEqual(CONFIDENCE_TOLERANCE);
        expect(answer.atPoints).toBe(true);
        expect(answer.atBackground).toBe(0);
        expect(Math.abs(answer.lit - referenceCase.lit_pixels)).toBeLessThanOrEqual(
          litPixelsTolerance(referenceCase.total_pixels),
        );
      }
    });

    test("refuses a seventh point rather than dropping it", async () => {
      const fixture = {
        coreUrl: CORE,
        points: [[10, 10], [20, 20], [30, 30], [40, 40], [50, 50], [60, 60], [70, 70]] as (readonly [
          number,
          number,
        ])[],
      };

      const code = await page.evaluate(async (fx) => {
        const { isInferenceRuntimeError } = (await import(fx.coreUrl)) as Core;
        const runtime = (globalThis as unknown as { __runtime: Runtime }).__runtime;
        const prepared = (globalThis as unknown as { __prepared: PreparedHandle }).__prepared;
        try {
          await runtime.suggest(prepared, { positive: fx.points, negative: [] });
          return "did not reject";
        } catch (error) {
          return isInferenceRuntimeError(error) ? error.code : `not a runtime error: ${String(error)}`;
        }
      }, fixture);

      expect(code).toBe("prompt-rejected");
    });

    test("refuses a negative point, naming why this model cannot answer one", async () => {
      const fixture = { coreUrl: CORE };

      const outcome = await page.evaluate(async (fx) => {
        const { isInferenceRuntimeError } = (await import(fx.coreUrl)) as Core;
        const runtime = (globalThis as unknown as { __runtime: Runtime }).__runtime;
        const prepared = (globalThis as unknown as { __prepared: PreparedHandle }).__prepared;
        try {
          await runtime.suggest(prepared, { positive: [[100, 100]], negative: [[200, 200]] });
          return { code: "did not reject", message: "" };
        } catch (error) {
          return {
            code: isInferenceRuntimeError(error) ? error.code : `not a runtime error: ${String(error)}`,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }, fixture);

      expect(outcome.code).toBe("prompt-rejected");
      expect(outcome.message).toMatch(/negative|background/i);
    });

    test("refuses a handle for an image it has replaced", async () => {
      const image = referenceImage();
      const fixture = {
        coreUrl: CORE,
        width: image.width,
        height: image.height,
        rgb: modelArgument(image.rgb),
      };

      const code = await page.evaluate(async (fx) => {
        const { isInferenceRuntimeError } = (await import(fx.coreUrl)) as Core;
        const runtime = (globalThis as unknown as { __runtime: Runtime }).__runtime;
        const stale = (globalThis as unknown as { __prepared: PreparedHandle }).__prepared;

        // A second `prepareImage` on the same worker: the worker now holds a new
        // generation, and `stale` — the handle every earlier test in this block used
        // successfully — names an embedding that no longer exists.
        await runtime.prepareImage({ width: fx.width, height: fx.height, rgb: Uint8Array.from(fx.rgb) });

        try {
          await runtime.suggest(stale, { positive: [[170, 192]], negative: [] });
          return "did not reject";
        } catch (error) {
          return isInferenceRuntimeError(error) ? error.code : `not a runtime error: ${String(error)}`;
        }
      }, fixture);

      expect(code).toBe("image-superseded");
    });
  });

  /**
   * WebGPU, whichever way this machine answers — see `runtime.spec.ts`'s identical
   * three-outcome reasoning for the tiny graph. Its own page, never the shared one above:
   * `require-webgpu` is a construction-time policy, so honouring it needs a second
   * worker, and this is the one test in the file allowed to start one.
   */
  test("reports honestly what WebGPU did", async ({ page }) => {
    await openHarness(page);
    const image = referenceImage();
    const fixture = {
      adapterUrl: ADAPTER,
      coreUrl: CORE,
      encoderUrl: ENCODER_URL,
      decoderUrl: DECODER_URL,
      width: image.width,
      height: image.height,
      rgb: modelArgument(image.rgb),
      point: REFERENCE!.cases[0]!.positive_points[0]!,
    };

    const outcome = await page.evaluate(async (fx) => {
      const { createEfficientSamRuntime } = (await import(fx.adapterUrl)) as Adapter;
      const { isInferenceRuntimeError } = (await import(fx.coreUrl)) as Core;

      const declared = "gpu" in navigator && navigator.gpu != null;
      let adapter = false;
      if (declared) {
        try {
          adapter = (await navigator.gpu.requestAdapter()) !== null;
        } catch {
          adapter = false;
        }
      }

      const [encoderBuf, decoderBuf] = await Promise.all([
        fetch(fx.encoderUrl).then((response) => response.arrayBuffer()),
        fetch(fx.decoderUrl).then((response) => response.arrayBuffer()),
      ]);

      try {
        const runtime = createEfficientSamRuntime({
          policy: "require-webgpu",
          encoder: new Uint8Array(encoderBuf),
          decoder: new Uint8Array(decoderBuf),
        });
        const providers = await runtime.ready();
        const prepared = await runtime.prepareImage({
          width: fx.width,
          height: fx.height,
          rgb: Uint8Array.from(fx.rgb),
        });
        const segmentation = await runtime.suggest(prepared, { positive: [fx.point], negative: [] });
        runtime.dispose();
        return {
          declared,
          adapter,
          executed: true,
          providers,
          confidence: segmentation.confidence as number | null,
          code: null as string | null,
        };
      } catch (error) {
        return {
          declared,
          adapter,
          executed: false,
          providers: null,
          confidence: null,
          code: isInferenceRuntimeError(error) ? error.code : `not a runtime error: ${String(error)}`,
        };
      }
    }, fixture);

    console.log(
      `[efficientsam webgpu] navigator.gpu ${outcome.declared ? "present" : "absent"}, adapter ` +
        `${outcome.adapter ? "obtained" : "unavailable"} -> require-webgpu ` +
        `${outcome.executed ? "EXECUTED ON WEBGPU" : `refused with ${String(outcome.code)}`}`,
    );

    if (!outcome.declared) {
      expect(outcome.executed).toBe(false);
      expect(outcome.code).toBe("webgpu-unavailable");
    } else if (outcome.adapter) {
      expect(outcome.executed).toBe(true);
      expect(outcome.providers).toEqual(["webgpu"]);
      expect(outcome.confidence).not.toBeNull();
    } else {
      // Declared but unusable — ORT fails at session creation, surfacing through
      // `model-load` as `graph-load-failed`, the same code a corrupt graph would raise.
      expect(outcome.executed).toBe(false);
      expect(outcome.code).toBe("graph-load-failed");
    }
  });
});
