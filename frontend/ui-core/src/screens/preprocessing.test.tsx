/**
 * Recipes: a project resource chosen in a release's Export section and written
 * in a modal dialog over the page, one step at a time: Name and model, Resize,
 * Augmentation.
 *
 * Three parts. `recipeDraft` is pure and holds the rules a form restates — the
 * hints preselecting only untouched fields, the body's bounds, the cross-field
 * constraints — so those are asserted without a DOM. The editor's own rules
 * (its steps, fields, drawings, info cards, saving and discarding) are driven
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

/** A new recipe's dialog, on its first step. */
async function openNew(): Promise<HTMLElement> {
  renderWithData(<Host name={null} />);
  const dialog = await screen.findByTestId("recipe-dialog");
  await within(dialog).findByTestId("recipe-editor");
  return dialog;
}

/** A stored recipe's dialog, on its first step. */
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

/**
 * The radio of a recipe's row in the export's list (`~none` is No recipe).
 * `behindDialog` reads it while a recipe dialog is open over the page, which
 * hides the page from assistive technology.
 */
function radio(exported: HTMLElement, name: string, behindDialog = false): HTMLInputElement {
  return within(within(exported).getByTestId(`recipe-row-${name}`)).getByRole("radio", { hidden: behindDialog });
}

/** Choose a recipe in the export's list, once its row has arrived. */
async function chooseRecipe(exported: HTMLElement, name: string): Promise<void> {
  await within(exported).findByTestId(`recipe-row-${name}`);
  await userEvent.click(radio(exported, name));
}

/** Press Next, which moves one step on. */
const next = (dialog: HTMLElement): Promise<void> => userEvent.click(within(dialog).getByTestId("recipe-next"));
/** Press Previous, which moves one step back. */
const previous = (dialog: HTMLElement): Promise<void> => userEvent.click(within(dialog).getByTestId("recipe-previous"));
/** The step the dialog is on, by its header. */
const stepOf = (dialog: HTMLElement): string => `${within(dialog).getByTestId("recipe-step-title").textContent} ${within(dialog).getByTestId("recipe-step-count").textContent}`;

/** Move on to the Resize step. */
async function toResize(dialog: HTMLElement): Promise<void> {
  await next(dialog);
  await within(dialog).findByTestId("recipe-step-size");
}

/** Move on to the Augmentation step. */
async function toAugment(dialog: HTMLElement): Promise<void> {
  await toResize(dialog);
  await next(dialog);
  await within(dialog).findByTestId("recipe-step-augment");
}

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
  it("opens a stored recipe on its first step and fills each step from it", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    const dialog = await openStored("yolo-640");

    expect(stepOf(dialog)).toBe("Name and model 1/3");
    expect(within(dialog).getByTestId("recipe-editor").getAttribute("data-mode")).toBe("edit");
    expect(within(dialog).getByTestId("recipe-name")).toHaveProperty("value", "yolo-640");
    expect(within(dialog).getByTestId("recipe-target").textContent?.trim()).toBe("YOLO11");
    // The next steps are not drawn until they are reached.
    expect(within(dialog).queryByTestId("resize-width")).toBeNull();

    await toResize(dialog);
    expect(within(dialog).getByTestId("resize-letterbox").getAttribute("data-state")).toBe("on");
    expect(within(dialog).getByTestId("resize-width")).toHaveProperty("value", "640");

    await next(dialog);
    expect(within(dialog).getByTestId("augment-hflip").getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByTestId("augment-variants").textContent).toBe("2");
    // Nothing has changed, so there is nothing to save.
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", true);
  });

  it("walks the steps: the header follows, Previous goes back, and a step's problem holds only its own Next", async () => {
    baseline();
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);

    expect(stepOf(dialog)).toBe("Name and model 1/3");
    // Nowhere to go back to from the first step: Previous keeps its place but is hidden.
    expect(within(dialog).getByTestId("recipe-previous").className).toContain("invisible");
    expect(within(dialog).getByTestId("recipe-next").textContent).toContain("Next");

    await next(dialog);
    expect(stepOf(dialog)).toBe("Resize 2/3");
    expect(within(dialog).getByTestId("recipe-previous").className).not.toContain("invisible");

    // A bad width holds this step's Next, says why, and points the field at the message.
    const width = within(dialog).getByTestId("resize-width");
    await userEvent.clear(width);
    await userEvent.type(width, "16");
    expect(within(dialog).getByTestId("recipe-problem").textContent).toContain("32 to 8192");
    expect(width.getAttribute("aria-invalid")).toBe("true");
    expect(width.getAttribute("aria-describedby")).toBe("recipe-status");
    expect(within(dialog).getByTestId("recipe-problem").id).toBe("recipe-status");
    expect(within(dialog).getByTestId("recipe-next")).toHaveProperty("disabled", true);

    // Another step's Next is not held by it: Previous still goes back, and the first step moves on.
    await previous(dialog);
    expect(stepOf(dialog)).toBe("Name and model 1/3");
    expect(within(dialog).queryByTestId("recipe-problem")).toBeNull();
    expect(within(dialog).getByTestId("recipe-next")).toHaveProperty("disabled", false);

    // The bad width is still there to fix.
    await next(dialog);
    expect(within(dialog).getByTestId("resize-width")).toHaveProperty("value", "16");
    expect(within(dialog).getByTestId("recipe-next")).toHaveProperty("disabled", true);
    await userEvent.clear(within(dialog).getByTestId("resize-width"));
    await userEvent.type(within(dialog).getByTestId("resize-width"), "320");
    expect(within(dialog).getByTestId("recipe-next")).toHaveProperty("disabled", false);

    await next(dialog);
    expect(stepOf(dialog)).toBe("Augmentation 3/3");
    expect(within(dialog).queryByTestId("recipe-next")).toBeNull();
    expect(within(dialog).getByTestId("recipe-save").textContent).toContain("Create recipe");
  });

  it("holds the first step on a missing name, and Enter in a field moves on like Next", async () => {
    baseline();
    const dialog = await openNew();
    const name = within(dialog).getByTestId("recipe-name");

    await userEvent.clear(name);
    expect(within(dialog).getByTestId("recipe-problem").textContent).toContain("Enter a name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("recipe-status");
    expect(within(dialog).getByTestId("recipe-next")).toHaveProperty("disabled", true);
    await userEvent.type(name, "{Enter}");
    expect(stepOf(dialog)).toBe("Name and model 1/3");

    await userEvent.type(name, "plain{Enter}");
    await within(dialog).findByTestId("recipe-step-size");
    expect(stepOf(dialog)).toBe("Resize 2/3");
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

    const list = within(exported).getByTestId("export-recipe");
    await within(list).findByTestId("recipe-row-yolo-640");
    const rows = [...list.querySelectorAll("[data-testid^='recipe-row-']")].map((one) => one.getAttribute("data-testid"));
    expect(rows).toEqual(["recipe-row-~none", "recipe-row-yolo-640", "recipe-row-plain"]);
    expect(radio(exported, "~none").checked).toBe(true);
    expect(radio(exported, "yolo-640").checked).toBe(false);

    // The detail is on hover and, as words, with the radio for a screen reader.
    const said = (name: string): string => within(exported).getByTestId(`recipe-row-${name}`).querySelector("span.sr-only")?.textContent ?? "";
    expect(said("yolo-640")).toContain("Letterbox 640×640");
    expect(said("yolo-640")).toContain("For YOLO11");
    expect(said("plain")).toContain("No transform");
    expect(said("plain")).toContain("For any model");
    // Nothing is written until a row asks for it, and no recipe is chosen for the person.
    expect(screen.queryByTestId("recipe-dialog")).toBeNull();
    // Edit and Delete belong to a chosen recipe.
    expect(within(exported).queryByTestId("recipe-edit")).toBeNull();
    expect(within(exported).queryByTestId("recipe-delete")).toBeNull();
  });

  it("puts Edit and Delete on the chosen recipe's row alone", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX), recipeRow("plain", PLAIN)]);
    const exported = await openExport();
    await chooseRecipe(exported, "yolo-640");

    const edit = within(exported).getByTestId("recipe-edit");
    expect(within(exported).getByTestId("recipe-row-yolo-640").contains(edit)).toBe(true);
    expect(within(exported).getAllByTestId("recipe-delete")).toHaveLength(1);

    await chooseRecipe(exported, "plain");
    expect(within(exported).getByTestId("recipe-row-plain").contains(within(exported).getByTestId("recipe-edit"))).toBe(true);
    expect(within(exported).getByTestId("recipe-row-yolo-640").querySelector("[data-testid='recipe-edit']")).toBeNull();

    await chooseRecipe(exported, "~none");
    expect(within(exported).queryByTestId("recipe-edit")).toBeNull();
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

  it("writes a new recipe from the list's last row, and the saved recipe becomes the export's", async () => {
    let created = false;
    handlers.push((request) => {
      if (request.method !== "GET" || !pathOf(request).endsWith("/preprocessing-recipes")) return undefined;
      const items = created ? [recipeRow("recipe", PLAIN)] : [];
      return { status: 200, body: { items, total: items.length } };
    });
    baseline();
    on("POST", /\/preprocessing-recipes$/, { status: 201, body: recipeRow("recipe", PLAIN) });
    const exported = await openExport();
    expect(radio(exported, "~none").checked).toBe(true);

    await userEvent.click(within(exported).getByTestId("recipe-new"));
    const dialog = await screen.findByTestId("recipe-dialog");
    await within(dialog).findByTestId("recipe-editor");
    expect(within(dialog).getByTestId("recipe-editor").getAttribute("data-mode")).toBe("create");
    await toAugment(dialog);
    created = true;
    await userEvent.click(within(dialog).getByTestId("recipe-save"));
    const saved = await within(dialog).findByTestId("recipe-saved");
    await userEvent.click(within(saved).getByTestId("recipe-saved-done"));
    await waitFor(() => expect(screen.queryByTestId("recipe-dialog")).toBeNull());

    // The export now runs the recipe that was just written, and the list shows it chosen.
    await within(exported).findByTestId("recipe-row-recipe");
    await waitFor(() => expect(radio(exported, "recipe").checked).toBe(true));
    expect(radio(exported, "~none").checked).toBe(false);
  });

  it("opens the chosen recipe to edit, over the page, and the export keeps it chosen after a save", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    on("PUT", /\/preprocessing-recipes\/yolo-640$/, { status: 200, body: recipeRow("yolo-640", { ...LETTERBOX, variants_per_asset: 3 }) });
    const exported = await openExport();
    await chooseRecipe(exported, "yolo-640");

    await userEvent.click(within(exported).getByTestId("recipe-edit"));
    const dialog = await screen.findByTestId("recipe-dialog");
    await within(dialog).findByTestId("recipe-editor");
    expect(within(dialog).getByTestId("recipe-editor").getAttribute("data-mode")).toBe("edit");
    expect(within(dialog).getByTestId("recipe-name")).toHaveProperty("value", "yolo-640");
    // The export's section is still on the page beneath it.
    expect(screen.getByTestId("section-export")).not.toBeNull();

    await toAugment(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "More variants" }));
    await userEvent.click(within(dialog).getByTestId("recipe-save"));
    await within(dialog).findByTestId("recipe-saved");
    expect(sent.some((r) => r.method === "PUT")).toBe(true);
    await userEvent.click(within(dialog).getByTestId("recipe-saved-done"));
    await waitFor(() => expect(screen.queryByTestId("recipe-dialog")).toBeNull());
    expect(radio(exported, "yolo-640").checked).toBe(true);
  });

  it("asks before an edit's close throws changes away, and leaves the Export section and its choice standing", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    const exported = await openExport();
    await chooseRecipe(exported, "yolo-640");
    await userEvent.click(within(exported).getByTestId("recipe-edit"));
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
    expect(radio(exported, "yolo-640").checked).toBe(true);
    expect(sent.some((r) => r.method === "PUT")).toBe(false);
  });

  it("says when the recipes could not be read, and the export still runs without one", async () => {
    on("GET", /\/preprocessing-recipes$/, { status: 503, body: { code: "WORKSPACE_BUSY", message: "Busy." } });
    baseline();
    const exported = await openExport();

    const said = (await within(exported).findByTestId("export-recipes-error")).textContent ?? "";
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

    expect(stepOf(dialog)).toBe("Name and model 1/3");
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

    // The steps after it start from what the model recommends.
    await next(dialog);
    expect(within(dialog).getByTestId("resize-letterbox").getAttribute("data-state")).toBe("on");
    expect(within(dialog).getByTestId("resize-width")).toHaveProperty("value", "640");
    expect(within(dialog).getByTestId("resize-height")).toHaveProperty("value", "640");
    await next(dialog);
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
    await toResize(dialog);
    await userEvent.clear(within(dialog).getByTestId("resize-width"));
    await userEvent.type(within(dialog).getByTestId("resize-width"), "800");

    // Back on the first step, the model is changed under the typed width.
    await previous(dialog);
    await chooseTarget(/Wide/);
    await next(dialog);

    expect(within(dialog).getByTestId("resize-width")).toHaveProperty("value", "800");
    expect(within(dialog).getByTestId("resize-height")).toHaveProperty("value", "720");
    expect(within(dialog).getByTestId("resize-stretch").getAttribute("data-state")).toBe("on");
  });

  it("names the rule between Previous and Next, points the field at it, and holds the step until it is met", async () => {
    baseline();
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);
    await toResize(dialog);
    const width = within(dialog).getByTestId("resize-width");
    await userEvent.clear(width);
    await userEvent.type(width, "16");

    expect(within(dialog).getByTestId("recipe-problem").textContent).toContain("32 to 8192");
    expect(width.getAttribute("aria-invalid")).toBe("true");
    expect(width.getAttribute("aria-describedby")).toBe("recipe-status");
    expect(within(dialog).getByTestId("recipe-next")).toHaveProperty("disabled", true);
    // Enter in the field is Next, so it does not get past the problem either.
    await userEvent.type(width, "{Enter}");
    expect(stepOf(dialog)).toBe("Resize 2/3");

    await userEvent.clear(within(dialog).getByTestId("resize-width"));
    await userEvent.type(within(dialog).getByTestId("resize-width"), "320");
    expect(within(dialog).queryByTestId("recipe-problem")).toBeNull();
    expect(within(dialog).getByTestId("recipe-status").textContent).toBe("");
    expect(within(dialog).getByTestId("recipe-next")).toHaveProperty("disabled", false);
  });

  it("draws what the fit does at the size, and the option pointed at before it is chosen", async () => {
    baseline();
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);
    await toResize(dialog);

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

    await userEvent.click(within(dialog).getByTestId("resize-none"));
    pointerLeaves(within(dialog).getByTestId("resize-none"), dialog);
    expect(within(dialog).getByTestId("recipe-stage-caption").textContent).toBe("Keeps each image at its own size.");
  });

  it("disables the size where it stands when the fit keeps each image's own size, so nothing can be typed into it", async () => {
    baseline();
    const dialog = await openNew();
    await toResize(dialog);
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

  it("opens brightness's amount under its switch only while the switch is on", async () => {
    baseline();
    const dialog = await openNew();
    await toAugment(dialog);
    expect(within(dialog).queryByRole("slider")).toBeNull();

    await userEvent.click(within(dialog).getByTestId("augment-brightness_contrast"));
    const slider = await within(dialog).findByRole("slider");
    // Drawn as Brightness's child: a branch from under its label, hidden from assistive technology.
    expect(within(dialog).getByTestId("recipe-amount-branch").getAttribute("aria-hidden")).toBe("true");
    // Its row follows the switch's and comes before Rotate's.
    const rotate = within(dialog).getByRole("switch", { name: "Rotate" });
    expect(slider.compareDocumentPosition(rotate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "Brightness" }).compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(within(dialog).getByTestId("augment-brightness_contrast"));
    await waitFor(() => expect(within(dialog).queryByRole("slider")).toBeNull());
  });

  it("switches the first augmentation on with one variant, and clears the count with the last", async () => {
    baseline();
    const dialog = await openNew();
    await toAugment(dialog);

    await userEvent.click(within(dialog).getByTestId("augment-brightness_contrast"));
    expect(within(dialog).getByTestId("augment-variants").textContent).toBe("1");
    await userEvent.click(within(dialog).getByTestId("augment-brightness_contrast"));
    expect(within(dialog).getByTestId("augment-variants").textContent).toBe("0");
    expect(within(dialog).getByRole("button", { name: "More variants" })).toHaveProperty("disabled", true);
    // What variants are for is one press away, not a line under the row.
    expect(await variantsNote(dialog)).toContain("training split");
  });

  it("draws what each augmentation does in a card beside its label, and one Escape closes only the card", async () => {
    baseline();
    const dialog = await openNew();
    await toAugment(dialog);

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
    await toAugment(dialog);

    const flip = within(dialog).getByRole("switch", { name: "Flip" });
    expect(flip.getAttribute("aria-describedby")).toBe("augment-hflip-detail");
    // Said once on screen, in the info card; the switch carries the same words for a screen reader only.
    const detail = dialog.querySelector("#augment-hflip-detail");
    expect(detail?.textContent).toBe("Mirrors left to right. Its labels are mirrored with it.");
    expect(detail?.classList.contains("sr-only")).toBe(true);
    expect(within(dialog).getByRole("switch", { name: "Brightness" })).not.toBeNull();
    expect(within(dialog).getByRole("switch", { name: "Rotate" })).not.toBeNull();
  });

  it("creates the recipe the steps describe, and says it is ready", async () => {
    baseline();
    on("POST", /\/preprocessing-recipes$/, { status: 201, body: recipeRow("yolo-640", LETTERBOX) });
    const dialog = await openNew();
    await chooseTarget(/YOLO11/);
    const name = within(dialog).getByTestId("recipe-name");
    await userEvent.clear(name);
    await userEvent.type(name, "yolo-640");
    expect(within(dialog).queryByTestId("recipe-name-suggested")).toBeNull();
    await toAugment(dialog);
    await userEvent.click(within(dialog).getByTestId("augment-hflip"));
    await userEvent.click(within(dialog).getByTestId("augment-brightness_contrast"));
    // The amount, from 0.20 to 0.30 in two of its 0.05 steps.
    const amount = within(dialog).getByRole("slider", { name: "Amount" });
    amount.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await userEvent.click(within(dialog).getByRole("button", { name: "More variants" }));

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

  it("renders a refused save as prose between Previous and Save, never as its code, until the draft changes", async () => {
    baseline();
    on("POST", /\/preprocessing-recipes$/, {
      status: 409,
      body: { code: "PREPROCESSING_RECIPE_NAME_TAKEN", message: "project 1111 already has a recipe named 'yolo-640'" },
    });
    const dialog = await openNew();
    await toAugment(dialog);
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
    // The model is optional: the recipe can still be taken to the end and created without one.
    expect(within(dialog).getByTestId("recipe-next")).toHaveProperty("disabled", false);
    await toAugment(dialog);
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", false);
  });
});

describe("editing a stored recipe", () => {
  it("replaces it with PUT at its current name, and the save waits for a change", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    on("PUT", /\/preprocessing-recipes\/yolo-640$/, { status: 200, body: recipeRow("yolo-640", { ...LETTERBOX, variants_per_asset: 3 }) });
    const dialog = await openStored("yolo-640");
    await toAugment(dialog);

    // Nothing changed yet, so Save changes has nothing to save.
    expect(within(dialog).getByTestId("recipe-save").textContent).toContain("Save changes");
    expect(within(dialog).getByTestId("recipe-save")).toHaveProperty("disabled", true);
    await userEvent.click(within(dialog).getByRole("button", { name: "More variants" }));
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
    await toResize(dialog);
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

    await userEvent.click(within(exported).getByTestId("recipe-delete"));
    const dialog = await screen.findByTestId("delete-recipe-dialog");
    expect(dialog.textContent).toContain("Delete yolo-640?");
    expect(sent.some((r) => r.method === "DELETE")).toBe(false);
    await userEvent.click(within(dialog).getByTestId("delete-recipe-submit"));

    const remove = () => sent.find((r) => r.method === "DELETE");
    await waitFor(() => expect(remove()).not.toBeUndefined());
    expect(pathOf(remove() as Request)).toMatch(/\/preprocessing-recipes\/yolo-640$/);
    await waitFor(() => expect(screen.queryByTestId("delete-recipe-dialog")).toBeNull());
    await waitFor(() => expect(within(exported).queryByTestId("recipe-row-yolo-640")).toBeNull());
    expect(within(exported).getByTestId("recipe-row-wide-720")).not.toBeNull();
    // The recipe the export was set to is gone, so it runs without one.
    expect(radio(exported, "~none").checked).toBe(true);
    expect(within(exported).queryByTestId("recipe-edit")).toBeNull();
  });

  it("renders a refused delete as prose in the dialog, never as its code", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    on("DELETE", /\/preprocessing-recipes\/yolo-640$/, {
      status: 404,
      body: { code: "PREPROCESSING_RECIPE_NOT_FOUND", message: "project 1111 has no recipe named 'yolo-640'" },
    });
    const exported = await openExport();
    await chooseRecipe(exported, "yolo-640");

    await userEvent.click(within(exported).getByTestId("recipe-delete"));
    await userEvent.click(await screen.findByTestId("delete-recipe-submit"));

    const said = (await screen.findByTestId("delete-recipe-error")).textContent ?? "";
    expect(said).toContain("no longer on record");
    expect(said).not.toContain("PREPROCESSING_RECIPE_NOT_FOUND");
    expect(said).not.toContain("1111");
    expect(screen.getByTestId("delete-recipe-dialog")).toBeTruthy();
    // Refused, so the export keeps the choice it had.
    expect(radio(exported, "yolo-640", true).checked).toBe(true);
  });

  it("can be cancelled without a request", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    const exported = await openExport();
    await chooseRecipe(exported, "yolo-640");

    await userEvent.click(within(exported).getByTestId("recipe-delete"));
    await userEvent.click(await screen.findByTestId("delete-recipe-cancel"));

    await waitFor(() => expect(screen.queryByTestId("delete-recipe-dialog")).toBeNull());
    expect(sent.some((r) => r.method === "DELETE")).toBe(false);
    expect(radio(exported, "yolo-640").checked).toBe(true);
  });
});
