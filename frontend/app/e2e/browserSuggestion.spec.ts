/**
 * Browser-local point suggestion, end to end: EfficientSAM-Ti runs in a real Chromium
 * against the real editor, using the Phase C hermetic fixture (never models.robomous.ai —
 * the real CDN is proved separately, once, by hand — see Task 16). Skipped whole-file when
 * the fixture is absent; VISIONSET_REQUIRE_BROWSER_MODELS=1 turns that into a hard failure,
 * the same bargain frontend/browser-inference/browser/efficientSam.spec.ts strikes.
 *
 * The Server/"This device" choice is a real `Tabs` component (`SuggestPanel.tsx`)
 * defaulting to the "server" tab, so every browser-target scenario here clicks
 * `suggest-target-browser` before touching the acquire button. There is no dedicated
 * "ready" testid: `DeviceTab` renders a plain `<Badge>Ready</Badge>` once
 * `listTargets()` answers non-empty, so "now ready" is read as that text appearing
 * inside `suggest-device-section` — and a failed acquisition renders `role="alert"`
 * beside the still-present acquire button (`SuggestPanel.tsx`'s `DeviceTab`).
 *
 * `TargetChooser` — and with it `suggest-target-browser` — is only mounted while
 * the session is in its ordinary idle/blocked states (`SuggestPanel.tsx`'s final
 * fallback render). The "shown" and "refused" cards replace it entirely, so a
 * claim about the active tab or the tab list has to be made from idle, never from
 * mid-suggestion or mid-refusal.
 *
 * `_wireApiStub.ts`'s `/content` route serves a real but 1×1 PNG — fine for the
 * ~150 tests in `annotate.spec.ts`, because `AnnotatorCanvas.tsx` lays the picture
 * out at the asset's *declared* width/height and never at its own `naturalWidth`
 * ("a picture whose natural size disagrees is a preview") — and `AnnotationPage.tsx`'s
 * `onImageReady` now hands the browser executor that same declared frame, so the
 * bounds it validates click coordinates against (`efficientSam.ts`'s
 * `x < 0 || x > width || ...`) agree with the canvas a click was made on. What a 1×1
 * `/content` still leaves wrong here is the *pixels*: `readRgb` would stretch one
 * sample across the whole declared frame, so this suite would be asking a real
 * EfficientSAM to segment an image it never saw. `mockAssetImage` below overrides
 * just this file's `/content` route with a real, correctly-sized PNG — scoped here
 * rather than changing `_wireApiStub.ts`'s shared default, which those ~150 other
 * tests may depend on for load speed.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { expect, test, type Page, type Request } from "@playwright/test";
import { JOB, serveApi } from "./_wireApiStub";

const ARTIFACTS_DIR = path.resolve(
  import.meta.dirname, "..", "..", "browser-inference", "model-artifacts", "efficientsam-ti",
);
const ENCODER_PATH = path.join(ARTIFACTS_DIR, "encoder.onnx");
const DECODER_PATH = path.join(ARTIFACTS_DIR, "decoder.onnx");
const HAS_ARTIFACTS = existsSync(ENCODER_PATH) && existsSync(DECODER_PATH);
const REQUIRE_ENV = "VISIONSET_REQUIRE_BROWSER_MODELS";
const MISSING_MESSAGE =
  "model-artifacts/efficientsam-ti/{encoder.onnx,decoder.onnx} are not on disk — see " +
  "frontend/browser-inference/browser/efficientSam.spec.ts for how to build them.";

if (process.env[REQUIRE_ENV] === "1" && !HAS_ARTIFACTS) {
  throw new Error(`${MISSING_MESSAGE}\n\n${REQUIRE_ENV}=1 is set, so this is an error rather than a skip.`);
}

const ENCODER_BYTES = HAS_ARTIFACTS ? readFileSync(ENCODER_PATH) : Buffer.alloc(0);
const DECODER_BYTES = HAS_ARTIFACTS ? readFileSync(DECODER_PATH) : Buffer.alloc(0);

/**
 * The real encoder's byte length, from `manifest.ts`'s `EFFICIENT_SAM_TI_EXPECTED.
 * encoder.bytes` — kept as a literal rather than imported, because that module
 * reads `import.meta.env` at module scope, which only exists under Vite's own
 * transform and would throw under this suite's plain Node/tsx loader.
 */
const REAL_ENCODER_BYTE_LENGTH = 24_799_777;
const REVISION = "b19782d049c0-843761ca46f4";
const MODEL_REF = `robomous/efficient-sam-ti@${REVISION}`;
const REGISTRY = {
  schema_version: 1,
  models: [
    { id: "efficient-sam-ti", name: "EfficientSAM-Ti", revision: REVISION, model_ref: MODEL_REF, manifest: `/models/efficient-sam-ti/${REVISION}/manifest.json` },
    { id: "mobile-sam", name: "MobileSAM", revision: "359e37f2b168-7983079ab060", model_ref: "robomous/mobile-sam@359e37f2b168-7983079ab060", manifest: "/models/mobile-sam/359e37f2b168-7983079ab060/manifest.json" },
    { id: "efficientvit-sam-l0", name: "EfficientViT-SAM-L0", revision: "e48dd681ba4b-1d3ba86d781b", model_ref: "robomous/efficientvit-sam-l0@e48dd681ba4b-1d3ba86d781b", manifest: "/models/efficientvit-sam-l0/e48dd681ba4b-1d3ba86d781b/manifest.json" },
    { id: "slimsam-77-uniform", name: "SlimSAM-77-uniform", revision: "7f2c646efd21-e6eb3c03cdbd", model_ref: "robomous/slimsam-77-uniform@7f2c646efd21-e6eb3c03cdbd", manifest: "/models/slimsam-77-uniform/7f2c646efd21-e6eb3c03cdbd/manifest.json" },
    { id: "sam2.1-hiera-tiny", name: "SAM2.1-hiera-tiny", revision: "7f000e65546d-6dbe21e6e60e", model_ref: "robomous/sam2.1-hiera-tiny@7f000e65546d-6dbe21e6e60e", manifest: "/models/sam2.1-hiera-tiny/7f000e65546d-6dbe21e6e60e/manifest.json" },
  ],
};
const MANIFEST = {
  schema_version: 1,
  id: "efficient-sam-ti",
  name: "EfficientSAM-Ti",
  revision: REVISION,
  model_ref: MODEL_REF,
  source: { repository: "https://github.com/yformer/EfficientSAM", revision: "d525f622e6f640acf5a0fc37c7ca1f243da5bde0" },
  runtime: { format: "onnx", opset: 17, onnxruntime_web: "1.29.0" },
  capabilities: { point_suggest: true, positive_points: true, negative_points: false, max_points: 6 },
  artifacts: {
    encoder: { path: "encoder.onnx", bytes: 24_799_777, sha256: "b19782d049c09a8f1cc36ccc6029264ca23c8ac35e6379fd9ef9f1bc6d81e7f2", content_type: "application/octet-stream" },
    decoder: { path: "decoder.onnx", bytes: 16_501_901, sha256: "843761ca46f4aa00b09fdcf0c94271321f76eece092a744296c742d682a86172", content_type: "application/octet-stream" },
  },
};

/** Routes the CDN manifest + artifacts to the local fixture — no network call ever leaves the page. */
async function mockCdn(page: Page, encoderBytes = ENCODER_BYTES, decoderBytes = DECODER_BYTES): Promise<void> {
  // Registered first, so it is matched *last* (Playwright tries the most-recently-added
  // handler first): anything at this host the specific routes below don't
  // recognise is hard-aborted rather than silently reaching the real CDN — including if
  // `VITE_MODEL_CDN_BASE_URL` or the manifest layout ever drifts out from under this stub.
  await page.route("**/models.robomous.ai/**", (route) => route.abort());
  await page.route("**/models.robomous.ai/registry/v1.json", (route) => route.fulfill({ json: REGISTRY }));
  // The complete deployed v1 shape: registry admission validates every field before
  // acquisition, while the pinned build record remains the integrity anchor.
  await page.route("**/models.robomous.ai/models/efficient-sam-ti/**/manifest.json", (route) =>
    route.fulfill({ json: MANIFEST }),
  );
  await page.route("**/models.robomous.ai/models/efficient-sam-ti/**/encoder.onnx", (route) =>
    route.fulfill({ body: encoderBytes, contentType: "application/octet-stream" }),
  );
  await page.route("**/models.robomous.ai/models/efficient-sam-ti/**/decoder.onnx", (route) =>
    route.fulfill({ body: decoderBytes, contentType: "application/octet-stream" }),
  );
}

// A minimal PNG encoder (signature + IHDR + one IDAT + IEND), so this file needs
// no image-processing dependency to produce a real, correctly-sized asset.
// Grayscale, 8-bit, one filter byte per row — `zlib.deflateSync` already emits a
// standard zlib stream, which is exactly what an IDAT chunk holds. Verified by
// hand against a real Chromium `Image.decode()` while writing this: a solid
// 640×480 PNG from this function reports `naturalWidth: 640, naturalHeight: 480`.
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function solidPng(width: number, height: number, gray = 128): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 0; // color type: grayscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width + 1);
    raw[rowStart] = 0; // filter type: none
    raw.fill(gray, rowStart + 1, rowStart + 1 + width);
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Matches `_wireApiStub.ts`'s `asset()` metadata — the coordinate frame every click here is in. */
const ASSET_WIDTH = 640;
const ASSET_HEIGHT = 480;
const REAL_ASSET_IMAGE = solidPng(ASSET_WIDTH, ASSET_HEIGHT);

/**
 * Overrides `/content` with a real, correctly-sized PNG. Must be registered
 * *after* `serveApi`'s own `**\/api/**` handler (Playwright tries the
 * most-recently-added matching handler first) so this one wins for `/content`
 * instead of `_wireApiStub.ts`'s 1×1 `PIXEL` — and before `page.goto`, since the
 * asset image is requested as soon as the annotation page mounts.
 */
async function mockAssetImage(page: Page): Promise<void> {
  await page.route("**/projects/**/assets/**/content", (route) =>
    route.fulfill({ contentType: "image/png", body: REAL_ASSET_IMAGE }),
  );
}

async function openJobWithBrowserRuntime(
  page: Page,
  sent: Request[],
  suggestible: boolean,
  modelSource: "fixture" | "live" = "fixture",
): Promise<void> {
  if (modelSource === "fixture") await mockCdn(page);
  await serveApi(page, sent, undefined, undefined, undefined, undefined, suggestible);
  await mockAssetImage(page);
  await page.goto(`/jobs/${JOB}`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("annotation-page")).toBeVisible();
}

function suggestCallsOf(sent: Request[]): Request[] {
  return sent.filter((r) => r.method() === "POST" && r.url().endsWith("/inference/suggest"));
}

/**
 * Counts requests to the model CDN from here on — via `page.on("request", ...)`
 * rather than a second `page.route`, so it never interferes with `mockCdn`'s own
 * fulfil handlers (a later-added `page.route` for the same pattern would run first
 * and could shadow them). Attach before whatever moment must not fetch, since a
 * listener added after the fact cannot see what already happened.
 */
function countModelRequestsFromNow(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (/models\.robomous\.ai\/.*\/(encoder|decoder)\.onnx$/.test(request.url())) count += 1;
  });
  return () => count;
}

/** Arms the suggest tool. The one and only place a scenario should click `tool-suggest`. */
async function armSuggestTool(page: Page): Promise<void> {
  await page.getByTestId("tool-suggest").click();
}

/**
 * Switches to "This device" and downloads the model, then waits for the real
 * "ready" signal: `DeviceTab` swaps the acquire button for a `Badge` reading
 * "Ready" once `listTargets()` answers non-empty (`SuggestPanel.tsx`). There is no
 * separate target-selection control to click — Phase F ships exactly one browser
 * target, and choosing the tab already set it as the active suggestion target.
 *
 * **Assumes the suggest tool is already armed** (see {@link armSuggestTool}).
 * Clicking `tool-suggest` again here would call `toggleSuggest()` a second time —
 * and `AnnotationPage.tsx`'s `toggleSuggest` clears the whole session when one
 * already exists (`session !== null` → `setSession(null)`), unmounting the very
 * panel this helper is trying to drive rather than doing nothing.
 */
async function acquireAndSelectBrowserTarget(page: Page): Promise<void> {
  await page.getByTestId("suggest-target-browser").click();
  await page.getByTestId("suggest-device-acquire-efficient-sam-ti").click();
  await expect(page.getByTestId("suggest-device-section").getByText("Ready", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

async function makeBrowserSuggestion(page: Page): Promise<void> {
  const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
  await expect(page.getByTestId("suggestion-shape")).toBeVisible({ timeout: 30_000 });
}

test.describe("browser suggestion", () => {
  // Real ONNX work competes with the rest of the fully-parallel app suite on local machines.
  // This is a functional ceiling, not a performance assertion; measured timings are reported
  // by the opt-in live smoke instead of turning shared-runner wall clock into a gate.
  test.setTimeout(60_000);
  test.skip(!HAS_ARTIFACTS, MISSING_MESSAGE);

  test("Server target: a click issues exactly one /inference/suggest HTTP request", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, true);
    await armSuggestTool(page);
    await expect(page.getByTestId("suggest-idle")).toBeVisible();
    const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await expect(page.getByTestId("suggestion-shape")).toBeVisible();
    expect(suggestCallsOf(sent)).toHaveLength(1);
  });

  test("This device target: a click never issues an /inference/suggest HTTP request", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, true);
    await armSuggestTool(page);
    await acquireAndSelectBrowserTarget(page);
    const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await expect(page.getByTestId("suggestion-shape")).toBeVisible({ timeout: 30_000 });
    expect(suggestCallsOf(sent)).toHaveLength(0);
  });

  test("an installed model survives reload and suggests again without an artifact GET", async ({ page }) => {
    const sent: Request[] = [];
    const artifactRequests = countModelRequestsFromNow(page);
    await openJobWithBrowserRuntime(page, sent, true);
    await armSuggestTool(page);
    await acquireAndSelectBrowserTarget(page);
    await makeBrowserSuggestion(page);
    expect(artifactRequests()).toBe(2);

    await page.reload();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await armSuggestTool(page);
    await expect(page.getByTestId("suggest-device-section").getByText(/ready/i)).toBeVisible({ timeout: 60_000 });
    expect(artifactRequests()).toBe(2);
    await makeBrowserSuggestion(page);
    expect(suggestCallsOf(sent)).toHaveLength(0);
  });

  test("live CDN smoke: admitted artifacts persist and reactivate without a second download", async ({ page }) => {
    test.skip(process.env.VISIONSET_LIVE_MODEL_SMOKE !== "1", "manual smoke against models.robomous.ai");
    test.setTimeout(120_000);
    const sent: Request[] = [];
    const responses: { url: string; bytes: number; milliseconds: number }[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith("https://models.robomous.ai/")) {
        console.info("VISIONSET_LIVE_MODEL_REQUEST", request.url());
      }
    });
    page.on("requestfailed", (request) => {
      if (request.url().startsWith("https://models.robomous.ai/")) {
        console.info("VISIONSET_LIVE_MODEL_REQUEST_FAILED", request.url(), request.failure()?.errorText);
      }
    });
    page.on("response", async (response) => {
      if (!response.url().startsWith("https://models.robomous.ai/")) return;
      console.info("VISIONSET_LIVE_MODEL_RESPONSE", response.status(), response.url());
      await response.finished();
      console.info("VISIONSET_LIVE_MODEL_RESPONSE_FINISHED", response.url());
      const timing = response.request().timing();
      const declaredBytes = Number(response.headers()["content-length"] ?? 0);
      const bytes = declaredBytes > 0 ? declaredBytes : (await response.body()).byteLength;
      responses.push({ url: response.url(), bytes, milliseconds: timing.responseEnd });
    });
    await openJobWithBrowserRuntime(page, sent, true, "live");
    await armSuggestTool(page);
    // Registry discovery is deliberately asynchronous and does not block the editor. Wait for
    // its immutable manifest validation before selecting the controlled This device tab; a
    // machine-speed click before the catalog has any target is intentionally a no-op.
    await expect.poll(() => responses.some(({ url }) => url.endsWith("/manifest.json"))).toBe(true);
    const coldStarted = Date.now();
    await acquireAndSelectBrowserTarget(page);
    const coldMilliseconds = Date.now() - coldStarted;
    await makeBrowserSuggestion(page);

    const cacheMeasurements = await page.evaluate(async () => {
      const cache = await caches.open("visionset-browser-models-v1");
      const keys = await cache.keys();
      let bytes = 0;
      let readMilliseconds = 0;
      let shaMilliseconds = 0;
      const lookupStarted = performance.now();
      await Promise.all(keys.map((key) => cache.match(key)));
      const lookupMilliseconds = performance.now() - lookupStarted;
      for (const key of keys) {
        const response = await cache.match(key);
        if (response === undefined) continue;
        const readStarted = performance.now();
        const body = await response.arrayBuffer();
        readMilliseconds += performance.now() - readStarted;
        bytes += body.byteLength;
        const shaStarted = performance.now();
        await crypto.subtle.digest("SHA-256", body);
        shaMilliseconds += performance.now() - shaStarted;
      }
      return { entries: keys.length, bytes, lookupMilliseconds, readMilliseconds, shaMilliseconds };
    });

    const artifactRequests = countModelRequestsFromNow(page);
    const reloadStarted = Date.now();
    await page.reload();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await armSuggestTool(page);
    await expect(page.getByTestId("suggest-device-section").getByText("Ready", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const reloadActivationMilliseconds = Date.now() - reloadStarted;
    expect(artifactRequests()).toBe(0);
    await makeBrowserSuggestion(page);

    console.info("VISIONSET_LIVE_MODEL_SMOKE", JSON.stringify({
      responses,
      coldMilliseconds,
      reloadActivationMilliseconds,
      ...cacheMeasurements,
    }));
  });

  test("an installed model remains usable when registry and artifact routes fail", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, true);
    await armSuggestTool(page);
    await acquireAndSelectBrowserTarget(page);
    await makeBrowserSuggestion(page);

    await page.route("**/models.robomous.ai/registry/v1.json", (route) =>
      route.fulfill({ status: 503, body: "offline fixture" }),
    );
    await page.route("**/models.robomous.ai/**/*.onnx", (route) =>
      route.fulfill({ status: 503, body: "offline fixture" }),
    );
    const artifactRequests = countModelRequestsFromNow(page);
    await page.reload();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await armSuggestTool(page);
    await expect(page.getByTestId("suggest-device-section").getByText(/ready/i)).toBeVisible({ timeout: 60_000 });
    expect(artifactRequests()).toBe(0);
    await makeBrowserSuggestion(page);
    expect(suggestCallsOf(sent)).toHaveLength(0);
  });

  test("Remove from this browser clears artifacts, disposes readiness, and survives reload", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, true);
    await armSuggestTool(page);
    await acquireAndSelectBrowserTarget(page);

    await page.getByTestId("suggest-device-remove-efficient-sam-ti").click();
    await expect(page.getByTestId("suggest-device-acquire-efficient-sam-ti")).toBeVisible();
    expect(await page.evaluate(async () => (await caches.open("visionset-browser-models-v1")).keys().then((keys) => keys.length))).toBe(0);

    const artifactRequests = countModelRequestsFromNow(page);
    await page.reload();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await armSuggestTool(page);
    await expect(page.getByTestId("suggest-device-acquire-efficient-sam-ti")).toBeVisible();
    expect(artifactRequests()).toBe(0);
  });

  test("a persistent storage refusal is reported as session-only readiness", async ({ page }) => {
    await page.addInitScript(() => {
      const nativeOpen = caches.open.bind(caches);
      caches.open = async (name: string): Promise<Cache> => {
        const cache = await nativeOpen(name);
        return {
          add: cache.add.bind(cache),
          addAll: cache.addAll.bind(cache),
          match: cache.match.bind(cache),
          matchAll: cache.matchAll.bind(cache),
          delete: cache.delete.bind(cache),
          keys: cache.keys.bind(cache),
          put: async () => { throw new DOMException("fixture quota", "QuotaExceededError"); },
        };
      };
    });
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, true);
    await armSuggestTool(page);
    await acquireAndSelectBrowserTarget(page);
    await expect(page.getByTestId("suggest-device-session-only")).toBeVisible();
    await makeBrowserSuggestion(page);

    await page.reload();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await armSuggestTool(page);
    await expect(page.getByTestId("suggest-device-acquire-efficient-sam-ti")).toBeVisible();
  });

  test("a ready browser target is never blocked by a server-connection blocker", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, false); // no server connections
    await armSuggestTool(page);
    await expect(page.getByTestId("suggest-no-connections")).toBeVisible();
    await acquireAndSelectBrowserTarget(page);
    await expect(page.getByTestId("suggest-no-connections")).not.toBeVisible();
    const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await expect(page.getByTestId("suggestion-shape")).toBeVisible({ timeout: 30_000 });
  });

  test("the model is never fetched before the user presses Download", async ({ page }) => {
    const sent: Request[] = [];
    // Attached before the page even navigates, so an eager fetch during runtime
    // construction or page load — the most likely regression this test guards
    // against — cannot happen in an unobserved window before this listener exists.
    const modelRequests = countModelRequestsFromNow(page);
    await openJobWithBrowserRuntime(page, sent, true);
    await armSuggestTool(page);
    await expect(page.getByTestId("suggest-idle")).toBeVisible();
    expect(modelRequests()).toBe(0);

    // Merely switching to "This device" — without ever pressing Download — must
    // not fetch anything either. Still idle here, so `suggest-target-browser` and
    // the acquire button are both mounted.
    await page.getByTestId("suggest-target-browser").click();
    await expect(page.getByTestId("suggest-device-acquire-efficient-sam-ti")).toBeVisible();
    expect(modelRequests()).toBe(0);

    // Back to Server, and the original claim: a Server suggestion never touches
    // the model CDN at all.
    await page.getByTestId("suggest-target-server").click();
    const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await expect(page.getByTestId("suggestion-shape")).toBeVisible();
    expect(modelRequests()).toBe(0);
  });

  test("a SHA-256 mismatch on the encoder hard-fails acquisition with no target exposed", async ({ page }) => {
    const sent: Request[] = [];
    // The *correct* byte length with different content: `fetchVerified`
    // (`acquireEfficientSam.ts`) checks size before hashing, so a buffer of the
    // wrong length would fail on the size check and never reach the SHA-256
    // comparison this test is named for.
    const wrongBytes = Buffer.alloc(REAL_ENCODER_BYTE_LENGTH);
    await openJobWithBrowserRuntime(page, sent, true);
    // mockCdn already ran with the real bytes inside openJobWithBrowserRuntime; re-route
    // the encoder specifically — Playwright tries the most-recently-added matching
    // handler first, so this one now answers every encoder.onnx request.
    await page.route("**/models.robomous.ai/models/efficient-sam-ti/**/encoder.onnx", (route) =>
      route.fulfill({ body: wrongBytes, contentType: "application/octet-stream" }),
    );
    await armSuggestTool(page);
    await page.getByTestId("suggest-target-browser").click();
    await page.getByTestId("suggest-device-acquire-efficient-sam-ti").click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("suggest-device-section").getByText(/ready/i)).toHaveCount(0);
    await expect(page.getByTestId("suggest-device-acquire-efficient-sam-ti")).toBeVisible();
  });

  test("two refinements on one asset never re-fetch the model", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, true);
    await armSuggestTool(page);
    await acquireAndSelectBrowserTarget(page);
    const modelRequests = countModelRequestsFromNow(page);
    const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await expect(page.getByTestId("suggestion-shape")).toBeVisible({ timeout: 30_000 });
    await page.mouse.click(picture.x + picture.width / 2 + 10, picture.y + picture.height / 2 + 10);
    await expect(page.getByTestId("suggestion-shape")).toBeVisible({ timeout: 30_000 });
    expect(modelRequests()).toBe(0);
  });

  test("a negative-point ask on the browser target refuses deterministically, with no HTTP and no Server fallback", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, true);
    await armSuggestTool(page);
    await acquireAndSelectBrowserTarget(page);
    const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await expect(page.getByTestId("suggestion-shape")).toBeVisible({ timeout: 30_000 });

    await page.keyboard.down("Alt");
    await page.mouse.click(picture.x + picture.width / 2 + 20, picture.y + picture.height / 2 + 20);
    await page.keyboard.up("Alt");

    // "Refused", not "answered nothing": the executor throws before ever calling the
    // model (`BrowserSuggestionExecutor.ts`), and the panel's refusal card carries its
    // message verbatim, same as a server refusal would.
    await expect(page.getByTestId("suggest-refusal")).toHaveText(/positive-point refinement only/i);

    // The refusal card replaces `TargetChooser` entirely (`SuggestPanel.tsx`'s
    // `status === "refused"` branch), so `suggest-target-browser` isn't mounted at
    // this instant — asserting on it here would fail on a missing element, not a
    // real regression. Escape (`discardSuggestion` → `cleared`, since a refused
    // session always `hasPending`) drops the session back to idle, which remounts
    // the chooser without touching `activeTarget` — the fact this is actually
    // proving no silent fallback to Server.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("suggest-target-browser")).toHaveAttribute("aria-selected", "true");
    expect(suggestCallsOf(sent)).toHaveLength(0);
  });
});
