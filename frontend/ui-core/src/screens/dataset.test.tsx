/**
 * The publication tail: the line of versions, publishing, verifying and export.
 *
 * A release is opened from the version panel (`version-v1`); its facts (integrity,
 * manifest, split) sit at the top of that panel, and so does its export, as the last
 * section. There is no tab and no dialog to reach any of it by.
 *
 * The claim worth the file is the **third gate word**. `confirm=` guards destroying
 * data, `allow_destructive=` guards narrowing a contract, and `allow_lossy=` guards
 * emitting an incomplete copy of something that stays intact — and the kernel is
 * emphatic that the three are never caught together. The form does not call the
 * compatibility route, so the consent flow is attempt → read the 409 → ask → retry
 * with the flag, and the test drives all four steps.
 */

import { QueryClient } from "@tanstack/react-query";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DatasetScreen } from "./DatasetScreen";
import { renderWithData } from "../testing/dataHarness";

// The four list fields `FormatOut` declares with a default. A default means the
// server serializes them every time, which is why the contract types them as always
// present rather than optional.
const FORMAT_REST = { geometries: [], modalities: [], degraded_geometries: [], targets: [] } as const;
const HINTS = {
  recommended_size: [640, 640],
  recommended_strategy: "letterbox",
  trainer_resizes: true,
  augmentation_common: true,
} as const;
const NO_HINTS = {
  recommended_size: null,
  recommended_strategy: null,
  trainer_resizes: true,
  augmentation_common: false,
} as const;

/**
 * A catalog with one target under each heading, and two under the first so the
 * order within a group is visible. `dummy` carries no task vocabulary, so its
 * second line has to come from its geometries — the other branch of the meta.
 */
const TARGETS = [
  {
    name: "dummy",
    label: "dummy",
    family: "other",
    format: "dummy",
    tasks: [],
    geometries: ["bbox", "polygon"],
    hints: NO_HINTS,
  },
  {
    name: "yolo11",
    label: "YOLO11",
    family: "ultralytics-yolo",
    format: "ultralytics",
    tasks: ["detect", "segment", "classify", "pose", "obb"],
    geometries: ["bbox", "polygon", "classification_tag"],
    hints: HINTS,
  },
  {
    name: "yolov10",
    label: "YOLOv10",
    family: "ultralytics-yolo",
    format: "ultralytics",
    tasks: ["detect"],
    geometries: ["bbox"],
    hints: HINTS,
  },
  {
    name: "yolov7",
    label: "YOLOv7",
    family: "community-yolo",
    format: "yolov5-yaml",
    tasks: ["detect"],
    geometries: ["bbox"],
    hints: HINTS,
  },
];

const PROJECT = "11111111-1111-4111-8111-111111111111";
const DATASET = "22222222-2222-4222-8222-222222222222";
const RELEASE = "33333333-3333-4333-8333-333333333333";
const EXPORT_JOB = "44444444-4444-4444-8444-444444444444";

// The browser's save is a download the page cannot observe; what it was asked to save is the claim.
const saved: { readonly blob: Blob; readonly name: string }[] = [];
vi.mock("./download", () => ({
  saveBlob: (blob: Blob, name: string) => {
    saved.push({ blob, name });
  },
}));

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];
const bodies = new Map<Request, string>();

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  bodies.clear();
  saved.length = 0;
  // Radix positions a popover and a card with it; jsdom has none, and nothing here measures.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
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

/** What a warning says: its button's name — the title — and the description under it. */
function warningSaid(button: HTMLElement): string {
  const described = button.getAttribute("aria-describedby");
  const body = described === null ? "" : (document.getElementById(described)?.textContent ?? "");
  return `${button.getAttribute("aria-label") ?? ""} ${body}`;
}

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname) ? answer : undefined,
  );
}

const RELEASE_ROW = {
  id: RELEASE,
  dataset_id: DATASET,
  tag: "v1",
  manifest_hash: "abcdef0123456789",
  schema_version: 3,
  asset_count: 12,
  annotation_count: 40,
  split: null,
  created_at: "2026-07-31T10:00:00.000000Z",
  visionset_version: "0.0.1.dev0",
};

const ASSET = "55555555-5555-4555-8555-555555555555";

/**
 * One trunk member, with every field `DatasetAssetOut` declares.
 *
 * Present rather than omitted, including the nulls: the generated shape check
 * runs at `unwrap` and rejects a body missing a required field before the screen
 * renders, so a stub answering a shape the endpoint never sends tests nothing.
 */
const ASSET_ROW = {
  id: ASSET,
  project_id: PROJECT,
  modality: "image",
  point_cloud: null,
  content_hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  width: 640,
  height: 480,
  format: "png",
  source_id: null,
  frame_index: 7,
  frame_timestamp: null,
  thumbnail_hash: null,
  ingested_at: "2026-07-31T09:00:00.000000Z",
  annotation_count: 2,
  label_classes: ["lane", "vehicle"],
  class_counts: [
    { label_class: "lane", annotations: 1 },
    { label_class: "vehicle", annotations: 1 },
  ],
  promoted_at: "2026-08-01T09:00:00.000000Z",
  promoted_by_batch_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  release_tags: ["v0.1"],
};

const BOX = "66666666-6666-4666-8666-666666666666";
const LANE = "77777777-7777-4777-8777-777777777777";

/** Two labels of two classes and two provenances, every field `AnnotationOut` declares. */
const ANNOTATIONS = [
  {
    id: BOX,
    asset_id: ASSET,
    label_class: "vehicle",
    schema_version: 3,
    geometry: { type: "bbox", x: 10, y: 20, width: 100, height: 50 },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  },
  {
    id: LANE,
    asset_id: ASSET,
    label_class: "lane",
    schema_version: 3,
    geometry: { type: "polygon", points: [[0, 0], [50, 0], [25, 40]] },
    attributes: {},
    provenance: "model",
    model_ref: "detector",
    confidence: 0.8,
    job_id: null,
  },
];

/** What opening a preview asks for, beyond the listing: the bytes, the labels, the schema. */
function previewable(): void {
  on("GET", /\/content$/, { status: 200, body: "not-really-png" });
  on("GET", /\/annotations$/, { status: 200, body: { items: ANNOTATIONS, total: 2 } });
  // A schema-less project is a real answer, and the overlay colours itself.
  on("GET", /\/schema$/, { status: 404, body: { code: "SCHEMA_NOT_FOUND", message: "none" } });
}

/** Open the release `RELEASE_ROW` describes, from the version panel, and wait for its facts. */
async function openRelease(tag = "v1"): Promise<void> {
  await userEvent.click(await screen.findByTestId(`version-${tag}`));
  await screen.findByTestId(`release-${tag}`);
}

/** The export form of an open release: the last section of its facts, open to begin with. */
async function openExport(): Promise<HTMLElement> {
  return await screen.findByTestId("export-form");
}

/** Open the release, then find its export section: where the model, the recipe and the job are. */
async function openReleaseExport(): Promise<HTMLElement> {
  await openRelease();
  return await openExport();
}

/** Choose a recipe in the export section from its select; `~none` is "No recipe". */
async function pickRecipe(value: string): Promise<void> {
  await userEvent.click(await screen.findByTestId("export-recipe"));
  await userEvent.click(await screen.findByTestId(`recipe-row-${value}`));
}

/** The chosen recipe's Edit recipe or Delete, from the "⋯" beside what it does. */
async function recipeAction(kind: "edit" | "delete"): Promise<void> {
  await userEvent.click(screen.getByTestId("recipe-actions"));
  await userEvent.click(await screen.findByTestId(`recipe-${kind}`));
}

/** A section's toggle: its heading. */
function sectionToggle(section: HTMLElement): HTMLElement {
  const toggle = section.querySelector<HTMLElement>("button[aria-controls]");
  if (toggle === null) throw new Error("a section without a heading toggle");
  return toggle;
}

/** Fold a section of the column by its id, if it is open. */
async function foldSection(id: string): Promise<HTMLElement> {
  const section = await screen.findByTestId(`section-${id}`);
  if (sectionToggle(section).getAttribute("aria-expanded") === "true") await userEvent.click(sectionToggle(section));
  return section;
}

/** Whether a node is in a folded section's body: still mounted, so it can unfold in place, but inert. */
function folded(node: HTMLElement): boolean {
  return node.closest("[inert]") !== null;
}

/**
 * Take the trunk's one image out the way the screen offers it: open it, then
 * press Remove in the viewer. The tile carries no trash button of its own.
 */
async function removeFromViewer(): Promise<void> {
  previewable();
  await userEvent.click(await screen.findByTestId(`open-${ASSET}`));
  await userEvent.click(await screen.findByTestId("preview-remove"));
}

function baseline(): void {
  on("GET", /\/dataset$/, {
    status: 200,
    body: { id: DATASET, project_id: PROJECT, name: "highway", description: null },
  });
  on("GET", /\/stats$/, {
    status: 200,
    body: {
      dataset_id: DATASET,
      asset_count: 12,
      annotated_asset_count: 9,
      annotation_count: 40,
      classes: [
        { label_class: "vehicle", annotations: 31, assets: 8 },
        { label_class: "lane", annotations: 9, assets: 3 },
      ],
    },
  });
  on("GET", /\/releases$/, { status: 200, body: { items: [RELEASE_ROW], total: 1 } });
  // Registered last of the GETs, so a test wanting a different trunk registers
  // its own before calling this — first matching handler wins, and a default
  // that could not be overridden would make every trunk test assert the fixture.
  on("GET", /\/assets$/, { status: 200, body: { items: [ASSET_ROW], total: 1 } });
  on("GET", /\/formats$/, {
    status: 200,
    body: {
      items: [
        { name: "dummy", lossy: false, ...FORMAT_REST, targets: ["dummy"] },
        { name: "ultralytics", lossy: true, ...FORMAT_REST, targets: ["yolo11", "yolov10"] },
        { name: "yolov5-yaml", lossy: true, ...FORMAT_REST, targets: ["yolov7"] },
      ],
      total: 3,
    },
  });
  on("GET", /\/export-targets$/, { status: 200, body: { items: TARGETS, total: TARGETS.length } });
  // The selected image's detail names its source; a project with none is a real answer.
  on("GET", /\/sources$/, { status: 200, body: { items: [], total: 0 } });
  on("GET", /\/preprocessing-recipes$/, { status: 200, body: { items: RECIPES, total: RECIPES.length } });
}

/** The project's active schema: both classes the dataset's labels use, at the version the releases pin. */
const SCHEMA = {
  status: 200,
  body: {
    project_id: PROJECT,
    version: 3,
    classes: [
      { name: "vehicle", geometries: ["bbox"], color: null, attributes: [] },
      { name: "lane", geometries: ["polygon"], color: null, attributes: [] },
    ],
  },
};

/** One recipe of the project: what the export section offers beside the target. */
const RECIPES = [
  {
    id: "88888888-8888-4888-8888-888888888888",
    project_id: PROJECT,
    name: "yolo-640",
    spec: {
      target: "yolo11",
      steps: [
        { kind: "resize", strategy: "letterbox", width: 640, height: 640, pad_value: 114 },
        { kind: "augment", op: "hflip", amount: 0.2 },
      ],
      variants_per_asset: 1,
    },
    created_at: "2026-08-20T10:00:00.000000Z",
    updated_at: "2026-08-20T10:00:00.000000Z",
    used_by: null,
  },
];

describe("the dataset view", () => {
  it("reports annotations and assets per class, because the two are different questions", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    await screen.findByTestId("dataset-stats");
    // The Overview's own classes panel, read off the trunk: the largest class leads the readout,
    // and a thousand labels over a thousand images reads apart from the same thousand over ten.
    expect((await screen.findByTestId("class-readout")).textContent).toContain("31 on 8 images");
    expect(screen.getByTestId("overview-class-vehicle").textContent).toContain("31");
    await userEvent.click(within(screen.getByTestId("overview-class-lane")).getByRole("button"));
    expect(screen.getByTestId("class-readout").textContent).toContain("9 on 3 images");
  });
});

describe("the dataset view's words", () => {
  it("lists its versions newest first — the working copy, then each release — and shelves no recipes beside them", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    const nav = await screen.findByTestId("version-nav");
    await within(nav).findByTestId("version-v1");
    const versions = within(nav)
      .getAllByRole("button")
      .map((one) => one.getAttribute("data-testid"))
      .filter((id) => id?.startsWith("version-"));
    expect(versions).toEqual(["version-working", "version-v1"]);
    expect(within(nav).getByTestId("version-working").textContent).toContain("Working copy");
    // Recipes are written where they are used, in a release's export; nothing is shelved here,
    // and the four-tab strip is gone.
    expect(screen.queryByTestId("recipe-shelf")).toBeNull();
    expect(screen.queryByTestId("recipe-list")).toBeNull();
    expect(screen.queryByTestId("dataset-tabs")).toBeNull();
  });

  it("reads the working copy in four numbers over the page, each warning said beside its number", async () => {
    baseline();
    on("GET", /\/schema$/, SCHEMA);
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    const kpis = await screen.findByTestId("dataset-kpis");
    // Each cell keeps its height while its source answers, a dash standing in for the number.
    await waitFor(() => expect(within(kpis).getByTestId("kpi-images").textContent).toContain("12"));
    const labeled = within(kpis).getByTestId("kpi-labeled");
    expect(labeled.textContent).toContain("75%");
    expect(labeled.textContent).toContain("9 of 12 images");
    // What holds nothing back but is worth knowing is a warning glyph, its words its name and description.
    expect(warningSaid(within(labeled).getByTestId("warning-labeling"))).toContain("3 images without labels");
    expect(warningSaid(within(labeled).getByTestId("warning-labeling"))).toContain("still exported, as negatives");
    await waitFor(() => expect(within(kpis).getByTestId("kpi-classes").textContent).toContain("3.3 per image"));
    expect(within(kpis).getByTestId("kpi-releases").textContent).toContain("Latest v1");
    // The per-class counts are not a table with a column each.
    expect(within(screen.getByTestId("version-facts")).queryByRole("columnheader")).toBeNull();
  });

  it("docks the releases under the facts, and opening one never re-mounts the column", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    const nav = await screen.findByTestId("version-nav");
    const dock = within(nav).getByTestId("releases-dock");
    // The releases are their own region at the column's foot, after the facts, so the facts'
    // height — which differs from one version to the next — never sets where the list is.
    expect(within(dock).getByTestId("section-releases").textContent).toContain("Releases");
    expect(within(dock).getByTestId("version-working")).not.toBeNull();
    expect(within(dock).queryByTestId("version-facts")).toBeNull();
    expect(screen.getByTestId("version-facts").compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Opening a release swaps the facts and keeps the very same list: nothing re-mounts, so
    // the column and the dock keep their scroll and the entry pressed stays where it was.
    const list = (await within(dock).findByTestId("version-v1")).closest("ol");
    await openRelease();
    expect(screen.getByTestId("version-v1").closest("ol")).toBe(list);
    expect(screen.getByTestId("version-nav")).toBe(nav);
    await userEvent.click(screen.getByTestId("version-working"));
    expect(screen.getByTestId("version-working").closest("ol")).toBe(list);
  });

  it("keeps a folded panel folded while other versions are opened and back", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openRelease();
    const proof = await foldSection("proof");
    // Folded, the band says the panel's answer; its fields stay mounted, out of reach.
    expect(sectionToggle(proof).textContent).toContain("Not verified");
    expect(folded(within(proof).getByTestId("state-integrity"))).toBe(true);

    // A release's panels are drawn inside its export form; the folds are held above both.
    await userEvent.click(screen.getByTestId("version-working"));
    await screen.findByTestId("dataset-stats");
    await openRelease();
    expect(sectionToggle(screen.getByTestId("section-proof")).getAttribute("aria-expanded")).toBe("false");
    // The ones nobody touched keep their default.
    expect(sectionToggle(screen.getByTestId("section-export")).getAttribute("aria-expanded")).toBe("true");
  });

  it("says which classes the schema declares and nothing labels, rather than leaving them out", async () => {
    baseline();
    on("GET", /\/schema$/, {
      status: 200,
      body: { ...SCHEMA.body, classes: [...SCHEMA.body.classes, { name: "sign", geometries: ["bbox"], color: null, attributes: [] }] },
    });
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    // A class nobody labelled is the gap a person training on this needs to see: it is in the legend.
    const sign = await screen.findByTestId("overview-class-sign");
    expect(sign.textContent).toContain("sign");
    expect(within(sign).getByRole("button")).toHaveProperty("disabled", true);
    // And the Classes number says so, as a warning beside it.
    const warning = await screen.findByTestId("warning-classes");
    expect(warningSaid(warning)).toContain("No labels for sign");
  });
});

describe("publishing", () => {
  it("sends the tag alone when nobody asked for folds", async () => {
    baseline();
    on("POST", /\/releases$/, { status: 201, body: RELEASE_ROW });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId("publish-release"));
    await userEvent.type(screen.getByTestId("release-tag"), "v2");
    await userEvent.click(screen.getByTestId("publish-submit"));

    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    expect(JSON.parse(bodies.get(sent.find((r) => r.method === "POST") as Request) ?? "{}")).toEqual({
      tag: "v2",
    });
  });

  it("names the classes the active schema no longer describes, and what to do", async () => {
    baseline();
    on("POST", /\/releases$/, {
      status: 409,
      body: {
        code: "RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA",
        message: "cannot publish this release: its active schema no longer describes annotations in the dataset",
        detail: {
          blockers: [
            { label_class: "lane", annotations: 12, assets: 3 },
            { label_class: "sign", annotations: 1, assets: 1 },
          ],
        },
      },
    });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId("publish-release"));
    await userEvent.type(screen.getByTestId("release-tag"), "v2");
    await userEvent.click(screen.getByTestId("publish-submit"));

    const said = (await screen.findByTestId("publish-error")).textContent ?? "";
    expect(said).toContain("active schema no longer describes");
    expect(said).not.toContain("RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA");
    const blockers = screen.getByTestId("publish-blockers").textContent ?? "";
    expect(blockers).toContain("lane: 12 annotations across 3 assets");
    expect(blockers).toContain("sign: 1 annotation across 1 asset");
    expect(screen.getByTestId("publish-remedy").textContent).toContain("publish a schema version");
  });

  it("says only what happened when the refusal carries no blockers", async () => {
    baseline();
    on("POST", /\/releases$/, {
      status: 409,
      body: { code: "RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA", message: "kernel wording" },
    });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId("publish-release"));
    await userEvent.type(screen.getByTestId("release-tag"), "v2");
    await userEvent.click(screen.getByTestId("publish-submit"));

    expect((await screen.findByTestId("publish-error")).textContent).toContain("active schema no longer describes");
    expect(screen.queryByTestId("publish-blockers")).toBeNull();
  });

  it("refuses a split whose fractions do not sum to one, as the kernel does", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId("publish-release"));
    await userEvent.type(screen.getByTestId("release-tag"), "v2");
    await userEvent.click(screen.getByTestId("use-split"));

    await userEvent.clear(screen.getByTestId("fraction-test"));
    await userEvent.type(screen.getByTestId("fraction-test"), "0.5");
    expect(screen.getByTestId("publish-submit")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("split-hint").textContent).toContain("must sum to 1");

    await userEvent.clear(screen.getByTestId("fraction-test"));
    await userEvent.type(screen.getByTestId("fraction-test"), "0.15");
    // 0.7 + 0.15 + 0.15 is not 1.0 in binary floating point, which is why the
    // kernel compares with `isclose` and why this mirrors that rather than a
    // stricter rule that would refuse a recipe the API accepts.
    expect(screen.getByTestId("publish-submit")).toHaveProperty("disabled", false);
  });
});

describe("verification", () => {
  it("does not run until it is asked, because it re-reads every blob", async () => {
    baseline();
    on("GET", /\/verify$/, {
      status: 200,
      body: {
        release_id: RELEASE,
        manifest_hash: RELEASE_ROW.manifest_hash,
        manifest_intact: true,
        ok: true,
        checked: 12,
        missing: [],
        corrupt: [],
        cache_mismatches: [],
      },
    });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openRelease();
    const releaseCard = screen.getByTestId("release-v1");
    // Not asked: the chip says so, and nothing has been read.
    expect(within(releaseCard).getByTestId("state-integrity").textContent).toBe("Not verified");
    expect(within(releaseCard).getByTestId("state-integrity").getAttribute("data-tone")).toBe("draft");
    expect(sent.some((r) => r.url.endsWith("/verify"))).toBe(false);

    await userEvent.click(screen.getByTestId("verify-v1"));
    await waitFor(() => expect(within(releaseCard).getByTestId("state-integrity").textContent).toBe("Intact"));
    expect(within(releaseCard).getByTestId("state-integrity").getAttribute("data-tone")).toBe("done");
    // A clean report is the chip alone; the report is for what was found wrong.
    expect(screen.queryByTestId("verified-v1")).toBeNull();
    // The history reads the same report: the release's entry now says so.
    expect(within(screen.getByTestId("version-nav")).getByTestId("version-verified-v1").textContent).toContain("Verified intact");
  });

  it("reports a broken manifest on its own, because nothing else was checked", async () => {
    baseline();
    on("GET", /\/verify$/, {
      status: 200,
      body: {
        release_id: RELEASE,
        manifest_hash: RELEASE_ROW.manifest_hash,
        manifest_intact: false,
        ok: false,
        checked: 0,
        missing: [],
        corrupt: [],
        cache_mismatches: [],
      },
    });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openRelease();
    await userEvent.click(await screen.findByTestId("verify-v1"));
    // `checked: 0` — every other number would be about a document that is not the
    // one its hash names.
    expect((await screen.findByTestId("verified-v1")).textContent).toContain(
      "does not match its hash",
    );
    expect(screen.getByTestId("state-integrity").textContent).toBe("Problems found");
    expect(screen.getByTestId("state-integrity").getAttribute("data-tone")).toBe("failed");
    expect(within(screen.getByTestId("version-nav")).getByTestId("version-verified-v1").textContent).toContain("Failed verification");
  });

  /**
   * A verify that could not be *asked* is not a verification (audit F10).
   *
   * Only the report had a rendering. A failed request left the button
   * un-pressed-looking and — the part that makes this worse than silent — any
   * previous report still on screen underneath, so a stale "everything checks
   * out" survived the press meant to stop trusting it.
   */
  it("says a failed verify request failed, rather than saying nothing", async () => {
    baseline();
    on("GET", /\/verify$/, {
      status: 503,
      body: { code: "WORKSPACE_BUSY", message: "database is locked" },
    });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openRelease();
    await userEvent.click(await screen.findByTestId("verify-v1"));

    const said = (await screen.findByTestId("verify-error-v1")).textContent ?? "";
    expect(said).toContain("busy");
    expect(said).not.toContain("WORKSPACE_BUSY");
    expect(screen.getByTestId("state-integrity").textContent).toBe("Couldn't verify");
    expect(screen.getByTestId("state-integrity").getAttribute("data-tone")).toBe("failed");
  });

  it("names the blobs a verification could not find or read, when it found any", async () => {
    baseline();
    on("GET", /\/verify$/, {
      status: 200,
      body: {
        release_id: RELEASE,
        manifest_hash: RELEASE_ROW.manifest_hash,
        manifest_intact: true,
        ok: false,
        checked: 12,
        missing: ["a".repeat(64)],
        corrupt: ["b".repeat(64), "c".repeat(64)],
        cache_mismatches: [],
      },
    });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openRelease();
    await userEvent.click(await screen.findByTestId("verify-v1"));

    const report = (await screen.findByTestId("verified-v1")).textContent ?? "";
    expect(report).toContain("cannot be reproduced");
    expect(report).toContain("1 missing · 2 corrupt");
    expect(report).toContain("of 12 checked");
  });

  it("takes a stale report off the screen when the next verify could not be asked", async () => {
    baseline();
    on("GET", /\/verify$/, {
      status: 200,
      body: {
        release_id: RELEASE,
        manifest_hash: RELEASE_ROW.manifest_hash,
        manifest_intact: true,
        ok: true,
        checked: 12,
        missing: [],
        corrupt: [],
        cache_mismatches: [],
      },
    });
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openRelease();
    await userEvent.click(await screen.findByTestId("verify-v1"));
    await waitFor(() => expect(screen.getByTestId("state-integrity").textContent).toBe("Intact"));

    // The second press cannot be answered. A green report left underneath the
    // silence would be the product asserting something it has just failed to
    // check.
    handlers.length = 0;
    baseline();
    on("GET", /\/verify$/, {
      status: 503,
      body: { code: "WORKSPACE_BUSY", message: "database is locked" },
    });
    await userEvent.click(screen.getByTestId("verify-v1"));

    await screen.findByTestId("verify-error-v1");
    // Neither the chip nor the history keeps saying "intact" under a check that did not run.
    expect(screen.getByTestId("state-integrity").textContent).toBe("Couldn't verify");
    expect(within(screen.getByTestId("version-nav")).queryByTestId("version-verified-v1")).toBeNull();
  });
});

/**
 * The download that said nothing at all (audit F8).
 *
 * `manifest.isError` was read nowhere, so a refusal produced no file and no
 * message — indistinguishable from a browser that had swallowed the save dialog,
 * which is the explanation a user would reach for and the wrong one.
 */
describe("downloading a manifest", () => {
  it("says why nothing was downloaded", async () => {
    baseline();
    on("GET", /\/manifest$/, {
      status: 404,
      body: { code: "RELEASE_NOT_FOUND", message: "no such release" },
    });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openRelease();
    await userEvent.click(await screen.findByTestId("manifest-v1"));

    const said = (await screen.findByTestId("manifest-error-v1")).textContent ?? "";
    expect(said).toContain("no longer on record");
    expect(said).not.toContain("RELEASE_NOT_FOUND");
  });
});

describe("export, and the third gate word", () => {
  it("groups the catalog by family and says what each target takes", async () => {
    baseline();

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));

    const listbox = await screen.findByRole("listbox");
    // The three headings, in the order a person training a model reads them.
    const headings = within(listbox)
      .getAllByRole("group")
      .map((group) => group.textContent ?? "");
    expect(headings[0]).toMatch(/^Ultralytics YOLO/);
    expect(headings[1]).toMatch(/^Community YOLO/);
    expect(headings[2]).toMatch(/^Other formats/);
    // The options are names; what a target takes is said with the option to a screen
    // reader (the tasks a model accepts, or, for a format with no task vocabulary,
    // the geometries it carries) and shown in a card beside the highlighted one.
    expect(screen.getByRole("option", { name: /YOLO11/ }).textContent).toContain(
      "detect · segment · classify · pose · obb",
    );
    expect(screen.getByRole("option", { name: /dummy/ }).textContent).toContain("box · polygon");
    expect(screen.queryByTestId("target-card-yolo11")).toBeNull();
    // The retired alias is not a target and never appears.
    expect(screen.queryByRole("option", { name: /^yolo$/ })).toBeNull();
  });

  it("shows what a target takes in a card beside the option the pointer is on", async () => {
    baseline();

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.hover(await screen.findByRole("option", { name: /YOLO11/ }));

    const card = await screen.findByTestId("target-card-yolo11", undefined, { timeout: 3000 });
    expect(card.textContent).toContain("detect · segment · classify · pose · obb");
    expect(card.textContent).toContain("Writes ultralytics.");
  });

  it("says when lossiness could not be read, rather than leaving the hint out silently", async () => {
    on("GET", /\/formats$/, { status: 503, body: { code: "WORKSPACE_BUSY", message: "Busy." } });
    baseline();

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /YOLOv10/ }));

    const said = warningSaid(await screen.findByTestId("lossy-unknown"));
    expect(said).toContain("YOLOv10");
    expect(screen.queryByTestId("lossy-hint")).toBeNull();
    // The picker still stands: the catalog answered, only the lossiness did not.
    expect(screen.getByTestId("export-submit")).toHaveProperty("disabled", false);
  });

  it("exports cleanly without any consent when the target loses nothing", async () => {
    baseline();
    handlers.push((request) =>
      request.method === "POST" && request.url.includes("/export")
        ? { status: 200, body: {} }
        : undefined,
    );

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /dummy/ }));
    await userEvent.click(screen.getByTestId("export-submit"));

    // `/export-targets` is a GET that also matches `/export`; the launch is the POST.
    const launch = () => sent.find((r) => r.method === "POST" && r.url.includes("/export"));
    await waitFor(() => expect(launch()).not.toBeUndefined());
    const request = launch();
    // The target, never the format: the route takes exactly one of the two.
    expect(new URL(request?.url ?? "").searchParams.get("target")).toBe("dummy");
    expect(new URL(request?.url ?? "").searchParams.get("format")).toBeNull();
    // Never sent unasked. `allow_lossy` is a gate word, not a default.
    expect(new URL(request?.url ?? "").searchParams.get("allow_lossy")).toBeNull();
  });

  it("asks before a lossy export, and retries with the flag once consented", async () => {
    baseline();
    handlers.push((request) => {
      if (request.method !== "POST" || !request.url.includes("/export")) return undefined;
      const allowed = new URL(request.url).searchParams.get("allow_lossy") === "true";
      return allowed
        ? { status: 200, body: {} }
        : {
            status: 409,
            body: {
              code: "LOSSY_EXPORT_NOT_CONSENTED",
              message: "ultralytics cannot express polygon annotations for yolov10.",
              detail: {
                compatibility: {
                  release_id: RELEASE,
                  format: "ultralytics",
                  target: "yolov10",
                  compatible: false,
                  format_is_lossy: true,
                  excluded_annotations: 1204,
                  excluded_assets: 3,
                  degraded_annotations: 0,
                  degraded_assets: 0,
                  dropped_modalities: [],
                  classes: [
                    {
                      label_class: "car",
                      geometry: "bbox",
                      status: "supported",
                      annotations: 40,
                      assets: 9,
                      reason: null,
                    },
                    {
                      label_class: "lane",
                      geometry: "polygon",
                      status: "excluded",
                      annotations: 1204,
                      assets: 3,
                      reason: "YOLOv10 accepts detect only; a polygon has no line to be written as",
                    },
                  ],
                },
              },
            },
          };
    });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /YOLOv10/ }));
    // The format declares it, so the warning is there before anything is attempted.
    expect(warningSaid(screen.getByTestId("lossy-hint"))).toContain("YOLOv10");

    await userEvent.click(screen.getByTestId("export-submit"));

    const consent = await screen.findByTestId("lossy-consent");
    // The sentence names the target, what it accepts, and how much of this
    // release it would drop — summed from the report, not from the message.
    expect(consent.textContent).toContain("YOLOv10 accepts boxes only");
    // The thousands separator is the locale's, so any one of them is accepted.
    expect(consent.textContent).toMatch(/1[,.\s]?204 polygons would be dropped\./);
    expect(consent.textContent).not.toContain("LOSSY_EXPORT_NOT_CONSENTED");
    // What is being consented to, from the refusal's own report: the classes the
    // target loses, each with how much, and not the ones it keeps.
    const lost = within(consent).getByTestId("lossy-classes");
    expect(lost.textContent).toContain("lane: 1,204 annotations across 3 assets.");
    expect(lost.textContent).toContain("no line to be written as");
    expect(lost.textContent).not.toContain("car");
    // Shut until the box is ticked — the gate is the consent, not the click.
    expect(screen.getByTestId("export-submit")).toHaveProperty("disabled", true);

    await userEvent.click(within(consent).getByTestId("lossy-checkbox"));
    await userEvent.click(screen.getByTestId("export-submit"));

    await waitFor(() =>
      expect(
        sent.filter((r) => r.url.includes("allow_lossy=true")).length,
      ).toBeGreaterThan(0),
    );
  });

  it("forgets a consent once the question changes: another recipe, another target", async () => {
    baseline();
    handlers.push((request) =>
      request.method === "POST" && request.url.includes("/export") && !request.url.includes("allow_lossy")
        ? {
            status: 409,
            body: { code: "LOSSY_EXPORT_NOT_CONSENTED", message: "ultralytics cannot express polygons." },
          }
        : undefined,
    );
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /YOLOv10/ }));

    async function consentTo(): Promise<void> {
      await userEvent.click(screen.getByTestId("export-submit"));
      const checkbox = within(await screen.findByTestId("lossy-consent")).getByTestId("lossy-checkbox");
      expect(checkbox).toHaveProperty("checked", false);
      await userEvent.click(checkbox);
      expect(checkbox).toHaveProperty("checked", true);
    }

    await consentTo();
    await userEvent.click(screen.getByTestId("export-recipe"));
    await userEvent.click(await screen.findByRole("option", { name: /yolo-640/ }));
    expect(screen.queryByTestId("lossy-consent")).toBeNull();

    await consentTo();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /YOLO11/ }));
    expect(screen.queryByTestId("lossy-consent")).toBeNull();

    await consentTo();
  });

  /**
   * The export job's own state.
   *
   * Without a rendering, `succeeded`/`failed`/`cancelled` are only a polling
   * predicate, so the one long-running operation in this product answers "is it
   * done?" with a button label and nothing else. A prose refusal covers the two
   * failures; the status itself belongs in the same vocabulary every other state
   * on the page uses.
   */
  function backgroundJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: EXPORT_JOB,
      type: "export",
      state: "running",
      attempt: 1,
      cancel_requested: false,
      created_at: "2026-08-06T09:00:00Z",
      started_at: "2026-08-06T09:00:01Z",
      finished_at: null,
      error: null,
      error_code: null,
      failures: [],
      processed: 3,
      total: 12,
      result: {},
      ...overrides,
    };
  }

  async function exportWith(
    state: string,
    overrides: Record<string, unknown> = {},
  ): Promise<HTMLElement> {
    baseline();
    // The launch is answered with a whole `BackgroundJobOut`, because
    // `checkExportRelease` validates it — a stub missing a required field makes
    // `onSuccess` never fire, and the symptom is a badge that does not render
    // rather than an error anybody can read.
    handlers.push((request) =>
      request.method === "POST" && request.url.includes("/export")
        ? { status: 200, body: backgroundJob({ state: "queued" }) }
        : undefined,
    );
    // Anchored, so the artifact download under `/artifact` is not answered with
    // a job document.
    on("GET", /\/background-jobs\/[^/]+$/, {
      status: 200,
      body: backgroundJob({ state, ...overrides }),
    });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /dummy/ }));
    await userEvent.click(screen.getByTestId("export-submit"));

    return await screen.findByTestId("export-job-state");
  }

  it("reads the recipes again once an export through one has succeeded, for its usage", async () => {
    baseline();
    handlers.push((request) =>
      request.method === "POST" && request.url.includes("/export")
        ? { status: 200, body: backgroundJob({ state: "queued" }) }
        : undefined,
    );
    on("GET", /\/background-jobs\/[^/]+$/, { status: 200, body: backgroundJob({ state: "succeeded" }) });
    const recipeReads = () =>
      sent.filter((r) => r.method === "GET" && r.url.includes("/preprocessing-recipes")).length;

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /dummy/ }));
    await pickRecipe("yolo-640");
    const before = recipeReads();
    await userEvent.click(screen.getByTestId("export-submit"));

    expect((await screen.findByTestId("export-job-state")).textContent).toContain("Downloaded");
    await waitFor(() => expect(recipeReads()).toBeGreaterThan(before));
  });

  it("says the export is queued, neutrally, before it has started", async () => {
    const badge = await exportWith("queued");
    expect(badge.textContent).toBe("Queued");
    expect(badge.getAttribute("data-tone")).toBe("draft");
  });

  it("says the export is running, with how far it has got, in the tone work-in-flight wears (#391)", async () => {
    const badge = await exportWith("running");
    expect(badge.textContent).toBe("Exporting 3/12");
    expect(badge.getAttribute("data-tone")).toBe("progress");
  });

  it("shows no failure while the export is still queued or running", async () => {
    // A job that has not settled has nothing to explain yet; the failure
    // sentence belongs to a job that stopped, never to one still working.
    await exportWith("queued");
    expect(screen.queryByTestId("export-job-error")).toBeNull();
    cleanup();
    await exportWith("running");
    expect(screen.queryByTestId("export-job-error")).toBeNull();
  });

  it("says a finished export was downloaded, in the success tone (#391)", async () => {
    const badge = await exportWith("succeeded");
    expect(badge.textContent).toBe("Downloaded");
    expect(badge.getAttribute("data-tone")).toBe("done");
  });

  it("says a failed export failed, and the prose stays beside it (#391)", async () => {
    const badge = await exportWith("failed");
    expect(badge.textContent).toBe("Failed");
    expect(badge.getAttribute("data-tone")).toBe("failed");
    // The badge is the glance; the sentence is still the answer.
    expect(screen.getByTestId("export-job-error")).not.toBeNull();
  });

  it("says a failed export's declared refusal in the vocabulary's sentence", async () => {
    // The job carries the same code the request path would have answered, so
    // the map serves it — the raw sentence, with its id, stays off the screen.
    await exportWith("failed", {
      error: `no release ${RELEASE} in project ${PROJECT}`,
      error_code: "RELEASE_NOT_FOUND",
    });
    const shown = screen.getByTestId("export-job-error");
    expect(shown.textContent).toContain("That release is no longer on record.");
    expect(shown.textContent).not.toContain(RELEASE);
    expect(shown.textContent).not.toContain("RELEASE_NOT_FOUND");
  });

  it("keeps a failed export's own sentence when its code has no entry, or it has no code", async () => {
    await exportWith("failed", {
      error: "the archive could not be written: disk full",
      error_code: "EXPORT_SOURCE_UNREADABLE",
    });
    expect(screen.getByTestId("export-job-error").textContent).toContain("disk full");
  });

  it("calls a cancelled export cancelled, neutrally — nothing failed (#391)", async () => {
    const badge = await exportWith("cancelled");
    expect(badge.textContent).toBe("Cancelled");
    // Somebody asked for it, so it is not the failed tone.
    expect(badge.getAttribute("data-tone")).toBe("draft");
  });

  it("saves the archive as the release's tag and the target, once the job has succeeded", async () => {
    on("GET", /\/artifact$/, { status: 200, body: "zip-bytes" });
    await exportWith("succeeded");

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.name).toBe("v1-dummy.zip");
    expect(screen.queryByTestId("export-download-error")).toBeNull();
  });

  it("says when the archive of a finished export could not be fetched, as a sentence", async () => {
    on("GET", /\/artifact$/, { status: 503, body: { code: "WORKSPACE_BUSY", message: "database is locked" } });
    await exportWith("succeeded");

    const said = (await screen.findByTestId("export-download-error")).textContent ?? "";
    expect(said).toContain("busy");
    expect(said).not.toContain("WORKSPACE_BUSY");
    expect(saved).toHaveLength(0);
  });

  it("says nothing was exported until a job runs, and keeps the job going while the section is folded", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    const section = screen.getByTestId("section-export");
    expect(section.textContent).toContain("Not exported this session");
    expect(screen.queryByTestId("export-job-state")).toBeNull();

    cleanup();
    await exportWith("running");
    const toggle = sectionToggle(screen.getByTestId("section-export"));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(toggle);

    // Folded, the form is out of the way and the heading still says how the job is going.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(folded(screen.getByTestId("export-form"))).toBe(true);
    const chip = screen.getByTestId("export-job-state");
    expect(chip.textContent).toBe("Exporting 3/12");
    expect(chip.getAttribute("data-tone")).toBe("progress");
    // Unfolded again, the same job is still the one being shown.
    await userEvent.click(toggle);
    expect(folded(screen.getByTestId("export-form"))).toBe(false);
    expect(screen.getByTestId("export-job-state").textContent).toBe("Exporting 3/12");
  });
});

/**
 * The two ways the target catalog arrives with nothing in it.
 *
 * They are different facts and the dialog owes a different sentence to each. A
 * failed `GET /export-targets` is a request that never got an answer; a
 * successful `{items: [], total: 0}` is an answer, and it says this server has
 * no exporter plugins installed. Falling both through the same `?? []` gives a
 * picker with an empty popover and no message anywhere — the swallowed-refusal
 * pattern `ui-capabilities` bans, and the visible signature of an install whose
 * exporters are not discoverable.
 *
 * The assertions that matter are the *pair*: each state renders its own thing
 * and not the other one's. A single test proving "something appears" would pass
 * against a component that answered both with the same alert.
 */
describe("a target catalog with nothing in it", () => {
  /** The first matching handler wins, so a failing one must be registered first. */
  function targetsFail(answer: Answer): void {
    on("GET", /\/export-targets$/, answer);
    baseline();
  }

  it("says a failed catalog request failed, in the shared vocabulary (#440)", async () => {
    targetsFail({
      status: 503,
      body: { code: "WORKSPACE_BUSY", message: "Another writer holds the workspace." },
    });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();

    const said = (await screen.findByTestId("export-targets-error")).textContent ?? "";
    // The product's sentence for the code, not the kernel's identifier.
    expect(said).toContain("workspace is busy");
    expect(said).not.toContain("WORKSPACE_BUSY");
    // Principle 9: the button is shut, and this is the adjacent explanation of why.
    expect(screen.getByTestId("export-submit")).toHaveProperty("disabled", true);
  });

  it("does not leave a silently empty picker where the failure is (#440)", async () => {
    targetsFail({ status: 503, body: { code: "WORKSPACE_BUSY", message: "Busy." } });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await screen.findByTestId("export-targets-error");

    // A control offering nothing, beside a message saying why there is nothing,
    // is the same unanswerable question over again.
    expect(screen.queryByTestId("export-target")).toBeNull();
  });

  it("offers the request again, and asking again asks the server (#440)", async () => {
    targetsFail({ status: 503, body: { code: "WORKSPACE_BUSY", message: "Busy." } });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    const failed = await screen.findByTestId("export-targets-error");

    const asked = () =>
      sent.filter((r) => new URL(r.url).pathname.endsWith("/export-targets")).length;
    const before = asked();
    await userEvent.click(within(failed).getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(asked()).toBeGreaterThan(before));
  });

  it("calls an empty install an empty install, not a failure (#440)", async () => {
    on("GET", /\/export-targets$/, { status: 200, body: { items: [], total: 0 } });
    baseline();

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();

    const said = (await screen.findByTestId("export-targets-empty")).textContent ?? "";
    // An invitation, not an apology — and it names what would fix it.
    expect(said).toContain("exporter");
    // The other state's rendering is absent. This is the half that a single
    // shared "nothing here" alert would fail.
    expect(screen.queryByTestId("export-targets-error")).toBeNull();
    expect(screen.queryByTestId("export-target")).toBeNull();
  });

  it("still lists the targets when there are targets (#440)", async () => {
    baseline();

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();

    // The success path keeps its picker and neither of the two explanations.
    expect(await screen.findByTestId("export-target")).not.toBeNull();
    expect(screen.queryByTestId("export-targets-error")).toBeNull();
    expect(screen.queryByTestId("export-targets-empty")).toBeNull();
  });
});

/**
 * Curating the trunk.
 *
 * Removal is reached by opening an image and pressing Remove in the viewer;
 * the tile has no trash button. The claim worth the block is that removal is
 * **curation, not deletion** — which is why the kernel gives it no `confirm=`
 * gate — and that the counts a removal invalidates include one on a screen this
 * mutation never touches.
 */
describe("curating the trunk", () => {
  it("lists what is in the trunk, which is what the counts above are counts of", async () => {
    // Already in the newest release, so the tile carries no "not released yet" mark.
    on("GET", /\/assets$/, { status: 200, body: { items: [{ ...ASSET_ROW, release_tags: ["v1"] }], total: 1 } });
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    const tile = await screen.findByTestId(`open-${ASSET}`);
    // The wall is a listbox of tiles, none selected until one is pressed.
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: /frame 7/ })).toBe(tile);
    expect(tile.getAttribute("aria-selected")).toBe("false");
    // The frame number when there is one, as the pill over the picture — not a
    // content hash nobody can act on — and how many labels it carries, read off
    // the listing itself rather than fetched per tile.
    expect(tile.textContent).toContain("7");
    expect(screen.getByTestId(`labels-${ASSET}`).textContent).toBe("2 labels");
    expect(screen.getByTestId(`labels-${ASSET}`).getAttribute("title")).toBe("lane, vehicle");
    expect(tile.getAttribute("aria-label")).toBe("frame 7, 2 labels");
  });

  it("says what removal costs, and is honest that almost nothing is destroyed", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await removeFromViewer();

    const consequence = await screen.findByTestId("remove-asset-consequence");
    // Every clause read off `DatasetService.remove_asset`, not assumed. The
    // release clause is the one a curator would otherwise have to guess at: a
    // release is a snapshot, so curating the trunk does not reach back into it.
    expect(consequence.textContent).toContain("together with its annotations");
    expect(consequence.textContent).toContain("is not deleted");
    expect(consequence.textContent).toContain("release already published is unaffected");
    expect(consequence.textContent).toContain("Promoting the batch again will restore it");
  });

  it("takes no action until the confirmation is answered", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await removeFromViewer();
    await screen.findByTestId("remove-asset-dialog");

    // Opening the dialog is not the decision. Nothing has been sent.
    expect(sent.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("sends the removal for the asset whose row was pressed", async () => {
    baseline();
    on("DELETE", /\/assets\//, { status: 204 });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await removeFromViewer();
    await userEvent.click(await screen.findByTestId("remove-asset-submit"));

    await waitFor(() => expect(sent.some((r) => r.method === "DELETE")).toBe(true));
    const request = sent.find((r) => r.method === "DELETE");
    expect(new URL(request?.url ?? "").pathname).toBe(`/datasets/${DATASET}/assets/${ASSET}`);
  });

  it("re-reads the counts and the trunk once one is gone, because both are stale", async () => {
    baseline();
    on("DELETE", /\/assets\//, { status: 204 });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await screen.findByTestId(`open-${ASSET}`);
    const before = {
      stats: sent.filter((r) => r.url.endsWith("/stats")).length,
      assets: sent.filter((r) => new URL(r.url).pathname.endsWith("/assets")).length,
    };

    await removeFromViewer();
    await userEvent.click(await screen.findByTestId("remove-asset-submit"));

    // A declaration — or a count — is a cached answer, so a mutation that moves
    // it has to invalidate it. `asset_count` is derived per call by the kernel
    // and would otherwise keep reporting the pre-removal trunk.
    await waitFor(() =>
      expect(sent.filter((r) => r.url.endsWith("/stats")).length).toBeGreaterThan(before.stats),
    );
    await waitFor(() =>
      expect(
        sent.filter((r) => new URL(r.url).pathname.endsWith("/assets")).length,
      ).toBeGreaterThan(before.assets),
    );
  });

  it("invalidates the batches too, because a batch reports current trunk membership", async () => {
    baseline();
    on("DELETE", /\/assets\//, { status: 204 });
    // A batch cache the screen never reads, seeded so the invalidation has
    // something to land on. `BatchOut.promoted_asset_count` is how many of a
    // batch's assets are in the trunk *right now* — current membership, derived
    // per read, deliberately not a promotion log — so a removal here moves a
    // number on a screen this mutation never touches.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["batches", "some-batch"], { promoted_asset_count: 12 });

    renderWithData(<DatasetScreen projectId={PROJECT} />, { queryClient: client });
    await removeFromViewer();
    await userEvent.click(await screen.findByTestId("remove-asset-submit"));

    await waitFor(() =>
      expect(client.getQueryState(["batches", "some-batch"])?.isInvalidated).toBe(true),
    );
  });

  it("renders a refusal as prose rather than as a code, and keeps the dialog open", async () => {
    baseline();
    on("DELETE", /\/assets\//, {
      status: 404,
      body: { code: "DATASET_NOT_FOUND", message: "No dataset with that id." },
    });

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await removeFromViewer();
    await userEvent.click(await screen.findByTestId("remove-asset-submit"));

    const failure = await screen.findByTestId("remove-asset-error");
    // The vocabulary's sentence for this code, not the server's message: the
    // kernel's wording interpolates the dataset's UUID, which is why the entry
    // exists at all.
    expect(failure.textContent).toContain("That dataset is no longer on record.");
    // And the dialog stays, so the person can read it and retry.
    expect(screen.queryByTestId("remove-asset-dialog")).not.toBeNull();
  });

  it("offers no paging for a trunk that fits on one page", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    await screen.findByTestId(`open-${ASSET}`);
    expect(screen.queryByTestId("trunk-paging")).toBeNull();
  });

  it("pages by offset, because the trunk is the collection that only grows", async () => {
    // Registered *before* `baseline`, which is what makes it win: the first
    // matching handler answers, so the default registered later cannot shadow
    // it. And it derives its answer from the offset the screen asked for rather
    // than from a frozen literal, so the assertion below is about the screen.
    handlers.push((request) => {
      const url = new URL(request.url);
      if (request.method !== "GET" || !url.pathname.endsWith("/assets")) return undefined;
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return {
        status: 200,
        body: {
          items: [{ ...ASSET_ROW, id: ASSET, frame_index: offset }],
          total: 60,
        },
      };
    });
    baseline();

    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await screen.findByTestId("trunk-paging");
    // `total` is the whole trunk, not the page — `docs/content/api.md`: paging bounds
    // the response, not the read.
    expect(screen.getByTestId("trunk-paging").textContent).toContain("of 60");
    expect(screen.getByTestId("trunk-previous")).toHaveProperty("disabled", true);

    await userEvent.click(screen.getByTestId("trunk-next"));

    await waitFor(() =>
      expect(sent.some((r) => new URL(r.url).searchParams.get("offset") === "48")).toBe(true),
    );
    expect(screen.getByTestId("trunk-previous")).toHaveProperty("disabled", false);
  });
});

/**
 * Looking at a member.
 *
 * The preview is a viewer and not an editor: the annotator's own shapes, drawn
 * over the picture in the asset's pixel frame, beside what the asset is and
 * what is on it. The claims worth the block are that the overlay is placed by
 * the asset's own dimensions, that the labels are read through the dataset and
 * not through a job, and that the viewer is the Images section's own detail,
 * beside the wall rather than over it, from which an image is taken out, in the
 * working copy only.
 */
describe("looking at a member", () => {
  it("opens a preview with the picture, the metadata and the labels drawn over it", async () => {
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));

    const preview = await screen.findByTestId("image-detail");
    expect(within(preview).getByTestId("image-detail-title").textContent).toBe("frame 7");
    expect(within(preview).getByTestId("image-facts").textContent).toContain("640 × 480");
    expect(within(preview).getByTestId("image-facts").textContent).toContain("PNG");
    // The overlay speaks the asset's pixel frame, which is what makes a stored
    // coordinate land on the pixel it names at every pane width.
    expect(within(preview).getByTestId("preview-overlay").getAttribute("viewBox")).toBe("0 0 640 480");
    await within(preview).findByTestId(`preview-shape-${BOX}`);
    expect(within(preview).getByTestId(`preview-shape-${LANE}`).getAttribute("data-geometry")).toBe("polygon");
    // A summary, not an inventory: counted by class, by who made them, by which
    // model and how surely. The picture is the inventory.
    expect(within(preview).getByTestId("preview-class-vehicle").textContent).toBe("vehicle1");
    expect(within(preview).getByTestId("preview-class-lane").textContent).toBe("lane1");
    // Where they came from is its own section, not a row among the classes.
    const provenance = within(preview).getByTestId("preview-provenance");
    expect(within(provenance).getByTestId("preview-by").textContent).toBe("person 1 · model 1");
    expect(within(within(preview).getByTestId("preview-labels")).queryByTestId("preview-by")).toBeNull();
    expect(within(preview).getByTestId("preview-models").textContent).toBe("detector");
    expect(within(preview).queryByTestId("preview-confidence")).toBeNull();
    expect(within(preview).queryByTestId(`preview-annotation-${BOX}`)).toBeNull();
    // Read through the dataset — a member carries no job id to read it through.
    const asked = sent.find((r) => new URL(r.url).pathname.endsWith("/annotations"));
    expect(new URL(asked?.url ?? "").pathname).toBe(`/datasets/${DATASET}/assets/${ASSET}/annotations`);
  });

  it("hides the overlay on request, and the list stays", async () => {
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));
    await screen.findByTestId(`preview-shape-${BOX}`);

    await userEvent.click(screen.getByTestId("preview-toggle-labels"));

    expect(screen.queryByTestId(`preview-shape-${BOX}`)).toBeNull();
    expect(screen.getByTestId("preview-class-vehicle")).not.toBeNull();
    expect(screen.getByTestId("preview-toggle-labels").getAttribute("aria-pressed")).toBe("false");
  });

  it("names a model by its short name and keeps the whole reference in reach", async () => {
    on("GET", /\/annotations$/, {
      status: 200,
      body: {
        items: [
          {
            ...ANNOTATIONS[1],
            model_ref: "IDEA-Research/grounding-dino-tiny@a2bb814dd30d776dcf7e30523b0065",
            confidence: 0.3,
          },
          { ...ANNOTATIONS[1], id: BOX, confidence: 0.75, model_ref: "IDEA-Research/grounding-dino-tiny@a2bb814dd30d776dcf7e30523b0065" },
        ],
        total: 2,
      },
    });
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));

    const models = await screen.findByTestId("preview-models");
    expect(models.textContent).toBe("grounding-dino-tiny");
    expect(models.querySelector("li")?.getAttribute("title")).toBe(
      "IDEA-Research/grounding-dino-tiny@a2bb814dd30d776dcf7e30523b0065",
    );
    expect(screen.getByTestId("preview-by").textContent).toBe("model 2");
  });

  it("selects a tile when it is pressed, and opens that image beside the wall", async () => {
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    const tile = await screen.findByTestId(`open-${ASSET}`);
    expect(screen.queryByTestId("image-detail")).toBeNull();

    await userEvent.click(tile);

    expect(tile.getAttribute("aria-selected")).toBe("true");
    const detail = await screen.findByTestId("image-detail");
    expect(within(detail).getByTestId("image-detail-position").textContent).toBe("1 of 1");
    // A pane of the page, not a modal: nothing is covered and nothing is trapped.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("trunk-grid")).not.toBeNull();
  });

  it("steps through the whole version with the arrows and the buttons, and stops at its ends", async () => {
    const ids = [
      "55555555-5555-4555-8555-555555555550",
      "55555555-5555-4555-8555-555555555551",
      "55555555-5555-4555-8555-555555555552",
    ];
    on("GET", /\/assets$/, {
      status: 200,
      body: { items: ids.map((id, at) => ({ ...ASSET_ROW, id, frame_index: at })), total: 3 },
    });
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${ids[0]}`));

    expect(screen.getByTestId("image-detail-position").textContent).toBe("1 of 3");
    expect(screen.getByTestId("image-previous")).toHaveProperty("disabled", true);

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("image-detail-position").textContent).toBe("2 of 3");
    expect(screen.getByTestId(`open-${ids[1]}`).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId(`open-${ids[0]}`).getAttribute("aria-selected")).toBe("false");

    await userEvent.click(screen.getByTestId("image-next"));
    expect(screen.getByTestId("image-detail-position").textContent).toBe("3 of 3");
    expect(screen.getByTestId("image-next")).toHaveProperty("disabled", true);
    // The edge is the edge: the key does nothing past it.
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("image-detail-position").textContent).toBe("3 of 3");

    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByTestId("image-detail-position").textContent).toBe("2 of 3");
  });

  it("turns the page when the arrows run off its edge, and counts across the whole version", async () => {
    // The wall is paged; the detail's count is the version's, not the page's.
    const PAGE = 48;
    const idAt = (at: number): string => `55555555-5555-4555-8555-${String(at).padStart(12, "0")}`;
    handlers.push((request) => {
      const url = new URL(request.url);
      if (request.method !== "GET" || !url.pathname.endsWith("/assets")) return undefined;
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const count = Math.min(PAGE, 60 - offset);
      return {
        status: 200,
        body: { items: Array.from({ length: count }, (_, at) => ({ ...ASSET_ROW, id: idAt(offset + at), frame_index: offset + at })), total: 60 },
      };
    });
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${idAt(PAGE - 1)}`));
    expect(screen.getByTestId("image-detail-position").textContent).toBe("48 of 60");

    await userEvent.keyboard("{ArrowRight}");

    await waitFor(() => expect(sent.some((r) => new URL(r.url).searchParams.get("offset") === String(PAGE))).toBe(true));
    await waitFor(() => expect(screen.getByTestId("image-detail-position").textContent).toBe("49 of 60"));
    expect((await screen.findByTestId(`open-${idAt(PAGE)}`)).getAttribute("aria-selected")).toBe("true");
  });

  it("puts the selected image in focus with Enter and steps back out with Escape, then out of the selection", async () => {
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));
    const toggle = await screen.findByTestId("image-focus-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("image-focus-toggle").getAttribute("aria-pressed")).toBe("true");

    // The first Escape leaves focus and keeps the selection; the second clears it.
    await userEvent.keyboard("{Escape}");
    expect(screen.getByTestId("image-focus-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId(`open-${ASSET}`).getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{Escape}");
    // It slides out to the right, then leaves.
    await waitFor(() => expect(screen.queryByTestId("image-detail")).toBeNull());
    expect(screen.getByTestId(`open-${ASSET}`).getAttribute("aria-selected")).toBe("false");
  });

  it("selects and focuses a tile on a double press, and the toggle is the way back", async () => {
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    await userEvent.dblClick(await screen.findByTestId(`open-${ASSET}`));

    expect((await screen.findByTestId("image-focus-toggle")).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByTestId("image-focus-toggle"));
    expect(screen.getByTestId("image-focus-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("image-detail-picture")).not.toBeNull();
  });

  it("removes from the preview through the same confirmation, and closes the viewer", async () => {
    previewable();
    baseline();
    on("DELETE", /\/assets\//, { status: 204 });
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));
    await userEvent.click(await screen.findByTestId("preview-remove"));

    // The viewer is the only way to remove, so the dialog is the one that says what removal costs.
    await screen.findByTestId("remove-asset-consequence");
    expect(sent.some((r) => r.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByTestId("remove-asset-submit"));

    await waitFor(() => expect(sent.some((r) => r.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("image-detail")).toBeNull());
  });

  it("says when the labels cannot be read, as a sentence", async () => {
    on("GET", /\/content$/, { status: 200, body: "not-really-png" });
    on("GET", /\/annotations$/, {
      status: 404,
      body: { code: "ASSET_NOT_IN_DATASET", message: "asset x is not in the trunk of dataset 'y'" },
    });
    on("GET", /\/schema$/, { status: 404, body: { code: "SCHEMA_NOT_FOUND", message: "none" } });
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));

    const failure = await screen.findByTestId("preview-labels-error");
    expect(failure.textContent).toBe("That frame is no longer in the dataset.");
    expect(screen.queryByTestId(`preview-shape-${BOX}`)).toBeNull();
  });

  it("says an image carries no labels, rather than leaving the panel empty", async () => {
    on("GET", /\/annotations$/, { status: 200, body: { items: [], total: 0 } });
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));

    expect((await screen.findByTestId("preview-no-labels")).textContent).toContain("No labels on this image");
    // Nothing to hide, so no switch; and no provenance to give for nothing.
    expect(screen.queryByTestId("preview-toggle-labels")).toBeNull();
    expect(screen.queryByTestId("preview-provenance")).toBeNull();
  });

  it("says which releases hold an image, or that none does yet", async () => {
    on("GET", /\/assets$/, {
      status: 200,
      body: { items: [{ ...ASSET_ROW, release_tags: ["v0.1", "v1"] }], total: 1 },
    });
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));
    expect((await screen.findByTestId("preview-releases")).textContent).toBe("In v0.1, v1");
  });

  it("says an image is in no release yet when none holds it", async () => {
    on("GET", /\/assets$/, {
      status: 200,
      body: { items: [{ ...ASSET_ROW, release_tags: [] }], total: 1 },
    });
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));
    expect((await screen.findByTestId("preview-releases")).textContent).toBe("Not in a release yet");
  });

  it("shows the picture without an overlay when the asset does not record its dimensions", async () => {
    on("GET", /\/assets$/, {
      status: 200,
      body: { items: [{ ...ASSET_ROW, width: null, height: null }], total: 1 },
    });
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));

    await screen.findByTestId("preview-no-overlay");
    expect(screen.queryByTestId("preview-overlay")).toBeNull();
    expect(screen.getByTestId("image-facts").textContent).toContain("Size—");
  });
});

describe("export, and the recipe beside the target", () => {
  const launch = () => sent.find((r) => r.method === "POST" && r.url.includes("/export"));

  it("sends no recipe by default: an export without one applies no transform", async () => {
    baseline();
    handlers.push((request) =>
      request.method === "POST" && request.url.includes("/export") ? { status: 200, body: {} } : undefined,
    );
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    // "No recipe" is the choice until another is made, and there is nothing chosen to edit.
    expect(screen.getByTestId("export-recipe").textContent).toBe("No recipe");
    expect(screen.queryByTestId("recipe-chosen")).toBeNull();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /dummy/ }));
    await userEvent.click(screen.getByTestId("export-submit"));

    await waitFor(() => expect(launch()).not.toBeUndefined());
    expect(new URL(launch()?.url ?? "").searchParams.get("recipe")).toBeNull();
  });

  it("lists the project's recipes by name with what each does, and sends the chosen one by name", async () => {
    baseline();
    handlers.push((request) =>
      request.method === "POST" && request.url.includes("/export") ? { status: 200, body: {} } : undefined,
    );
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /dummy/ }));
    await userEvent.click(screen.getByTestId("export-recipe"));
    const option = await screen.findByTestId("recipe-row-yolo-640");
    // The option is the name; what the recipe does is heard with it, and shown in a card beside it.
    expect(option.textContent).toContain("Letterbox 640×640 · flip · 1 variant");
    expect(option.textContent).toContain("For YOLO11");
    await userEvent.click(option);
    expect(screen.getByTestId("export-recipe").textContent).toBe("yolo-640");
    // Chosen, what it does is the line under the select, its Edit recipe and Delete behind the "⋯".
    expect(screen.getByTestId("recipe-chosen").textContent).toContain("Letterbox 640×640 · flip · 1 variant");
    await userEvent.click(screen.getByTestId("recipe-actions"));
    expect(await screen.findByTestId("recipe-edit")).not.toBeNull();
    expect(screen.getByTestId("recipe-delete")).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByTestId("export-submit"));

    await waitFor(() => expect(launch()).not.toBeUndefined());
    const query = new URL(launch()?.url ?? "").searchParams;
    expect(query.get("recipe")).toBe("yolo-640");
    expect(query.get("target")).toBe("dummy");
  });

  it("offers only 'No recipe', and the \"+\" that writes one, when the project has none", async () => {
    on("GET", /\/preprocessing-recipes$/, { status: 200, body: { items: [], total: 0 } });
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();

    // Writing one is the "+" beside the field's label, named for what it does.
    expect(screen.getByTestId("recipe-new").getAttribute("aria-label")).toBe("New recipe");
    await userEvent.click(screen.getByTestId("export-recipe"));
    expect(await screen.findAllByRole("option")).toHaveLength(1);
    expect(screen.getByTestId("recipe-row-~none").getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{Escape}");
    // Nothing chosen but "No recipe", so there is nothing to edit or delete.
    expect(screen.queryByTestId("recipe-actions")).toBeNull();
  });

  it("says a recipes read that failed, and still exports without one", async () => {
    on("GET", /\/preprocessing-recipes$/, { status: 503, body: { code: "WORKSPACE_BUSY", message: "Busy." } });
    baseline();
    handlers.push((request) =>
      request.method === "POST" && request.url.includes("/export") ? { status: 200, body: {} } : undefined,
    );
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();

    const said = warningSaid(await screen.findByTestId("export-recipes-error"));
    expect(said).toContain("workspace is busy");
    expect(said).toContain("The export runs without a recipe.");
    expect(said).not.toContain("WORKSPACE_BUSY");

    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /dummy/ }));
    await userEvent.click(screen.getByTestId("export-submit"));
    await waitFor(() => expect(launch()).not.toBeUndefined());
    expect(new URL(launch()?.url ?? "").searchParams.get("recipe")).toBeNull();
  });

  it("opens the recipe writer from the section as a plain modal, and keeps the export's choices", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /dummy/ }));

    await userEvent.click(await screen.findByTestId("recipe-new"));

    // Recipes are written where they are used, in a modal over the page; the export is
    // page content behind it, not another dialog.
    expect(await screen.findByTestId("recipe-dialog")).not.toBeNull();
    expect(screen.queryByTestId("export-dialog")).toBeNull();
    // And the model already chosen is still the model chosen.
    expect(screen.getByTestId("export-target").textContent).toContain("dummy");
  });

  it("asks before deleting the chosen recipe, and falls back to no recipe when it is gone", async () => {
    baseline();
    on("DELETE", /\/preprocessing-recipes\//, { status: 204 });
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await pickRecipe("yolo-640");

    await recipeAction("delete");
    await screen.findByTestId("delete-recipe-dialog");
    // Opening the confirmation is not the decision.
    expect(sent.some((r) => r.method === "DELETE")).toBe(false);

    await userEvent.click(screen.getByTestId("delete-recipe-submit"));
    await waitFor(() => expect(sent.some((r) => r.method === "DELETE")).toBe(true));
    expect(new URL(sent.find((r) => r.method === "DELETE")?.url ?? "").pathname).toBe(`/projects/${PROJECT}/preprocessing-recipes/yolo-640`);
    // The recipe this export was going to run is gone, so it runs none.
    await waitFor(() => expect(screen.getByTestId("export-recipe").textContent).toBe("No recipe"));
  });

  it("says a recipe that could not be deleted, as a sentence, and keeps the confirmation open", async () => {
    baseline();
    on("DELETE", /\/preprocessing-recipes\//, { status: 503, body: { code: "WORKSPACE_BUSY", message: "Busy." } });
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await pickRecipe("yolo-640");
    await recipeAction("delete");
    await userEvent.click(await screen.findByTestId("delete-recipe-submit"));

    const said = (await screen.findByTestId("delete-recipe-error")).textContent ?? "";
    expect(said).toContain("busy");
    expect(said).not.toContain("WORKSPACE_BUSY");
    expect(screen.getByTestId("delete-recipe-dialog")).not.toBeNull();
  });

  it("renders the split refusal as prose, with the remedy", async () => {
    baseline();
    handlers.push((request) =>
      request.method === "POST" && request.url.includes("/export")
        ? {
            status: 409,
            body: {
              code: "AUGMENTATION_REQUIRES_SPLIT",
              message: "the recipe asks for 1 augmented variant(s) per asset and this release has no split recipe",
            },
          }
        : undefined,
    );
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /dummy/ }));
    await pickRecipe("yolo-640");
    await userEvent.click(screen.getByTestId("export-submit"));

    const said = (await screen.findByTestId("export-error")).textContent ?? "";
    expect(said).toContain("published without a split");
    expect(said).not.toContain("AUGMENTATION_REQUIRES_SPLIT");
    // A refusal, never a consent: no checkbox appears for it.
    expect(screen.queryByTestId("lossy-consent")).toBeNull();
  });

  it("renders the geometry refusal as prose", async () => {
    baseline();
    handlers.push((request) =>
      request.method === "POST" && request.url.includes("/export")
        ? {
            status: 409,
            body: {
              code: "PREPROCESSING_STEP_UNSUPPORTED_GEOMETRY",
              message: "the 'rot90' step cannot transform a polyline (asset 1234 carries one)",
              detail: { step: "rot90", geometry: "polyline", asset_id: "1234" },
            },
          }
        : undefined,
    );
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /dummy/ }));
    await userEvent.click(screen.getByTestId("export-submit"));

    const said = (await screen.findByTestId("export-error")).textContent ?? "";
    expect(said).toContain("cannot follow a polyline");
    expect(said).not.toContain("PREPROCESSING_STEP_UNSUPPORTED_GEOMETRY");
  });

  // The two 500s a misdeclared export plugin raises. Neither is a rule the
  // person broke, so the sentence has to say where the problem is.
  it.each([
    ["EXPORT_TARGET_CONFLICT", "two export plugins declare target 'dummy'", "Two installed export plugins"],
    ["INVALID_EXPORT_TARGET", "target 'dummy' claims geometry 'polyline'", "cannot write for"],
  ])("renders %s as prose", async (code, message, expected) => {
    baseline();
    handlers.push((request) =>
      request.method === "POST" && request.url.includes("/export")
        ? { status: 500, body: { code, message } }
        : undefined,
    );
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openReleaseExport();
    await userEvent.click(screen.getByTestId("export-target"));
    await userEvent.click(await screen.findByRole("option", { name: /dummy/ }));
    await userEvent.click(screen.getByTestId("export-submit"));

    const said = (await screen.findByTestId("export-error")).textContent ?? "";
    expect(said).toContain(expected);
    expect(document.body.textContent).not.toContain(code);
  });
});

/**
 * The line of versions.
 *
 * The working copy is the trunk as it stands and each release is frozen out of
 * it; opening one asks the listing for that release's members, and what the
 * viewer offers depends on which is open — removal is the trunk's curation, so
 * it is not offered inside something frozen.
 */
describe("the line of versions", () => {
  const SECOND = "55555555-5555-4555-8555-555555555556";

  it("lists the working copy and each release, newest first", async () => {
    const newer = { ...RELEASE_ROW, id: "99999999-9999-4999-8999-999999999999", tag: "v2", asset_count: 20, created_at: "2026-08-15T10:00:00.000000Z" };
    on("GET", /\/releases$/, { status: 200, body: { items: [RELEASE_ROW, newer], total: 2 } });
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    const nav = await screen.findByTestId("version-nav");
    await within(nav).findByTestId("version-v2");
    const order = within(nav)
      .getAllByRole("button")
      .map((one) => one.getAttribute("data-testid"))
      .filter((id) => id?.startsWith("version-"));
    expect(order).toEqual(["version-working", "version-v2", "version-v1"]);
    // Each entry says what changed against the one before it, and only that.
    expect(within(nav).getByTestId("version-notes-v2").textContent).toContain("+8images");
    expect(within(nav).getByTestId("version-notes-v1").textContent).toContain("the first release");
    expect(within(nav).queryByTestId("version-verified-v1")).toBeNull();
    // The working copy is open to begin with.
    expect(within(nav).getByTestId("version-working").getAttribute("aria-current")).toBe("true");
  });

  it("asks the listing for a release's members when it is opened, and for none in the working copy", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await screen.findByTestId(`open-${ASSET}`);
    const listings = () => sent.filter((r) => new URL(r.url).pathname.endsWith("/assets"));
    expect(listings().every((r) => new URL(r.url).searchParams.get("release_id") === null)).toBe(true);

    await openRelease();

    await waitFor(() => expect(listings().some((r) => new URL(r.url).searchParams.get("release_id") === RELEASE)).toBe(true));
  });

  it("says how many of a release's images have since left the dataset", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openRelease();

    // The release froze 12 and the listing holds 1 of them.
    expect(warningSaid(await screen.findByTestId("release-gone"))).toContain("11 of its images have since left the dataset");
  });

  it("offers Remove in the viewer for the working copy, and not inside a release", async () => {
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));
    const detail = await screen.findByTestId("image-detail");
    expect(within(detail).getByTestId("preview-remove")).not.toBeNull();

    await userEvent.click(screen.getByTestId("version-v1"));
    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));
    const inRelease = await screen.findByTestId("image-detail");
    expect(within(inRelease).getByTestId("image-next")).not.toBeNull();
    expect(within(inRelease).getByTestId("preview-panel")).not.toBeNull();
    expect(within(inRelease).queryByTestId("preview-remove")).toBeNull();
  });

  it("closes the selected image with Escape, because it is a pane and not a dialog", async () => {
    previewable();
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    await userEvent.click(await screen.findByTestId(`open-${ASSET}`));
    await screen.findByTestId("image-detail");
    // A pane, not a dialog: nothing modal is on the page, and there is no button to close it.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("preview-close")).toBeNull();
    expect(within(screen.getByTestId("version-facts")).getByTestId("dataset-stats")).not.toBeNull();

    await userEvent.keyboard("{Escape}");
    // It slides out to the right, then leaves.
    await waitFor(() => expect(screen.queryByTestId("image-detail")).toBeNull());
    // The version's facts never left the column.
    expect(within(screen.getByTestId("version-facts")).getByTestId("dataset-stats")).not.toBeNull();
  });

  it("marks only images the newest release lacks, and only in the working copy", async () => {
    on("GET", /\/assets$/, {
      status: 200,
      body: {
        items: [
          { ...ASSET_ROW, release_tags: ["v1"] },
          { ...ASSET_ROW, id: SECOND, frame_index: 8, release_tags: [] },
        ],
        total: 2,
      },
    });
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);

    await screen.findByTestId(`open-${SECOND}`);
    expect(screen.getByTestId(`fresh-${SECOND}`)).not.toBeNull();
    expect(screen.queryByTestId(`fresh-${ASSET}`)).toBeNull();
    expect(screen.getByTestId(`open-${SECOND}`).getAttribute("aria-label")).toContain("not released yet");

    await openRelease();
    await screen.findByTestId(`open-${SECOND}`);
    expect(screen.queryByTestId(`fresh-${SECOND}`)).toBeNull();
  });

  it("says a release's split as its three shares", async () => {
    const split = { train: 0.7, val: 0.2, test: 0.1, seed: 7 };
    on("GET", /\/releases$/, { status: 200, body: { items: [{ ...RELEASE_ROW, split }], total: 1 } });
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    await openRelease();

    const bar = screen.getByTestId("split-v1");
    expect(bar.textContent).toContain("Train 70%");
    expect(bar.textContent).toContain("Validation 20%");
    expect(bar.textContent).toContain("Test 10%");
  });

  it("offers Publish in the project bar for the working copy only, and Export as a section of a release's facts", async () => {
    baseline();
    renderWithData(<DatasetScreen projectId={PROJECT} />);
    // The working copy is not exportable: it is not a release.
    await screen.findByTestId("dataset-stats");
    // "Publish" with its icon, named in full for whoever cannot see the bar's context.
    expect(screen.getByTestId("publish-release").textContent).toBe("Publish");
    expect(screen.getByRole("button", { name: "Publish release" })).toBe(screen.getByTestId("publish-release"));
    expect(screen.queryByTestId("section-export")).toBeNull();
    expect(screen.queryByTestId("export-form")).toBeNull();

    await openRelease();
    // A release's forward action is its export, which is a section of its facts and not a
    // button in the bar or a dialog; the publish is the working copy's.
    expect(screen.queryByTestId("publish-release")).toBeNull();
    expect(screen.queryByTestId("export-open")).toBeNull();
    expect(screen.queryByTestId("export-dialog")).toBeNull();

    const form = await openExport();
    const section = screen.getByTestId("section-export");
    expect(section.textContent).toContain("Export");
    // Open to begin with, and the last section of the release's facts.
    expect(within(section).getByRole("button", { expanded: true })).not.toBeNull();
    expect(within(section).getByTestId("export-form")).toBe(form);
    expect(screen.getByTestId("release-v1").lastElementChild).toBe(section);
    expect(within(form).getByTestId("export-submit").textContent).toBe("Export");
    // Nothing is chosen, so nothing can be sent yet.
    expect(within(form).getByTestId("export-submit")).toHaveProperty("disabled", true);
  });
});
