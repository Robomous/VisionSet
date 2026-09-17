import { fireEvent, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import {
  useBrowserInferenceRuntime,
  VisionSetBrowserInferenceProvider,
} from "./VisionSetBrowserInferenceProvider";
import type {
  BrowserModelCatalogEntry,
  BrowserSuggestionAssetSource,
  VisionSetBrowserInferenceRuntime,
} from "./browserPort";
import { clearPrefs, writePref } from "../data/prefs";
import {
  AnnotationPage,
  readyBrowserTargets,
  staleStoredBrowserTarget,
} from "../annotator/AnnotationPage";
import { TooltipProvider } from "@robomous/ui-core";
import { renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";

const RUNTIME: VisionSetBrowserInferenceRuntime = {
  listTargets: async () => [
    { id: "t1", label: "This device", modelRef: "example/model@rev" },
  ],
  executorFor: () => ({ suggest: async () => { throw new Error("not called"); } }),
};

function withRuntime(runtime?: VisionSetBrowserInferenceRuntime) {
  return function Wrapper({ children }: { readonly children: ReactNode }): JSX.Element {
    return (
      <VisionSetBrowserInferenceProvider runtime={runtime}>
        {children}
      </VisionSetBrowserInferenceProvider>
    );
  };
}

describe("useBrowserInferenceRuntime", () => {
  it("is null with no provider at all, and does not throw", () => {
    const { result } = renderHook(() => useBrowserInferenceRuntime());
    expect(result.current).toBeNull();
  });

  it("is null when a host supplies no runtime", () => {
    const { result } = renderHook(() => useBrowserInferenceRuntime(), {
      wrapper: withRuntime(undefined),
    });
    expect(result.current).toBeNull();
  });

  it("is the host's runtime when one is supplied", () => {
    const { result } = renderHook(() => useBrowserInferenceRuntime(), {
      wrapper: withRuntime(RUNTIME),
    });
    expect(result.current).toBe(RUNTIME);
  });

  it("hands back a target list and an executor for a target", async () => {
    const { result } = renderHook(() => useBrowserInferenceRuntime(), {
      wrapper: withRuntime(RUNTIME),
    });
    const targets = await result.current!.listTargets();
    expect(targets.map((target) => target.id)).toEqual(["t1"]);
    expect(typeof result.current!.executorFor("t1").suggest).toBe("function");
  });
});

/**
 * The seam is inert: a `VisionSetBrowserInferenceProvider` in the tree must not change what
 * the suggest gesture puts on the wire. Nothing in `@visionset/ui-core` reads this runtime
 * yet, so the strongest available proof is a black-box one — drive the real annotation flow
 * twice, once bare and once wrapped, and diff the requests byte for byte.
 *
 * This is the minimum lifted from `suggestFlow.test.tsx`'s harness, not an import of it: that
 * file's helpers are module-private, and the plan treats copying the minimum as the accepted
 * deviation from lifting them into a shared module, so as not to touch the primary
 * behaviour-preservation gate for this branch.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";
const CONNECTION = "66666666-6666-4666-8666-666666666666";
const MODEL_REF = "facebook/sam2-hiera-base-plus@main";

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  description: null,
  created_at: null,
  provenance: "curated",
  classes: [{ name: "vehicle", geometries: ["bbox"], color: "#3355ff", attributes: [] }],
};

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

const sent: Sent[] = [];
let connections: readonly Record<string, unknown>[] = [];
let suggestion: Record<string, unknown> | null = null;

function connectionRow(): Record<string, unknown> {
  return {
    id: CONNECTION,
    name: "local sam",
    connection_type: "local",
    model_id: "facebook/sam2-hiera-base-plus",
    model_revision: "main",
    device: "cuda",
    precision: "fp16",
    endpoint_url: null,
    provider_id: "sam",
    credential_env: null,
    origin: "huggingface",
    setup_state: "ready",
    allowed_actions: [],
    capabilities: ["point_suggest"],
    produces: ["bbox", "polygon"],
    download: null,
    integrity_check: null,
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
  };
}

/**
 * The asset's declared frame — what the wire says this asset measures, and so what
 * `documentFromWire` puts in the document's `AssetDescriptor`. Per-test rather than
 * a constant only so the descriptor-frame test below can pick numbers no decoded
 * `<img>` in this file reports; `beforeEach` puts it back.
 */
let assetExtent = { width: 640, height: 480 };

function assetRow(id: string, hash: string): Record<string, unknown> {
  return {
    id,
    project_id: PROJECT,
    modality: "image",
    content_hash: hash.padEnd(64, "0"),
    width: assetExtent.width,
    height: assetExtent.height,
    format: "png",
    thumbnail_hash: null,
    frame_index: null,
    frame_timestamp: null,
    source_id: null,
    ingested_at: null,
    job_id: JOB,
    progress: "unannotated",
    allowed_actions: assetActions("unannotated", { batchState: "in_annotation" }),
    annotation_count: 0,
    min_confidence: null,
  };
}

function answer(path: string): unknown {
  if (path === "/inference/connections") {
    return { items: connections, total: connections.length };
  }
  if (path === `/jobs/${JOB}`) {
    return {
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: 1,
      allowed_actions: jobActions("in_progress", { settled: false }),
      assignee: null,
      pre_label_run: null,
    };
  }
  if (path === `/batches/${BATCH}`) {
    return {
      id: BATCH,
      project_id: PROJECT,
      name: "drive-01",
      state: "in_annotation",
      schema_version: 1,
      asset_count: 1,
      allowed_actions: batchActions("in_annotation"),
      promoted_asset_count: 0,
      parent_batch_id: null,
      pre_label_run: null,
      progress: {
        unannotated: 1,
        pre_labeled: 0,
        annotated: 0,
        skipped: 0,
        review_pending: 0,
        accepted: 0,
        total: 1,
      },
    };
  }
  if (path.endsWith("/schema/versions/1") || path.endsWith("/schema")) return SCHEMA;
  if (path.endsWith("/assets")) {
    return { items: [assetRow(ASSET, "abcdef0")], total: 1 };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  sent.length = 0;
  clearPrefs();
  assetExtent = { width: 640, height: 480 };
  connections = [connectionRow()];
  suggestion = {
    model_ref: MODEL_REF,
    confidence: 0.9125,
    regions: [
      { geometry: { type: "bbox", x: 12, y: 34, width: 56, height: 78 }, contour: [] },
    ],
    applied: { tolerance: 1 },
    parameters: [],
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  stubResizeObserver();
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") {
      sent.push({ method: request.method, path, body: await request.clone().text() });
      if (path === "/inference/suggest") {
        return new Response(JSON.stringify(suggestion), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(answer(path)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
});

function mount(node: ReactNode, runtime?: VisionSetBrowserInferenceRuntime): JSX.Element {
  return (
    <TooltipProvider>
      <VisionSetBrowserInferenceProvider runtime={runtime}>
        {node}
      </VisionSetBrowserInferenceProvider>
    </TooltipProvider>
  );
}

async function open(runtime?: VisionSetBrowserInferenceRuntime): Promise<() => void> {
  const view = renderWithData(mount(<AnnotationPage jobId={JOB} />, runtime));
  await screen.findByTestId("annotation-page");
  return view.unmount;
}

async function arm(): Promise<void> {
  await userEvent.click(screen.getByTestId("tool-suggest"));
  await screen.findByTestId("suggest-panel");
}

function clickCanvas(): void {
  fireEvent.pointerDown(screen.getByTestId("annotator-pane"), {
    button: 0,
    clientX: 100,
    clientY: 100,
    pointerId: 1,
  });
}

function asks(): readonly Record<string, unknown>[] {
  return sent
    .filter((row) => row.path === "/inference/suggest")
    .map((row) => JSON.parse(row.body) as Record<string, unknown>);
}

describe("an injected browser runtime changes nothing on the wire", () => {
  it("sends the identical suggest request with and without a runtime in the tree", async () => {
    const unmountFirst = await open();
    await arm();
    clickCanvas();
    await waitFor(() => expect(asks()).toHaveLength(1));
    const withoutRuntime = asks();
    unmountFirst();

    sent.length = 0;
    const unmountSecond = await open(RUNTIME);
    await arm();
    clickCanvas();
    await waitFor(() => expect(asks()).toHaveLength(1));
    const withRuntime = asks();
    unmountSecond();

    expect(withRuntime).toEqual(withoutRuntime);
  });
});

describe("target selection routes a ready browser target around the server", () => {
  it("a ready browser target answers suggestions even with no server connections", async () => {
    connections = [];
    writePref(`suggest.target.${PROJECT}`, "browser:efficient-sam-ti");

    const browserSuggest = vi.fn().mockResolvedValue({
      model_ref: "efficient-sam-ti@rev",
      confidence: 0.9,
      regions: [{ geometry: { type: "polygon", points: [[0, 0], [1, 0], [1, 1]] }, contour: [] }],
      applied: { tolerance: 1 },
      parameters: ["tolerance"],
    });
    const runtime: VisionSetBrowserInferenceRuntime = {
      listTargets: async () => [
        { id: "efficient-sam-ti", label: "EfficientSAM-Ti", modelRef: "efficient-sam-ti@rev" },
      ],
      executorFor: (id) => {
        expect(id).toBe("efficient-sam-ti");
        return { suggest: browserSuggest };
      },
    };

    const unmount = await open(runtime);
    await arm();

    // The blocker the panel renders must clear once the browser target reports
    // ready, even though the server side has nothing — "no-connections" must
    // never win once the active target isn't asking the server anything.
    await screen.findByTestId("suggest-idle");
    expect(screen.queryByTestId("suggest-no-connections")).toBeNull();

    clickCanvas();

    await waitFor(() => expect(browserSuggest).toHaveBeenCalledTimes(1));
    expect(asks()).toHaveLength(0);

    unmount();
  });

  it("falls back to Server silently when the stored browser target isn't in a resolved list", async () => {
    // Acquired model bytes are never persisted across a reload, so this — a stored
    // preference naming a browser target `listTargets()` no longer reports — is the
    // ordinary shape of every reload for someone who last picked "This device", not a
    // rare failure. It must read as "no connections" (the server's own honest state),
    // never as a browser "not-ready" the person never asked to see again.
    connections = [];
    writePref(`suggest.target.${PROJECT}`, "browser:gone-model");

    const runtime: VisionSetBrowserInferenceRuntime = {
      listTargets: async () => [],
      executorFor: () => ({
        suggest: async () => {
          throw new Error("unused");
        },
      }),
    };

    const unmount = await open(runtime);
    await arm();

    await screen.findByTestId("suggest-no-connections");
    expect(screen.queryByTestId("suggest-not-ready")).toBeNull();

    unmount();
  });
});

describe("executor selection never calls executorFor on an unready browser target", () => {
  it("selecting 'This device' before any download completes does not crash the render", async () => {
    // Mirrors `BrowserInferenceRuntime.executorFor`'s real behavior (Task 8): it throws
    // synchronously for a target whose acquisition state isn't "ready" yet. Selecting the
    // "This device" tab sets `activeTarget` to a browser target before any download has
    // completed — that is how the acquisition flow starts — so `executor`'s computation
    // must never call this unconditionally for a browser-kind `activeTarget`.
    const runtime: VisionSetBrowserInferenceRuntime = {
      listTargets: async () => [],
      executorFor: (id) => {
        throw new Error(`no ready browser target "${id}"`);
      },
      listAcquisitions: () => [
        { id: "efficient-sam-ti", label: "EfficientSAM-Ti", approxBytes: 123_456, acquire: async () => {} },
      ],
    };

    const unmount = await open(runtime);
    await arm();

    // Wait for the server tab's own connection to resolve to the ready one `beforeEach`
    // seeds (`connectionRow()`), so the assertion below is a real proof that a click
    // doesn't fall through to a genuinely usable server executor — not a false negative
    // from `serverExecutor` merely being null too, for an unrelated reason (still loading,
    // or no connection at all). `suggest-idle` only renders once the server tab's blocker
    // clears, which is exactly that resolution.
    await screen.findByTestId("suggest-idle");

    // This click sets `activeTarget` to `{kind: "browser", targetId: "efficient-sam-ti"}`
    // while `browserTargets` is still `[]` — the exact unready state that used to throw
    // during render. A throw here would fail this test on its own, uncaught.
    await userEvent.click(screen.getByTestId("suggest-target-browser"));
    await screen.findByTestId("suggest-device-section");
    expect(screen.queryByTestId("suggest-panel")).not.toBeNull();
    // The user-facing outcome this whole guard exists for: the tab lands on the actual
    // Download control rather than a blank or crashed panel.
    expect(screen.queryByTestId("suggest-device-acquire-efficient-sam-ti")).not.toBeNull();

    // With no ready executor, a click on the canvas must be a silent no-op rather than
    // falling through to the server executor — which is genuinely non-null here (the
    // resolved connection above), so this assertion is a real proof, not a false
    // negative from nothing being available to fall through to. The flush lets a
    // wrongly-dispatched `mutateAsync` actually reach `sent` before we check — a bare
    // synchronous check right after `clickCanvas()` would pass even with a fallthrough
    // bug present, since the fetch is dispatched a tick later.
    clickCanvas();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asks()).toHaveLength(0);

    unmount();
  });
});

describe("readyBrowserTargets", () => {
  const target = { id: "efficient-sam-ti", label: "EfficientSAM-Ti", modelRef: "model@revision" };
  const model: BrowserModelCatalogEntry = {
    id: target.id,
    label: target.label,
    modelRef: target.modelRef,
    revision: "revision",
    bytes: 41_301_678,
    license: "Apache-2.0",
    source: { label: "EfficientSAM", href: "https://example.test/upstream" },
    state: "ready",
    storage: "persistent",
  };

  it("removes a stale ready target synchronously when catalog removal publishes", () => {
    expect(readyBrowserTargets([target], [{ ...model, state: "available", storage: "none" }])).toEqual([]);
  });

  it("keeps a target while its catalog entry is ready", () => {
    expect(readyBrowserTargets([target], [model])).toEqual([target]);
  });
});

describe("staleStoredBrowserTarget", () => {
  const listed = [{ id: "t1", label: "T1", modelRef: "m@rev" }];

  it("flags a stored (non-explicit) browser preference missing from a resolved list", () => {
    expect(staleStoredBrowserTarget({ kind: "browser", targetId: "gone" }, listed, false)).toBe(true);
  });

  it("does not flag a stored preference that is in the resolved list", () => {
    expect(staleStoredBrowserTarget({ kind: "browser", targetId: "t1" }, listed, false)).toBe(false);
  });

  it("does not flag a server preference, or a list still resolving", () => {
    expect(staleStoredBrowserTarget({ kind: "server" }, [], false)).toBe(false);
    expect(staleStoredBrowserTarget({ kind: "browser", targetId: "gone" }, undefined, false)).toBe(false);
  });

  it("never flags a target this session explicitly chose, even once it drops out of the list", () => {
    // This is the other half of the same rule: an explicit in-session choice that later
    // fails must keep surfacing through `blocker`/`refusal`, not silently revert.
    expect(staleStoredBrowserTarget({ kind: "browser", targetId: "gone" }, [], true)).toBe(false);
  });

  it("keeps a known admitted preference when the model is not installed yet", () => {
    expect(staleStoredBrowserTarget({ kind: "browser", targetId: "efficient-sam-ti" }, [], false, true)).toBe(
      false,
    );
  });
});

describe("BrowserSuggestionAssetSource", () => {
  it("hands the browser runtime a BrowserSuggestionAssetSource once the asset image loads", async () => {
    const setActiveAsset = vi.fn();
    const runtime: VisionSetBrowserInferenceRuntime = {
      listTargets: async () => [],
      executorFor: () => ({
        suggest: async () => {
          throw new Error("unused");
        },
      }),
      setActiveAsset,
    };

    await open(runtime);

    const image = screen.getByTestId("annotator-image");
    fireEvent.load(image);

    await waitFor(() => expect(setActiveAsset).toHaveBeenCalledTimes(1));
    const [source] = setActiveAsset.mock.calls[0] as [BrowserSuggestionAssetSource];
    expect(source.assetId).toBe(ASSET);
    expect(typeof source.readRgb).toBe("function");
  });

  it("carries the asset descriptor's frame, not the decoded image's natural size", async () => {
    /*
      The two frames are made to disagree — and to disagree by a *transposition*,
      the shape an EXIF-rotated decode actually takes — because a fixture where
      they coincide cannot tell them apart. That is exactly how reading
      `naturalWidth`/`naturalHeight` here survived the suite that shipped it.

      The descriptor is what every coordinate this source meets is expressed in:
      the click points, the shapes `shapesFromMask` returns, the annotations
      already on the frame. So the claim is made twice — on the extent the
      executor bound-checks clicks against, and on what `readRgb` actually asks
      the decoder for, which is the one a plausible "fix" to the first alone
      would leave wrong.
    */
    assetExtent = { width: 7, height: 5 };
    const setActiveAsset = vi.fn();
    const runtime: VisionSetBrowserInferenceRuntime = {
      listTargets: async () => [],
      executorFor: () => ({
        suggest: async () => {
          throw new Error("unused");
        },
      }),
      setActiveAsset,
    };

    await open(runtime);

    const image = screen.getByTestId("annotator-image") as HTMLImageElement;
    Object.defineProperty(image, "naturalWidth", { value: 5, configurable: true });
    Object.defineProperty(image, "naturalHeight", { value: 7, configurable: true });
    fireEvent.load(image);

    await waitFor(() => expect(setActiveAsset).toHaveBeenCalledTimes(1));
    const [source] = setActiveAsset.mock.calls[0] as [BrowserSuggestionAssetSource];
    expect({ width: source.width, height: source.height }).toEqual({ width: 7, height: 5 });

    const drawImage = vi.fn();
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(7 * 5 * 4) }));
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage, getImageData } as unknown as CanvasRenderingContext2D);
    try {
      const pixels = source.readRgb();
      expect({ width: pixels.width, height: pixels.height }).toEqual({ width: 7, height: 5 });
    } finally {
      getContext.mockRestore();
    }
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 7, 5);
  });
});
