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
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Request } from "@playwright/test";
import { openJob } from "./_wireApiStub";

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

/** Routes the CDN manifest + artifacts to the local fixture — no network call ever leaves the page. */
async function mockCdn(page: Page, encoderBytes = ENCODER_BYTES, decoderBytes = DECODER_BYTES): Promise<void> {
  await page.route("**/models.robomous.ai/models/efficient-sam-ti/**/manifest.json", (route) =>
    route.fulfill({ json: { encoder: { path: "/encoder.onnx" }, decoder: { path: "/decoder.onnx" } } }),
  );
  await page.route("**/models.robomous.ai/encoder.onnx", (route) =>
    route.fulfill({ body: encoderBytes, contentType: "application/octet-stream" }),
  );
  await page.route("**/models.robomous.ai/decoder.onnx", (route) =>
    route.fulfill({ body: decoderBytes, contentType: "application/octet-stream" }),
  );
}

async function openJobWithBrowserRuntime(
  page: Page,
  sent: Request[],
  suggestible: boolean,
): Promise<void> {
  await mockCdn(page);
  await openJob(page, sent, undefined, undefined, undefined, undefined, suggestible);
}

function suggestCallsOf(sent: Request[]): Request[] {
  return sent.filter((r) => r.method() === "POST" && r.url().endsWith("/inference/suggest"));
}

/**
 * Counts requests to the model CDN from here on — via `page.on("request", ...)`
 * rather than a second `page.route`, so it never interferes with `mockCdn`'s own
 * fulfil handlers (a later-added `page.route` for the same pattern would run first
 * and could shadow them).
 */
function countModelRequestsFromNow(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (request.url().includes("models.robomous.ai")) count += 1;
  });
  return () => count;
}

/**
 * Clicks into the "This device" tab and downloads the model, then waits for the
 * real "ready" signal: `DeviceTab` swaps the acquire button for a `Badge` reading
 * "Ready" once `listTargets()` answers non-empty (`SuggestPanel.tsx`). There is no
 * separate target-selection control to click — Phase F ships exactly one browser
 * target, and choosing the tab already set it as the active suggestion target.
 */
async function acquireAndSelectBrowserTarget(page: Page): Promise<void> {
  await page.getByTestId("tool-suggest").click();
  await page.getByTestId("suggest-target-browser").click();
  await page.getByTestId("suggest-device-acquire-efficient-sam-ti").click();
  await expect(page.getByTestId("suggest-device-section").getByText(/ready/i)).toBeVisible({ timeout: 60_000 });
}

test.describe("browser suggestion", () => {
  test.skip(!HAS_ARTIFACTS, MISSING_MESSAGE);

  test("Server target: a click issues exactly one /inference/suggest HTTP request", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, true);
    await page.getByTestId("tool-suggest").click();
    await expect(page.getByTestId("suggest-idle")).toBeVisible();
    const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await expect(page.getByTestId("suggestion-shape")).toBeVisible();
    expect(suggestCallsOf(sent)).toHaveLength(1);
  });

  test("This device target: a click never issues an /inference/suggest HTTP request", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, true);
    await acquireAndSelectBrowserTarget(page);
    const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await expect(page.getByTestId("suggestion-shape")).toBeVisible({ timeout: 30_000 });
    expect(suggestCallsOf(sent)).toHaveLength(0);
  });

  test("a ready browser target is never blocked by a server-connection blocker", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, false); // no server connections
    await page.getByTestId("tool-suggest").click();
    await expect(page.getByTestId("suggest-no-connections")).toBeVisible();
    await acquireAndSelectBrowserTarget(page);
    await expect(page.getByTestId("suggest-no-connections")).not.toBeVisible();
    const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await expect(page.getByTestId("suggestion-shape")).toBeVisible({ timeout: 30_000 });
  });

  test("the model is never fetched before the user presses Download", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, true);
    const modelRequests = countModelRequestsFromNow(page);
    await page.getByTestId("tool-suggest").click();
    const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await expect(page.getByTestId("suggestion-shape")).toBeVisible();
    expect(modelRequests()).toBe(0);
  });

  test("a SHA-256 mismatch on the encoder hard-fails acquisition with no target exposed", async ({ page }) => {
    const sent: Request[] = [];
    const wrongBytes = Buffer.from("not the real encoder, deliberately wrong length and hash");
    await openJobWithBrowserRuntime(page, sent, true);
    // mockCdn already ran with the real bytes inside openJobWithBrowserRuntime; re-route
    // the encoder specifically — Playwright tries the most-recently-added matching
    // handler first, so this one now answers every encoder.onnx request.
    await page.route("**/models.robomous.ai/encoder.onnx", (route) =>
      route.fulfill({ body: wrongBytes, contentType: "application/octet-stream" }),
    );
    await page.getByTestId("tool-suggest").click();
    await page.getByTestId("suggest-target-browser").click();
    await page.getByTestId("suggest-device-acquire-efficient-sam-ti").click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("suggest-device-section").getByText(/ready/i)).toHaveCount(0);
    await expect(page.getByTestId("suggest-device-acquire-efficient-sam-ti")).toBeVisible();
  });

  test("two refinements on one asset never re-fetch the model", async ({ page }) => {
    const sent: Request[] = [];
    await openJobWithBrowserRuntime(page, sent, true);
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
    // Still on the browser tab — a refusal never silently falls back to Server.
    await expect(page.getByTestId("suggest-target-browser")).toHaveAttribute("aria-selected", "true");
    expect(suggestCallsOf(sent)).toHaveLength(0);
  });
});
