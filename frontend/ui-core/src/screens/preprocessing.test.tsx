/**
 * Recipes: a project resource chosen in a release's Export section and written
 * in a modal dialog over the page, on one page: the name and the model, the
 * controls (resize, augmentation), and what they make for the release.
 *
 * Three parts. `recipeDraft` is pure and holds the rules a form restates — the
 * hints preselecting only untouched fields, the body's bounds, the cross-field
 * constraints — so those are asserted without a DOM. The editor's own rules
 * (its fields, drawings, info cards, preview, counts, saving and discarding) are driven
 * through `RecipeDialog` in a minimal host. The entry points — where a recipe
 * is chosen, created, edited and deleted — are driven through the real
 * Dataset page and a release's Export section. Both go through a stubbed wire
 * and assert what a person sees and what the server was sent.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useRef, useState, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DatasetScreen } from "./DatasetScreen";
import { DiscardRecipeDialog, RecipeDialog, type OpenRecipe, type RecipeEditorHandle } from "./dataset/recipe/RecipeDialog";
import { suggestName } from "./dataset/recipe/flow";
import { tallyRelease } from "./dataset/recipe/tally";
import type { ExportTarget } from "./queries";
import {
  applyTargetHints,
  describeRecipeSpec,
  draftFromSpec,
  draftToSpec,
  EMPTY_DRAFT,
  touch,
  type RecipeSpec,
} from "./recipeDraft";
import { renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const DATASET = "22222222-2222-4222-8222-222222222222";
const RELEASE = "33333333-3333-4333-8333-333333333333";
const ASSET_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ASSET_B = "aaaaaaaa-0000-4000-8000-000000000002";
const ASSET_C = "aaaaaaaa-0000-4000-8000-000000000003";
const ASSET_D = "aaaaaaaa-0000-4000-8000-000000000004";

const YOLO11: ExportTarget = {
  name: "yolo11",
  label: "YOLO11",
  family: "ultralytics-yolo",
  format: "ultralytics",
  tasks: ["detect", "segment"],
  geometries: ["bbox", "polygon"],
  hints: {
    recommended_size: [640, 640],
    recommended_strategy: "letterbox",
    trainer_resizes: true,
    augmentation_common: true,
  },
};
const WIDE: ExportTarget = {
  ...YOLO11,
  name: "wide",
  label: "Wide",
  hints: { ...YOLO11.hints, recommended_size: [1280, 720], recommended_strategy: "stretch" },
};
const DUMMY: ExportTarget = {
  name: "dummy",
  label: "dummy",
  family: "other",
  format: "dummy",
  tasks: [],
  geometries: ["bbox"],
  hints: {
    recommended_size: null,
    recommended_strategy: null,
    trainer_resizes: true,
    augmentation_common: false,
  },
};
const TARGETS = [YOLO11, WIDE, DUMMY];

const LETTERBOX: RecipeSpec = {
  target: "yolo11",
  steps: [
    { kind: "resize", strategy: "letterbox", width: 640, height: 640, pad_value: 114 },
    { kind: "augment", op: "hflip", amount: 0.2 },
    { kind: "augment", op: "brightness_contrast", amount: 0.3 },
  ],
  variants_per_asset: 2,
};

interface RecipeUsage {
  readonly export_count: number;
  readonly release_id: string;
  readonly release_tag: string;
  readonly target: string | null;
  readonly format: string;
}

/** What a warning says: its button's name — the title — and the description under it. */
function warningSaid(button: HTMLElement): string {
  const described = button.getAttribute("aria-describedby");
  const body = described === null ? "" : (document.getElementById(described)?.textContent ?? "");
  return `${button.getAttribute("aria-label") ?? ""} ${body}`;
}

function recipeRow(name: string, spec: RecipeSpec, usedBy: RecipeUsage | null = null) {
  return {
    id: `cccccccc-0000-4000-8000-${name.padStart(12, "0")}`,
    project_id: PROJECT,
    name,
    spec,
    created_at: "2026-08-20T10:00:00.000000Z",
    updated_at: "2026-08-20T10:00:00.000000Z",
    used_by: usedBy,
  };
}

function assetRow(id: string) {
  return {
    id,
    project_id: PROJECT,
    modality: "image",
    point_cloud: null,
    content_hash: id.slice(-12).padStart(64, "0"),
    width: 640,
    height: 480,
    format: "png",
    source_id: null,
    frame_index: null,
    frame_timestamp: null,
    thumbnail_hash: null,
    ingested_at: null,
  };
}

// --- the pure half ---------------------------------------------------------------

describe("recipeDraft", () => {
  it("preselects the strategy and size from the target's hints", () => {
    const draft = applyTargetHints(EMPTY_DRAFT, YOLO11);
    expect(draft.target).toBe("yolo11");
    expect(draft.strategy).toBe("letterbox");
    expect(draft.width).toBe("640");
    expect(draft.height).toBe("640");
  });

  it("rewrites the suggestion only for fields nobody has touched", () => {
    const typed = touch({ ...applyTargetHints(EMPTY_DRAFT, YOLO11), width: "800" }, "width");
    const moved = applyTargetHints(typed, WIDE);
    // The width was chosen; the height and the strategy were not.
    expect(moved.width).toBe("800");
    expect(moved.height).toBe("720");
    expect(moved.strategy).toBe("stretch");
  });

  it("leaves untouched fields alone when the target has no recommendation", () => {
    const from = applyTargetHints(EMPTY_DRAFT, YOLO11);
    const moved = applyTargetHints(from, DUMMY);
    expect(moved.target).toBe("dummy");
    expect(moved.width).toBe("640");
    expect(moved.strategy).toBe("letterbox");
  });

  it("round-trips a stored spec through the draft", () => {
    const outcome = draftToSpec(draftFromSpec("yolo-640", LETTERBOX));
    expect(outcome.kind).toBe("spec");
    if (outcome.kind === "spec") expect(outcome.spec).toEqual(LETTERBOX);
  });

  it("restates the body's bounds beside the field, with the rule named", () => {
    const base = applyTargetHints(EMPTY_DRAFT, YOLO11);
    const tooSmall = draftToSpec({ ...base, width: "16" });
    expect(tooSmall.kind).toBe("problems");
    if (tooSmall.kind === "problems") {
      expect(tooSmall.problems.map((one) => one.step)).toEqual(["resize"]);
      expect(tooSmall.problems[0]?.text).toContain("32 to 8192");
    }
    const pad = draftToSpec({ ...base, padValue: "300" });
    expect(pad.kind === "problems" && pad.problems[0]?.text).toContain("0 to 255");
    // Stretch has no padding, so a pad value out of range is not a problem there.
    expect(draftToSpec({ ...base, strategy: "stretch", padValue: "300" }).kind).toBe("spec");
  });

  it("sends the pad value for the fits that pad, and the default for the ones that cover the frame", () => {
    const base = { ...applyTargetHints(EMPTY_DRAFT, YOLO11), padValue: "0" };
    const padOf = (strategy: "center_crop" | "fill"): number | undefined => {
      const outcome = draftToSpec({ ...base, strategy });
      const resize = outcome.kind === "spec" ? outcome.spec.steps[0] : undefined;
      return resize?.kind === "resize" ? resize.pad_value : undefined;
    };
    expect(padOf("center_crop")).toBe(0);
    expect(padOf("fill")).toBe(114);
    expect(draftToSpec({ ...base, strategy: "center_crop", padValue: "300" }).kind).toBe("problems");
    expect(draftToSpec({ ...base, strategy: "fill", padValue: "300" }).kind).toBe("spec");
  });

  it("round-trips a stored cropping spec and names it by its fit", () => {
    const crop: RecipeSpec = {
      target: null,
      steps: [{ kind: "resize", strategy: "center_crop", width: 512, height: 512, pad_value: 0 }],
      variants_per_asset: 0,
    };
    const draft = draftFromSpec("crop", crop);
    const outcome = draftToSpec(draft);
    expect(outcome.kind === "spec" && outcome.spec).toEqual(crop);
    expect(suggestName({ ...draft, strategy: "fill" })).toBe("recipe-512-fill");
    expect(describeRecipeSpec(crop)).toBe("center_crop 512×512");
  });

  it("holds the cross-field rule in both directions", () => {
    const base = applyTargetHints(EMPTY_DRAFT, YOLO11);
    const opsWithoutVariants = draftToSpec({ ...base, ops: ["hflip"], variants: "0" });
    expect(opsWithoutVariants.kind === "problems" && opsWithoutVariants.problems[0]?.text).toContain(
      "from 1 to 8",
    );
    const variantsWithoutOps = draftToSpec({ ...base, ops: [], variants: "2" });
    expect(variantsWithoutOps.kind === "problems" && variantsWithoutOps.problems[0]?.text).toContain(
      "at least one augmentation",
    );
    const amount = draftToSpec({ ...base, ops: ["brightness_contrast"], variants: "1", amount: "0.7" });
    expect(amount.kind === "problems" && amount.problems[0]?.text).toContain("at most 0.5");
  });

  it("suggests a name from the choices, until somebody types one", () => {
    expect(suggestName(EMPTY_DRAFT)).toBe("recipe");
    const sized = applyTargetHints(EMPTY_DRAFT, YOLO11);
    expect(suggestName(sized)).toBe("yolo11-640");
    expect(suggestName({ ...sized, ops: ["hflip"], variants: "2" })).toBe("yolo11-640-aug2");
    expect(suggestName({ ...applyTargetHints(EMPTY_DRAFT, WIDE) })).toBe("wide-1280x720-stretch");
  });

  it("says a spec in one line", () => {
    expect(describeRecipeSpec(LETTERBOX)).toBe("letterbox 640×640 · flip, brightness/contrast · 2 variants");
    expect(describeRecipeSpec({ target: null, steps: [], variants_per_asset: 0 })).toBe("No transform");
  });
});

// --- the screen ------------------------------------------------------------------

describe("what a recipe writes for a release", () => {
  const split = { train: 0.5, val: 0.25, test: 0.25, seed: 0, group_by: null };

  it("writes every asset once and each training asset once more per variant", () => {
    expect(tallyRelease({ asset_count: 6, split }, { train: 3, val: 2, test: 1 }, 0)).toEqual({ kind: "folds", train: 3, val: 2, test: 1, added: 0, written: 6 });
    expect(tallyRelease({ asset_count: 6, split }, { train: 3, val: 2, test: 1 }, 2)).toEqual({ kind: "folds", train: 3, val: 2, test: 1, added: 6, written: 12 });
    expect(tallyRelease({ asset_count: 10, split }, { train: 7, val: 0, test: 3 }, 8)).toEqual({ kind: "folds", train: 7, val: 0, test: 3, added: 56, written: 66 });
  });

  it("counts nothing without a release, and waits for the folds of one that has a split", () => {
    expect(tallyRelease(undefined, { train: 3, val: 2, test: 1 }, 2)).toEqual({ kind: "no-release" });
    expect(tallyRelease({ asset_count: 6, split }, undefined, 2)).toEqual({ kind: "pending" });
  });

  it("writes an unsplit release's assets once, and gives no count when variants are asked of it", () => {
    expect(tallyRelease({ asset_count: 4, split: null }, undefined, 0)).toEqual({ kind: "no-split", written: 4 });
    expect(tallyRelease({ asset_count: 4, split: null }, undefined, 1)).toEqual({ kind: "no-split", written: null });
  });
});

// --- the modal, over a stubbed wire ---------------------------------------------

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];
const bodies = new Map<Request, string>();

beforeEach(() => {
  // The amount and pad sliders measure their track on mount.
  stubResizeObserver();
  handlers = [];
  sent.length = 0;
  bodies.clear();
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    if (request.method !== "GET") bodies.set(request, await request.clone().text());
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? null), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ code: "NO_STUB", message: request.url }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
});

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname) ? answer : undefined,
  );
}

function pathOf(request: Request): string {
  return new URL(request.url).pathname;
}

function bodyOf(request: Request): Record<string, unknown> {
  return JSON.parse(bodies.get(request) ?? "{}") as Record<string, unknown>;
}

const FORMAT_REST = { geometries: [], modalities: [], degraded_geometries: [], targets: [] } as const;

const RELEASE_ROW = {
  id: RELEASE,
  dataset_id: DATASET,
  tag: "v1",
  manifest_hash: "abcdef0123456789",
  schema_version: 1,
  asset_count: 4,
  annotation_count: 0,
  split: null,
  created_at: "2026-07-31T10:00:00.000000Z",
  visionset_version: "0.0.1.dev0",
};

/** Every read the page makes, with the project holding four assets and one release, `v1`. */
function baseline(recipes: ReturnType<typeof recipeRow>[] = []): void {
  on("GET", /\/preprocessing-recipes$/, { status: 200, body: { items: recipes, total: recipes.length } });
  on("GET", /\/export-targets$/, { status: 200, body: { items: TARGETS, total: TARGETS.length } });
  on("GET", /\/schema$/, {
    status: 200,
    body: {
      project_id: PROJECT,
      version: 1,
      classes: [
        { name: "car", geometries: ["bbox"], color: null, attributes: [] },
        { name: "lane", geometries: ["polygon"], color: null, attributes: [] },
      ],
    },
  });
  on("GET", /\/dataset$/, {
    status: 200,
    body: { id: DATASET, project_id: PROJECT, name: "highway", description: null },
  });
  on("GET", /\/releases$/, { status: 200, body: { items: [RELEASE_ROW], total: 1 } });
  on("GET", /\/formats$/, {
    status: 200,
    body: { items: [{ name: "ultralytics", lossy: false, ...FORMAT_REST, targets: ["yolo11", "wide"] }], total: 1 },
  });
  on("GET", /\/stats$/, {
    status: 200,
    body: { dataset_id: DATASET, asset_count: 0, annotated_asset_count: 0, annotation_count: 0, classes: [] },
  });
  on("GET", /\/projects\/[^/]+\/assets$/, {
    status: 200,
    body: { items: [ASSET_A, ASSET_B, ASSET_C, ASSET_D].map(assetRow), total: 4 },
  });
}

/** Choose a target through the grouped picker. */
async function chooseTarget(label: RegExp): Promise<void> {
  await userEvent.click(screen.getByTestId("recipe-target"));
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

const PLAIN: RecipeSpec = { target: null, steps: [], variants_per_asset: 0 };

/**
 * The recipe dialog and the question that guards it, hosted as the export
 * dialog hosts them: a close asks the editor whether it holds unsaved work, and
 * a saved recipe is the one the dialog now shows.
 */
function Host({ name, onSaved }: { readonly name: string | null; readonly onSaved?: (name: string) => void }): JSX.Element {
  const [open, setOpen] = useState<OpenRecipe | null>({ session: 1, name });
  const [asking, setAsking] = useState(false);
  const editor = useRef<RecipeEditorHandle>(null);
  return (
    <>
      <RecipeDialog
        projectId={PROJECT}
        recipe={open}
        editor={editor}
        onRequestClose={() => {
          if (editor.current?.hasUnsavedChanges() === true) setAsking(true);
          else setOpen(null);
        }}
        onSaved={(saved) => {
          setOpen((before) => (before === null ? null : { session: before.session, name: saved }));
          onSaved?.(saved);
        }}
      />
      <DiscardRecipeDialog
        name={open?.name ?? null}
        open={asking}
        onKeep={() => setAsking(false)}
        onDiscard={() => {
          setAsking(false);
          setOpen(null);
        }}
      />
    </>
  );
}

/** A new recipe's dialog. */
async function openNew(): Promise<HTMLElement> {
  renderWithData(<Host name={null} />);
  const dialog = await screen.findByTestId("recipe-dialog");
  await within(dialog).findByTestId("recipe-editor");
  return dialog;
}

/** A stored recipe's dialog. */
async function openStored(name: string): Promise<HTMLElement> {
  renderWithData(<Host name={name} />);
  const dialog = await screen.findByTestId("recipe-dialog");
  await within(dialog).findByTestId("recipe-editor");
  return dialog;
}

/** The Dataset page, with release `v1` opened: its Export section, in the left column. */
async function openExport(): Promise<HTMLElement> {
  renderWithData(<DatasetScreen projectId={PROJECT} />);
  await userEvent.click(await screen.findByTestId("version-v1"));
  const section = await screen.findByTestId("section-export");
  await within(section).findByTestId("export-form");
  return section;
}

/** The recipe the export's select shows chosen — "No recipe" for none. */
function chosen(exported: HTMLElement): string {
  return within(exported).getByTestId("export-recipe").textContent ?? "";
}

/** Open the export's recipe select and read its options, in order; Escape closes it again. */
async function recipeOptions(exported: HTMLElement): Promise<string[]> {
  await userEvent.click(within(exported).getByTestId("export-recipe"));
  await screen.findByTestId("recipe-row-~none");
  return screen.getAllByRole("option").map((one) => one.getAttribute("data-testid") ?? "");
}

/** Choose a recipe from the export's select, once its option has arrived. */
async function chooseRecipe(exported: HTMLElement, name: string): Promise<void> {
  await waitFor(async () => {
    await userEvent.click(within(exported).getByTestId("export-recipe"));
    await userEvent.click(await screen.findByTestId(`recipe-row-${name}`, {}, { timeout: 200 }));
  });
}

/** The chosen recipe's Edit recipe or Delete, from the "⋯" beside what it does. */
async function recipeAction(exported: HTMLElement, kind: "edit" | "delete"): Promise<void> {
  await userEvent.click(within(exported).getByTestId("recipe-actions"));
  await userEvent.click(await screen.findByTestId(`recipe-${kind}`));
}

/** The variants chosen, by the radio that is checked; "none" while none is. */
function variantsOf(dialog: HTMLElement): string {
  const checked = within(within(dialog).getByTestId("augment-variants")).queryAllByRole("radio").find((one) => one.getAttribute("aria-checked") === "true");
  return checked?.textContent ?? "none";
}

const chooseVariants = (dialog: HTMLElement, count: number): Promise<void> => userEvent.click(within(dialog).getByTestId(`augment-variants-${count}`));

/**
 * The pointer moving off `from` onto `to`. Inside the modal user-event moves
 * the pointer without the out/over pair React derives a leave from, so the
 * pair is sent as a browser sends it.
 */
function pointerLeaves(from: HTMLElement, to: HTMLElement): void {
  fireEvent.pointerOut(from, { relatedTarget: to });
  fireEvent.pointerOver(to, { relatedTarget: from });
}

/** Opens the variants' info tooltip and reads it. */
async function variantsNote(dialog: HTMLElement): Promise<string> {
  return infoNote(within(dialog).getByTestId("augment-variants-info"));
}

/** Opens the model's info tooltip and reads it. */
async function modelNote(dialog: HTMLElement): Promise<string> {
  return infoNote(within(dialog).getByTestId("recipe-target-info"));
}

async function infoNote(button: HTMLElement): Promise<string> {
  await userEvent.hover(button);
  return (await screen.findByRole("tooltip")).textContent ?? "";
}

describe("the editor", () => {
  it("opens a stored recipe on one page, every field filled from it", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    const dialog = await openStored("yolo-640");

    expect(within(dialog).getByTestId("recipe-title").textContent).toBe("Edit recipe");
    expect(within(dialog).getByTestId("recipe-editor").getAttribute("data-mode")).toBe("edit");
    expect(within(dialog).getByTestId("recipe-name")).toHaveProperty("value", "yolo-640");
    expect(within(dialog).getByTestId("recipe-target").textContent?.trim()).toBe("YOLO11");
    expect(within(dialog).getByTestId("resize-letterbox").getAttribute("data-state")).toBe("on");
    expect(within(dialog).getByTestId("resize-width")).toHaveProperty("value", "640");
    expect(within(dialog).getByTestId("augment-hflip").getAttribute("aria-checked")).toBe("true");
    expect(variantsOf(dialog)).toBe("2");
    // Nothing has changed, so there is nothing to save.
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", true);
  });

  it("holds the save on the first problem down the page, says it once beside the save, and points the field at it", async () => {
    baseline();
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);

    expect(within(dialog).getByTestId("recipe-title").textContent).toBe("New recipe");
    expect(within(dialog).getByTestId("recipe-save").textContent).toContain("Create recipe");
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", false);

    // A bad width holds the save, says why, and points the field at the message.
    const width = within(dialog).getByTestId("resize-width");
    await userEvent.clear(width);
    await userEvent.type(width, "16");
    expect(within(dialog).getByTestId("recipe-problem").textContent).toContain("32 to 8192");
    expect(width.getAttribute("aria-invalid")).toBe("true");
    expect(width.getAttribute("aria-describedby")).toBe("recipe-status");
    expect(within(dialog).getByTestId("recipe-problem").id).toBe("recipe-status");
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", true);

    // The name sits above the size, so a missing name is the problem said first, and only it.
    const name = within(dialog).getByTestId("recipe-name");
    await userEvent.clear(name);
    expect(within(dialog).getByTestId("recipe-problem").textContent).toContain("Enter a name");
    expect(within(dialog).getAllByTestId("recipe-problem")).toHaveLength(1);
    await userEvent.type(name, "plain");
    expect(within(dialog).getByTestId("recipe-problem").textContent).toContain("32 to 8192");

    await userEvent.clear(within(dialog).getByTestId("resize-width"));
    await userEvent.type(within(dialog).getByTestId("resize-width"), "320");
    expect(within(dialog).queryByTestId("recipe-problem")).toBeNull();
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", false);
  });

  it("holds the save on a missing name, and Enter in a field saves like Create recipe", async () => {
    baseline();
    on("POST", /\/preprocessing-recipes$/, { status: 201, body: recipeRow("plain", PLAIN) });
    const dialog = await openNew();
    const name = within(dialog).getByTestId("recipe-name");

    await userEvent.clear(name);
    expect(within(dialog).getByTestId("recipe-problem").textContent).toContain("Enter a name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("recipe-status");
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", true);
    await userEvent.type(name, "{Enter}");
    expect(sent.some((r) => r.method === "POST")).toBe(false);

    await userEvent.type(name, "plain{Enter}");
    await within(dialog).findByTestId("recipe-saved");
    expect(bodyOf(sent.find((r) => r.method === "POST") as Request)).toEqual({ name: "plain", spec: PLAIN });
  });

  it("asks before Cancel would throw unsaved work away, like any other close", async () => {
    baseline();
    const dialog = await openNew();
    await userEvent.type(within(dialog).getByTestId("recipe-name"), "-x");

    await userEvent.click(within(dialog).getByTestId("recipe-cancel"));
    expect((await screen.findByTestId("recipe-discard-dialog")).textContent).toContain("Discard the new recipe?");
    await userEvent.click(screen.getByTestId("recipe-discard-changes"));
    await waitFor(() => expect(screen.queryByTestId("recipe-dialog")).toBeNull());
  });

  it("asks before a close would throw unsaved work away, and keeps it on Keep editing", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    const dialog = await openStored("yolo-640");
    const name = within(dialog).getByTestId("recipe-name");
    await userEvent.clear(name);
    await userEvent.type(name, "yolo-640-v2");

    await userEvent.keyboard("{Escape}");
    expect((await screen.findByTestId("recipe-discard-dialog")).textContent).toContain("Discard changes to yolo-640?");
    await userEvent.click(screen.getByTestId("recipe-keep-editing"));
    await waitFor(() => expect(screen.queryByTestId("recipe-discard-dialog")).toBeNull());
    expect(within(screen.getByTestId("recipe-dialog")).getByTestId("recipe-name")).toHaveProperty("value", "yolo-640-v2");

    await userEvent.keyboard("{Escape}");
    await userEvent.click(await screen.findByTestId("recipe-discard-changes"));
    await waitFor(() => expect(screen.queryByTestId("recipe-dialog")).toBeNull());
  });

  it("closes without asking when nothing changed", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    await openStored("yolo-640");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("recipe-dialog")).toBeNull());
    expect(screen.queryByTestId("recipe-discard-dialog")).toBeNull();
  });

  it("says which export used the open recipe, and shows no such row when none did", async () => {
    const stored = [
      recipeRow("yolo-640", LETTERBOX, { export_count: 3, release_id: RELEASE, release_tag: "v0.5", target: "yolo11", format: "ultralytics" }),
      recipeRow("by-format", LETTERBOX, { export_count: 1, release_id: RELEASE, release_tag: "v1", target: null, format: "coco" }),
      recipeRow("plain", PLAIN),
    ];
    baseline(stored);
    const dialog = await openStored("yolo-640");
    expect(within(dialog).getByTestId("recipe-used-by").textContent).toBe("The v0.5 YOLO11 export and 2 earlier");

    cleanup();
    const byFormat = await openStored("by-format");
    expect(within(byFormat).getByTestId("recipe-used-by").textContent).toBe("The v1 coco export");

    cleanup();
    const plain = await openStored("plain");
    expect(within(plain).queryByTestId("recipe-used-by")).toBeNull();
  });

  it("shows no used-by row on a new recipe", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX, { export_count: 1, release_id: RELEASE, release_tag: "v1", target: "yolo11", format: "ultralytics" })]);
    const dialog = await openNew();
    expect(within(dialog).queryByTestId("recipe-used-by")).toBeNull();
  });
});

describe("the recipe in a release's Export section", () => {
  it("lists No recipe first and chosen, then the project's recipes, each with its summary and model for a reader of the page", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX), recipeRow("plain", PLAIN)]);
    const exported = await openExport();

    expect(chosen(exported)).toBe("No recipe");
    await waitFor(async () => {
      await userEvent.keyboard("{Escape}");
      expect(await recipeOptions(exported)).toEqual(["recipe-row-~none", "recipe-row-yolo-640", "recipe-row-plain"]);
    });
    expect(screen.getByTestId("recipe-row-~none").getAttribute("aria-selected")).toBe("true");

    // The detail is in a card beside the highlighted option and, as words, with the option for a screen reader.
    const said = (name: string): string => screen.getByTestId(`recipe-row-${name}`).querySelector("span.sr-only")?.textContent ?? "";
    expect(said("yolo-640")).toContain("Letterbox 640×640");
    expect(said("yolo-640")).toContain("For YOLO11");
    expect(said("plain")).toContain("No transform");
    expect(said("plain")).toContain("For any model");
    await userEvent.keyboard("{Escape}");
    // Nothing is written until the "+" asks for it, and no recipe is chosen for the person.
    expect(screen.queryByTestId("recipe-dialog")).toBeNull();
    // Edit and Delete belong to a chosen recipe.
    expect(within(exported).queryByTestId("recipe-actions")).toBeNull();
  });

  it("says what the chosen recipe does under the select, with its Edit recipe and Delete, and nothing for No recipe", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX), recipeRow("plain", PLAIN)]);
    const exported = await openExport();
    await chooseRecipe(exported, "yolo-640");

    expect(chosen(exported)).toBe("yolo-640");
    expect(within(exported).getByTestId("recipe-chosen").textContent).toContain("Letterbox 640×640");
    expect(within(exported).getByTestId("recipe-actions").getAttribute("aria-label")).toBe("Actions for yolo-640");

    await chooseRecipe(exported, "plain");
    expect(within(exported).getByTestId("recipe-chosen").textContent).toContain("No transform");
    expect(within(exported).getByTestId("recipe-actions").getAttribute("aria-label")).toBe("Actions for plain");

    await chooseRecipe(exported, "~none");
    expect(within(exported).queryByTestId("recipe-chosen")).toBeNull();
    expect(within(exported).queryByTestId("recipe-actions")).toBeNull();
  });

  it("shelves no recipes in the working copy, and the project bar publishes", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    const nav = await screen.findByTestId("version-nav");
    expect(within(nav).getByTestId("version-working")).not.toBeNull();
    await within(nav).findByTestId("version-v1");
    expect(screen.queryByTestId("recipe-shelf")).toBeNull();
    expect(screen.queryByTestId("recipe-list")).toBeNull();
    expect(screen.queryByTestId("recipe-yolo-640")).toBeNull();
    expect(screen.queryByTestId("recipe-new")).toBeNull();
    expect(screen.queryByTestId("recipe-dialog")).toBeNull();
    expect(screen.getByTestId("publish-release").getAttribute("data-variant")).not.toBe("outline");
  });

  it("opens the working copy for every tab the host names, and opens no recipe", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    renderWithData(<DatasetScreen projectId={PROJECT} tab="preprocessing" />);

    const nav = await screen.findByTestId("version-nav");
    await within(nav).findByTestId("version-v1");
    expect(within(nav).getByTestId("version-working").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("publish-release")).not.toBeNull();
    expect(screen.queryByTestId("recipe-dialog")).toBeNull();
  });

  it("writes a new recipe from the \"+\" beside the label, and the saved recipe becomes the export's", async () => {
    let created = false;
    handlers.push((request) => {
      if (request.method !== "GET" || !pathOf(request).endsWith("/preprocessing-recipes")) return undefined;
      const items = created ? [recipeRow("recipe", PLAIN)] : [];
      return { status: 200, body: { items, total: items.length } };
    });
    baseline();
    on("POST", /\/preprocessing-recipes$/, { status: 201, body: recipeRow("recipe", PLAIN) });
    const exported = await openExport();
    expect(chosen(exported)).toBe("No recipe");

    await userEvent.click(within(exported).getByTestId("recipe-new"));
    const dialog = await screen.findByTestId("recipe-dialog");
    await within(dialog).findByTestId("recipe-editor");
    expect(within(dialog).getByTestId("recipe-editor").getAttribute("data-mode")).toBe("create");
    created = true;
    await userEvent.click(within(dialog).getByTestId("recipe-save"));
    const saved = await within(dialog).findByTestId("recipe-saved");
    await userEvent.click(within(saved).getByTestId("recipe-saved-done"));
    await waitFor(() => expect(screen.queryByTestId("recipe-dialog")).toBeNull());

    // The export now runs the recipe that was just written, and the select shows it chosen.
    await waitFor(() => expect(chosen(exported)).toBe("recipe"));
  });

  it("opens the chosen recipe to edit, over the page, and the export keeps it chosen after a save", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    on("PUT", /\/preprocessing-recipes\/yolo-640$/, { status: 200, body: recipeRow("yolo-640", { ...LETTERBOX, variants_per_asset: 3 }) });
    const exported = await openExport();
    await chooseRecipe(exported, "yolo-640");

    await recipeAction(exported, "edit");
    const dialog = await screen.findByTestId("recipe-dialog");
    await within(dialog).findByTestId("recipe-editor");
    expect(within(dialog).getByTestId("recipe-editor").getAttribute("data-mode")).toBe("edit");
    expect(within(dialog).getByTestId("recipe-name")).toHaveProperty("value", "yolo-640");
    // The export's section is still on the page beneath it.
    expect(screen.getByTestId("section-export")).not.toBeNull();

    await chooseVariants(dialog, 3);
    await userEvent.click(within(dialog).getByTestId("recipe-save"));
    await within(dialog).findByTestId("recipe-saved");
    expect(sent.some((r) => r.method === "PUT")).toBe(true);
    await userEvent.click(within(dialog).getByTestId("recipe-saved-done"));
    await waitFor(() => expect(screen.queryByTestId("recipe-dialog")).toBeNull());
    expect(chosen(exported)).toBe("yolo-640");
  });

  it("asks before an edit's close throws changes away, and leaves the Export section and its choice standing", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    const exported = await openExport();
    await chooseRecipe(exported, "yolo-640");
    await recipeAction(exported, "edit");
    const dialog = await screen.findByTestId("recipe-dialog");
    const name = await within(dialog).findByTestId("recipe-name");
    await userEvent.clear(name);
    await userEvent.type(name, "yolo-640-v2");

    await userEvent.keyboard("{Escape}");
    const ask = await screen.findByTestId("recipe-discard-dialog");
    expect(ask.textContent).toContain("Discard changes to yolo-640?");
    await userEvent.click(within(ask).getByTestId("recipe-discard-changes"));

    await waitFor(() => expect(screen.queryByTestId("recipe-dialog")).toBeNull());
    expect(screen.getByTestId("section-export")).not.toBeNull();
    expect(chosen(exported)).toBe("yolo-640");
    expect(sent.some((r) => r.method === "PUT")).toBe(false);
  });

  it("says when the recipes could not be read, and the export still runs without one", async () => {
    on("GET", /\/preprocessing-recipes$/, { status: 503, body: { code: "WORKSPACE_BUSY", message: "Busy." } });
    baseline();
    const exported = await openExport();

    const said = warningSaid(await within(exported).findByTestId("export-recipes-error"));
    expect(said).toContain("busy");
    expect(said).toContain("The export runs without a recipe");
    expect(within(exported).queryByTestId("recipe-row-~none")).toBeNull();
    expect(within(exported).getByTestId("export-submit")).not.toBeNull();
  });
});

describe("writing a new recipe", () => {
  it("opens on the name and model; a model fills in the size and the name, and says what it takes behind the info button", async () => {
    baseline();
    const dialog = await openNew();

    expect(within(dialog).getByTestId("recipe-title").textContent).toBe("New recipe");
    expect(within(dialog).getByTestId("recipe-editor").getAttribute("data-mode")).toBe("create");
    expect(within(dialog).getByTestId("recipe-target").textContent?.trim()).toBe("Any model");
    // The dialog takes focus itself, not its close button.
    expect(document.activeElement).toBe(dialog);

    await chooseTarget(/YOLO11/);
    // The field says the model's name; what it takes is one press away.
    expect(within(dialog).getByTestId("recipe-target").textContent?.trim()).toBe("YOLO11");
    const meta = await modelNote(dialog);
    expect(meta).toContain("detect · segment");
    expect(meta).toContain("Letterboxes to 640 on its own.");
    expect(within(dialog).getByTestId("recipe-name")).toHaveProperty("value", "yolo11-640");
    expect(within(dialog).getByTestId("recipe-name-suggested").textContent).toBe("Suggested");

    // One Escape closes the model's card and leaves the dialog open.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(screen.getByTestId("recipe-dialog")).not.toBeNull();

    // The controls under it start from what the model recommends.
    expect(within(dialog).getByTestId("resize-letterbox").getAttribute("data-state")).toBe("on");
    expect(within(dialog).getByTestId("resize-width")).toHaveProperty("value", "640");
    expect(within(dialog).getByTestId("resize-height")).toHaveProperty("value", "640");
    expect(await variantsNote(dialog)).toContain("Usual when training YOLO11");
    expect(within(dialog).getByTestId("recipe-save").textContent).toContain("Create recipe");
  });

  it("clears the model from the list itself", async () => {
    baseline();
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);

    await chooseTarget(/^Any model$/);
    expect(within(dialog).getByTestId("recipe-target").textContent?.trim()).toBe("Any model");
    const meta = await modelNote(dialog);
    expect(meta).toContain("A model fills in the fit and size it trains at.");
    expect(meta).not.toContain("on its own");
  });

  it("names the models alone in the list, and says what one takes in a card beside the highlighted option", async () => {
    baseline();
    await openNew();
    await userEvent.click(screen.getByTestId("recipe-target"));
    const option = await screen.findByRole("option", { name: /YOLO11/ });
    // The name is all that shows; the tasks are heard with it, not seen.
    expect(option.querySelector(".text-muted-foreground")).toBeNull();
    expect(option.textContent).toContain("YOLO11");

    // Highlighting it, by pointer or keyboard, opens its card after a moment.
    act(() => option.focus());
    const card = await screen.findByTestId("target-card-yolo11");
    expect(card.textContent).toContain("detect · segment");

    // One Escape closes the list, card and all, and leaves the recipe open.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.queryByTestId("target-card-yolo11")).toBeNull();
    expect(screen.getByTestId("recipe-dialog")).not.toBeNull();
  });

  it("keeps a typed size when the model changes, and moves the rest", async () => {
    baseline();
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);
    await userEvent.clear(within(dialog).getByTestId("resize-width"));
    await userEvent.type(within(dialog).getByTestId("resize-width"), "800");

    // The model is changed under the typed width.
    await chooseTarget(/Wide/);

    expect(within(dialog).getByTestId("resize-width")).toHaveProperty("value", "800");
    expect(within(dialog).getByTestId("resize-height")).toHaveProperty("value", "720");
    expect(within(dialog).getByTestId("resize-stretch").getAttribute("data-state")).toBe("on");
  });

  it("names the rule beside the save, points the field at it, and Enter does not get past it", async () => {
    baseline();
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);
    const width = within(dialog).getByTestId("resize-width");
    await userEvent.clear(width);
    await userEvent.type(width, "16");

    expect(within(dialog).getByTestId("recipe-problem").textContent).toContain("32 to 8192");
    expect(width.getAttribute("aria-invalid")).toBe("true");
    expect(width.getAttribute("aria-describedby")).toBe("recipe-status");
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", true);
    // Enter in the field is the save, so it does not get past the problem either.
    await userEvent.type(width, "{Enter}");
    expect(sent.some((r) => r.method === "POST")).toBe(false);
    expect(within(dialog).queryByTestId("recipe-saved")).toBeNull();

    await userEvent.clear(within(dialog).getByTestId("resize-width"));
    await userEvent.type(within(dialog).getByTestId("resize-width"), "320");
    expect(within(dialog).queryByTestId("recipe-problem")).toBeNull();
    expect(within(dialog).getByTestId("recipe-status").textContent).toBe("");
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", false);
  });

  it("draws what the fit does at the size, and the option pointed at before it is chosen", async () => {
    baseline();
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);

    // Every fit's card draws its own fit, as decoration: the card's label names it.
    for (const fit of ["letterbox", "stretch", "fill", "center_crop", "none"]) {
      const art = within(dialog).getByTestId(`resize-${fit}`).querySelector("svg");
      expect(art?.getAttribute("data-fit")).toBe(fit);
      expect(art?.getAttribute("aria-hidden")).toBe("true");
    }

    const stage = within(dialog).getByTestId("recipe-stage");
    expect(stage.getAttribute("aria-hidden")).toBe("true");
    const drawn = (): string | null | undefined => stage.querySelector("svg")?.getAttribute("data-fit");
    expect(drawn()).toBe("letterbox");
    // The caption says what the fit does; the fit and the size are the fields under it, not repeated.
    expect(within(dialog).getByTestId("recipe-stage-caption").textContent).toBe("Keeps the shape and pads the rest.");

    // Pointing at Stretch draws it without choosing it; leaving hands the stage back.
    await userEvent.hover(within(dialog).getByTestId("resize-stretch"));
    expect(drawn()).toBe("stretch");

    expect(within(dialog).getByTestId("resize-letterbox").getAttribute("data-state")).toBe("on");
    pointerLeaves(within(dialog).getByTestId("resize-stretch"), dialog);
    expect(drawn()).toBe("letterbox");

    // The cropping fits are offered beside them, each drawn and captioned with its loss.
    for (const fit of ["fill", "center_crop"]) {
      await userEvent.hover(within(dialog).getByTestId(`resize-${fit}`));
      expect(drawn()).toBe(fit);
      expect(within(dialog).getByTestId("recipe-stage-caption").textContent).toContain("Labels cut mostly away are dropped.");
      pointerLeaves(within(dialog).getByTestId(`resize-${fit}`), dialog);
    }

    await userEvent.click(within(dialog).getByTestId("resize-none"));
    pointerLeaves(within(dialog).getByTestId("resize-none"), dialog);
    expect(within(dialog).getByTestId("recipe-stage-caption").textContent).toBe("Keeps each image at its own size.");
  });

  it("keeps the fit a choice of one while it wraps: one radio per option, the chosen one checked, arrows walk them", async () => {
    baseline();
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);

    const fit = within(dialog).getByTestId("resize-fit");
    const options = within(fit).getAllByRole("radio");
    expect(options.map((one) => one.getAttribute("data-testid"))).toEqual(["resize-letterbox", "resize-stretch", "resize-fill", "resize-center_crop", "resize-none"]);
    expect(options.map((one) => one.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false", "false"]);
    // Separate options, not a joined strip: a wrapped strip would draw its joins in mid-row.
    expect(fit.getAttribute("data-spacing")).not.toBe("0");

    options[0]?.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(options[1]);
    await userEvent.keyboard(" ");
    expect(options[1]?.getAttribute("aria-checked")).toBe("true");
    expect(options[0]?.getAttribute("aria-checked")).toBe("false");
  });

  it("draws Crop's photograph clearly larger than Fill's, so the two fits read apart", async () => {
    baseline();
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);
    const stage = within(dialog).getByTestId("recipe-stage");
    const photoScale = (): number => {
      const transform = stage.querySelectorAll<SVGGElement>("svg > g")[1]?.style.transform ?? "";
      return Number(/scale\(([\d.]+)/.exec(transform)?.[1]);
    };

    await userEvent.click(within(dialog).getByTestId("resize-fill"));
    const fill = photoScale();
    await userEvent.click(within(dialog).getByTestId("resize-center_crop"));
    const crop = photoScale();
    expect(fill).toBeGreaterThan(0);
    expect(crop / fill).toBeGreaterThanOrEqual(1.2);
  });

  it("draws the common sizes at the control's own size, not the small one", async () => {
    baseline();
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);
    const presets = within(within(dialog).getByTestId("resize-presets")).getAllByRole("radio");
    expect(presets.map((one) => one.textContent)).toEqual(["320", "416", "640", "1024", "1280"]);
    for (const preset of presets) expect(preset.getAttribute("data-size")).not.toBe("sm");
  });

  it("disables the size where it stands when the fit keeps each image's own size, so nothing can be typed into it", async () => {
    baseline();
    const dialog = await openNew();
    // The pad is not asked: a letterbox keeps the grey it has.
    expect(dialog.querySelector("#recipe-pad")).toBeNull();
    await userEvent.click(within(dialog).getByTestId("resize-none"));

    // Disabled on the inputs and the common sizes themselves, not only through the fieldset.
    const width = within(dialog).getByTestId("resize-width");
    expect(width).toHaveProperty("disabled", true);
    expect(within(dialog).getByTestId("resize-height")).toHaveProperty("disabled", true);
    expect(within(dialog).getByRole("radio", { name: "640 × 640" })).toHaveProperty("disabled", true);
    const before = (width as HTMLInputElement).value;
    await userEvent.type(width, "77");
    expect(width).toHaveProperty("value", before);

    await userEvent.click(within(dialog).getByTestId("resize-letterbox"));
    expect(within(dialog).getByTestId("resize-width")).toHaveProperty("disabled", false);
  });

  it("opens brightness's amount inside its row only while the switch is on, its value in a chip", async () => {
    baseline();
    const dialog = await openNew();
    expect(within(dialog).queryByRole("slider")).toBeNull();

    await userEvent.click(within(dialog).getByTestId("augment-brightness_contrast"));
    const slider = await within(dialog).findByRole("slider");
    // Inside Brightness's own row, with the value it is at beside it.
    expect(within(dialog).getByTestId("augment-row-brightness_contrast").contains(slider)).toBe(true);
    expect(within(dialog).getByTestId("augment-amount-value").textContent).toBe("±20%");
    // It follows the switch and comes before Rotate's.
    const rotate = within(dialog).getByRole("switch", { name: "Rotate" });
    expect(slider.compareDocumentPosition(rotate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "Brightness" }).compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(within(dialog).getByTestId("augment-brightness_contrast"));
    await waitFor(() => expect(within(dialog).queryByRole("slider")).toBeNull());
  });

  it("offers the variants only while an augmentation is on: the first one makes one, and the last one off clears them", async () => {
    baseline();
    const dialog = await openNew();
    const choices = (): HTMLElement[] => within(within(dialog).getByTestId("augment-variants")).getAllByRole("radio");
    expect(choices().map((one) => one.textContent)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    // Nothing on: none chosen, and none can be.
    expect(variantsOf(dialog)).toBe("none");
    for (const one of choices()) expect(one).toHaveProperty("disabled", true);

    await userEvent.click(within(dialog).getByTestId("augment-brightness_contrast"));
    expect(variantsOf(dialog)).toBe("1");
    for (const one of choices()) expect(one).toHaveProperty("disabled", false);
    await chooseVariants(dialog, 4);
    expect(variantsOf(dialog)).toBe("4");

    await userEvent.click(within(dialog).getByTestId("augment-brightness_contrast"));
    expect(variantsOf(dialog)).toBe("none");
    for (const one of choices()) expect(one).toHaveProperty("disabled", true);
    // What variants are for is one press away, not a line under the row.
    expect(await variantsNote(dialog)).toContain("training split");
  });

  it("draws what each augmentation does in a card beside its label, and one Escape closes only the card", async () => {
    baseline();
    const dialog = await openNew();

    const flip = within(dialog).getByTestId("augment-hflip-info");
    expect(flip.getAttribute("aria-label")).toBe("About flip");
    await userEvent.hover(flip);
    const card = await screen.findByRole("tooltip");
    expect(card.textContent).toContain("Mirrors left to right");
    expect(card.textContent).toContain("Its labels are mirrored with it.");
    // The drawing is decoration: the card says it in words.
    expect(card.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(flip.getAttribute("aria-describedby")).toBe(card.id);

    // Brightness's card says how far its amount reaches; Rotate's, what it refuses.
    pointerLeaves(flip, dialog);
    await userEvent.hover(within(dialog).getByTestId("augment-brightness_contrast-info"));
    expect((await screen.findByRole("tooltip")).textContent).toContain("by up to its amount");
    pointerLeaves(within(dialog).getByTestId("augment-brightness_contrast-info"), dialog);
    within(dialog).getByTestId("augment-rot90-info").focus();
    expect((await screen.findByRole("tooltip")).textContent).toContain("refuses it over polylines");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(screen.getByTestId("recipe-dialog")).not.toBeNull();
  });

  it("labels each augmentation switch by its row and says what it does", async () => {
    baseline();
    const dialog = await openNew();

    const flip = within(dialog).getByRole("switch", { name: "Flip" });
    expect(flip.getAttribute("aria-describedby")).toBe("augment-hflip-detail");
    // Said once on screen, in the info card; the switch carries the same words for a screen reader only.
    const detail = dialog.querySelector("#augment-hflip-detail");
    expect(detail?.textContent).toBe("Mirrors left to right. Its labels are mirrored with it.");
    expect(detail?.classList.contains("sr-only")).toBe(true);
    expect(within(dialog).getByRole("switch", { name: "Brightness" })).not.toBeNull();
    expect(within(dialog).getByRole("switch", { name: "Rotate" })).not.toBeNull();
  });

  it("creates the recipe the page describes, and says it is ready", async () => {
    baseline();
    on("POST", /\/preprocessing-recipes$/, { status: 201, body: recipeRow("yolo-640", LETTERBOX) });
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);
    const name = within(dialog).getByTestId("recipe-name");
    await userEvent.clear(name);
    await userEvent.type(name, "yolo-640");
    expect(within(dialog).queryByTestId("recipe-name-suggested")).toBeNull();
    await userEvent.click(within(dialog).getByTestId("augment-hflip"));
    await userEvent.click(within(dialog).getByTestId("augment-brightness_contrast"));
    // The amount, from 0.20 to 0.30 in two of its 0.05 steps.
    const amount = within(dialog).getByRole("slider", { name: "Amount" });
    amount.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await chooseVariants(dialog, 2);

    await userEvent.click(within(dialog).getByTestId("recipe-save"));

    const create = () => sent.find((r) => r.method === "POST" && pathOf(r).endsWith("/preprocessing-recipes"));
    await waitFor(() => expect(create()).not.toBeUndefined());
    expect(bodyOf(create() as Request)).toEqual({ name: "yolo-640", spec: LETTERBOX });
    const saved = await within(dialog).findByTestId("recipe-saved");
    expect(saved.textContent).toContain("yolo-640 is ready");
    expect(saved.textContent).toContain("Letterbox 640×640 · flip, brightness/contrast · 2 variants");
    // Done closes; nothing is left to lose.
    await userEvent.click(within(saved).getByTestId("recipe-saved-done"));
    await waitFor(() => expect(screen.queryByTestId("recipe-dialog")).toBeNull());
    expect(screen.queryByTestId("recipe-discard-dialog")).toBeNull();
  });

  it("renders a refused save as prose beside the save, never as its code, until the draft changes", async () => {
    baseline();
    on("POST", /\/preprocessing-recipes$/, {
      status: 409,
      body: { code: "PREPROCESSING_RECIPE_NAME_TAKEN", message: "project 1111 already has a recipe named 'yolo-640'" },
    });
    const dialog = await openNew();
    await userEvent.click(within(dialog).getByTestId("recipe-save"));

    const said = (await within(dialog).findByTestId("recipe-save-error")).textContent ?? "";
    expect(said).toContain("already exists");
    expect(said).not.toContain("PREPROCESSING_RECIPE_NAME_TAKEN");
    expect(said).not.toContain("1111");
    expect(within(dialog).queryByTestId("recipe-saved")).toBeNull();
    // Answering it — a change to the draft — retires it.
    await userEvent.click(within(dialog).getByTestId("augment-hflip"));
    expect(within(dialog).queryByTestId("recipe-save-error")).toBeNull();
  });

  it("says why the model cannot be chosen when the catalog could not be read", async () => {
    on("GET", /\/export-targets$/, { status: 503, body: { code: "WORKSPACE_BUSY", message: "Busy." } });
    baseline();
    const dialog = await openNew();

    expect(within(dialog).getByTestId("recipe-targets-error").textContent).toContain("Try again to choose a model");
    expect(within(dialog).queryByTestId("recipe-target")).toBeNull();
    // The model is optional: the recipe can still be created without one.
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", false);
  });
});

describe("what the recipe makes for the release it was opened from", () => {
  const SPLIT_RELEASE = { ...RELEASE_ROW, split: { train: 0.5, val: 0.25, test: 0.25, seed: 0, group_by: null } };
  const PICTURE = {
    annotations: [],
    asset_id: ASSET_B,
    frame_index: null,
    height: 48,
    width: 64,
    image_base64: "iVBORw0KGgo=",
    media_type: "image/png",
    original_height: 480,
    original_width: 640,
    source_name: null,
    variant: 0,
  };

  /** The Dataset page with `v1` split three ways, and a new recipe opened from its export. */
  async function openFromSplitRelease(): Promise<HTMLElement> {
    on("GET", /\/releases$/, { status: 200, body: { items: [SPLIT_RELEASE], total: 1 } });
    on("GET", new RegExp(`/releases/${RELEASE}/assignment$`), { status: 200, body: { train: [ASSET_B, ASSET_A], val: [ASSET_C], test: [ASSET_D] } });
    baseline();
    const exported = await openExport();
    await userEvent.click(within(exported).getByTestId("recipe-new"));
    const dialog = await screen.findByTestId("recipe-dialog");
    await within(dialog).findByTestId("recipe-editor");
    return dialog;
  }

  const count = (dialog: HTMLElement, row: string): string => within(dialog).getByTestId(`recipe-tally-${row}`).querySelector("dd")?.textContent ?? "";

  it("counts the release's folds, and what the variants add to the training split only", async () => {
    const dialog = await openFromSplitRelease();
    const tally = await within(dialog).findByTestId("recipe-tally-written");

    // The release the dialog was opened from is the one asked for, and named.
    expect(sent.some((r) => r.method === "GET" && pathOf(r) === `/releases/${RELEASE}/assignment`)).toBe(true);
    expect(within(dialog).getByTestId("recipe-tally").textContent).toContain("For v1");
    expect(count(dialog, "train")).toBe("2");
    expect(count(dialog, "val")).toBe("1");
    expect(count(dialog, "test")).toBe("1");
    expect(tally.querySelector("dd")?.textContent).toBe("4");
    expect(within(dialog).queryByTestId("recipe-tally-added")).toBeNull();

    await userEvent.click(within(dialog).getByTestId("augment-hflip"));
    await chooseVariants(dialog, 3);
    expect(count(dialog, "added")).toBe("+6");
    expect(count(dialog, "val")).toBe("1· unchanged");
    expect(count(dialog, "test")).toBe("1· unchanged");
    expect(count(dialog, "written")).toBe("10");
  });

  it("previews the release's first training image through the draft, and each variant on its tab", async () => {
    on("POST", /\/preprocessing-preview$/, { status: 200, body: PICTURE });
    const dialog = await openFromSplitRelease();

    const image = await within(dialog).findByTestId("recipe-preview-image", {}, { timeout: 2000 });
    expect(image.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(within(dialog).queryByTestId("recipe-stage")).toBeNull();
    const previews = (): Record<string, unknown>[] => sent.filter((r) => r.method === "POST" && pathOf(r).endsWith("/preprocessing-preview")).map(bodyOf);
    expect(previews()[0]).toMatchObject({ asset_id: ASSET_B, variant: 0, spec: { steps: [], variants_per_asset: 0 } });
    // No variants, no tabs: the original is all there is to show.
    expect(within(dialog).queryByTestId("recipe-preview-tabs")).toBeNull();

    await userEvent.click(within(dialog).getByTestId("augment-hflip"));
    await chooseVariants(dialog, 2);
    const tabs = await within(dialog).findByTestId("recipe-preview-tabs", {}, { timeout: 2000 });
    expect(within(tabs).getAllByRole("radio").map((one) => one.textContent)).toEqual(["Original", "Variant 1", "Variant 2"]);
    await userEvent.click(within(tabs).getByRole("radio", { name: "Variant 2" }));
    await waitFor(() => expect(previews().at(-1)).toMatchObject({ asset_id: ASSET_B, variant: 2, spec: { variants_per_asset: 2 } }));
  });

  it("draws the fit instead when the server refuses the picture, says why quietly, and the save is not held", async () => {
    on("POST", /\/preprocessing-preview$/, {
      status: 409,
      body: { code: "EXPORT_SOURCE_UNREADABLE", message: "asset bytes are gone" },
    });
    const dialog = await openFromSplitRelease();

    const said = await within(dialog).findByTestId("recipe-preview-error", {}, { timeout: 2000 });
    expect(said.textContent).not.toContain("EXPORT_SOURCE_UNREADABLE");
    expect(said.className).not.toContain("destructive");
    expect(within(dialog).getByTestId("recipe-stage")).not.toBeNull();
    expect(within(dialog).queryByTestId("recipe-preview-image")).toBeNull();
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", false);
  });

  it("says an unsplit release writes each asset once, and that variants need a split, without asking for folds", async () => {
    baseline();
    const exported = await openExport();
    await userEvent.click(within(exported).getByTestId("recipe-new"));
    const dialog = await screen.findByTestId("recipe-dialog");

    expect((await within(dialog).findByTestId("recipe-tally-written")).querySelector("dd")?.textContent).toBe("4· no split");
    await userEvent.click(within(dialog).getByTestId("augment-hflip"));
    expect(within(dialog).getByTestId("recipe-tally-no-split").textContent).toContain("v1 has no split. Variants are written for the training split only");
    expect(within(dialog).queryByTestId("recipe-tally-written")).toBeNull();
    expect(sent.some((r) => pathOf(r).endsWith("/assignment"))).toBe(false);
    // Nothing to preview without a training image: the fit is drawn.
    expect(within(dialog).getByTestId("recipe-stage")).not.toBeNull();
  });

  it("counts nothing and asks for nothing when opened without a release", async () => {
    baseline();
    const dialog = await openNew();
    await userEvent.click(within(dialog).getByTestId("augment-hflip"));

    expect(within(dialog).queryByTestId("recipe-tally")).toBeNull();
    expect(within(dialog).getByTestId("recipe-stage")).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sent.some((r) => pathOf(r).endsWith("/assignment") || pathOf(r).endsWith("/preprocessing-preview"))).toBe(false);
  });
});

describe("editing a stored recipe", () => {
  it("replaces it with PUT at its current name, and the save waits for a change", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    on("PUT", /\/preprocessing-recipes\/yolo-640$/, { status: 200, body: recipeRow("yolo-640", { ...LETTERBOX, variants_per_asset: 3 }) });
    const dialog = await openStored("yolo-640");

    // Nothing changed yet, so Save changes has nothing to save.
    expect(within(dialog).getByTestId("recipe-save").textContent).toContain("Save changes");
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", true);
    await chooseVariants(dialog, 3);
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", false);
    await userEvent.click(within(dialog).getByTestId("recipe-save"));

    const replace = () => sent.find((r) => r.method === "PUT");
    await waitFor(() => expect(replace()).not.toBeUndefined());
    expect(pathOf(replace() as Request)).toMatch(/\/preprocessing-recipes\/yolo-640$/);
    expect(bodyOf(replace() as Request)).toEqual({ name: "yolo-640", spec: { ...LETTERBOX, variants_per_asset: 3 } });
    expect((await within(dialog).findByTestId("recipe-saved")).textContent).toContain("Changes to yolo-640 are saved");

    // Keep editing returns to the recipe as saved, with nothing unsaved.
    await userEvent.click(within(dialog).getByTestId("recipe-saved-again"));
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", true);
  });

  it("asks before closing a changed recipe, and Discard closes without a request", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    const dialog = await openStored("yolo-640");
    const width = within(dialog).getByTestId("resize-width");
    await userEvent.clear(width);
    await userEvent.type(width, "320");

    await userEvent.keyboard("{Escape}");
    const ask = await screen.findByTestId("recipe-discard-dialog");
    expect(ask.textContent).toContain("Discard changes to yolo-640?");
    await userEvent.click(within(ask).getByTestId("recipe-discard-changes"));

    await waitFor(() => expect(screen.queryByTestId("recipe-dialog")).toBeNull());
    expect(sent.some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("deleting a recipe", () => {
  it("asks first, sends DELETE at the recipe's name, and the export falls back to No recipe", async () => {
    const stored = [recipeRow("yolo-640", LETTERBOX), recipeRow("wide-720", { ...LETTERBOX, target: "wide" })];
    handlers.push((request) => {
      if (request.method !== "GET" || !pathOf(request).endsWith("/preprocessing-recipes")) return undefined;
      const items = sent.some((r) => r.method === "DELETE") ? stored.slice(1) : stored;
      return { status: 200, body: { items, total: items.length } };
    });
    baseline();
    on("DELETE", /\/preprocessing-recipes\/yolo-640$/, { status: 204 });
    const exported = await openExport();
    await chooseRecipe(exported, "yolo-640");

    await recipeAction(exported, "delete");
    const dialog = await screen.findByTestId("delete-recipe-dialog");
    expect(dialog.textContent).toContain("Delete yolo-640?");
    expect(sent.some((r) => r.method === "DELETE")).toBe(false);
    await userEvent.click(within(dialog).getByTestId("delete-recipe-submit"));

    const remove = () => sent.find((r) => r.method === "DELETE");
    await waitFor(() => expect(remove()).not.toBeUndefined());
    expect(pathOf(remove() as Request)).toMatch(/\/preprocessing-recipes\/yolo-640$/);
    await waitFor(() => expect(screen.queryByTestId("delete-recipe-dialog")).toBeNull());
    // The recipe the export was set to is gone, so it runs without one, and the select no longer offers it.
    await waitFor(() => expect(chosen(exported)).toBe("No recipe"));
    expect(within(exported).queryByTestId("recipe-actions")).toBeNull();
    await waitFor(async () => {
      await userEvent.keyboard("{Escape}");
      expect(await recipeOptions(exported)).toEqual(["recipe-row-~none", "recipe-row-wide-720"]);
    });
    await userEvent.keyboard("{Escape}");
  });

  it("renders a refused delete as prose in the dialog, never as its code", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    on("DELETE", /\/preprocessing-recipes\/yolo-640$/, {
      status: 404,
      body: { code: "PREPROCESSING_RECIPE_NOT_FOUND", message: "project 1111 has no recipe named 'yolo-640'" },
    });
    const exported = await openExport();
    await chooseRecipe(exported, "yolo-640");

    await recipeAction(exported, "delete");
    await userEvent.click(await screen.findByTestId("delete-recipe-submit"));

    const said = (await screen.findByTestId("delete-recipe-error")).textContent ?? "";
    expect(said).toContain("no longer on record");
    expect(said).not.toContain("PREPROCESSING_RECIPE_NOT_FOUND");
    expect(said).not.toContain("1111");
    expect(screen.getByTestId("delete-recipe-dialog")).toBeTruthy();
    // Refused, so the export keeps the choice it had.
    expect(chosen(exported)).toBe("yolo-640");
  });

  it("can be cancelled without a request", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    const exported = await openExport();
    await chooseRecipe(exported, "yolo-640");

    await recipeAction(exported, "delete");
    await userEvent.click(await screen.findByTestId("delete-recipe-cancel"));

    await waitFor(() => expect(screen.queryByTestId("delete-recipe-dialog")).toBeNull());
    expect(sent.some((r) => r.method === "DELETE")).toBe(false);
    expect(chosen(exported)).toBe("yolo-640");
  });
});
