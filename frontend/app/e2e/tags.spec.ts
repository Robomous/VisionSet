/**
 * Classification tags: the tool with no canvas, and the uniqueness the kernel does
 * not keep.
 *
 * v1 had nothing like this. The scenarios matter because #45 found that
 * `AnnotationService._validate` judges an annotation against the pinned schema alone
 * and never reads the store, `AnnotationRow` carries no unique index, and nothing
 * deduplicates — so **the kernel enforces no `(asset, class)` uniqueness for a
 * classification tag** (filed as #121). The annotator holds it structurally instead:
 * an already-tagged `tagCommand` returns a command that changes nothing, `CommandLog`
 * records nothing when the document did not move, and `mint` is never reached, so no
 * second tag can exist and no id is burned.
 *
 * "No second tag can exist" is a claim about a payload, so it is checked against the
 * payload — `wire`, the projection a host would actually send.
 */

import { expect, test } from "@playwright/test";

import { drawBbox, expectCounts, focusCanvas, frameOf, wire, SHOWCASE } from "./_frame";

test.beforeEach(async ({ page }) => {
  await page.goto(SHOWCASE);
});

test("a tag is checked and cleared from the panel, and never drawn on the canvas", async ({
  page,
}) => {
  await frameOf(page);
  const daytime = page.getByTestId("tag-daytime");
  await expect(daytime).not.toBeChecked();

  await daytime.click();
  await expect(daytime).toBeChecked();
  await expectCounts(page, 1, 0);
  // A whole-asset tag carries no coordinates, so nothing renders in either layer.
  await expect(page.getByTestId("annotation-layer").locator("[data-annotation-id]")).toHaveCount(0);

  await daytime.click();
  await expect(daytime).not.toBeChecked();
  await expectCounts(page, 0, 0);
});

/**
 * The palette row for a taggable class toggles the tag rather than activating a
 * tool, and that split is structural rather than cosmetic. `toolFor` answers
 * `select` for a tag class, so folding `toggle-tag` into `activate-class` would emit
 * `tool-changed` — which **every** drag row in the machine answers with a cancel.
 * Tagging halfway through drawing a polygon would destroy it.
 *
 * So: place two vertices, tag from the palette, and finish the polygon.
 */
test("tagging mid-draw does not destroy the polygon being drawn", async ({ page }) => {
  const frame = await frameOf(page);
  await focusCanvas(page);
  await page.keyboard.press("2");

  await page.mouse.click(frame.at(500, 330).x, frame.at(500, 330).y);
  await page.mouse.click(frame.at(430, 470).x, frame.at(430, 470).y);

  await page.getByTestId("class-daytime").click();
  await expect(page.getByTestId("tag-daytime")).toBeChecked();

  await page.mouse.click(frame.at(570, 470).x, frame.at(570, 470).y);
  await page.keyboard.press("Enter");

  // Two annotations: the tag, and the polygon the tag did not interrupt.
  await expectCounts(page, 2, 1);
  const payload = await wire(page);
  expect(payload.map((row) => row.label_class).sort()).toEqual(["daytime", "lane"]);
});

/**
 * The uniqueness the kernel does not enforce, held here instead.
 *
 * Clicking the palette row and the checkbox are two different controls reaching the
 * same `toggleTagCommand`; neither can produce a second `daytime`. The history is
 * the sharper half of the claim — an identity command still goes through
 * `store.execute`, but `CommandLog` records nothing when `after === before`, so a
 * redundant tag leaves no entry to undo.
 */
test("a class can carry at most one tag, however many times it is asked for", async ({ page }) => {
  await frameOf(page);

  await page.getByTestId("tag-daytime").click();
  await page.getByTestId("class-daytime").click();
  await page.getByTestId("class-daytime").click();
  await page.getByTestId("tag-daytime").click();
  await page.getByTestId("class-daytime").click();

  const payload = await wire(page);
  expect(payload.filter((row) => row.label_class === "daytime")).toHaveLength(1);
  await expect(page.getByTestId("tag-daytime")).toBeChecked();

  // One undo returns to untagged, because the redundant asks recorded nothing.
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("tag-daytime")).not.toBeChecked();
});

/**
 * Only a `classification_tag` class gets a checkbox — the predicate matches on the
 * **geometry**, never on the class name. `sampleSchema.ts` has one of each other
 * kind, so the negative half is real rather than vacuous.
 */
test("only the taggable class has a tag control", async ({ page }) => {
  await frameOf(page);

  await expect(page.getByTestId("tag-daytime")).toBeVisible();
  for (const name of ["vehicle", "lane", "pedestrian", "centerline"]) {
    await expect(page.getByTestId(`tag-${name}`)).toHaveCount(0);
  }
});

/**
 * Pasting a tag the asset already carries (#123), which is the deferral's fourth
 * reason and the one that changed while it waited.
 *
 * It used to read *"the kernel does not enforce this"*; **#121 closed**, so the
 * kernel now refuses a duplicate outright with `DuplicateClassificationTag`. That
 * makes the local rule matter more rather than less: without it a paste would
 * look like it worked and the whole save would refuse minutes later, blaming an
 * index. So a duplicating entry is dropped here, the way `tagCommand` makes a
 * second tag unrepresentable rather than refusing one — and a paste whose every
 * entry was such a tag records no history entry at all.
 */
test("pasting a tag the asset already carries adds nothing and records nothing", async ({
  page,
}) => {
  const frame = await frameOf(page);
  await page.getByTestId("tag-daytime").click();
  await drawBbox(page, frame, { x: 400, y: 240 }, { x: 700, y: 440 });
  await expectCounts(page, 2, 1);

  // The tag is selectable from the object list even though it is never under the
  // pointer — which is the only way a copy can pick one up. If this click missed,
  // the box would still be selected and the paste below would duplicate *it*.
  await page.getByTestId("object-select-0").click();
  await focusCanvas(page);
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");

  await expectCounts(page, 2, 1);
  const payload = await wire(page);
  expect(payload.filter((row) => row.label_class === "daytime")).toHaveLength(1);

  // No entry to unwind: one undo takes back the box, not a paste. The tag is
  // still selected afterwards, because `selection.ts` filters on read and the
  // tag is the thing the copy picked up.
  await page.keyboard.press("ControlOrMeta+z");
  await expectCounts(page, 1, 1);
  await expect(page.getByTestId("tag-daytime")).toBeChecked();
});

test("a tag and a drawn shape coexist, and undo unwinds them in order", async ({ page }) => {
  const frame = await frameOf(page);
  await page.getByTestId("tag-daytime").click();
  await drawBbox(page, frame, { x: 400, y: 240 }, { x: 700, y: 440 });
  await expectCounts(page, 2, 1);

  await page.keyboard.press("ControlOrMeta+z");
  await expectCounts(page, 1, 0);
  await expect(page.getByTestId("tag-daytime")).toBeChecked();

  await page.keyboard.press("ControlOrMeta+z");
  await expectCounts(page, 0, 0);
  await expect(page.getByTestId("tag-daytime")).not.toBeChecked();
});
