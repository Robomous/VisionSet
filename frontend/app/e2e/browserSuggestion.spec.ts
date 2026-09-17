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

/**
 * The real encoder's byte length, from `manifest.ts`'s `EFFICIENT_SAM_TI_EXPECTED.
 * encoder.bytes` — kept as a literal rather than imported, because that module
 * reads `import.meta.env` at module scope, which only exists under Vite's own
 * transform and would throw under this suite's plain Node/tsx loader.
 */
const REAL_ENCODER_BYTE_LENGTH = 24_799_777;

/** Routes the CDN manifest + artifacts to the local fixture — no network call ever leaves the page. */
async function mockCdn(page: Page, encoderBytes = ENCODER_BYTES, decoderBytes = DECODER_BYTES): Promise<void> {
  // Registered first, so it is matched *last* (Playwright tries the most-recently-added
  // handler first): anything at this host the three specific routes below don't
  // recognise is hard-aborted rather than silently reaching the real CDN — including if
  // `VITE_MODEL_CDN_BASE_URL` or the manifest layout ever drifts out from under this stub.
  await page.route("**/models.robomous.ai/**", (route) => route.abort());
  // The real, live manifest shape (fixed in manifest.ts/acquireEfficientSam.ts after a
  // production incident): artifacts nest under `artifacts`, and each `path` is a bare
  // filename resolved relative to the manifest's own revision directory — never a
  // leading-slash, top-level path.
  await page.route("**/models.robomous.ai/models/efficient-sam-ti/**/manifest.json", (route) =>
    route.fulfill({ json: { artifacts: { encoder: { path: "encoder.onnx" }, decoder: { path: "decoder.onnx" } } } }),
  );
  await page.route("**/models.robomous.ai/models/efficient-sam-ti/**/encoder.onnx", (route) =>
    route.fulfill({ body: encoderBytes, contentType: "application/octet-stream" }),
  );
  await page.route("**/models.robomous.ai/models/efficient-sam-ti/**/decoder.onnx", (route) =>
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
 * and could shadow them). Attach before whatever moment must not fetch, since a
 * listener added after the fact cannot see what already happened.
 */
function countModelRequestsFromNow(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (request.url().includes("models.robomous.ai")) count += 1;
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
  await expect(page.getByTestId("suggest-device-section").getByText(/ready/i)).toBeVisible({ timeout: 60_000 });
}

test.describe("browser suggestion", () => {
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
