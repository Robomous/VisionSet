import { expect, test, type Page } from "@playwright/test";

import { HELPERS, MANIFEST, serveInsecure } from "./_support.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/browser/harness.html");
});

function inspect(page: Page, file: string) {
  return page.evaluate(
    async ([helpers, name]) => {
      const h = await import(helpers);
      return (await h.materializer()).inspect(await h.fixture(name));
    },
    [HELPERS, file] as const,
  );
}

for (const fixture of MANIFEST.clips) {
  test(`inspect reports ${fixture.file} as it was encoded`, async ({ page }) => {
    const rotated = fixture.rotation === 90 || fixture.rotation === 270;
    expect(await inspect(page, fixture.file)).toMatchObject({
      fileName: fixture.file,
      container: fixture.container,
      codec: fixture.codec,
      // Display dimensions, so a rotated track reports the frame the way it is seen.
      displayWidth: rotated ? fixture.height : fixture.width,
      displayHeight: rotated ? fixture.width : fixture.height,
      rotation: fixture.rotation,
      decodable: true,
    });
  });
}

test("inspect measures duration and source frame rate", async ({ page }) => {
  const inspection = await inspect(page, "vp8.webm");
  expect(inspection.durationSeconds).toBeCloseTo(MANIFEST.frames / MANIFEST.fps, 3);
  expect(inspection.sourceFps).toBeCloseTo(MANIFEST.fps, 1);
  expect(inspection.refusal).toBeUndefined();
});

test("a file that is not a container is refused, whatever it is called", async ({ page }) => {
  expect(await inspect(page, "garbage.webm")).toMatchObject({
    fileName: "garbage.webm",
    refusal: "unparsable-container",
    decodable: false,
  });
});

test("an insecure origin has no WebCodecs, and that is a refusal not a crash", async ({ page }) => {
  await page.goto(await serveInsecure(page));
  // `OffscreenCanvas` survives an insecure origin; WebCodecs does not, and one missing
  // primitive is enough — which is exactly the situation the refusal is for.
  expect(
    await page.evaluate(() => ({
      secure: window.isSecureContext,
      decoder: typeof VideoDecoder,
      encoder: typeof VideoEncoder,
    })),
  ).toEqual({ secure: false, decoder: "undefined", encoder: "undefined" });

  const inspection = await page.evaluate(async () => {
    const adapter = "/dist/mediabunny/index.js";
    const { MediabunnyVideoMaterializer } = await import(adapter);
    return new MediabunnyVideoMaterializer().inspect({ name: "vp8.webm" });
  });
  expect(inspection).toMatchObject({ fileName: "vp8.webm", refusal: "unsupported-browser" });
});

test("an abort during inspection ends it, and takes the worker with it", async ({ page }) => {
  // Reading a container is not free — duration and frame-rate metrics can walk the
  // whole thing — so a signal that is only read once, at the door, is a signal the
  // caller cannot actually back out with.
  const outcome = await page.evaluate(async (helpers) => {
    const h = await import(helpers);
    const controller = new AbortController();
    const run = (await h.materializer()).inspect(await h.fixture("vp8.webm"), controller.signal);
    controller.abort();
    return run.then(
      () => "resolved",
      (error: Error) => error.message,
    );
  }, HELPERS);
  expect(outcome).toBe("inspection aborted");
  await expect.poll(() => page.workers().length).toBe(0);
});

test("a signal that never fires leaves inspection alone", async ({ page }) => {
  const inspection = await page.evaluate(async (helpers) => {
    const h = await import(helpers);
    return (await h.materializer()).inspect(
      await h.fixture("vp8.webm"),
      new AbortController().signal,
    );
  }, HELPERS);
  expect(inspection).toMatchObject({ fileName: "vp8.webm", decodable: true });
});
