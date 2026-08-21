/**
 * The design system, in a browser — the half of its contract no unit test can
 * reach.
 *
 * `tokens.test.ts` proves `styles.css` and `tokens.ts` agree, and
 * `primitives.test.tsx` proves each component behaves. Neither proves the thing
 * that actually breaks: **that the class strings become CSS.** `ui-core` ships as
 * `tsc` output, so its utilities exist only if the consuming app's Tailwind build
 * scans the package's sources — a missing `@source` produces a page that compiles,
 * mounts, renders every element and is completely unstyled, with nothing failing
 * anywhere. Reading a computed colour back out of a real browser is the only
 * check for that.
 *
 * Deliberately small. This is not a visual-regression suite; it is four questions
 * about the wiring, and it runs inside the existing `annotator e2e (chromium)` job
 * rather than paying for one of its own.
 *
 * ## Reading a colour back, since the shadcn preset foundation
 *
 * Every semantic token here is authored in `oklch()`. Chromium's computed style
 * reports an `oklch()`-authored colour as an `oklch(...)`/`oklab(...)` string —
 * not `rgb(...)` — so `toHaveCSS("background-color", "rgb(...)")` against one of
 * these elements fails on format even when the colour is right. `channelsOf`
 * below sidesteps the serialisation: a 1×1 canvas is the browser's own
 * conversion of *any* valid CSS colour into the four 0–255 bytes it actually
 * paints, so the constants below are plain sRGB byte tuples rather than colour
 * strings.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

/** A CSS colour, read back as the sRGB bytes it actually paints. See header. */
async function channelsOf(page: Page, colour: string): Promise<readonly number[]> {
  return page.evaluate((value) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  }, colour);
}

/** `getComputedStyle(locator, ...)[prop]`, normalised through `channelsOf`. */
async function rgbaOf(page: Page, locator: Locator, prop: string): Promise<readonly number[]> {
  const raw = await locator.evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), prop);
  return channelsOf(page, raw);
}

/**
 * A computed `box-shadow`, split into its layers at the top-level commas.
 *
 * Nova's focus ring is a `box-shadow` rather than an outline (`ring-3`), and
 * Tailwind v4 composes every shadow-ish utility into that **one** property through
 * five variables — inset shadow, inset ring, ring offset, ring, drop shadow — each
 * with a transparent `0 0 #0000` initial value. So a control wearing a ring *and*
 * `shadow-sm` computes to six comma-separated layers, three of them placeholders,
 * and the ring is not the first of them. Reading it back means picking a layer out
 * of a list.
 *
 * The split is paren-aware because `rgba(0, 0, 0, 0)` — which is exactly what the
 * three placeholder layers serialise as — has commas inside it, so a plain
 * `split(",")` cuts every layer into pieces.
 */
async function shadowLayersOf(locator: Locator): Promise<readonly string[]> {
  return locator.evaluate((node) => {
    const raw = getComputedStyle(node).boxShadow;
    const layers: string[] = [];
    let depth = 0;
    let start = 0;
    for (let at = 0; at < raw.length; at += 1) {
      const ch = raw[at];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === "," && depth === 0) {
        layers.push(raw.slice(start, at).trim());
        start = at + 1;
      }
    }
    layers.push(raw.slice(start).trim());
    return layers;
  });
}

/** The geometry Nova's ring paints: no offset, no blur, 3px of spread. */
const RING_GEOMETRY = "0px 0px 0px 3px";

/**
 * The colour of the 3px ring layer in `locator`'s `box-shadow`, as painted bytes.
 *
 * The layer is found by its *geometry* rather than by its position, and that is
 * half the assertion: a ring that lost its spread — or a control that never got
 * one — is not found at all and this throws rather than passing on a shadow that
 * happens to be there for another reason.
 */
async function ringColourOf(page: Page, locator: Locator): Promise<readonly number[]> {
  const layers = await shadowLayersOf(locator);
  const ring = layers.find((layer) => layer.endsWith(RING_GEOMETRY));
  if (ring === undefined) {
    throw new Error(`no ${RING_GEOMETRY} ring in box-shadow: ${JSON.stringify(layers)}`);
  }
  return channelsOf(page, ring.slice(0, ring.length - RING_GEOMETRY.length).trim());
}

/** `--color-primary` — the preset's own near-black neutral, `oklch(0.205 0 0)`. */
const PRIMARY = [23, 23, 23];
/** `--color-brand` — the coral, `oklch(0.653 0.178 32.3)`. Identity only; it
 * belongs to exactly two elements (the wordmark, its styleguide swatch) and
 * must never be what a functional control is wearing. */
const BRAND = [232, 93, 68];
/** `--color-foreground`, `oklch(0.145 0 0)`. */
const INK = [10, 10, 10];
/** `--color-muted`, `oklch(0.97 0 0)` — the hover/focus fill and the progress track. */
const MUTED = [245, 245, 245];
/** `--color-background`, `oklch(1 0 0)` — pure white in this preset (unlike the
 * previous foundation, `background` and `card` are no longer distinguishable
 * from each other by value). */
const BACKGROUND = [255, 255, 255];
/** `--color-ring`, `oklch(0.708 0 0)`, before the base layer's `/50` opacity. */
const RING = [161, 161, 161];

test.beforeEach(async ({ page }) => {
  await page.goto("/styleguide");
});

test("the token utilities reach the browser as the contract's values", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("VisionSet design system");

  // If Tailwind never saw `ui-core`'s sources, `bg-primary` is not a rule and this
  // element is transparent — which is exactly what a missing `@source` looks like.
  const filled = page.getByTestId("button-primary");
  expect(await rgbaOf(page, filled, "background-color")).toEqual([...PRIMARY, 255]);
  const heading = page.getByRole("heading", { level: 1 });
  expect(await rgbaOf(page, heading, "color")).toEqual([...INK, 255]);
});

/**
 * The palette's actual claim, and the only place a browser can check it.
 *
 * Before this foundation the claim was "the brand is on the progress bar and
 * nowhere near the primary button" — the palette's whole point was that a
 * functional fill was never the identity colour. Task 5 of the shadcn preset
 * rewrite changed the *premise*, not just the value: the progress indicator is
 * now `bg-primary` (`ui-core/src/primitives/Feedback.tsx`), the same functional
 * colour as the primary button, and `brand` dropped to exactly two call sites —
 * the wordmark and its styleguide swatch — neither of which is this page's
 * progress bar. So the claim this test can still make, and the one worth
 * keeping, is the same shape turned around: the fill matches the button
 * (both `primary`) and neither matches `brand`. A revert that pointed the
 * indicator back at `brand` would satisfy every unit test in the repository
 * and fail here.
 */
test("the progress fill wears the functional primary colour, not the brand", async ({ page }) => {
  const filled = page.getByTestId("button-primary");
  const filledRgb = await rgbaOf(page, filled, "background-color");
  expect(filledRgb.slice(0, 3)).toEqual(PRIMARY);

  // Radix's indicator is the fill inside the track; the track itself is `muted`.
  const bar = page.getByRole("progressbar").first();
  const trackRgb = await rgbaOf(page, bar, "background-color");
  const indicator = bar.locator("> *").first();
  const indicatorRgb = await rgbaOf(page, indicator, "background-color");

  expect(indicatorRgb).toEqual(filledRgb);
  expect(indicatorRgb.slice(0, 3)).not.toEqual(BRAND);
  expect(trackRgb.slice(0, 3)).toEqual(MUTED);
});

/**
 * The base layer's wiring, seen from a rendered page — turned around from the
 * previous foundation's version of this test.
 *
 * The old contract fixed a single body font-size (14px) and line-height in
 * `@layer base`, so every screen inherited one rhythm without asking. The
 * shadcn preset does not: typography is Tailwind's ordinary scale, applied per
 * element (`DESIGN.md`, *Typography* and *Density and Spacing*), and the base
 * layer's job shrank to three things — `html` gets `font-sans` (Inter), `h1`–`h4`
 * get `font-heading` (Geist) and `body` gets `bg-background`/`text-foreground`.
 * Those three are what this now asserts; a body-wide font-size is no longer
 * part of the claim because it is no longer part of the contract.
 */
test("the base layer wires fonts and background, not a per-screen font-size", async ({ page }) => {
  const body = page.locator("body");
  const heading = page.getByRole("heading", { level: 1 });

  const bodyFont = await body.evaluate((node) => getComputedStyle(node).fontFamily);
  const headingFont = await heading.evaluate((node) => getComputedStyle(node).fontFamily);
  const bodyBg = await rgbaOf(page, body, "background-color");

  // `html { @apply font-sans }` — every screen, not a class on each page.
  expect(bodyFont).toContain("Inter");
  // `h1`–`h4` carry `font-heading` in the base layer, so a heading never repeats it.
  expect(headingFont).toContain("Geist");
  // `body { @apply bg-background }` — the preset's own white, applied once.
  expect(bodyBg.slice(0, 3)).toEqual(BACKGROUND);
});

/**
 * The bug `cn.ts` documents, seen from the far end.
 *
 * `tailwind-merge` read `text-sm` as a colour and dropped it, so every field in
 * the package rendered at the browser's default size instead of the contract's.
 * `cn.test.ts` pins the merge; this pins the pixels, because the two failures look
 * nothing alike from the outside.
 */
test("a merged font size survives to the rendered element", async ({ page }) => {
  await expect(page.getByLabel("Project name")).toHaveCSS("font-size", "14px");
});

/** Radix owns the overlay behaviour; this is the proof it is actually wired. */
test("a dialog traps focus, closes on Escape and returns focus to its trigger", async ({ page }) => {
  const trigger = page.getByTestId("open-dialog");
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName("Delete highway-survey?");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

/**
 * The tab bar's actual claim, which is a claim about pixels.
 *
 * `primitives.test.tsx` asserts the *meaning* — `aria-selected`, `data-state`, one
 * panel in the tree — and deliberately matches no class string, so it would stay
 * green through a restyle that made all three tabs look identical. The difference
 * between an active tab and an inactive one is a computed colour, and jsdom
 * computes nothing from a stylesheet. This is where that is checked.
 *
 * What that difference *is* moved with Nova: `TabsList`'s default is a **segmented
 * control**, not an underlined row. The list is a `muted` trough and the active tab
 * is a `background` chip lifted out of it on a hairline shadow, so the active
 * claim is a fill plus a shadow rather than a `border-bottom-color`. The inactive
 * claim is untouched and reads stronger for it: "no fill, no shadow" is now
 * exactly the pair the active tab has, rather than the absence of an underline.
 */
test("the active tab is lifted out of the trough and an inactive one wears no chrome", async ({
  page,
}) => {
  const bar = page.getByTestId("tabs-segmented");
  const open = bar.getByRole("tab", { name: "Batches" });
  const shut = bar.getByRole("tab", { name: "About" });

  // The trough the chip is lifted out of. A list that were `background` too would
  // leave the segmented control with no shape at all — the raised tab and the
  // surface behind it would be the same colour.
  const list = bar.getByRole("tablist");
  expect((await rgbaOf(page, list, "background-color")).slice(0, 3)).toEqual(MUTED);

  expect((await rgbaOf(page, open, "background-color")).slice(0, 3)).toEqual(BACKGROUND);
  // `shadow-sm`, and it is the second half of "lifted": the fill alone would read
  // as a flat swap on a page whose own background is the same white.
  expect(await open.evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe("none");

  // The report's complaint, inverted into an assertion: no fill, no border, no
  // shadow. An inactive tab must not read as a button somebody has not pressed.
  // `transparent` is a keyword, not an `oklch()` value, so Chromium still
  // serialises it as `rgba(0, 0, 0, 0)` — no `channelsOf` needed here.
  await expect(shut).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
  await expect(shut).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(shut).toHaveCSS("box-shadow", "none");

  await shut.click();
  // `transition-all` animates the new fill in rather than snapping it, so a bare
  // read-once-and-compare can catch the colour mid-transition — Chromium did,
  // occasionally, in the gate. `expect.poll` retries `rgbaOf` the same way
  // `toHaveCSS` retries its own read, so the assertion waits out the animation
  // instead of racing it.
  await expect
    .poll(async () => (await rgbaOf(page, shut, "background-color")).slice(0, 3))
    .toEqual(BACKGROUND);
  // And the chrome moved rather than accumulating: the tab that was raised is
  // back down in the trough, fill and shadow both.
  await expect(open).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(open).toHaveCSS("box-shadow", "none");
});

/**
 * Focus, now that the primitive owns it.
 *
 * `styles.css` used to carry a blanket `:focus-visible { @apply outline-2; }` —
 * a stylesheet-level floor, there because the tab bar had no ring of its own and
 * the alternative was the browser's native 1px `outline-style: auto`. That rule is
 * gone (`DESIGN.md`, *Borders and Focus*): every focusable primitive supplies
 * Nova's ring itself, so what is asserted here is the *component's* treatment,
 * which is also why this reads `1px` where it used to read `2px`. Delete the ring
 * from `TabsTrigger` and nothing global catches it any more — which is the whole
 * point of measuring it here.
 */
test("focus on a tab is Nova's own ring, not a stylesheet-wide floor", async ({ page }) => {
  // Arrive by keyboard, because `:focus-visible` is the point — and from the last
  // focusable before the bar, so this is one press rather than a hunt.
  await page.getByLabel("Description").focus();
  await page.keyboard.press("Tab");

  const focused = page.getByTestId("tabs-segmented").getByRole("tab", { name: "Batches" });
  await expect(focused).toBeFocused();

  // `focus-visible:ring-[3px] focus-visible:ring-ring/50` — a box-shadow, painted
  // *outside* the box, so it survives whichever fill is underneath it.
  const ring = await ringColourOf(page, focused);
  // The ring token's own grey — a canvas's RGB read-back is unpremultiplied,
  // so the colour channels come back exact regardless of the alpha below.
  expect(ring.slice(0, 3)).toEqual(RING);
  // …at partial opacity, which is what the `/50` modifier promises: fully opaque
  // would be a different rule, and fully transparent would be no ring at all.
  expect(ring[3]).toBeGreaterThan(64);
  expect(ring[3]).toBeLessThan(220);

  // The 1px hairline `TabsTrigger` adds on top of the ring, in the same token at
  // full strength (`focus-visible:outline-1 focus-visible:outline-ring`). The
  // *colour* still comes from the base layer's `outline-ring/50` on every element;
  // the width and the full-strength colour are the primitive's.
  await expect(focused).toHaveCSS("outline-width", "1px");
  expect((await rgbaOf(page, focused, "outline-color")).slice(0, 3)).toEqual(RING);
  // And the border joins in (`focus-visible:border-ring`), which is the same
  // three-part treatment `Button`, `Input` and `SelectTrigger` wear — one focus
  // idiom, so a keyboard user reads the same thing everywhere.
  expect((await rgbaOf(page, focused, "border-bottom-color")).slice(0, 3)).toEqual(RING);

  // Focus decorates the active tab rather than replacing it: the chip is still
  // lifted onto `background` underneath the ring.
  expect((await rgbaOf(page, focused, "background-color")).slice(0, 3)).toEqual(BACKGROUND);
});

test("the class palette draws the schema's colour and the derived hue side by side", async ({
  page,
}) => {
  // The acceptance criterion "one spelling", made visible: `vehicle` declares
  // `#38bdf8` and `pedestrian` declares nothing, so the second must still get a
  // colour and it must not be the first one's.
  const swatches = page.getByTestId("class-palette").locator("span[aria-hidden]");
  await expect(swatches).toHaveCount(4);

  // These are schema-authored (`#38bdf8`) or hash-derived (`hsl(...)`) colours,
  // not preset tokens — legacy colour functions, so Chromium still normalises
  // them to `rgb(...)` and a plain string compare is exactly right.
  const colours = await swatches.evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).backgroundColor),
  );
  expect(colours[0]).toBe("rgb(56, 189, 248)");
  expect(new Set(colours).size).toBe(4);
});

/**
 * One rule owns the space between a tab bar and its content.
 *
 * That rule is now the `Tabs` **root**'s `gap-2` — 8px, Nova's own — rather than
 * the `mt-3` `TabsContent` used to bake in, and a consumer still adds no gap of its
 * own. The direction of the move matters more than the number: a margin on the
 * panel is a declaration two elements have to agree about (and did not, which is
 * how the doubling this test was written for happened), while a gap on the root is
 * the container spacing its own children once.
 *
 * Measured here as well as on the real screen, because the styleguide is where the
 * bar is looked at in isolation and a regression would be seen first.
 */
test("the tab bar sits one rhythm step above its content", async ({ page }) => {
  await page.goto("/styleguide");

  const scope = page.getByTestId("tabs-segmented");
  const list = await scope.locator('[role="tablist"]').boundingBox();
  const panel = await scope.locator('[role="tabpanel"][data-state="active"]').boundingBox();
  expect(list).not.toBeNull();
  expect(panel).not.toBeNull();
  expect(panel!.y - (list!.y + list!.height)).toBeCloseTo(8, 0);
});

/**
 * The two-line option's claim, which is a claim about pixels.
 *
 * `primitives.test.tsx` asserts the *structure* — two elements, the meta in the
 * muted role, the id keeping its own line — and jsdom computes no layout, so the
 * one thing it cannot see is the thing that was reported: a two-line value inside
 * a control measured for one line. A revert to a fixed height leaves every unit
 * test green and fails here.
 *
 * The one-line number is Nova's control height, 32px, and it is asserted twice:
 * against the constant, and against the `Input` in the same field row. The second
 * is the one that catches the interesting failure — `SelectTrigger` is `min-h-8`
 * rather than `h-8` so the second line can grow it, and a *minimum* height is one
 * the padding can quietly overshoot. A trigger standing taller than the text field
 * beside it is a broken row whatever the absolute number turns out to be.
 */
test("a two-line option grows its trigger, and a one-line one is Nova's 32px", async ({
  page,
}) => {
  const plain = await page.getByLabel("Geometry").boundingBox();
  const stacked = await page.getByLabel("Model").boundingBox();
  const field = await page.getByLabel("Project name").boundingBox();
  expect(plain).not.toBeNull();
  expect(stacked).not.toBeNull();
  expect(field).not.toBeNull();

  // Nova's own control height: `min-h-8`, and the padding does not overshoot it.
  expect(plain!.height).toBeCloseTo(32, 0);
  // The same height as the `Input` beside it, which is what the field row reads as.
  expect(plain!.height).toBeCloseTo(field!.height, 0);
  // Grown, not squashed: the second line is inside the box rather than over it.
  expect(stacked!.height).toBeGreaterThan(plain!.height);

  // And the identifier is whole — no ellipsis, no clipped end.
  const id = page.getByLabel("Model").locator("span", { hasText: "facebook/sam2.1-hiera-base-plus" }).first();
  await expect(id).toHaveCSS("text-overflow", "clip");
});
