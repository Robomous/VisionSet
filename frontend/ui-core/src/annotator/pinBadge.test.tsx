/**
 * The pin badge as an answer rather than a statement.
 *
 * `v3` on the top bar says which contract this batch is judged against, and the
 * pin is movable. What it cannot say on its own is what everybody asks next —
 * *is that the current one, and what am I missing?* — and both halves of that
 * answer used to be a navigation away, which principle 10 forbids.
 *
 * Mounted through `AnnotationPage` rather than in isolation, because the claim
 * that matters is about **which requests leave and when**: the badge's whole
 * design is that it fetches nothing until it is opened, and a component test with
 * hand-fed props could not tell that apart from a page that fetched on arrival
 * and passed the answer down. Every request is recorded here and the assertions
 * are about the record.
 */

import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { TooltipProvider } from "../primitives/Menu";
import { writeToken } from "../data/session";
import { AnnotationPage } from "./AnnotationPage";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";

const PINNED = {
  project_id: PROJECT,
  version: 1,
  classes: [{ name: "sign", geometries: ["bbox"], color: null, attributes: [] }],
  description: null,
  created_at: null,
  provenance: "curated",
};

/** How far the *project* has moved on. Set per test before rendering. */
let activeVersion = 3;

/** Every path this page asks for, in order — the record the claims are about. */
const asked: string[] = [];

function answer(path: string, search: string): unknown {
  if (path === `/jobs/${JOB}`) {
    return {
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: 1,
      allowed_actions: jobActions("in_progress", { settled: false }),
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
      progress: { unannotated: 1, annotated: 0, skipped: 0, review_pending: 0, accepted: 0, total: 1 },
    };
  }
  if (path.endsWith("/schema/compare")) {
    // The whole `SchemaDiffOut`, because `unwrap` validates the shape and a
    // partial stub answers as three slow requests rather than as an error.
    // `search` is read so the stub cannot silently answer a comparison nobody
    // asked for.
    const bounds = new URLSearchParams(search);
    return {
      is_destructive: false,
      destructive_classes: [],
      changes: [
        {
          kind: "additive",
          label_class: "crossing",
          attribute: null,
          detail: `class 'crossing' was added between v${bounds.get("from")} and v${bounds.get("to")}`,
        },
      ],
    };
  }
  if (path.endsWith("/schema/versions/1")) return PINNED;
  // The *active* version, which is the one the badge opens to learn.
  if (path.endsWith("/schema")) return { ...PINNED, version: activeVersion };
  if (path.endsWith("/assets")) {
    return {
      items: [
        {
          id: ASSET,
          project_id: PROJECT,
          modality: "image",
          content_hash: "a".repeat(64),
          width: 640,
          height: 480,
          format: "png",
          thumbnail_hash: null,
          frame_index: null,
          frame_timestamp: null,
          source_id: null,
          ingested_at: null,
          job_id: JOB,
          progress: "unannotated",
          allowed_actions: assetActions("unannotated", { batchState: "in_annotation" }),
        },
      ],
      total: 1,
    };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  asked.length = 0;
  activeVersion = 3;
  writeToken("a-token");
  // A viewport at least the annotator's floor, or no store and no top bar mount
  // at all — see `viewportFloor.test.tsx` for why that gate exists.
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("fetch", async (request: Request) => {
    const url = new URL(request.url);
    asked.push(url.pathname);
    return new Response(JSON.stringify(answer(url.pathname, url.search)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
});

function mount(node: ReactNode): JSX.Element {
  return (
    <ApiProvider
      baseUrl={API}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>{node}</TooltipProvider>
    </ApiProvider>
  );
}

/** The badge, once the page has walked job → batch → pinned schema → assets. */
async function badge(): Promise<HTMLElement> {
  render(mount(<AnnotationPage jobId={JOB} />));
  return screen.findByTestId("pinned-schema");
}

describe("what it fetches, and when", () => {
  it("asks for nothing about the active version until it is opened", async () => {
    await badge();
    // The rule `e2e/annotate.spec.ts` pins: opening a job makes no request to
    // `/schema` at all, because a page that read the active version would be one
    // refactor from offering classes this batch's pin does not declare.
    expect(asked.some((path) => path === `/projects/${PROJECT}/schema`)).toBe(false);
    expect(asked.some((path) => path.endsWith("/schema/compare"))).toBe(false);
  });

  it("asks on demand, once opened", async () => {
    await userEvent.click(await badge());

    await waitFor(() => {
      expect(asked.some((path) => path === `/projects/${PROJECT}/schema`)).toBe(true);
    });
    // Decision 7's "diffs stay fetched on demand", one surface over from the
    // ledger it was written about.
    await waitFor(() => {
      expect(asked.some((path) => path.endsWith("/schema/compare"))).toBe(true);
    });
  });

  it("stops asking once it is closed again", async () => {
    // The `open &&` on the comparison's bounds is *not* redundant behind the
    // active-version gate, and this is the only state where the difference shows:
    // after one opening the active version is cached, so `behind` stays true, and
    // a comparison left enabled would keep refetching over a closed popover. A
    // disabled query ignores an invalidation; an enabled one answers it.
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ApiProvider baseUrl={API} queryClient={queries}>
        <TooltipProvider>
          <AnnotationPage jobId={JOB} />
        </TooltipProvider>
      </ApiProvider>,
    );

    await userEvent.click(await screen.findByTestId("pinned-schema"));
    await screen.findByTestId("pin-diff");
    await userEvent.keyboard("{Escape}");

    const before = asked.filter((path) => path.endsWith("/schema/compare")).length;
    await act(async () => {
      await queries.invalidateQueries();
    });

    expect(asked.filter((path) => path.endsWith("/schema/compare"))).toHaveLength(before);
  });

  it("does not compare when the pin is already the current version", async () => {
    activeVersion = 1;
    await userEvent.click(await badge());

    await screen.findByTestId("pin-current");
    // Nothing to diff, so nothing is asked. `useSchemaComparison` reads a null
    // bound as "do not ask", which is what makes this one condition rather than
    // a second `enabled` to keep in step.
    expect(asked.some((path) => path.endsWith("/schema/compare"))).toBe(false);
  });
});

describe("what it says", () => {
  it("names the version the batch is judged against", async () => {
    await userEvent.click(await badge());

    expect(screen.getByTestId("pin-popover").textContent).toContain("v1");
  });

  it("says the project has moved on, and what arrived since", async () => {
    await userEvent.click(await badge());

    const behind = await screen.findByTestId("pin-behind");
    expect(behind.textContent).toContain("v3");
    // **Not "adding one from here re-pins it"** (#381). An additive version now
    // brings every open batch with it, so a batch that is behind has declined
    // something — and the sentence says which, instead of offering a remedy that
    // is no longer how the pin moves.
    expect(behind.textContent).toContain("narrowed the schema past this pin");
    expect(behind.textContent).not.toContain("re-pins it");
    // The kernel's own words for the change, not a second classification in
    // TypeScript — the same payload `SchemaEditor`'s ledger renders.
    const diff = await screen.findByTestId("pin-diff");
    // Including the bounds, so the assertion covers *which* comparison was
    // asked for: a badge diffing v1 against v2 would render prose just as
    // plausible and would be answering a different question.
    expect(diff.textContent).toContain("class 'crossing' was added between v1 and v3");
  });

  it("says so plainly when there is nothing behind", async () => {
    activeVersion = 1;
    await userEvent.click(await badge());

    expect((await screen.findByTestId("pin-current")).textContent).toMatch(/current version/i);
    expect(screen.queryByTestId("pin-behind")).toBeNull();
  });
});

describe("opening and closing it", () => {
  it("shows nothing until it is pressed", async () => {
    await badge();
    expect(screen.queryByTestId("pin-popover")).toBeNull();
  });

  it("closes on Escape, so the canvas gets the keyboard back", async () => {
    // The annotator reads the keyboard off its own root, which is why this is a
    // hand-built disclosure rather than a Radix Popover: a press that landed
    // anywhere but back on the canvas would leave every chord dead.
    await userEvent.click(await badge());
    await screen.findByTestId("pin-popover");

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByTestId("pin-popover")).toBeNull();
  });

  it("closes on a press outside it", async () => {
    await userEvent.click(await badge());
    await screen.findByTestId("pin-popover");

    await userEvent.click(screen.getByTestId("canvas-stage"));

    expect(screen.queryByTestId("pin-popover")).toBeNull();
  });
});
