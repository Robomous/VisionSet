/**
 * The schema editor and its class ledger, driven against a stubbed `fetch`
 * (`testing/screensHarness.tsx`).
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type JSX, type ReactNode } from "react";
// `VisionSetDataProvider` and `QueryClient` stay direct imports: three tests
// below build their own local `wrap` that a `rerender` reuses across a prop
// change, which needs the same `client` identity (and the same `QueryClient`,
// since they assert on its cache) present on both sides of the rerender —
// something `renderWithData`'s result cannot give a caller-driven `rerender`.
// See each local `wrap` below.
import { TooltipProvider } from "@robomous/ui-core";
import { VisionSetDataProvider } from "../data/VisionSetDataProvider";
import { classColor, hexColor } from "../palette";
import { ProjectScreen } from "./ProjectScreen";
import { type LabelClassBody } from "./queries";
import { harnessClient, renderWithData } from "../testing/dataHarness";
import { batchActions } from "../testing/wire.fixtures.js";
import { IMPLEMENTED_GEOMETRIES, geometryPage } from "../testing/geometries";
import {
  CLASSES,
  OTHER_PROJECT,
  PROJECT,
  addNamedClass,
  barState,
  bodies,
  cancelSheet,
  classCards,
  closeSheet,
  curatedDrafts,
  describedBy,
  handlers,
  on,
  sent,
  installScreensHarness,
  viewVersion,
  type HandlerAnswer,
} from "../testing/screensHarness";
import { PreviewSchemaChangeProbe, SchemaBlockingAssetsProbe } from "../testing/screensProbes";

installScreensHarness();

describe("the schema editor", () => {
  function projectWithSchema(): void {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: {
        id: PROJECT,
        name: "highway",
        description: null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 200,
      body: { project_id: PROJECT, version: 3, classes: CLASSES },
    });
    on("GET", /schema\/versions$/, {
      status: 200,
      body: {
        items: [
          { project_id: PROJECT, version: 1, classes: [CLASSES[0]] },
          { project_id: PROJECT, version: 2, classes: CLASSES },
          { project_id: PROJECT, version: 3, classes: CLASSES },
        ],
        total: 3,
      },
    });
  }

  /** Open one class's dialog, putting away whichever one was open first. */
  async function selectClass(index: number): Promise<void> {
    await closeSheet();
    await userEvent.click(screen.getByTestId(`class-card-${index}`));
    await screen.findByTestId(`class-${index}`);
  }

  /** Remove a class from its open dialog; the dialog closes with it. */
  async function removeClass(index: number): Promise<void> {
    await selectClass(index);
    await userEvent.click(screen.getByTestId(`remove-class-${index}`));
    await waitFor(() => expect(classCards()).toHaveLength(CLASSES.length - 1));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
  }

  it("previews a candidate without lane and reads its orphan blockers", async () => {
    const candidate: readonly LabelClassBody[] = [
      { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    ];
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });

    renderWithData(<PreviewSchemaChangeProbe projectId={PROJECT} classes={candidate} />);
    await userEvent.click(screen.getByTestId("preview-schema-change"));

    await waitFor(() =>
      expect(screen.getByTestId("preview-result").textContent).toBe("lane:12:3:true"),
    );
    const request = sent.find(
      (sentRequest) =>
        sentRequest.method === "POST" && new URL(sentRequest.url).pathname.endsWith("/schema/preview"),
    );
    if (request === undefined) throw new Error("Expected a schema preview request");
    expect(JSON.parse(bodies.get(request) ?? "")).toEqual({ classes: candidate });
    expect(
      sent.some(
        (sentRequest) =>
          sentRequest.method === "POST" &&
          new URL(sentRequest.url).pathname.endsWith("/schema/drafts/curated/publish"),
      ),
    ).toBe(false);
  });

  it("reads the blocking frames off the typed listing", async () => {
    const ASSET = "22222222-2222-4222-8222-222222222222";
    const BATCH = "33333333-3333-4333-8333-333333333333";
    on("POST", /\/schema\/blocking-assets$/, {
      status: 200,
      body: {
        items: [
          {
            asset: {
              id: ASSET,
              project_id: PROJECT,
              modality: "image",
              point_cloud: null,
              content_hash: "deadbeef",
              format: "jpeg",
              width: 1920,
              height: 1080,
              frame_index: null,
              frame_timestamp: null,
              source_id: null,
              thumbnail_hash: "abc",
              ingested_at: "2024-01-01T00:00:00Z",
            },
            label_classes: ["lane"],
            annotations: 12,
            batch_ids: [BATCH],
          },
        ],
        total: 1,
      },
    });

    renderWithData(<SchemaBlockingAssetsProbe projectId={PROJECT} classes={[]} />);

    await waitFor(() =>
      expect(screen.getByTestId("blocking-assets-result").textContent).toBe("1:12:1"),
    );
  });

  it("stays disabled while nothing is proposed", () => {
    renderWithData(<SchemaBlockingAssetsProbe projectId={PROJECT} classes={null} />);
    expect(screen.getByTestId("blocking-assets-result").textContent).toBe("pending");
    expect(
      sent.some((sentRequest) => new URL(sentRequest.url).pathname.endsWith("/schema/blocking-assets")),
    ).toBe(false);
  });

  it("hashes a proposal's property order out of the key, not just its members", async () => {
    on("POST", /\/schema\/blocking-assets$/, { status: 200, body: { items: [], total: 0 } });

    // Same class, two builds: `color` before `attributes` versus after. Two
    // logically-identical proposals reaching this hook by different code paths
    // must share a cache entry — TanStack's own key hash sorts object keys for
    // exactly this reason, and pre-stringifying here would have thrown that away.
    const classesA: readonly LabelClassBody[] = [
      { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    ];
    const classesB: readonly LabelClassBody[] = [
      { color: "#38bdf8", attributes: [], name: "vehicle", geometries: ["bbox"] },
    ];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = harnessClient();
    const scope = Symbol("schema-blocking-assets-test");
    const wrap = (node: ReactNode): JSX.Element => (
      <TooltipProvider>
        <VisionSetDataProvider client={client} scope={scope} makeQueryClient={() => queryClient}>
          {node}
        </VisionSetDataProvider>
      </TooltipProvider>
    );

    const { rerender } = render(
      wrap(<SchemaBlockingAssetsProbe projectId={PROJECT} classes={classesA} />),
    );
    await waitFor(() =>
      expect(screen.getByTestId("blocking-assets-result").textContent).toBe("0:undefined:undefined"),
    );

    rerender(wrap(<SchemaBlockingAssetsProbe projectId={PROJECT} classes={classesB} />));
    await waitFor(() =>
      expect(screen.getByTestId("blocking-assets-result").textContent).toBe("0:undefined:undefined"),
    );

    expect(
      sent.filter((sentRequest) =>
        new URL(sentRequest.url).pathname.endsWith("/schema/blocking-assets"),
      ),
    ).toHaveLength(1);
  });

  /**
   * The frames behind a refusal are listed in the refusal's own dialog, and only
   * there. The page has no section for them; they are one press from every place
   * that mentions them, and they are asked about when that dialog opens — not on
   * page load, and not on a timer of their own.
   */
  it("lists the frames in the way inside the refusal, and links each to every batch holding it", async () => {
    const ASSET = "22222222-2222-4222-8222-222222222222";
    const BATCH = "33333333-3333-4333-8333-333333333333";
    const CORRECTION = "44444444-4444-4444-8444-444444444444";
    projectWithSchema();
    // The full wire shape: `useBatches` validates the response, and a listing
    // that fails validation is a query with no data — which reads here as every
    // link falling back to "Open batch".
    const batch = (id: string, name: string): Record<string, unknown> => ({
      id,
      project_id: PROJECT,
      name,
      state: "in_annotation",
      asset_count: 4,
      schema_version: 3,
      progress: {
        unannotated: 4,
        pre_labeled: 0,
        annotated: 0,
        skipped: 0,
        review_pending: 0,
        accepted: 0,
        total: 4,
      },
      allowed_actions: batchActions("in_annotation", { settled: false }),
      modalities: ["image"],
      promoted_asset_count: 0,
      parent_batch_id: null,
      pre_label_run: null,
    });
    on("GET", /\/batches$/, {
      status: 200,
      body: { items: [batch(BATCH, "survey"), batch(CORRECTION, "fixes")], total: 2 },
    });
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    on("POST", /\/schema\/blocking-assets/, {
      status: 200,
      body: {
        items: [
          {
            asset: {
              id: ASSET,
              project_id: PROJECT,
              modality: "image",
              point_cloud: null,
              content_hash: "deadbeef",
              format: "jpeg",
              width: 1920,
              height: 1080,
              frame_index: 42,
              frame_timestamp: null,
              source_id: null,
              thumbnail_hash: null,
              ingested_at: "2024-01-01T00:00:00Z",
            },
            label_classes: ["lane"],
            annotations: 12,
            batch_ids: [BATCH, CORRECTION],
          },
        ],
        // Every blocking frame, not this page's size: the list says how many
        // there are and how many of them it is showing.
        total: 30,
      },
    });
    const opened = vi.fn();
    const asks = (): Request[] =>
      sent.filter((request) => new URL(request.url).pathname.endsWith("/schema/blocking-assets"));

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onOpenBatch={opened} />);
    await screen.findByTestId("schema-editor");
    // Nothing on the page, and nothing asked: there is no frames section to fill.
    expect(screen.queryByTestId("blocking-assets")).toBeNull();
    expect(asks()).toHaveLength(0);

    await selectClass(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("“lane” can’t be removed yet");
    expect(within(dialog).getByTestId("orphan-close").textContent).toBe("Keep lane");
    expect(dialog.textContent).toContain("open a batch below to clear or relabel a frame");
    const panel = await within(dialog).findByTestId("blocking-assets");
    await within(panel).findByTestId("blocking-asset-list");
    expect(panel.textContent).toContain("12");
    expect(panel.textContent).toContain("lane");
    // Two rows reading "12 labels under lane" would be one row to a screen
    // reader, so the frame names itself.
    expect(panel.textContent).toContain("Frame 42");
    // `total` counts every blocking frame and the request is windowed, so the
    // panel states the whole number and how much of it is on screen.
    expect(within(dialog).getByTestId("blocking-asset-count").textContent).toContain("30");
    // The clause too, not only the number: a count with no window stated is a
    // panel silently showing 12 of 30.
    expect(within(dialog).getByTestId("blocking-asset-count").textContent).toContain(
      "showing the first",
    );
    // Asked once, with the proposal the refusal was about — the draft without
    // the class being removed — and windowed.
    expect(asks()).toHaveLength(1);
    expect(new URL(asks()[0].url).searchParams.get("limit")).toBe("12");
    expect(JSON.parse(bodies.get(asks()[0]) ?? "")).toEqual({ classes: [CLASSES[0]] });
    // An asset is held by many batches — `batches_holding` returns a list, and an
    // annotation names no batch at all — so the row offers all of them rather
    // than picking one there is no stored fact to prefer.
    const links = within(panel).getAllByTestId("blocking-asset-batch");
    expect(links).toHaveLength(2);
    // Named from the batch listing: three links all reading "Open batch" would
    // name no destination between them.
    expect(links[0].textContent).toContain("survey");
    expect(links[1].textContent).toContain("fixes");
    await userEvent.click(links[0]);
    expect(opened).toHaveBeenCalledWith(BATCH);
  });

  /**
   * The rail settles its preview on the draft's classes, and `useSettled` holds
   * that value across a props change — while this screen is re-rendered rather
   * than remounted when `:projectId` does. A rail that survived the switch would
   * ask the arriving project about the classes it settled on under the departing
   * one. `key={projectId}` is what remounts it, and this is the probe that says so.
   *
   * The arriving project has a stored draft that differs from its active version,
   * so it is dirty from its first render: the rail asks about it at once, and the
   * only list a surviving timer could hand it is the departing project's. Both
   * halves of the setup are load-bearing. The arriving project is rendered
   * **first** so its schema and draft are cached — without that `SchemaSection`
   * renders `LoadingState`, the rail unmounts on its own, and the bug hides. And
   * the typing is followed by a real pause, so the settle actually fires under the
   * departing project — a switch inside the debounce window clears the pending
   * timer and the probe passes whether or not the key is there.
   */
  it("does not carry a settled preview across a project switch", async () => {
    projectWithSchema();
    curatedDrafts.set(OTHER_PROJECT, {
      project_id: OTHER_PROJECT,
      kind: "curated",
      classes: [CLASSES[0]],
      note: "",
      based_on: 3,
      revision: 1,
      updated_at: "2024-01-01T00:00:00Z",
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = harnessClient();
    const scope = Symbol("project-switch-test");
    const wrap = (projectId: string): JSX.Element => (
      <TooltipProvider>
        <VisionSetDataProvider client={client} scope={scope} makeQueryClient={() => queryClient}>
          <ProjectScreen projectId={projectId} tab="schema" onOpenBatch={vi.fn()} />
        </VisionSetDataProvider>
      </TooltipProvider>
    );
    const previewsUnder = (projectId: string): Request[] =>
      sent.filter((request) => {
        const path = new URL(request.url).pathname;
        return path.startsWith(`/projects/${projectId}/`) && path.endsWith("/schema/preview");
      });

    // The project switched *to*, first, so its own queries are warm when it
    // comes back — otherwise the rail is unmounted by its own loading state.
    const view = render(wrap(OTHER_PROJECT));
    await screen.findByTestId("schema-editor");
    await waitFor(() => expect(previewsUnder(OTHER_PROJECT).length).toBeGreaterThan(0));
    const before = previewsUnder(OTHER_PROJECT).length;

    view.rerender(wrap(PROJECT));
    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "PEDESTRIAN");
    // The class reaches the draft when it is added, and the draft is what the
    // rail asks about.
    await closeSheet();
    // Long enough for the settle to fire here, which is the whole point: the
    // value the rail is holding when the switch lands must be this project's.
    await waitFor(() => {
      const asked = previewsUnder(PROJECT).map((request) => bodies.get(request) ?? "");
      expect(asked.some((body) => body.includes("PEDESTRIAN"))).toBe(true);
    });

    view.rerender(wrap(OTHER_PROJECT));
    await screen.findByTestId("schema-editor");
    await new Promise((resolve) => setTimeout(resolve, 600));

    // The arriving project is still dirty and is not asked about the departing
    // one's classes — whichever way its own preview was answered.
    for (const request of previewsUnder(OTHER_PROJECT)) {
      expect(bodies.get(request) ?? "").not.toContain("PEDESTRIAN");
    }
    expect(previewsUnder(OTHER_PROJECT).length).toBeGreaterThanOrEqual(before);
  });

  /**
   * The version being read is state of the editor, and the editor is keyed by
   * project — so a version somebody was looking at in one project is not the one
   * the next project opens on.
   */
  it("opens a project on its draft, not on the version read in the one before it", async () => {
    projectWithSchema();
    on("GET", /schema\/compare/, {
      status: 200,
      body: { is_destructive: false, destructive_classes: [], changes: [] },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = harnessClient();
    const scope = Symbol("project-switch-viewing-test");
    const wrap = (projectId: string): JSX.Element => (
      <TooltipProvider>
        <VisionSetDataProvider client={client} scope={scope} makeQueryClient={() => queryClient}>
          <ProjectScreen projectId={projectId} tab="schema" />
        </VisionSetDataProvider>
      </TooltipProvider>
    );

    const view = render(wrap(OTHER_PROJECT));
    await screen.findByTestId("schema-editor");
    view.rerender(wrap(PROJECT));
    await viewVersion(1);
    await screen.findByTestId("past-version");

    view.rerender(wrap(OTHER_PROJECT));

    await screen.findByTestId("class-list");
    expect(screen.queryByTestId("past-version")).toBeNull();
    expect(screen.getByTestId("save-schema")).not.toBeNull();
  });

  /**
   * The rail asks the server what saving would change, and it asks about the
   * name somebody meant: a settled proposal, not a keystroke. A clean draft
   * publishes nothing, so it is not asked about at all.
   */
  it("asks once the class name stops changing, not once per keystroke", async () => {
    projectWithSchema();

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    const asks = (): Request[] =>
      sent.filter(
        (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/schema/preview"),
      );
    // Nothing has changed, so there is nothing to say about it.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(asks()).toHaveLength(0);

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    // The dialog buffers: ten keystrokes change nothing the draft holds, so the
    // server — which walks every annotation in the project for each answer — is
    // asked about none of them, nor about the nine prefixes of the name.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(asks()).toHaveLength(0);

    // The class is added once, whole, and that is what the rail asks about.
    await closeSheet();
    await waitFor(() => expect(asks().length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 600));

    // A bound rather than an exact count: a slow machine can outlast one 400ms
    // settle window, which makes a further ask correct behaviour. What is not a
    // race is that the last question asked is about the whole name.
    expect(asks().length).toBeLessThan(5);
    expect(bodies.get(asks()[asks().length - 1] as Request)).toContain("pedestrian");
    // An unnamed class is never part of a proposal: it is not a class
    // `POST /preview` accepts.
    for (const request of asks()) {
      for (const declared of (JSON.parse(bodies.get(request) ?? "{}") as { classes: { name: string }[] }).classes) {
        expect(declared.name).not.toBe("");
      }
    }
  });

  /**
   * `ProjectScreen` is *re-rendered* rather than remounted when the route's
   * `:projectId` changes, and nothing clears the draft it holds — so a draft
   * typed in one project is still in hand while another one is on screen. Every
   * read of it goes through `shownDraft`'s project guard, and the rail is the
   * one that would otherwise POST project A's classes to project B's API and
   * invite somebody to go clear real annotations over a narrowing nobody
   * proposed there.
   */
  it("never asks one project's API about another project's draft", async () => {
    projectWithSchema();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = harnessClient();
    const scope = Symbol("schema-draft-cross-project-test");
    const wrap = (node: ReactNode): JSX.Element => (
      <TooltipProvider>
        <VisionSetDataProvider client={client} scope={scope} makeQueryClient={() => queryClient}>
          {node}
        </VisionSetDataProvider>
      </TooltipProvider>
    );

    const view = render(
      wrap(<ProjectScreen projectId={PROJECT} tab="schema" onOpenBatch={vi.fn()} />),
    );
    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await closeSheet();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");

    view.rerender(wrap(<ProjectScreen projectId={OTHER_PROJECT} tab="schema" onOpenBatch={vi.fn()} />));

    // The arriving project shows its own, untouched draft…
    await waitFor(() =>
      expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes"),
    );
    // …and long enough for the settle to have fired the departing project's
    // proposal too, had anything been holding it.
    await new Promise((resolve) => setTimeout(resolve, 600));
    // …and nothing under it ever carries the class somebody typed in the project
    // they left.
    for (const request of sent.filter((sentRequest) =>
      new URL(sentRequest.url).pathname.startsWith(`/projects/${OTHER_PROJECT}/`),
    )) {
      expect(bodies.get(request) ?? "").not.toContain("pedestrian");
    }
    expect(
      sent.some(
        (request) =>
          new URL(request.url).pathname.startsWith(`/projects/${OTHER_PROJECT}/`) &&
          new URL(request.url).pathname.endsWith("/schema/preview"),
      ),
    ).toBe(false);
  });

  it("lists no frames on the page, and asks about none until a refusal opens the dialog", async () => {
    projectWithSchema();
    on("POST", /\/schema\/blocking-assets/, { status: 200, body: { items: [], total: 0 } });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onOpenBatch={vi.fn()} />);

    await screen.findByTestId("schema-editor");
    // The frames used to be a section under the editor, asked about on load and
    // again per keystroke. They are the refusal dialog's now, so the page itself
    // neither shows them nor pays for them.
    expect(screen.queryByTestId("blocking-assets")).toBeNull();
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByTestId("blocking-assets")).toBeNull();
    expect(
      sent.some((request) =>
        new URL(request.url).pathname.endsWith("/schema/blocking-assets"),
      ),
    ).toBe(false);
  });

  it("treats a schema-less project as an empty draft, not as an error", async () => {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: {
        id: PROJECT,
        name: "fresh",
        description: null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    // A project starts schema-less on purpose. This 404 is the normal state
    // of a project three seconds old, and an error surface here would tell a new
    // user their project is broken.
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 404,
      body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
    });
    on("GET", /schema\/versions$/, { status: 200, body: { items: [], total: 0 } });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    await waitFor(() => expect(screen.queryByTestId("schema-editor")).not.toBeNull());
    expect(screen.queryByTestId("schema-error")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).toContain("Saving creates version 1");
    expect(screen.getByTestId("save-schema").textContent).toBe("Save version 1");
    // Nothing is published yet, so there is no history to open and nothing to
    // compare a draft against.
    expect(screen.queryByTestId("open-history")).toBeNull();
  });

  it("edits a draft and publishes it as the next version", async () => {
    projectWithSchema();
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { project_id: PROJECT, version: 4, classes: CLASSES }, advanced_batches: [] },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    // Versioning is on demand: a clean draft has nothing to save, so the bar
    // that saves it is down — inert, and hidden from assistive tech — while
    // the status line says where the project stands for whoever cannot see it.
    expect(screen.getByTestId("schema-status").textContent).toContain("Version 3 active");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    expect(barState()).toBe("down");
    expect(screen.getByTestId("commit-bar").hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("commit-bar").getAttribute("aria-hidden")).toBe("true");
    // The button names the version it would publish.
    expect(screen.getByTestId("save-schema").textContent).toBe("Save version 4");
    // Reached anyway, a save of nothing answers rather than sending anything.
    await userEvent.click(screen.getByTestId("save-schema"));
    expect(sent.some((r) => r.method === "POST")).toBe(false);

    await userEvent.click(screen.getByTestId("add-class"));
    // A nameless class is refused the same way, not by a grey button:
    // `normalize_name` refuses a blank, so this mirrors the API's rule — and it
    // is refused at the dialog, so no nameless class ever reaches the draft.
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    expect((await screen.findByTestId("class-name-error-2")).textContent).toBe("Name this class.");
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    // The rail's own settled previews are questions, not writes, so what must
    // not go out is a publish.
    expect(
      sent.some(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname.endsWith("/publish"),
      ),
    ).toBe(false);

    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await closeSheet();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes create v4");
    // The bar rises with the first edit, reachable now.
    expect(barState()).toBe("up");
    expect(screen.getByTestId("commit-bar").hasAttribute("inert")).toBe(false);
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() =>
      expect(
        sent.some(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toBe(true),
    );
    const request = sent.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
    );
    expect(request).toBeDefined();
    // The plain save carries no gate — `allow_destructive` is only ever sent
    // after the API has said it is needed.
    expect(new URL(request?.url ?? "").searchParams.get("allow_destructive")).toBeNull();
  });

  /**
   * A row's mark is what the draft does to its class, read off the kernel's own
   * answer by name. Only a draft that differs from the active version has
   * anything to say, so a clean ledger is unmarked.
   */
  it("marks a draft's rows with what saving would do to each, and lists the changes", async () => {
    projectWithSchema();
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        is_refused: false,
        blockers: [],
        diff: {
          is_destructive: false,
          destructive_classes: [],
          changes: [
            { kind: "additive", label_class: "pedestrian", attribute: null, detail: "class 'pedestrian' added" },
            {
              kind: "additive",
              label_class: "vehicle",
              attribute: "lit",
              detail: "optional attribute 'lit' added to 'vehicle'",
            },
          ],
        },
      },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    expect(document.querySelectorAll('[data-testid^="class-mark-"]')).toHaveLength(0);
    expect(screen.queryByTestId("draft-changes")).toBeNull();

    await addNamedClass("pedestrian");

    // New is known the moment the class is named; Changed is the kernel's, so it
    // waits for the settled answer.
    expect(screen.getByTestId("class-mark-2").textContent).toBe("New");
    await waitFor(() => expect(screen.getByTestId("class-mark-0").textContent).toBe("Changed"));
    // `lane` was not touched, and a row with nothing to say carries nothing.
    expect(screen.queryByTestId("class-mark-1")).toBeNull();
    // The mark is a description of the row, not part of its name: "Edit
    // pedestrian" is still what it is called, and a screen reader hears the mark
    // after it.
    const card = screen.getByTestId("class-card-2");
    expect(card.getAttribute("aria-label")).toBe("Edit pedestrian");
    expect(document.getElementById(card.getAttribute("aria-describedby") ?? "")?.textContent).toBe("New");
    // The bar counts the same answer, and its Review lists it, one line per
    // change, in the kernel's words.
    await waitFor(() => expect(screen.getByTestId("draft-count").textContent).toBe("2 changes in draft"));
    await userEvent.click(screen.getByTestId("review-changes"));
    const changes = await screen.findByTestId("draft-changes");
    expect([...changes.querySelectorAll("li")].map((line) => line.textContent)).toEqual([
      "class 'pedestrian' added",
      "optional attribute 'lit' added to 'vehicle'",
    ]);
    // A line opens the class it is about.
    await userEvent.click(within(changes).getByRole("button", { name: "optional attribute 'lit' added to 'vehicle'" }));
    expect(await screen.findByTestId("class-0")).not.toBeNull();
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "vehicle");
  });

  /**
   * The badge is the dialog's third door, beside a refused removal and a refused
   * Save: it says the frames are there before Save is pressed, from a settled
   * preview — the publish's own answer still decides.
   */
  it("says how many frames are in the way before Save, and opens the dialog that lists them", async () => {
    const ASSET = "22222222-2222-4222-8222-222222222222";
    const BATCH = "33333333-3333-4333-8333-333333333333";
    projectWithSchema();
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        is_refused: true,
        diff: { changes: [], destructive_classes: ["lane", "vehicle"], is_destructive: true },
        blockers: [
          { label_class: "lane", annotations: 12, assets: 3 },
          { label_class: "vehicle", annotations: 2, assets: 1 },
        ],
      },
    });
    on("POST", /\/schema\/blocking-assets/, {
      status: 200,
      body: {
        items: [
          {
            asset: {
              id: ASSET,
              project_id: PROJECT,
              modality: "image",
              point_cloud: null,
              content_hash: "deadbeef",
              format: "jpeg",
              width: 1920,
              height: 1080,
              frame_index: 7,
              frame_timestamp: null,
              source_id: null,
              thumbnail_hash: null,
              ingested_at: "2024-01-01T00:00:00Z",
            },
            label_classes: ["lane"],
            annotations: 12,
            batch_ids: [BATCH],
          },
        ],
        total: 1,
      },
    });
    const opened = vi.fn();

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onOpenBatch={opened} />);
    await screen.findByTestId("schema-editor");
    expect(screen.queryByTestId("frames-in-the-way")).toBeNull();

    await addNamedClass("pedestrian");

    // The sum of the blockers' frames, said in the draft's own panel.
    const badge = await screen.findByTestId("frames-in-the-way");
    expect(badge.textContent).toContain("4 frames in the way");
    // And on the rows the preview names, over the "Changed"/"New" a row would
    // otherwise carry.
    await waitFor(() => expect(screen.getByTestId("class-mark-0").textContent).toBe("In the way"));
    expect(screen.getByTestId("class-mark-1").textContent).toBe("In the way");
    expect(screen.getByTestId("class-mark-2").textContent).toBe("New");
    // Nothing has been asked about the frames themselves, nor published.
    expect(screen.queryByTestId("orphan-dialog")).toBeNull();
    expect(
      sent.some((request) => new URL(request.url).pathname.endsWith("/schema/blocking-assets")),
    ).toBe(false);

    // The badge can be showing the answer about the draft a moment ago (the
    // list is kept while the next proposal is asked about); the dialog is about
    // the settled one, so wait for it to have settled on the typed name.
    await waitFor(() =>
      expect(
        sent.some(
          (request) =>
            new URL(request.url).pathname.endsWith("/schema/preview") &&
            (bodies.get(request) ?? "").includes("pedestrian"),
        ),
      ).toBe(true),
    );
    await userEvent.click(badge);

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("This draft can’t be saved yet");
    expect(dialog.textContent).toContain("lane: 12 annotations across 3 assets");
    expect(dialog.textContent).toContain("Undo the change, or clear those labels first");
    expect(within(dialog).getByTestId("orphan-close").textContent).toBe("Close");
    await within(dialog).findByTestId("blocking-asset-list");
    expect(within(dialog).getByTestId("blocking-asset-count").textContent).toContain("1");
    // Asked about the settled draft, pedestrian included — the list is of what
    // *this* proposal would orphan.
    const asked = sent.filter((request) =>
      new URL(request.url).pathname.endsWith("/schema/blocking-assets"),
    );
    expect(asked).toHaveLength(1);
    expect(bodies.get(asked[0])).toContain("pedestrian");
    await userEvent.click(within(dialog).getByTestId("blocking-asset-batch"));
    expect(opened).toHaveBeenCalledWith(BATCH);

    await userEvent.click(within(dialog).getByTestId("orphan-close"));
    await waitFor(() => expect(screen.queryByTestId("orphan-dialog")).toBeNull());
    // Closing it changes nothing about the draft or what is in the way.
    expect(screen.getByTestId("frames-in-the-way")).not.toBeNull();
    expect(classCards()).toHaveLength(3);
    expect(sent.some((request) => new URL(request.url).pathname.endsWith("/publish"))).toBe(false);
  });

  it("speaks of a single frame in the way in the singular", async () => {
    projectWithSchema();
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        is_refused: true,
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 5, assets: 1 }],
      },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await addNamedClass("pedestrian");

    expect((await screen.findByTestId("frames-in-the-way")).textContent).toContain("1 frame in the way");
  });

  it("locks draft mutations until a deferred publish settles", async () => {
    projectWithSchema();
    let resolvePublish: ((answer: Exclude<HandlerAnswer, undefined>) => void) | undefined;
    handlers.push((request) => {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish")
      ) {
        return undefined;
      }
      return new Promise((resolve) => {
        resolvePublish = resolve;
      });
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await addNamedClass("pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));
    await waitFor(() => expect(resolvePublish).toBeDefined());

    // The row is still pressable while the publish is in flight; what it opens
    // is a form whose every control is locked.
    await userEvent.click(screen.getByTestId("class-card-2"));
    const className = await screen.findByTestId("class-name-2");
    expect(className).toHaveProperty("disabled", true);
    expect(screen.getByTestId("add-class")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("remove-class-2")).toHaveProperty("disabled", true);
    await userEvent.type(className, "-newer");
    expect(className).toHaveProperty("value", "pedestrian");

    if (resolvePublish === undefined) throw new Error("Expected the deferred publish request");
    resolvePublish({
      status: 201,
      body: {
        published: {
          project_id: PROJECT,
          version: 4,
          classes: [...CLASSES, { name: "pedestrian", geometries: ["bbox"], color: null, attributes: [] }],
        },
        advanced_batches: [],
      },
    });
    await waitFor(() => expect(screen.getByTestId("save-schema")).toHaveProperty("disabled", false));
    expect(screen.getByTestId("class-name-2")).toHaveProperty("value", "pedestrian");
  });

  it("previews a publishable narrowing before one flagged publish", async () => {
    projectWithSchema();
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    handlers.push((request) => {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish")
      ) {
        return undefined;
      }
      const allowed = new URL(request.url).searchParams.get("allow_destructive") === "true";
      return allowed
        ? {
            status: 201,
            body: {
              published: { project_id: PROJECT, version: 4, classes: [] },
              advanced_batches: [],
            },
          }
        : {
            status: 409,
            body: {
              code: "DESTRUCTIVE_SCHEMA_CHANGE",
              message: "internal wording must not appear",
            },
          };
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("destructive-dialog");
    expect(dialog.textContent).toContain("lane");
    expect(dialog.textContent).not.toContain("internal wording must not appear");
    // Three descriptions, and a screen reader reaches all three — not only the first.
    expect(describedBy(dialog)).toHaveLength(3);
    expect(describedBy(dialog).join(" ")).toContain("A batch still open on the current version");
    // The blast radius, counted: DESIGN.md requires a confirmation to name what
    // it costs. `blockers` is empty on every preview that reaches this dialog,
    // so the zero is measured rather than assumed.
    expect(dialog.textContent).toContain("1 class narrows");
    expect(dialog.textContent).toContain("No existing annotation becomes invalid");
    // The removed promise. It said annotations are untouched, which answers the
    // invariant by implication; the dialog states the rule itself instead.
    expect(dialog.textContent).not.toContain("Existing annotations are not touched");
    expect(
      sent.some(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
      ),
    ).toBe(false);

    const allow = screen.getByTestId("allow-destructive");
    await waitFor(() => expect(allow).toHaveProperty("disabled", false));
    await userEvent.click(allow);
    await waitFor(() =>
      expect(
        sent.filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toHaveLength(1),
    );
    const publishRequest = sent.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
    );
    expect(new URL(publishRequest?.url ?? "").searchParams.get("allow_destructive")).toBe("true");
  });

  it("counts every narrowing class in the confirmation", async () => {
    projectWithSchema();
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) {
        return undefined;
      }
      return {
        status: 200,
        body: {
          is_refused: false,
          blockers: [],
          diff: {
            is_destructive: true,
            destructive_classes: ["lane", "sign"],
            changes: [
              { kind: "destructive", label_class: "lane", attribute: null, detail: "class 'lane' removed" },
              { kind: "destructive", label_class: "sign", attribute: null, detail: "class 'sign' removed" },
            ],
          },
        },
      };
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("destructive-dialog");
    expect(dialog.textContent).toContain("2 classes narrow");
    expect(dialog.textContent).toContain("lane");
    expect(dialog.textContent).toContain("sign");
    expect(dialog.textContent).toContain("No existing annotation becomes invalid");
    // The kernel's words, not a count: a re-casing and a removal both "narrow one
    // class", and only the detail tells them apart.
    const listed = within(dialog).getAllByTestId("narrowing-change").map((item) => item.textContent);
    expect(listed).toEqual(["class 'lane' removed", "class 'sign' removed"]);
  });

  it("says what a batch still open on the outgoing version will keep writing", async () => {
    projectWithSchema();
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) {
        return undefined;
      }
      return {
        status: 200,
        body: {
          is_refused: false,
          blockers: [],
          diff: {
            is_destructive: true,
            destructive_classes: ["lane", "sign"],
            changes: [
              { kind: "destructive", label_class: "lane", attribute: null, detail: "class 'lane' removed" },
              { kind: "destructive", label_class: "sign", attribute: null, detail: "class 'sign' removed" },
            ],
          },
        },
      };
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("destructive-dialog");
    // A batch still pinned to the outgoing version keeps writing the dropped
    // class, and the bill arrives at the release rather than at this save.
    expect(dialog.textContent).toContain("still open on the current version");
    expect(dialog.textContent).toContain("a release cannot be published");
    // Still no machine code, no UUID, no SDK keyword.
    expect(dialog.textContent).not.toContain("SCHEMA_CHANGE_WOULD_ORPHAN");
    expect(dialog.textContent).not.toContain("allow_destructive");
  });

  it("prevents repeated confirmation while its second preview is pending", async () => {
    projectWithSchema();
    // The removal's own preview, then the rail's settled one and Save's — in
    // whichever order the debounce and the click fall — and then the preview the
    // confirmation sends again, which is the one held open.
    let previews = 0;
    let resolveSecondPreview: ((answer: Exclude<HandlerAnswer, undefined>) => void) | undefined;
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) {
        return undefined;
      }
      previews += 1;
      if (previews === 4) {
        return new Promise((resolve) => {
          resolveSecondPreview = resolve;
        });
      }
      return {
        status: 200,
        body: {
          diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
          blockers: [],
          is_refused: false,
        },
      };
    });
    on("POST", /schema\/drafts\/curated\/publish(?:\?.*)?$/, {
      status: 201,
      body: {
        published: { project_id: PROJECT, version: 4, classes: [] },
        advanced_batches: [],
      },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));
    const allow = await screen.findByTestId("allow-destructive");
    await waitFor(() => expect(allow).toHaveProperty("disabled", false));
    // The rail's settled preview has landed too, so the next one is the
    // confirmation's and not a late arrival from the debounce.
    await waitFor(() => expect(previews).toBe(3));
    await userEvent.click(allow);
    await waitFor(() => expect(resolveSecondPreview).toBeDefined());

    expect(allow).toHaveProperty("disabled", true);
    await userEvent.click(allow);

    if (resolveSecondPreview === undefined) throw new Error("Expected the deferred second preview");
    resolveSecondPreview({
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    await waitFor(() =>
      expect(
        sent.filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toHaveLength(1),
    );
  });

  it("opens the terminal blocker dialog when the save-time preview refuses", async () => {
    projectWithSchema();
    let previews = 0;
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) {
        return undefined;
      }
      previews += 1;
      return previews === 1
        ? {
            status: 200,
            body: {
              diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
              blockers: [],
              is_refused: false,
            },
          }
        : {
            status: 200,
            body: {
              diff: {
                changes: [
                  { kind: "additive", label_class: "Lane", attribute: null, detail: "class 'Lane' added" },
                  {
                    kind: "destructive",
                    label_class: "lane",
                    attribute: null,
                    detail: "class 'lane' removed; 'Lane' differs only in its casing",
                  },
                ],
                destructive_classes: ["lane"],
                is_destructive: true,
              },
              blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
              is_refused: true,
            },
          };
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("12 annotations");
    expect(dialog.textContent).toContain("3 assets");
    expect(describedBy(dialog)).toHaveLength(2);
    expect(describedBy(dialog).join(" ")).toContain("There is no override for this one");
    // What was asked, in the kernel's words — the only place a re-casing is told
    // apart from a removal. Additive changes stay out of a refusal.
    expect(
      within(dialog).getAllByTestId("narrowing-change").map((item) => item.textContent),
    ).toEqual(["class 'lane' removed; 'Lane' differs only in its casing"]);
    // The missing button *is* the assertion. `SchemaChangeWouldOrphan` has no
    // override and is deliberately not a subclass of `DestructiveSchemaChange`, so
    // a "Save anyway" here would be an infinite loop with a person in it.
    expect(screen.queryByTestId("allow-destructive")).toBeNull();
    expect(screen.queryByTestId("destructive-dialog")).toBeNull();
    expect(within(dialog).getByTestId("orphan-close")).not.toBeNull();
    expect(
      sent.some(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
      ),
    ).toBe(false);
  });

  it("uses typed publish-time orphan blockers when the preview becomes stale", async () => {
    projectWithSchema();
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    on("POST", /schema\/drafts\/curated\/publish(?:\?.*)?$/, {
      status: 409,
      body: {
        code: "SCHEMA_CHANGE_WOULD_ORPHAN",
        message: "internal wording must not appear",
        detail: { blockers: [{ label_class: "lane", annotations: 12, assets: 3 }] },
      },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));
    const allow = await screen.findByTestId("allow-destructive");
    await waitFor(() => expect(allow).toHaveProperty("disabled", false));
    await userEvent.click(allow);
    await waitFor(() =>
      expect(
        sent.filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toHaveLength(1),
    );

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("lane: 12 annotations across 3 assets");
    expect(dialog.textContent).not.toContain("internal wording must not appear");
    expect(screen.queryByTestId("allow-destructive")).toBeNull();
    expect(screen.queryByTestId("destructive-dialog")).toBeNull();
  });

  it.each([
    { shape: "absent", detail: undefined },
    { shape: "malformed", detail: { blockers: [{ label_class: "lane" }] } },
  ])(
    "clears destructive confirmation and renders prose for an orphan refusal with $shape detail",
    async ({ detail }) => {
      projectWithSchema();
      on("POST", /schema\/preview$/, {
        status: 200,
        body: {
          diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
          blockers: [],
          is_refused: false,
        },
      });
      on("POST", /schema\/drafts\/curated\/publish(?:\?.*)?$/, {
        status: 409,
        body: {
          code: "SCHEMA_CHANGE_WOULD_ORPHAN",
          message: "internal wording must not appear",
          detail,
        },
      });

      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
      await screen.findByTestId("schema-editor");
      await removeClass(1);
      await userEvent.click(screen.getByTestId("save-schema"));
      await userEvent.click(await screen.findByTestId("allow-destructive"));

      const error = await screen.findByTestId("schema-error");
      expect(error.textContent).toContain(
        "Annotations already exist that this change would orphan.",
      );
      expect(error.textContent).not.toContain("internal wording must not appear");
      expect(error.textContent).not.toContain("SCHEMA_CHANGE_WOULD_ORPHAN");
      expect(screen.queryByTestId("allow-destructive")).toBeNull();
      expect(screen.queryByTestId("destructive-dialog")).toBeNull();
    },
  );

  it("says an autosave failure in prose, not as a kernel identifier", async () => {
    projectWithSchema();
    on("PUT", /\/schema\/drafts\/curated$/, {
      status: 409,
      body: {
        code: "DESTRUCTIVE_SCHEMA_CHANGE",
        message: "internal wording must not appear",
      },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await addNamedClass("pedestrian");

    const alert = await screen.findByTestId("schema-draft-error", {}, { timeout: 2000 });
    expect(alert.textContent).toContain(
      "This change removes part of the contract already in use.",
    );
    expect(alert.textContent).not.toContain("DESTRUCTIVE_SCHEMA_CHANGE");
    expect(alert.textContent).not.toContain("internal wording must not appear");
  });

  it("offers the geometries the server publishes, and asks it for them", async () => {
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    // `polyline` is offered even where no tool draws one: the API
    // accepts it, the exporters need it, and the tool strip is where a person
    // learns there is nothing to draw with. Offering it is not offering a refusal.
    //
    // Addressed by `data-testid`, which keeps the **wire** value, while the label
    // beside it is the display word — so this asserts which geometries are on
    // offer without also asserting what they are called, which is
    // `geometryCategory.test.ts`'s job.
    for (const geometry of IMPLEMENTED_GEOMETRIES) {
      expect(await screen.findByTestId(`class-geometry-0-${geometry}`)).toBeTruthy();
    }
    // `keypoints` is refused at write time with `UnsupportedGeometry`, and the
    // server does not publish it.
    expect(screen.queryByTestId("class-geometry-0-keypoints")).toBeNull();
    expect(sent.some((request) => new URL(request.url).pathname.endsWith("/geometries"))).toBe(true);
  });

  it("offers a geometry the server adds, with no list in the client to edit", async () => {
    on("GET", /\/geometries$/, { status: 200, body: geometryPage([...IMPLEMENTED_GEOMETRIES, "keypoints"]) });
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    expect(await screen.findByTestId("class-geometry-0-keypoints")).toBeTruthy();
  });

  it("offers only the subset the server publishes", async () => {
    on("GET", /\/geometries$/, { status: 200, body: geometryPage(["polygon", "bbox"]) });
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    await waitFor(() =>
      expect(within(screen.getByTestId("class-geometry-0")).getAllByRole("button").map((item) => item.getAttribute("data-testid"))).toEqual([
        "class-geometry-0-bbox",
        "class-geometry-0-polygon",
      ]),
    );
    expect(screen.getByTestId("class-geometry-0-bbox")).toHaveProperty("disabled", false);
  });

  it("keeps the shapes disabled while the set loads", async () => {
    handlers.push((request) => (new URL(request.url).pathname.endsWith("/geometries") ? new Promise<HandlerAnswer>(() => {}) : undefined));
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    const group = screen.getByTestId("class-geometry-0");
    expect(group.getAttribute("aria-busy")).toBe("true");
    expect(within(group).getAllByRole("button").map((item) => item.getAttribute("data-testid"))).toEqual(["class-geometry-0-bbox"]);
    expect(screen.getByTestId("class-geometry-0-bbox")).toHaveProperty("disabled", true);
  });

  it("says a failed read with the shapes disabled, and offers them once a retry answers", async () => {
    let refusals = 1;
    handlers.push((request) => {
      if (!new URL(request.url).pathname.endsWith("/geometries") || refusals === 0) return undefined;
      refusals -= 1;
      return { status: 500, body: { code: "INTERNAL_ERROR", message: "The geometry catalog could not be read." } };
    });
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    const error = await screen.findByTestId("class-geometry-0-error");
    expect(error.textContent).toContain("The geometry catalog could not be read.");
    expect(screen.getByTestId("class-geometry-0-bbox")).toHaveProperty("disabled", true);
    expect(screen.queryByTestId("class-geometry-0-polygon")).toBeNull();

    await userEvent.click(within(error).getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("class-geometry-0-polygon")).toHaveProperty("disabled", false);
    expect(screen.queryByTestId("class-geometry-0-error")).toBeNull();
  });

  /**
   * The class dialog's shapes are one flat group of icon buttons: a class
   * takes a handful of shapes, and a caption per category over one or two of
   * them is more page than the choice is worth. (The annotator's narrow
   * add-a-class dialog still groups them — `classFields.test.tsx` holds that.)
   *
   * What is asserted is what is on the page without opening anything, which is
   * the point of checkboxes over a dropdown: what a class accepts is readable
   * at a glance, in the order a person reads down it.
   */
  it("lists the shapes it offers as one row of icon buttons, with no category captions", async () => {
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    const group = screen.getByTestId("class-geometry-0");
    const chips = within(group).getAllByRole("button");
    expect(chips.map((chip) => chip.getAttribute("data-testid"))).toEqual([
      "class-geometry-0-bbox",
      "class-geometry-0-obb",
      "class-geometry-0-polygon",
      "class-geometry-0-mask",
      "class-geometry-0-polyline",
      "class-geometry-0-classification_tag",
      "class-geometry-0-cuboid_3d",
      "class-geometry-0-polyline_3d",
    ]);
    // The display words, not the wire values: `classification_tag` is an
    // identifier and `tag` is what it is called. Icon only, so the word is
    // each button's name, and it is said again beside the group.
    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual(["Box", "Rotated box", "Polygon", "Mask", "Polyline", "Tag", "3D box", "3D polyline"]);
    expect(chips.map((chip) => chip.textContent)).toEqual(["", "", "", "", "", "", "", ""]);
    expect(within(group.parentElement!).getByText("Box").getAttribute("aria-hidden")).toBe("true");
    // What the class accepts is readable at a glance, with nothing opened.
    expect(chips.map((chip) => chip.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false", "false", "false", "false", "false"]);
    expect(screen.queryByTestId(/^geometry-category-/)).toBeNull();
  });

  /**
   * The regression pin. A shape is *added* to the set, and — like every other
   * field in the dialog — only reaches the draft on Save.
   */
  it("adds a geometry to a class rather than replacing the one it had, and only on Save", async () => {
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    expect(screen.getByTestId("class-geometry-0-bbox").getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(screen.getByTestId("class-geometry-0-polyline"));

    // Both, which is the whole feature — a control that replaced would leave the
    // first chip off and this would still find the second one on.
    expect(screen.getByTestId("class-geometry-0-bbox").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-geometry-0-polyline").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await closeSheet();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    await userEvent.click(screen.getByTestId("class-card-0"));
    expect(screen.getByTestId("class-geometry-0-bbox").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-geometry-0-polyline").getAttribute("aria-pressed")).toBe("true");
  });

  it("refuses to unpress the last geometry, and says why rather than greying out", async () => {
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    const only = screen.getByTestId("class-geometry-0-bbox");
    expect(only.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(only);

    expect(screen.getByTestId("class-geometry-0-bbox").getAttribute("aria-pressed")).toBe("true");
    // Principle 9: the control that will not move carries the reason. `title`
    // and `aria-disabled` rather than the `disabled` attribute, so a keyboard
    // still reaches it.
    expect(only.getAttribute("title")).toMatch(/at least one shape/i);
    expect(only.getAttribute("aria-disabled")).toBe("true");
    expect(only.tagName).toBe("BUTTON");
    expect(only.hasAttribute("disabled")).toBe(false);
    // Drawn as the canvas draws it, beside its word.
    expect(only.querySelector("svg")).not.toBeNull();
    expect(only.getAttribute("aria-label")).toBe("Box");
    // Nothing was changed, so there is nothing to save.
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  /**
   * The colour control has to show the colour the class is actually drawn in.
   *
   * The swatch was bound to the **stored** colour, which is `null` for a derived
   * class, so `<input type="color">` fell back to its own default and rendered
   * grey — beside a dot showing the real teal, and against an annotator drawing
   * that same teal. One row, two colours, in the one control whose entire job is to
   * say what colour something is.
   */
  it("previews a derived class in the colour it is actually drawn in", async () => {
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");

    // `lane` declares no colour, so `classColor` derives one. Computed here from
    // the shipped rule rather than hardcoded, which is what makes this a check on
    // *agreement* — a change to the palette moves both sides together, and only a
    // picker that stopped reading `classColor` fails.
    const derived = hexColor(
      classColor({ name: "lane", geometries: ["polygon"], color: null, attributes: [] }, "lane"),
    );
    expect(derived).not.toBeNull();
    // One dialog at a time, so each class is asserted from its own.
    await selectClass(1);
    // The picker lives in the custom tile's popover, so it is opened to be read.
    await userEvent.click(screen.getByTestId("class-color-trigger-1"));
    expect(screen.getByTestId("class-color-hex-1")).toHaveProperty("value", derived!.slice(1).toUpperCase());
    // Never the neutral, which is what it used to be for every derived class.
    expect(screen.getByTestId("class-color-hex-1")).not.toHaveProperty("value", "888888");
    // A derived colour is not a declared one, so there is nothing to put back.
    expect(screen.queryByTestId("clear-color-1")).toBeNull();

    // And a declared colour is still itself.
    await userEvent.keyboard("{Escape}");
    await selectClass(0);
    await userEvent.click(screen.getByTestId("class-color-trigger-0"));
    expect(screen.getByTestId("class-color-hex-0")).toHaveProperty("value", "38BDF8");
  });

  it("does not turn a derived colour into a declared one just by showing it", async () => {
    // The half worth being careful about: making the
    // input *display* a colour must not make the class *declare* it. A schema
    // version that pinned today's hash output would make every derived class look
    // authored, and would change meaning if the palette rule ever moved.
    projectWithSchema();
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { project_id: PROJECT, version: 4, classes: CLASSES }, advanced_batches: [] },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    // Dirty by something that is not the colour. An untouched draft sends
    // nothing — the button answers instead of being grey, and that
    // refusal is itself the first half of the guarantee.
    await userEvent.click(screen.getByTestId("save-schema"));
    expect(sent.some((r) => r.method === "PUT")).toBe(false);
    await addNamedClass("pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));

    // The classes now travel in the draft's own write, not in the publish —
    // Save flushes it before publishing, so this is the request that carries
    // what the version will actually record.
    await waitFor(() => expect(sent.some((r) => r.method === "PUT")).toBe(true));
    const request = sent.find((r) => r.method === "PUT")!;
    const body = JSON.parse(bodies.get(request) ?? "{}") as {
      classes: { name: string; color: string | null }[];
    };
    // Assert the payload, never the control: what matters is what the version
    // records.
    expect(body.classes.find((one) => one.name === "lane")?.color).toBeNull();
    expect(body.classes.find((one) => one.name === "pedestrian")?.color).toBeNull();
    expect(body.classes.find((one) => one.name === "vehicle")?.color).toBe("#38bdf8");
  });

  it("\"Use the name’s colour\" clears a declared colour back to the derived one, once saved", async () => {
    projectWithSchema();
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { project_id: PROJECT, version: 4, classes: CLASSES }, advanced_batches: [] },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);
    await userEvent.click(screen.getByTestId("class-color-trigger-0"));
    await userEvent.click(screen.getByTestId("clear-color-0"));

    // Nothing is declared any more, so the way back is gone with it.
    expect(screen.queryByTestId("clear-color-0")).toBeNull();
    // The stored value goes back to null, which is what the button is for.
    await userEvent.keyboard("{Escape}");
    await closeSheet();
    await userEvent.click(screen.getByTestId("save-schema"));
    // The draft's own write carries the classes now; the publish that follows
    // carries only a revision.
    await waitFor(() => expect(sent.some((r) => r.method === "PUT")).toBe(true));
    const request = sent.find((r) => r.method === "PUT")!;
    const body = JSON.parse(bodies.get(request) ?? "{}") as {
      classes: { name: string; color: string | null }[];
    };
    expect(body.classes.find((one) => one.name === "vehicle")?.color).toBeNull();
  });
});

/**
 * The sections are tabs, so what is *not* on the page is an assertion.
 *
 * The interesting one is the last: a query that lives in the section that renders
 * it is a query that follows the tab. That is what makes the split more than
 * cosmetic, and it is invisible in the rendering — only the request log shows it.
 */

describe("the schema editor's class ledger", () => {
  /** Fifty classes: an ordinary Physical AI ontology, and what the stack broke at. */
  const MANY = Array.from({ length: 50 }, (_, index) => ({
    name: `class-${String(index).padStart(2, "0")}`,
    geometries: ["bbox"],
    color: null,
    attributes: [],
  }));

  function withClasses(
    classes: unknown[],
    options: {
      readonly usage?: readonly { label_class: string; annotations: number; assets: number }[];
      readonly versions?: readonly unknown[];
    } = {},
  ): void {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: {
        id: PROJECT,
        name: "highway",
        description: null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 200,
      body: { project_id: PROJECT, version: 1, classes },
    });
    on("GET", /schema\/versions$/, {
      status: 200,
      body: { items: options.versions ?? [], total: options.versions?.length ?? 0 },
    });
    on("GET", /\/stats$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        asset_count: 10,
        annotated_asset_count: 5,
        annotation_count: 4372,
        class_count: classes.length,
        annotated_pct: 50,
        classes: options.usage ?? [{ label_class: "class-00", annotations: 4372, assets: 5 }],
      },
    });
    on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
    on("GET", /\/batches/, { status: 200, body: { items: [], total: 0 } });
  }

  /** Open one class's dialog. */
  async function openCard(index: number): Promise<void> {
    await userEvent.click(screen.getByTestId(`class-card-${index}`));
    await screen.findByTestId(`class-${index}`);
  }

  /** Pick the Shortcut the open dialog's class should hold — its place in the list. */
  async function choosePosition(slot: number, place: number): Promise<void> {
    await userEvent.click(screen.getByTestId(`class-position-${slot}`));
    await userEvent.click(await screen.findByTestId(`class-position-${slot}-${place}`));
  }

  it("shows every class as a row, and none of their forms until one is opened", async () => {
    // The whole point of the layout. Fifty stacked forms is what the first
    // editor was, and it is unusable well before fifty. Rows come twenty-five to
    // a page, so the table is never as long as the schema.
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    await screen.findByTestId("class-list");
    expect(classCards()).toHaveLength(25);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–25 of 50 classes");
    expect(screen.queryByTestId("class-sheet")).toBeNull();
    expect(screen.queryByTestId("class-name-0")).toBeNull();
    expect(screen.queryByTestId("class-name-49")).toBeNull();
    // The ledger is the page: no picker to choose a class from.
    expect(screen.queryByTestId("class-picker")).toBeNull();
  });

  it("shows a row's name, shapes, hotkey, attributes and how much has been drawn with it", async () => {
    withClasses([
      {
        name: "class-00",
        geometries: ["bbox", "polygon"],
        color: "#38bdf8",
        attributes: [
          { name: "occluded", kind: "boolean", required: true, options: null, default: null },
          { name: "note", kind: "string", required: false, options: null, default: null },
        ],
      },
      { name: "class-01", geometries: ["polyline"], color: null, attributes: [] },
    ]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    const first = screen.getByTestId("class-card-0");
    // A row's name is a plain button that says what it opens.
    expect(first.tagName).toBe("BUTTON");
    expect(first.getAttribute("aria-label")).toBe("Edit class-00");
    expect(first.getAttribute("aria-haspopup")).toBeNull();
    expect(first.textContent).toContain("class-00");
    // How many attributes it declares, inline beside the name.
    expect(first.textContent).toContain("2 attributes");
    const row = screen.getByTestId("class-row-0");
    // One glyph per geometry, each shape named in words for a screen reader.
    expect(row.querySelectorAll("svg[viewBox='0 0 28 20']")).toHaveLength(2);
    expect(row.textContent).toContain("box");
    expect(row.textContent).toContain("polygon");
    // The hotkey the annotator will give it, and the attributes it declares —
    // a required one carries a star.
    expect(within(row).getByLabelText("Hotkey 1").textContent).toBe("1");
    expect(row.textContent).toContain("occluded*, note");
    expect(row.textContent).not.toContain("note*");
    expect(row.textContent).not.toContain("No attributes");

    const second = screen.getByTestId("class-row-1");
    expect(within(second).getByLabelText("Hotkey 2").textContent).toBe("2");
    expect(second.textContent).toContain("No attributes");

    // Counts arrive after the rows do, and a class nothing has used says so.
    await waitFor(() =>
      expect(screen.getByTestId("class-card-count-0").textContent).toBe(
        `${(4372).toLocaleString(undefined)} annotations`,
      ),
    );
    expect(screen.getByTestId("class-card-count-1").textContent).toBe("Not used yet");
  });

  it("speaks of a single annotation in the singular", async () => {
    withClasses(MANY.slice(0, 1), { usage: [{ label_class: "class-00", annotations: 1, assets: 1 }] });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    // The row says it in the singular, and so does the open row's sentence.
    await waitFor(() =>
      expect(screen.getByTestId("class-card-count-0").textContent).toBe("1 annotation"),
    );
    await openCard(0);
    expect(screen.getByTestId("class-count-0").textContent).toContain("1 label on 1 frame");
  });

  it("gives a hotkey to the first nine classes and none to the rest", async () => {
    withClasses(MANY.slice(0, 10));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    expect(screen.getByLabelText("Hotkey 9")).not.toBeNull();
    expect(screen.queryByLabelText("Hotkey 10")).toBeNull();
    expect(screen.getByTestId("class-card-9").textContent).not.toMatch(/\b10\b/);
  });

  it("opens the dialog of the class it names, over the ledger", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-card-1"));

    const detail = await screen.findByTestId("class-sheet");
    // A panel at the right of the table, labelled for what it holds.
    expect(detail.closest("aside")?.getAttribute("aria-label")).toBe("Class");
    expect(detail.closest("[role=dialog]")).toBeNull();
    // Focus went into it, onto the name.
    expect(document.activeElement).toBe(within(detail).getByTestId("class-name-1"));
    expect(within(detail).getByTestId("class-1")).not.toBeNull();
    expect(within(detail).queryByTestId("class-0")).toBeNull();
    expect(within(detail).getByTestId("class-name-1")).toHaveProperty("value", "lane");
    // It is the table's neighbour, not a part of the list.
    expect(screen.getByTestId("class-list").contains(detail)).toBe(false);
    expect(within(detail).getByRole("heading", { name: "Edit lane" })).not.toBeNull();
    // Nothing is drawn with `lane` yet, so the dialog says a change is free.
    expect(screen.getByTestId("class-count-1").textContent).toContain(
      "Not used yet, so any change here is free.",
    );
    expect(screen.getByTestId("class-meta-1").textContent).toContain("Not used yet");
    // One class's form at a time, the other's is not in the page.
    expect(screen.queryByTestId("class-name-0")).toBeNull();
  });

  it("opens a row from the keyboard, and puts it away with Save, focus back on the row", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    screen.getByTestId("class-card-0").focus();
    await userEvent.keyboard("{Enter}");
    await screen.findByTestId("class-0");

    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(classCards()).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));
    // Saving what was not changed is not an edit.
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("puts a dialog away with Cancel, and opens another class's in its place, one at a time", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-card-0"));
    await screen.findByTestId("class-0");
    expect(screen.getAllByTestId("class-sheet")).toHaveLength(1);
    // Not modal: the rows beside the panel stay in the page, and it is its own region.
    expect(screen.getByTestId("class-list").closest("[aria-hidden='true']")).toBeNull();
    expect(screen.getByTestId("class-sheet").closest("aside")?.getAttribute("aria-label")).toBe("Class");

    await userEvent.click(screen.getByTestId("class-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));

    await userEvent.click(screen.getByTestId("class-card-1"));
    await screen.findByTestId("class-1");
    expect(screen.queryByTestId("class-0")).toBeNull();
    expect(screen.getAllByTestId("class-sheet")).toHaveLength(1);

    await userEvent.click(screen.getByTestId("class-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));
    // Closing it is not an edit.
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("puts a dialog away with Escape and hands focus back to the row", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-card-1"));
    const name = await screen.findByTestId("class-name-1");
    name.focus();
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("moves focus between the rows with the arrow keys, and stops at the ends", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    screen.getByTestId("class-card-0").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-2"));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));

    // Moving between rows opens nothing: focus is not selection.
    expect(screen.queryByTestId("class-sheet")).toBeNull();

    // And stops at the ends rather than wrapping or leaving the list.
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));

    // J and K too, as every table on the workbench takes them.
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));
    await userEvent.keyboard("k");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));
  });

  it("shows how much a class is drawn with as a bar relative to the most-drawn one", async () => {
    withClasses(MANY.slice(0, 3), {
      usage: [
        { label_class: "class-00", annotations: 40, assets: 4 },
        { label_class: "class-01", annotations: 10, assets: 1 },
      ],
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    const share = (name: string): HTMLElement =>
      screen.getByRole("progressbar", { name: `${name}: share of the most-drawn class` });
    // Counts arrive after the rows do; the bars follow them.
    await waitFor(() => expect(share("class-00").getAttribute("aria-valuenow")).toBe("100"));
    // A quarter of the busiest class; one nothing is drawn with says so in
    // words rather than drawing an empty bar.
    expect(share("class-01").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.queryByRole("progressbar", { name: "class-02: share of the most-drawn class" })).toBeNull();
    expect(screen.getByTestId("class-card-count-2").textContent).toBe("Not used yet");
    expect(share("class-01").closest('[data-testid="class-row-1"]')).not.toBeNull();
  });

  it("draws a row's bar in its class's colour, declared or derived, and none for an unused class", async () => {
    withClasses(
      [
        { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
        { name: "lane", geometries: ["polygon"], color: null, attributes: [] },
        { name: "sign", geometries: ["bbox"], color: null, attributes: [] },
      ],
      {
        usage: [
          { label_class: "vehicle", annotations: 4, assets: 1 },
          { label_class: "lane", annotations: 2, assets: 1 },
        ],
      },
    );
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    const declared = await screen.findByTestId("class-card-bar-0");
    expect(declared.style.getPropertyValue("--bar")).toBe("#38bdf8");
    expect(declared.style.getPropertyValue("--bar-track")).toContain("#38bdf8");
    // Derived from the name, so the same colour the annotator draws it in.
    const derived = screen.getByTestId("class-card-bar-1");
    expect(derived.style.getPropertyValue("--bar")).toBe(classColor({ name: "lane", geometries: ["polygon"], color: null, attributes: [] }, "lane"));
    expect(declared.getAttribute("aria-valuenow")).toBe("100");
    expect(derived.getAttribute("aria-valuenow")).toBe("50");
    // Nothing drawn with it: said, not drawn.
    expect(screen.queryByTestId("class-card-bar-2")).toBeNull();
    expect(screen.getByTestId("class-card-count-2").textContent).toBe("Not used yet");
  });

  it("discards what was typed when its dialog is put away with Escape", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.type(screen.getByTestId("class-name-1"), "s");
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(screen.getByTestId("class-card-1").getAttribute("aria-label")).toBe("Edit lane");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    // Opened again, it is the class as the draft holds it, not as it was left.
    await openCard(1);
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "lane");
  });

  it("opens a class on the draft's values again after Cancel", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.type(screen.getByTestId("class-name-1"), "s");
    await choosePosition(1, 0);
    await userEvent.click(screen.getByTestId("class-geometry-1-bbox"));
    await cancelSheet();

    await openCard(1);
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "lane");
    expect(screen.getByTestId("class-position-1").textContent).toBe("2picks it while annotating");
    expect(screen.getByTestId("class-geometry-1-bbox").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("class-geometry-1-polygon").getAttribute("aria-pressed")).toBe("true");
    // And Saving it unchanged is no edit, rather than writing the discarded one.
    await closeSheet();
    expect(screen.getByTestId("class-card-1").getAttribute("aria-label")).toBe("Edit lane");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("opens a blank dialog for a second add, with no name carried over from the first", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await addNamedClass("a");
    expect(classCards()).toHaveLength(3);

    await userEvent.click(screen.getByTestId("add-class"));
    const name = await screen.findByTestId("class-name-3");
    expect(name).toHaveProperty("value", "");
    expect(screen.queryByTestId("class-name-error-3")).toBeNull();
    expect(screen.getByTestId("class-position-3").textContent).toBe("4picks it while annotating");
    expect(screen.getByTestId("class-sheet-done").textContent).toBe("Add to draft");

    await userEvent.type(name, "b");
    await closeSheet();
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Edit vehicle",
      "Edit lane",
      "Edit a",
      "Edit b",
    ]);
  });

  it("opens an add on a blank dialog after an abandoned one", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(await screen.findByTestId("class-name-2"), "pedestrian");
    await cancelSheet();

    await userEvent.click(screen.getByTestId("add-class"));
    expect(await screen.findByTestId("class-name-2")).toHaveProperty("value", "");
    expect(screen.queryByTestId("class-name-error-2")).toBeNull();
  });

  it("opens the class that took a removed one's place on its own fields", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.click(screen.getByTestId("remove-class-0"));
    await waitFor(() => expect(classCards()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    await openCard(0);
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "lane");
    expect(screen.getByTestId("class-geometry-0-polygon").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-geometry-0-bbox").getAttribute("aria-pressed")).toBe("false");
    // Saved as it is, it leaves the surviving class alone.
    await closeSheet();
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit lane"]);
  });

  it("says a class is in use, in its dialog, once something is drawn with it", async () => {
    withClasses(MANY.slice(0, 2));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");
    await waitFor(() =>
      expect(screen.getByTestId("class-card-count-0").textContent).toContain(
        (4372).toLocaleString(undefined),
      ),
    );

    // `class-00` has 4,372 annotations on 5 frames; `class-01` has none.
    await openCard(0);
    expect(screen.getByTestId("class-count-0").textContent).toBe(
      `${(4372).toLocaleString(undefined)} labels on 5 frames — removing the class, or a shape they use, waits until they are cleared.`,
    );

    await cancelSheet();
    await openCard(1);
    expect(screen.getByTestId("class-count-1").textContent).toBe(
      "Not used yet, so any change here is free.",
    );
  });

  /** The classes' names in ledger order, read off the rows' own labels. */
  function ledgerOrder(): (string | null)[] {
    return classCards().map((card) => card.getAttribute("aria-label"));
  }

  it("moves a class by its Shortcut, as one edit applied on Save that renumbers the hotkeys", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await openCard(0);
    // Said as a number, because a class's position is its hotkey.
    expect(screen.getByTestId("class-position-0").textContent).toBe("1picks it while annotating");
    await choosePosition(0, 1);
    // And as whose place it takes, before anything is saved.
    expect(screen.getByTestId("class-position-0").textContent).toBe("2takes class-01's place");
    // Picking is buffered like every other field: the ledger has not moved.
    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-01", "Edit class-02"]);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(ledgerOrder()).toEqual(["Edit class-01", "Edit class-00", "Edit class-02"]);
    // A move is an edit like any other.
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    // The hotkeys follow the positions, not the classes.
    expect(within(screen.getByTestId("class-row-0")).getByLabelText("Hotkey 1")).not.toBeNull();
    expect(within(screen.getByTestId("class-row-1")).getByLabelText("Hotkey 2")).not.toBeNull();
    expect(screen.getByTestId("class-card-1").textContent).toContain("class-00");
    // The dialog is gone, and focus is on the row the class landed in.
    expect(screen.queryByTestId("class-sheet")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));

    // Opened again, it is the same class, now at place two.
    await openCard(1);
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "class-00");
    expect(screen.getByTestId("class-position-1").textContent).toBe("2picks it while annotating");
  });

  it("moves a class up, and moving it back is no change at all", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(2);
    await choosePosition(2, 1);
    await closeSheet();

    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-02", "Edit class-01"]);
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));

    // The order the active version has again: nothing left to save.
    await openCard(1);
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "class-02");
    await choosePosition(1, 2);
    await closeSheet();
    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-01", "Edit class-02"]);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("changes nothing when the Shortcut it holds is picked again, and a move is lost to Cancel", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    // Every place the list has, and no more: three classes, three keys.
    await userEvent.click(screen.getByTestId("class-position-0"));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await userEvent.click(await screen.findByTestId("class-position-0-0"));
    await closeSheet();
    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-01", "Edit class-02"]);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await openCard(0);
    await choosePosition(0, 2);
    await cancelSheet();
    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-01", "Edit class-02"]);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("names whose place each Shortcut takes, and says when a place has no key", async () => {
    // Only the first nine classes have one, so the tenth is where a move runs out.
    withClasses(MANY.slice(0, 10));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(8);
    await userEvent.click(screen.getByTestId("class-position-8"));
    expect(screen.getByTestId("class-position-8-8").textContent).toContain("where it is now");
    expect(screen.getByTestId("class-position-8-7").textContent).toContain("class-07");
    expect(screen.getByTestId("class-position-8-9").textContent).toContain("class-09");
    expect(screen.getByTestId("class-position-8-9").textContent).toContain("no key");
    expect(screen.getByTestId("class-position-8-7").textContent).not.toContain("no key");
    await userEvent.click(screen.getByTestId("class-position-8-9"));
    // Past the ninth the trigger says there is no key, and its title says why.
    expect(screen.getByTestId("class-position-8").textContent).toBe("No key — past the ninth class");
    expect(screen.getByTestId("class-position-8").getAttribute("title")).toMatch(/Only the first nine classes have a key/);
    await userEvent.click(screen.getByTestId("class-position-8"));
    await userEvent.click(await screen.findByTestId("class-position-8-7"));
    expect(screen.getByTestId("class-position-8").textContent).toBe("8takes class-07's place");
    expect(screen.getByTestId("class-position-8").getAttribute("title")).toBe("Pressing 8 picks this class while annotating");
  });

  it("clears the filter when a class is moved, so it lands where it can be seen", async () => {
    // The class lands somewhere the filter may hide.
    withClasses(MANY.slice(0, 9));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "class-03");
    expect(classCards()).toHaveLength(1);
    await userEvent.click(classCards()[0]);
    await choosePosition(3, 2);
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(screen.getByTestId("class-filter")).toHaveProperty("value", "");
    expect(classCards()).toHaveLength(9);
    expect(screen.getByTestId("class-card-2").getAttribute("aria-label")).toBe("Edit class-03");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-2"));
  });

  it("adds the class once on Ctrl+Enter, from the name and from anywhere else in the sheet", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(await screen.findByTestId("class-name-2"), "pedestrian");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Edit vehicle",
      "Edit lane",
      "Edit pedestrian",
    ]);

    // And from a control that is not the name: Meta, on the shape chips.
    await openCard(1);
    await userEvent.click(screen.getByTestId("class-geometry-1-polyline"));
    screen.getByTestId("class-geometry-1-polyline").focus();
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    await openCard(1);
    expect(screen.getByTestId("class-geometry-1-polyline").getAttribute("aria-pressed")).toBe("true");
    expect(classCards()).toHaveLength(3);
  });

  it("does not submit on Ctrl+Enter while the class has no name, and says so", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await screen.findByTestId("class-name-2");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");

    expect((await screen.findByTestId("class-name-error-2")).textContent).toBe("Name this class.");
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(classCards()).toHaveLength(2);
  });

  it("keeps the one status line when a name is taken: the error replaces the facts, in the same place", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    const meta = screen.getByTestId("class-meta-1");
    const status = meta.parentElement!;
    expect(screen.queryByTestId("class-name-error-1")).toBeNull();

    await userEvent.clear(screen.getByTestId("class-name-1"));
    await userEvent.type(screen.getByTestId("class-name-1"), "vehicle");

    // The same line says it, so nothing below it moves.
    const error = await screen.findByTestId("class-name-error-1");
    expect(error.parentElement).toBe(status);
    expect(screen.queryByTestId("class-meta-1")).toBeNull();
    expect(screen.getByTestId("class-name-1").getAttribute("aria-describedby")).toBe(error.id);

    await userEvent.clear(screen.getByTestId("class-name-1"));
    await userEvent.type(screen.getByTestId("class-name-1"), "lane");
    expect(await screen.findByTestId("class-meta-1")).toBeTruthy();
    expect(screen.queryByTestId("class-name-error-1")).toBeNull();
  });

  it("adds an attribute line in the sheet, in place, and writes it to the draft on Save", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    const add = screen.getByTestId("add-attribute-0");
    await userEvent.click(add);
    // The button did not move, and the new group is open with its name in focus.
    expect(screen.getByTestId("add-attribute-0")).toBe(add);
    expect(screen.getByTestId("attr-toggle-0-0").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByTestId("attr-name-0-0"));
    await userEvent.type(screen.getByTestId("attr-name-0-0"), "occluded");
    await userEvent.click(screen.getByTestId("attr-required-0-0"));
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await closeSheet();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    expect(screen.getByTestId("class-row-0").textContent).toContain("occluded*");

    // Reopened, the group is closed again and says what it asks; opening it shows the fields.
    await openCard(0);
    const toggle = screen.getByTestId("attr-toggle-0-0");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("occluded, Text · required");
    // The active version has no such attribute, so the group is marked new.
    expect(within(toggle).getByText("new")).toBeTruthy();
    await userEvent.click(toggle);
    expect(screen.getByTestId("attr-name-0-0")).toHaveProperty("value", "occluded");
    expect(screen.getByTestId("attr-required-0-0").getAttribute("aria-checked")).toBe("true");
  });

  it("drops an attribute line nobody touched on Save, so a blank name never reaches the draft", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.click(screen.getByTestId("add-attribute-0"));
    await userEvent.click(screen.getByTestId("add-attribute-0"));
    expect(screen.getByTestId("attr-row-0-1")).toBeTruthy();

    // Two abandoned adds and nothing else: Save is no change at all.
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    expect(screen.getByTestId("class-row-0").textContent).not.toContain("unnamed");
  });

  it("refuses Save while an attribute somebody filled in has no name, and says so on the status line", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.click(screen.getByTestId("add-attribute-0"));
    await userEvent.click(screen.getByTestId("attr-required-0-0"));

    await userEvent.click(screen.getByTestId("class-sheet-done"));
    expect(screen.getByTestId("class-sheet")).toBeTruthy();
    expect(screen.getByTestId("class-attribute-error-0").textContent).toContain("Name every attribute");
    expect(document.activeElement).toBe(screen.getByTestId("attr-name-0-0"));
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await userEvent.type(screen.getByTestId("attr-name-0-0"), "occluded");
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(screen.getByTestId("class-row-0").textContent).toContain("occluded*");
  });

  it("makes a choice the default by pressing its chip, and keeps that on Save", async () => {
    withClasses([
      {
        name: "lane",
        geometries: ["polyline"],
        color: null,
        attributes: [{ name: "surface", kind: "select", required: false, options: ["tarmac", "gravel"], default: null }],
      },
    ]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.click(screen.getByTestId("attr-toggle-0-0"));
    await userEvent.click(screen.getByRole("button", { name: "gravel" }));
    expect(screen.getByRole("button", { name: "gravel" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "tarmac" }).getAttribute("aria-pressed")).toBe("false");
    await closeSheet();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");

    await openCard(0);
    await userEvent.click(screen.getByTestId("attr-toggle-0-0"));
    expect(screen.getByRole("button", { name: "gravel" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("edits a class in its dialog, and the row shows the change only once saved", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.type(screen.getByTestId("class-name-1"), "s");
    // The dialog holds a working copy: neither the row nor the draft has it yet.
    expect(screen.getByTestId("class-card-1").getAttribute("aria-label")).toBe("Edit lane");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    await closeSheet();

    expect(screen.getByTestId("class-card-1").getAttribute("aria-label")).toBe("Edit lanes");
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
  });

  it("writes the draft once on Save, trimming the name, with every field and the move in that one edit", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(2);
    await userEvent.type(screen.getByTestId("class-name-2"), "  extra ");
    await userEvent.click(screen.getByTestId("class-geometry-2-polygon"));
    // The palette is behind the swatch; it is put away again before the rest.
    await userEvent.click(screen.getByTestId("class-color-trigger-2"));
    await userEvent.click(screen.getByTestId("class-palette-2-7C3AED"));
    await userEvent.keyboard("{Escape}");
    await choosePosition(2, 0);
    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-01", "Edit class-02"]);
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(ledgerOrder()).toEqual(["Edit class-02  extra", "Edit class-00", "Edit class-01"]);
    // One edit carried all of it, and the name lost its trailing space.
    await openCard(0);
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "class-02  extra");
    expect(screen.getByTestId("class-geometry-0-polygon").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-color-trigger-0").getAttribute("aria-description")).toBe("#7C3AED");
    expect(screen.getByTestId("class-position-0").textContent).toBe("1picks it while annotating");
  });

  it("closes with its close button without keeping what was typed", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.type(screen.getByTestId("class-name-0"), "x");
    const sheet = screen.getByTestId("class-sheet");
    await userEvent.click(within(sheet).getByRole("button", { name: "Close vehicle" }));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));

    expect(screen.getByTestId("class-card-0").getAttribute("aria-label")).toBe("Edit vehicle");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("is not replaced by another row while it holds changes, and is when it holds none", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.type(screen.getByTestId("class-name-0"), "x");
    // The rows are beside the panel, not behind a modal: a press on one is
    // answered rather than obeyed, so the typed name is not thrown away.
    await userEvent.click(screen.getByTestId("class-card-1"));
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "vehiclex");
    expect(screen.queryByTestId("class-name-1")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("class-name-0"));

    await userEvent.clear(screen.getByTestId("class-name-0"));
    await userEvent.type(screen.getByTestId("class-name-0"), "vehicle");
    await userEvent.click(screen.getByTestId("class-card-1"));
    await screen.findByTestId("class-name-1");
    expect(screen.getAllByTestId("class-sheet")).toHaveLength(1);
    expect(screen.queryByTestId("class-name-0")).toBeNull();
  });

  it("locks its fields and its buttons while a save is in flight", async () => {
    withClasses(CLASSES);
    let resolvePreview: ((answer: Exclude<HandlerAnswer, undefined>) => void) | undefined;
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) return undefined;
      return new Promise((resolve) => {
        resolvePreview = resolve;
      });
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));
    await waitFor(() => expect(screen.getByTestId("class-sheet-done")).toHaveProperty("disabled", true));
    expect(screen.getByTestId("class-name-1")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("class-geometry-1-polygon")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("class-position-1")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("class-color-trigger-1")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("add-attribute-1")).toHaveProperty("disabled", true);

    if (resolvePreview === undefined) throw new Error("Expected the deferred preview request");
    resolvePreview({
      status: 200,
      body: { diff: { changes: [], destructive_classes: [], is_destructive: false }, blockers: [], is_refused: false },
    });
    await waitFor(() => expect(classCards()).toHaveLength(1));
  });

  it("gives its blockers dialog the page, and comes back to the class dialog when it is closed", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));
    await screen.findByTestId("orphan-dialog");
    expect(screen.getByTestId("orphan-dialog").textContent).toContain("“lane” can’t be removed yet");
    await userEvent.click(screen.getByTestId("orphan-close"));

    await waitFor(() => expect(screen.queryByTestId("orphan-dialog")).toBeNull());
    // Back on the class it was about, still open and still editable.
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(screen.getByTestId("remove-class-1").getAttribute("aria-label")).toBe("Remove class 2");
    await waitFor(() => expect(screen.getByTestId("class-name-1")).toHaveProperty("disabled", false));
  });


  it("opens the class a row names, not the row's position in a filtered ledger", async () => {
    // The trap the filter creates: a row's index in the *view* is not its index
    // in the schema, and writing through the wrong one edits a different class.
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "class-42");
    expect(classCards()).toHaveLength(1);

    await userEvent.click(classCards()[0]);
    expect(await screen.findByTestId("class-name-42")).toHaveProperty("value", "class-42");
    expect(screen.getByTestId("class-42")).not.toBeNull();
  });

  it("filters case-insensitively on a substring", async () => {
    withClasses([
      { name: "Vehicle", geometries: ["bbox"], color: null, attributes: [] },
      ...MANY.slice(0, 8),
    ]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "EHIC");
    expect(classCards()).toHaveLength(1);
    expect(classCards()[0].getAttribute("aria-label")).toBe("Edit Vehicle");
  });

  it("says so when a filter matches nothing, rather than showing an empty box", async () => {
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "zzz");
    // A sentence in the accordion's place, not an accordion with nothing in it.
    expect(screen.getByTestId("filter-empty").textContent).toBe("No class matches “zzz”.");
    expect(screen.queryByTestId("class-list")).toBeNull();
    expect(classCards()).toHaveLength(0);
    // The way to add a class is still there while nothing matches.
    expect(screen.getByTestId("add-class")).not.toBeNull();
  });

  it("clears the filter with its clear button, and with Escape, bringing every row back", async () => {
    withClasses(MANY.slice(0, 12));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");
    expect(classCards()).toHaveLength(12);
    // No clear button while there is nothing to clear.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    await userEvent.type(screen.getByTestId("class-filter"), "class-0");
    expect(classCards()).toHaveLength(10);
    await userEvent.type(screen.getByTestId("class-filter"), "3");
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit class-03"]);

    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByTestId("class-filter")).toHaveProperty("value", "");
    expect(classCards()).toHaveLength(12);
    expect(document.activeElement).toBe(screen.getByTestId("class-filter"));

    await userEvent.type(screen.getByTestId("class-filter"), "zzz");
    expect(screen.getByTestId("filter-empty")).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("filter-empty")).toBeNull();
    expect(classCards()).toHaveLength(12);
  });

  it("offers the filter in the band whenever there is a class to find, and / reaches it from anywhere", async () => {
    // A tool that came and went with the ninth class moved the band under the
    // pointer; the band holds its tools still.
    withClasses(MANY.slice(0, 1));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    expect(screen.getByTestId("class-filter")).not.toBeNull();
    expect(screen.getByTestId("class-filter").getAttribute("aria-keyshortcuts")).toBe("/");
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("/");
    expect(document.activeElement).toBe(screen.getByTestId("class-filter"));
    // Typed into the filter, a slash is a slash.
    await userEvent.keyboard("/");
    expect(screen.getByTestId("class-filter")).toHaveProperty("value", "/");
  });

  it("keeps the filter in place as classes are added and removed", async () => {
    withClasses(MANY.slice(0, 8));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");
    const filter = screen.getByTestId("class-filter");

    await addNamedClass("class-08", 8);
    expect(screen.getByTestId("class-filter")).toBe(filter);
    expect(classCards()).toHaveLength(9);

    // Asked of the server, which answers that nothing is in the way.
    await openCard(8);
    await userEvent.click(screen.getByTestId("remove-class-8"));
    await waitFor(() => expect(classCards()).toHaveLength(8));
    expect(screen.getByTestId("class-filter")).toBe(filter);
  });

  it("offers Add class from the empty ledger, which opens a dialog and gives way to the class it adds", async () => {
    withClasses([]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    const none = await screen.findByTestId("classes-none");
    expect(within(none).getByText("No classes yet")).not.toBeNull();
    await userEvent.click(within(none).getByRole("button", { name: "New class" }));

    await screen.findByTestId("class-0");
    // Nothing exists until the dialog submits, so the empty ledger stays put.
    expect(screen.queryByTestId("classes-none")).not.toBeNull();
    expect(classCards()).toHaveLength(0);

    await userEvent.type(screen.getByTestId("class-name-0"), "vehicle");
    await closeSheet();

    expect(screen.queryByTestId("classes-none")).toBeNull();
    expect(classCards()).toHaveLength(1);
    expect(screen.getByTestId("class-card-0").getAttribute("aria-label")).toBe("Edit vehicle");
    // Below the ledger now, as the one button that adds another.
    expect(screen.getAllByTestId("add-class")).toHaveLength(1);
    expect(screen.queryByTestId("classes-none")).toBeNull();
  });

  it("says what a class is when there are none, with Add class as the only way on", async () => {
    withClasses([]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    const none = await screen.findByTestId("classes-none");
    expect(none.textContent).toContain("No classes yet");
    expect(none.textContent).toContain("A class is a name for what you draw");
    expect(classCards()).toHaveLength(0);
    expect(screen.queryByTestId("class-list")).toBeNull();
    // The one Add class button, and it lives in the Empty.
    expect(screen.getAllByTestId("add-class")).toHaveLength(1);
    expect(within(none).getByTestId("add-class")).not.toBeNull();
    expect(screen.queryByTestId("class-filter")).toBeNull();

    // The line goes once there is a class to look at — not when the dialog opens.
    await userEvent.click(screen.getByTestId("add-class"));
    await screen.findByTestId("class-0");
    expect(screen.queryByTestId("classes-none")).not.toBeNull();
    await userEvent.type(screen.getByTestId("class-name-0"), "vehicle");
    await closeSheet();
    expect(screen.queryByTestId("classes-none")).toBeNull();
  });

  it("pages the ledger twenty-five to a page, keeps each class's own place, and returns focus to a row on the page it is on", async () => {
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 2");
    expect(screen.getByTestId("table-pager-prev").getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(screen.getByTestId("table-pager-next"));

    // The second page holds the schema's own places 26–50: a row's place is its
    // position in the schema, never its place on the page.
    expect(screen.getByTestId("table-pager-range").textContent).toBe("26–50 of 50 classes");
    expect(classCards()).toHaveLength(25);
    expect(screen.queryByTestId("class-card-0")).toBeNull();
    expect(screen.getByTestId("class-row-25")).not.toBeNull();
    expect(screen.getByTestId("class-card-25").getAttribute("aria-label")).toBe("Edit class-25");

    // Opening a class there and putting the sheet away returns focus to its row.
    await userEvent.click(screen.getByTestId("class-card-30"));
    await screen.findByTestId("class-sheet");
    await closeSheet();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("class-card-30")));

    // The filter's rows are paged too, and narrowing starts over at the first page.
    await userEvent.type(screen.getByTestId("class-filter"), "class-4");
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–10 of 10 classes · filtered from 50");
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 1");
  });

  it("adds a class from a dialog on a blank one, and nothing is added until it submits", async () => {
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));

    const detail = await screen.findByTestId("class-sheet");
    expect(within(detail).getByRole("heading", { name: "New class" })).not.toBeNull();
    expect(within(detail).getByTestId("class-50")).not.toBeNull();
    expect(within(detail).getByTestId("class-name-50")).toHaveProperty("value", "");
    // Focus lands in the name, so adding a class is typing its name.
    expect(document.activeElement).toBe(screen.getByTestId("class-name-50"));
    // One shape to begin with, and a shortcut at the end of the list.
    expect(screen.getByTestId("class-geometry-50-bbox").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-position-50").getAttribute("title")).toMatch(/Only the first nine classes have a key/);
    // Not a class yet: no row, no draft change, and no Remove for what is not there.
    expect(classCards()).toHaveLength(25);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–25 of 50 classes");
    expect(screen.queryByTestId("class-card-50")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    expect(screen.queryByTestId("remove-class-50")).toBeNull();
    // The button says what pressing it will do, and names the class once it has a name.
    expect(screen.getByTestId("class-sheet-done").textContent).toBe("Add to draft");
    await userEvent.type(screen.getByTestId("class-name-50"), "  pedestrian ");
    expect(screen.getByTestId("class-sheet-done").textContent).toBe("Add pedestrian to draft");
    expect(classCards()).toHaveLength(25);

    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    // Once, at the end, with its name trimmed — on the last page, which is the
    // page shown so focus can return to the row.
    expect(screen.getByTestId("table-pager-range").textContent).toBe("51 of 51 classes");
    expect(classCards()).toHaveLength(1);
    expect(screen.getByTestId("class-card-50").getAttribute("aria-label")).toBe("Edit pedestrian");
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-50"));
  });

  it("adds the class once when Enter submits the dialog", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(await screen.findByTestId("class-name-2"), "pedestrian{Enter}");
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Edit vehicle",
      "Edit lane",
      "Edit pedestrian",
    ]);
  });

  it("abandons an add with Cancel, leaving no class and no unsaved change behind", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(await screen.findByTestId("class-name-2"), "pedestrian");
    await userEvent.click(screen.getByTestId("class-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(classCards()).toHaveLength(2);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    expect(document.activeElement).toBe(screen.getByTestId("add-class"));
  });

  it("refuses to add a class with no name, saying so beside the field", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await screen.findByTestId("class-name-2");
    expect(screen.queryByTestId("class-name-error-2")).toBeNull();
    await userEvent.click(screen.getByTestId("class-sheet-done"));

    expect((await screen.findByTestId("class-name-error-2")).textContent).toBe("Name this class.");
    expect(screen.getByTestId("class-name-2").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("class-name-2"));
    expect(classCards()).toHaveLength(2);
    // Whitespace is no name either.
    await userEvent.type(screen.getByTestId("class-name-2"), "   ");
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(classCards()).toHaveLength(2);
  });

  it("says a name is taken as it is typed, ignoring case and spaces, and will not submit it", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(await screen.findByTestId("class-name-2"), "  LANE ");

    // Live, before anything is pressed, and naming the class it clashes with.
    expect((await screen.findByTestId("class-name-error-2")).textContent).toBe(
      "“lane” already has this name — names ignore case.",
    );
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(classCards()).toHaveLength(2);

    // A different name clears it, and the add goes through.
    await userEvent.clear(screen.getByTestId("class-name-2"));
    await userEvent.type(screen.getByTestId("class-name-2"), "lane marking");
    expect(screen.queryByTestId("class-name-error-2")).toBeNull();
    await closeSheet();
    expect(classCards()).toHaveLength(3);
  });

  it("says a rename is taken too, but not that a class clashes with itself", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    // Its own name, in another case, is the same class and not a clash.
    await userEvent.clear(screen.getByTestId("class-name-1"));
    await userEvent.type(screen.getByTestId("class-name-1"), "Lane");
    expect(screen.queryByTestId("class-name-error-1")).toBeNull();

    await userEvent.clear(screen.getByTestId("class-name-1"));
    await userEvent.type(screen.getByTestId("class-name-1"), "VEHICLE");
    expect((await screen.findByTestId("class-name-error-1")).textContent).toContain("“vehicle” already has this name");
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("clears the filter when a class is added, or the new class would be hidden by it", async () => {
    // A filter that matched the new name's absence would hide the card that was
    // just created, and the ledger would look as though nothing had happened.
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "class-42");
    expect(classCards()).toHaveLength(1);
    await addNamedClass("zebra", 50);

    expect(screen.getByTestId("class-filter")).toHaveProperty("value", "");
    // The new class is the 51st, on the last page — and that page is the one shown.
    expect(screen.getByTestId("table-pager-range").textContent).toBe("51 of 51 classes");
    expect(screen.getByTestId("class-card-50").getAttribute("aria-label")).toBe("Edit zebra");
  });

  it("keeps an orphaning removal terminal and leaves the draft unchanged", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    expect((await screen.findByTestId("orphan-dialog")).textContent).toContain("12 annotations");
    expect(screen.getByTestId("orphan-dialog").textContent).toContain("3 assets");
    expect(screen.queryByTestId("remove-class-confirm")).toBeNull();
    expect(screen.queryByTestId("allow-destructive")).toBeNull();
    // Refused, so the class is still in the draft and still in its open row.
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "lane");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("lists the frames behind a refusal in the dialog, for a host that can open a batch", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    on("POST", /\/schema\/blocking-assets/, { status: 200, body: { items: [], total: 0 } });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onOpenBatch={vi.fn()} />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    // The count without a destination is what this flow was refused for. The
    // sentence says where the remedy is, and the frames are right under it — in
    // the dialog, not in a section somewhere else on the page.
    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("open a batch below to clear or relabel a frame");
    expect(within(dialog).getByTestId("blocking-assets")).not.toBeNull();
    expect(screen.queryByText("Frames in the way")).toBeNull();
  });

  it("names no list of frames to a host that cannot open a batch, because none is shown", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    // The frames are listed only where a batch can be opened, so pointing at
    // them here would name a list that is not in the dialog — and asking the
    // server for frames nothing can link to would be a walk for nothing.
    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("Keep the class");
    expect(dialog.textContent).not.toContain("open a batch");
    expect(within(dialog).queryByTestId("blocking-assets")).toBeNull();
    expect(
      sent.some((request) => new URL(request.url).pathname.endsWith("/schema/blocking-assets")),
    ).toBe(false);
  });

  it("removes a clear candidate from the local draft without publishing, and closes its row", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    await waitFor(() => expect(classCards()).toHaveLength(1));
    // The open row was editing the class that is gone, so it goes with it.
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(screen.queryByTestId("class-1")).toBeNull();
    expect(screen.queryByTestId("orphan-dialog")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    expect(sent.some((request) => new URL(request.url).pathname.endsWith("/publish"))).toBe(false);
  });

  it("shows shared preview failure prose and leaves the draft unchanged", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 503,
      body: { code: "NETWORK_ERROR", message: "unreachable" },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    const error = await screen.findByTestId("schema-preview-error");
    expect(error.textContent).toContain("The server could not be reached");
    expect(error.textContent).not.toContain("unreachable");
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "lane");
    expect(screen.queryByTestId("orphan-dialog")).toBeNull();
  });

  it("does not apply field edits while a removal preview is pending", async () => {
    withClasses(CLASSES);
    let resolvePreview: ((answer: Exclude<HandlerAnswer, undefined>) => void) | undefined;
    handlers.push((request) => {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/schema/preview")
      ) {
        return undefined;
      }
      return new Promise((resolve) => {
        resolvePreview = resolve;
      });
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.click(screen.getByTestId("remove-class-0"));
    await waitFor(() => expect(screen.getByTestId("remove-class-0")).toHaveProperty("disabled", true));
    expect(screen.getByTestId("remove-class-0").textContent).toContain("Checking…");
    expect(screen.getByTestId("remove-class-0").getAttribute("aria-label")).toBe(
      "Checking class removal",
    );

    await userEvent.type(screen.getByTestId("class-name-0"), "-edited");
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "vehicle");

    if (resolvePreview === undefined) throw new Error("Expected the deferred preview request");
    resolvePreview({
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["vehicle"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });

    await waitFor(() => expect(classCards()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    // The class that was asked about is the one that went, and the edit typed
    // while it was being asked about went nowhere.
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit lane"]);
    await openCard(0);
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "lane");
  });

  it("shows each class's annotation count on its row and in its open row", async () => {
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    // The row renders before the counts arrive — it has a class to show and does
    // not wait on a number to show it — so this waits for the count.
    await waitFor(() =>
      expect(screen.getByTestId("class-card-count-0").textContent).toContain(
        (4372).toLocaleString(undefined),
      ),
    );
    await openCard(0);
    expect(screen.getByTestId("class-count-0").textContent).toContain(
      `${(4372).toLocaleString(undefined)} labels on`,
    );
    await closeSheet();

    await openCard(1);
    expect(screen.getByTestId("class-count-1").textContent).toContain("Not used yet");
  });

  it("removes a class from its row menu, asking the server first, and keeps it in the table struck through with the way back", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: {
          changes: [{ kind: "destructive", label_class: "lane", attribute: null, detail: "class 'lane' removed" }],
          destructive_classes: ["lane"],
          is_destructive: true,
        },
        blockers: [],
        is_refused: false,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-menu-1"));
    await userEvent.click(await screen.findByTestId("class-menu-remove"));

    await waitFor(() => expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit vehicle"]));
    // Asked about the draft without it, before anything left the draft.
    const asked = sent
      .filter((request) => request.url.endsWith("/schema/preview"))
      .map((request) => JSON.parse(bodies.get(request) ?? "") as unknown);
    expect(asked).toContainEqual({ classes: [CLASSES[0]] });
    // Still in the table where it stood, struck through: a removal is a change
    // that saving would publish, and it is seen as one. It opens nothing and
    // holds no key.
    const gone = screen.getByTestId("class-removed-lane");
    expect(gone.textContent).toContain("Removed");
    expect(within(gone).queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(within(gone).queryByLabelText(/^Hotkey/)).toBeNull();
    expect(barState()).toBe("up");

    // And kept again, where it was: the draft is the version in force once more.
    await userEvent.click(within(gone).getByRole("button", { name: "Restore lane" }));
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit vehicle", "Edit lane"]);
    expect(screen.queryByTestId("class-removed-lane")).toBeNull();
    expect(barState()).toBe("down");
    expect(sent.some((request) => new URL(request.url).pathname.endsWith("/publish"))).toBe(false);
  });

  it("refuses a row menu's Remove of a class frames carry in the dialog that says why, never with a greyed-out item", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-menu-1"));
    const remove = await screen.findByTestId("class-menu-remove");
    expect(remove.getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(remove);

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("“lane” can’t be removed yet");
    expect(dialog.textContent).toContain("lane: 12 annotations across 3 assets");
    expect(within(dialog).queryByTestId("allow-destructive")).toBeNull();
    await userEvent.click(within(dialog).getByTestId("orphan-close"));
    await waitFor(() => expect(screen.queryByTestId("orphan-dialog")).toBeNull());
    // Refused, so nothing left the draft.
    expect(classCards()).toHaveLength(2);
    expect(screen.queryByTestId("class-removed-lane")).toBeNull();
    expect(barState()).toBe("down");
  });

  it("undoes every edit to one class from its row menu", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("class-geometry-1-bbox"));
    await closeSheet();
    expect(barState()).toBe("up");

    await userEvent.click(screen.getByTestId("class-menu-1"));
    await userEvent.click(await screen.findByTestId("class-menu-revert"));

    expect(barState()).toBe("down");
    await openCard(1);
    expect(screen.getByTestId("class-geometry-1-bbox").getAttribute("aria-pressed")).toBe("false");
  });

  it("offers no Undo for a class the draft has not touched", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-menu-0"));
    await screen.findByTestId("class-menu-edit");
    expect(screen.queryByTestId("class-menu-revert")).toBeNull();
    // Edit opens the class, as its row does.
    await userEvent.click(screen.getByTestId("class-menu-edit"));
    expect(await screen.findByTestId("class-0")).not.toBeNull();
  });

  it("narrows the table to what the draft changed, or to the classes nothing is drawn with", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");
    await addNamedClass("zebra", 3);
    // `class-00` has 4,372 annotations; the rest none.
    await waitFor(() => expect(screen.getByTestId("class-card-count-0").textContent).toContain((4372).toLocaleString(undefined)));
    const lens = screen.getByTestId("classes-lens");

    await userEvent.click(within(lens).getByText("Changed in draft"));
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit zebra"]);
    expect(screen.getByTestId("classes-count").textContent).toBe("1 of 4");

    await userEvent.click(within(lens).getByText("Not used"));
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit class-01", "Edit class-02", "Edit zebra"]);

    await userEvent.click(within(lens).getByText("All"));
    expect(classCards()).toHaveLength(4);
    expect(screen.getByTestId("classes-count").textContent).toBe("4");
  });

  it("keeps the other classes, and no open row, after a class in the middle is removed", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));
    await waitFor(() => expect(classCards()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Edit class-00",
      "Edit class-02",
    ]);
  });

  /**
   * A draft the server holds with a class nobody has named yet — a colleague's
   * unfinished work. The dialog never writes one, but one can arrive, and it has
   * to be removable.
   */
  function withUnnamedClass(): void {
    withClasses(CLASSES);
    curatedDrafts.set(PROJECT, {
      project_id: PROJECT,
      kind: "curated",
      classes: [...CLASSES, { name: "", geometries: ["bbox"], color: null, attributes: [] }],
      note: "",
      based_on: 1,
      revision: 1,
      updated_at: "2024-01-01T00:00:00Z",
    });
  }

  it("removes a class that was never named without asking the server", async () => {
    withUnnamedClass();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");
    expect(screen.getByTestId("class-card-2").getAttribute("aria-label")).toBe("Edit New class");
    const before = sent.filter((request) => request.url.endsWith("/schema/preview")).length;

    await openCard(2);
    expect(screen.getByRole("heading", { name: "Edit new class" })).not.toBeNull();
    await userEvent.click(screen.getByTestId("remove-class-2"));

    await waitFor(() => expect(classCards()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(sent.filter((request) => request.url.endsWith("/schema/preview"))).toHaveLength(before);
    expect(screen.queryByTestId("schema-preview-error")).toBeNull();
  });

  it("leaves an unnamed class out of the removal preview it cannot be part of", async () => {
    withUnnamedClass();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    await waitFor(() => expect(classCards()).toHaveLength(2));
    const previews = sent
      .filter((sentRequest) => sentRequest.url.endsWith("/schema/preview"))
      .map((sentRequest) => JSON.parse(bodies.get(sentRequest) ?? "") as { classes: { name: string }[] });
    // The removal's own question: the draft without `lane`, and without the
    // class nobody has named yet.
    expect(previews).toContainEqual({ classes: [CLASSES[0]] });
    // And no question the rail asks while the draft is dirty carries it either.
    for (const asked of previews) {
      expect(asked.classes.every((declared) => declared.name !== "")).toBe(true);
    }
    expect(screen.queryByTestId("schema-preview-error")).toBeNull();
  });
});

