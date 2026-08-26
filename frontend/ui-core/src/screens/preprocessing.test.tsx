/**
 * The Pre-processing view: recipes as a project resource, the editor's four
 * steps, and the preview through the export's own path.
 *
 * Two halves. `recipeDraft` is pure and holds the rules a form restates — the
 * hints preselecting only untouched fields, the body's bounds, the cross-field
 * constraints — so those are asserted without a DOM. The screen tests drive
 * the tab through a stubbed wire and assert what a person sees and what the
 * server was sent.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { DatasetScreen } from "./DatasetScreen";
import { PreprocessingTab } from "./PreprocessingTab";
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

const API = "http://visionset.test";
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

function recipeRow(name: string, spec: RecipeSpec) {
  return {
    id: `cccccccc-0000-4000-8000-${name.padStart(12, "0")}`,
    project_id: PROJECT,
    name,
    spec,
    created_at: "2026-08-20T10:00:00.000000Z",
    updated_at: "2026-08-20T10:00:00.000000Z",
  };
}

function assetRow(id: string) {
  return {
    id,
    project_id: PROJECT,
    modality: "image",
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

/** One rendering, carrying one placed box so the overlay has something to draw. */
function previewRow(assetId: string, variant: number) {
  return {
    asset_id: assetId,
    variant,
    width: 512,
    height: 384,
    annotations: [
      {
        id: variant === 0 ? "box-1" : `box-1-aug${variant}`,
        label_class: "car",
        schema_version: 1,
        geometry: { type: "bbox", x: 10, y: 20, width: 100, height: 50 },
        attributes: {},
        provenance: "human",
        model_ref: null,
        confidence: null,
      },
    ],
    image_base64: "aGVsbG8=",
    media_type: "image/png",
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
  handlers = [];
  sent.length = 0;
  bodies.clear();
  writeToken("a-token");
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

function mount(node: ReactNode): JSX.Element {
  return (
    <ApiProvider
      baseUrl={API}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </ApiProvider>
  );
}

function pathOf(request: Request): string {
  return new URL(request.url).pathname;
}

function bodyOf(request: Request): Record<string, unknown> {
  return JSON.parse(bodies.get(request) ?? "{}") as Record<string, unknown>;
}

/** Every read the tab makes, with the project holding four assets and no release. */
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
  on("GET", /\/releases$/, { status: 200, body: { items: [], total: 0 } });
  on("GET", /\/projects\/[^/]+\/assets$/, {
    status: 200,
    body: { items: [ASSET_A, ASSET_B, ASSET_C, ASSET_D].map(assetRow), total: 4 },
  });
  handlers.push((request) => {
    if (request.method !== "POST" || !pathOf(request).endsWith("/preprocessing-preview")) return undefined;
    const body = bodyOf(request);
    return { status: 200, body: previewRow(String(body["asset_id"]), Number(body["variant"])) };
  });
}

/** Choose a target through the grouped picker. */
async function chooseTarget(label: RegExp): Promise<void> {
  await userEvent.click(screen.getByTestId("recipe-target"));
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

describe("the dataset's tab roster", () => {
  it("carries Pre-processing between Assets and Releases, with the recipe count", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    on("GET", /\/stats$/, {
      status: 200,
      body: { dataset_id: DATASET, asset_count: 0, annotated_asset_count: 0, annotation_count: 0, classes: [] },
    });
    render(mount(<DatasetScreen projectId={PROJECT} />));

    const tabs = await screen.findByTestId("dataset-tabs");
    const labels = within(tabs)
      .getAllByRole("tab")
      .map((tab) => tab.getAttribute("data-testid"));
    expect(labels).toEqual([
      "dataset-tab-overview",
      "dataset-tab-assets",
      "dataset-tab-preprocessing",
      "dataset-tab-releases",
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("dataset-tab-preprocessing").textContent).toContain("1"),
    );
  });

  it("opens on the view the host names, and hands a normalised one back", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    const changed = vi.fn();
    render(mount(<DatasetScreen projectId={PROJECT} tab="preprocessing" onTabChange={changed} />));

    expect(await screen.findByTestId("preprocessing-tab")).not.toBeNull();
    await userEvent.click(screen.getByTestId("dataset-tab-assets"));
    expect(changed).toHaveBeenCalledWith("assets");
  });
});

describe("the recipe list", () => {
  it("lists every recipe with its summary and the target's label, and opens the first", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX), recipeRow("plain", { target: null, steps: [], variants_per_asset: 0 })]);
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));

    const row = await screen.findByTestId("recipe-yolo-640");
    expect(row.textContent).toContain("letterbox 640×640");
    expect(row.textContent).toContain("YOLO11");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("recipe-plain").textContent).toContain("No transform");
    expect(screen.getByTestId("recipe-list-note").textContent).toContain("Applied at export");
    // The open recipe's fields, as stored.
    expect(screen.getByTestId("recipe-name")).toHaveProperty("value", "yolo-640");
    expect(screen.getByTestId("resize-width")).toHaveProperty("value", "640");
    expect(screen.getByTestId("augment-hflip")).toHaveProperty("checked", true);
    expect(screen.getByTestId("augment-variants")).toHaveProperty("value", "2");
  });

  it("is an invitation with one verb-first action while there are none", async () => {
    baseline();
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));

    const empty = await screen.findByTestId("recipes-empty");
    expect(within(empty).getAllByRole("button")).toHaveLength(1);
    await userEvent.click(within(empty).getByTestId("recipe-new"));
    expect(await screen.findByTestId("recipe-editor")).not.toBeNull();
    expect(screen.getByTestId("recipe-footer-note").textContent).toContain("A recipe needs a name");
  });

  it("says when the recipes could not be read, rather than showing an empty list", async () => {
    on("GET", /\/preprocessing-recipes$/, { status: 503, body: { code: "WORKSPACE_BUSY", message: "Busy." } });
    baseline();
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));

    const said = (await screen.findByTestId("recipes-error")).textContent ?? "";
    expect(said).toContain("busy");
    expect(screen.queryByTestId("recipes-empty")).toBeNull();
  });
});

describe("the editor", () => {
  it("presets the resize from the target's hints and marks the suggestion", async () => {
    baseline();
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await userEvent.click(await screen.findByTestId("recipe-new"));

    expect(screen.getByTestId("recipe-step-target").getAttribute("data-state")).toBe("upcoming");
    await chooseTarget(/YOLO11/);

    expect(screen.getByTestId("recipe-step-target").getAttribute("data-state")).toBe("complete");
    expect(screen.getByTestId("recipe-target-meta").textContent).toContain("Ultralytics YOLO");
    expect(screen.getByTestId("recipe-target-meta").textContent).toContain("detect, segment");
    expect(screen.getByTestId("recipe-target-carries").textContent).toContain("boxes and polygons");
    expect(screen.getByTestId("recipe-target-carries").textContent).toContain("2 classes");
    expect(screen.getByTestId("resize-ambient").textContent).toContain("YOLO11 letterboxes to 640 on its own");
    expect(screen.getByTestId("resize-letterbox").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("resize-letterbox-suggested")).not.toBeNull();
    expect(screen.getByTestId("resize-width")).toHaveProperty("value", "640");
    expect(screen.getByTestId("resize-height")).toHaveProperty("value", "640");
    expect(screen.getByTestId("resize-pad")).toHaveProperty("value", "114");
    expect(screen.getByTestId("resize-geometry").textContent).toContain("Geometry exact");
    expect(screen.getByTestId("augment-ambient").textContent).toContain("usual practice");
  });

  it("keeps a typed size when the target changes, and moves the rest", async () => {
    baseline();
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await userEvent.click(await screen.findByTestId("recipe-new"));
    await chooseTarget(/YOLO11/);
    await userEvent.clear(screen.getByTestId("resize-width"));
    await userEvent.type(screen.getByTestId("resize-width"), "800");

    await chooseTarget(/Wide/);

    expect(screen.getByTestId("resize-width")).toHaveProperty("value", "800");
    expect(screen.getByTestId("resize-height")).toHaveProperty("value", "720");
    expect(screen.getByTestId("resize-stretch").getAttribute("aria-pressed")).toBe("true");
  });

  it("names the rule beside the field and keeps Save shut with the reason in the footer", async () => {
    baseline();
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await userEvent.click(await screen.findByTestId("recipe-new"));
    await userEvent.type(screen.getByTestId("recipe-name"), "small");
    await chooseTarget(/YOLO11/);
    await userEvent.clear(screen.getByTestId("resize-width"));
    await userEvent.type(screen.getByTestId("resize-width"), "16");

    expect(screen.getByTestId("resize-problem").textContent).toContain("32 to 8192");
    expect(screen.getByTestId("recipe-step-resize").getAttribute("data-state")).toBe("upcoming");
    expect(screen.getByTestId("recipe-save")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("recipe-footer-note").textContent).toContain("32 to 8192");
  });

  it("ticks the first augmentation with one variant, and clears the count with the last", async () => {
    baseline();
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await userEvent.click(await screen.findByTestId("recipe-new"));

    await userEvent.click(screen.getByTestId("augment-brightness_contrast"));
    expect(screen.getByTestId("augment-variants")).toHaveProperty("value", "1");
    expect(screen.getByTestId("augment-amount")).toHaveProperty("value", "0.2");
    await userEvent.click(screen.getByTestId("augment-brightness_contrast"));
    expect(screen.getByTestId("augment-variants")).toHaveProperty("value", "0");
    expect(screen.queryByTestId("augment-amount")).toBeNull();
    expect(screen.getByTestId("augment-ambient-split").textContent).toContain("train fold");
  });

  it("creates a new recipe with the spec the steps describe", async () => {
    baseline();
    on("POST", /\/preprocessing-recipes$/, { status: 201, body: recipeRow("yolo-640", LETTERBOX) });
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await userEvent.click(await screen.findByTestId("recipe-new"));
    await userEvent.type(screen.getByTestId("recipe-name"), "yolo-640");
    await chooseTarget(/YOLO11/);
    await userEvent.click(screen.getByTestId("augment-hflip"));
    await userEvent.click(screen.getByTestId("augment-brightness_contrast"));
    await userEvent.clear(screen.getByTestId("augment-amount"));
    await userEvent.type(screen.getByTestId("augment-amount"), "0.3");
    await userEvent.clear(screen.getByTestId("augment-variants"));
    await userEvent.type(screen.getByTestId("augment-variants"), "2");
    expect(screen.getByTestId("recipe-footer-note").textContent).toContain("Unsaved changes");

    await userEvent.click(screen.getByTestId("recipe-save"));

    const create = () =>
      sent.find((r) => r.method === "POST" && pathOf(r).endsWith("/preprocessing-recipes"));
    await waitFor(() => expect(create()).not.toBeUndefined());
    expect(bodyOf(create() as Request)).toEqual({ name: "yolo-640", spec: LETTERBOX });
    // Saved: the footer says so and the row is selected.
    await waitFor(() => expect(screen.getByTestId("recipe-footer-note").textContent).toContain("No unsaved changes"));
  });

  it("replaces an open recipe with PUT, at its current name", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    on("PUT", /\/preprocessing-recipes\/yolo-640$/, {
      status: 200,
      body: recipeRow("yolo-640", { ...LETTERBOX, variants_per_asset: 3 }),
    });
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await screen.findByTestId("recipe-editor");
    expect(screen.getByTestId("recipe-save")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("recipe-footer-note").textContent).toContain("No unsaved changes");

    await userEvent.clear(screen.getByTestId("augment-variants"));
    await userEvent.type(screen.getByTestId("augment-variants"), "3");
    await userEvent.click(screen.getByTestId("recipe-save"));

    const replace = () => sent.find((r) => r.method === "PUT");
    await waitFor(() => expect(replace()).not.toBeUndefined());
    expect(pathOf(replace() as Request)).toMatch(/\/preprocessing-recipes\/yolo-640$/);
    expect(bodyOf(replace() as Request)).toEqual({
      name: "yolo-640",
      spec: { ...LETTERBOX, variants_per_asset: 3 },
    });
  });

  it("discards back to the stored recipe", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await screen.findByTestId("recipe-editor");
    expect(screen.getByTestId("recipe-discard")).toHaveProperty("disabled", true);

    await userEvent.clear(screen.getByTestId("resize-width"));
    await userEvent.type(screen.getByTestId("resize-width"), "320");
    expect(screen.getByTestId("recipe-discard")).toHaveProperty("disabled", false);
    await userEvent.click(screen.getByTestId("recipe-discard"));

    expect(screen.getByTestId("resize-width")).toHaveProperty("value", "640");
    expect(sent.some((r) => r.method === "PUT")).toBe(false);
  });

  it("renders a refused save as prose, never as its code", async () => {
    baseline();
    on("POST", /\/preprocessing-recipes$/, {
      status: 409,
      body: { code: "PREPROCESSING_RECIPE_NAME_TAKEN", message: "project 1111 already has a recipe named 'yolo-640'" },
    });
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await userEvent.click(await screen.findByTestId("recipe-new"));
    await userEvent.type(screen.getByTestId("recipe-name"), "yolo-640");
    await userEvent.click(screen.getByTestId("recipe-save"));

    const said = (await screen.findByTestId("recipe-save-error")).textContent ?? "";
    expect(said).toContain("already exists");
    expect(said).not.toContain("PREPROCESSING_RECIPE_NAME_TAKEN");
    expect(said).not.toContain("1111");
  });
});

describe("deleting a recipe", () => {
  it("asks first, sends DELETE at the recipe's name, and the row leaves the list", async () => {
    const stored = [recipeRow("yolo-640", LETTERBOX), recipeRow("wide-720", { ...LETTERBOX, target: "wide" })];
    handlers.push((request) => {
      if (request.method !== "GET" || !pathOf(request).endsWith("/preprocessing-recipes")) return undefined;
      const items = sent.some((r) => r.method === "DELETE") ? stored.slice(1) : stored;
      return { status: 200, body: { items, total: items.length } };
    });
    baseline();
    on("DELETE", /\/preprocessing-recipes\/yolo-640$/, { status: 204 });
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await screen.findByTestId("recipe-editor");
    expect(screen.getByTestId("recipe-yolo-640").getAttribute("aria-current")).toBe("true");

    await userEvent.click(screen.getByTestId("recipe-delete-yolo-640"));
    const dialog = await screen.findByTestId("delete-recipe-dialog");
    expect(dialog.textContent).toContain("Delete yolo-640?");
    expect(sent.some((r) => r.method === "DELETE")).toBe(false);
    await userEvent.click(within(dialog).getByTestId("delete-recipe-submit"));

    const remove = () => sent.find((r) => r.method === "DELETE");
    await waitFor(() => expect(remove()).not.toBeUndefined());
    expect(pathOf(remove() as Request)).toMatch(/\/preprocessing-recipes\/yolo-640$/);
    await waitFor(() => expect(screen.queryByTestId("delete-recipe-dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("recipe-yolo-640")).toBeNull());
    // The editor held the deleted one, so it moves to the recipe that is left.
    expect(screen.getByTestId("recipe-wide-720").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("recipe-name")).toHaveProperty("value", "wide-720");
  });

  it("returns to the invitation when the last recipe goes", async () => {
    const stored = [recipeRow("yolo-640", LETTERBOX)];
    handlers.push((request) => {
      if (request.method !== "GET" || !pathOf(request).endsWith("/preprocessing-recipes")) return undefined;
      const items = sent.some((r) => r.method === "DELETE") ? [] : stored;
      return { status: 200, body: { items, total: items.length } };
    });
    baseline();
    on("DELETE", /\/preprocessing-recipes\/yolo-640$/, { status: 204 });
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await screen.findByTestId("recipe-editor");

    await userEvent.click(screen.getByTestId("recipe-delete-yolo-640"));
    await userEvent.click(await screen.findByTestId("delete-recipe-submit"));

    await screen.findByTestId("recipes-empty");
    expect(screen.queryByTestId("recipe-editor")).toBeNull();
  });

  it("renders a refused delete as prose in the dialog, never as its code", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    on("DELETE", /\/preprocessing-recipes\/yolo-640$/, {
      status: 404,
      body: { code: "PREPROCESSING_RECIPE_NOT_FOUND", message: "project 1111 has no recipe named 'yolo-640'" },
    });
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await screen.findByTestId("recipe-editor");

    await userEvent.click(screen.getByTestId("recipe-delete-yolo-640"));
    await userEvent.click(await screen.findByTestId("delete-recipe-submit"));

    const said = (await screen.findByTestId("delete-recipe-error")).textContent ?? "";
    expect(said).toContain("no longer on record");
    expect(said).not.toContain("PREPROCESSING_RECIPE_NOT_FOUND");
    expect(said).not.toContain("1111");
    expect(document.body.textContent).not.toContain("PREPROCESSING_RECIPE_NOT_FOUND");
    // The dialog stays up holding the refusal, and the editor still holds the recipe.
    expect(screen.getByTestId("delete-recipe-dialog")).toBeTruthy();
    expect(screen.getByTestId("recipe-editor")).toBeTruthy();
  });

  it("can be cancelled without a request", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));
    await screen.findByTestId("recipe-editor");

    await userEvent.click(screen.getByTestId("recipe-delete-yolo-640"));
    await userEvent.click(await screen.findByTestId("delete-recipe-cancel"));

    await waitFor(() => expect(screen.queryByTestId("delete-recipe-dialog")).toBeNull());
    expect(sent.some((r) => r.method === "DELETE")).toBe(false);
    expect(screen.getByTestId("recipe-yolo-640").getAttribute("aria-current")).toBe("true");
  });
});

describe("the preview", () => {
  it("samples the project's first three assets when no release has a split, and renders each stage", async () => {
    baseline([recipeRow("yolo-640", LETTERBOX)]);
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));

    const grid = await screen.findByTestId("preview-grid");
    expect(within(grid).getAllByTestId(/^preview-row-/)).toHaveLength(3);
    expect(screen.getByTestId("preview-aside").textContent).toBe("3 sample assets · seeded");

    await waitFor(() =>
      expect(screen.getByTestId("preview-0-augment").getAttribute("data-state")).toBe("rendered"),
    );
    // The original is the asset through no transform; the resize column the
    // resize step alone; the augmentation column variant 1 of the whole spec.
    const previews = sent.filter((r) => r.method === "POST" && pathOf(r).endsWith("/preprocessing-preview"));
    const forFirst = previews.filter((r) => bodyOf(r)["asset_id"] === ASSET_A).map(bodyOf);
    const specs = forFirst.map((body) => ({
      variant: body["variant"],
      steps: (body["spec"] as RecipeSpec).steps.map((step) => step.kind),
    }));
    expect(specs).toContainEqual({ variant: 0, steps: [] });
    expect(specs).toContainEqual({ variant: 0, steps: ["resize"] });
    expect(specs).toContainEqual({ variant: 1, steps: ["resize", "augment", "augment"] });
    expect(previews.some((r) => bodyOf(r)["asset_id"] === ASSET_D)).toBe(false);
    const original = screen.getByTestId("preview-0-original");
    const image = original.querySelector("img");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    // The placed label, drawn by the static overlay in the rendering's own frame.
    expect(within(original).getByTestId("preview-overlay").getAttribute("viewBox")).toBe("0 0 512 384");
    expect(within(original).getByTestId("preview-shape-box-1")).not.toBeNull();
    expect(within(screen.getByTestId("preview-0-augment")).getByTestId("preview-shape-box-1-aug1")).not.toBeNull();
    expect(screen.getByTestId("recipe-step-preview").getAttribute("data-state")).toBe("complete");
  });

  it("samples the newest release's train fold when it has a split", async () => {
    on("GET", /\/releases$/, {
      status: 200,
      body: {
        items: [
          {
            id: RELEASE,
            dataset_id: DATASET,
            tag: "v1",
            manifest_hash: "abcdef0123456789",
            schema_version: 1,
            asset_count: 4,
            annotation_count: 0,
            split: { train: 0.5, val: 0.25, test: 0.25, seed: 0 },
            created_at: "2026-08-01T10:00:00.000000Z",
            visionset_version: "0.0.1.dev0",
          },
        ],
        total: 1,
      },
    });
    on("GET", /\/assignment$/, {
      status: 200,
      body: { train: [ASSET_C, ASSET_D], val: [ASSET_A], test: [ASSET_B] },
    });
    baseline([recipeRow("plain", { target: null, steps: [], variants_per_asset: 0 })]);
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));

    await screen.findByTestId("preview-grid");
    await waitFor(() =>
      expect(screen.getByTestId("preview-1-original").getAttribute("data-state")).toBe("rendered"),
    );
    const sampled = new Set(
      sent
        .filter((r) => r.method === "POST" && pathOf(r).endsWith("/preprocessing-preview"))
        .map((r) => bodyOf(r)["asset_id"]),
    );
    expect(sampled).toEqual(new Set([ASSET_C, ASSET_D]));
    // No resize step and no augmentation: the two stages say so rather than
    // repeating the original.
    expect(screen.getByTestId("preview-0-resize").textContent).toContain("No resize step");
    expect(screen.getByTestId("preview-0-augment").textContent).toContain("No augmentation");
  });

  it("shows a refused rendering as prose in the cell", async () => {
    baseline([recipeRow("plain", { target: null, steps: [], variants_per_asset: 0 })]);
    handlers.unshift((request) =>
      request.method === "POST" && pathOf(request).endsWith("/preprocessing-preview")
        ? { status: 422, body: { code: "UNSUPPORTED_MEDIA", message: "That file is not an image this server reads." } }
        : undefined,
    );
    render(mount(<PreprocessingTab projectId={PROJECT} datasetId={DATASET} />));

    await screen.findByTestId("preview-grid");
    await waitFor(() =>
      expect(screen.getByTestId("preview-0-original").getAttribute("data-state")).toBe("error"),
    );
    const cell = screen.getByTestId("preview-0-original");
    expect(cell.textContent).toContain("not an image");
    expect(cell.textContent).not.toContain("UNSUPPORTED_MEDIA");
  });
});
