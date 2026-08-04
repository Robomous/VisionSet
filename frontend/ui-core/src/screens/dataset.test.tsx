/**
 * The publication tail: stats, the timeline, publishing, verifying and export.
 *
 * The claim worth the file is the **third gate word**. `confirm=` guards destroying
 * data, `allow_destructive=` guards narrowing a contract, and `allow_lossy=` guards
 * emitting an incomplete copy of something that stays intact — and the kernel is
 * emphatic that the three are never caught together. There is no pre-export
 * validation route, so the consent flow is attempt → read the 409 → ask → retry
 * with the flag, and the test drives all four steps.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { DatasetScreen } from "./DatasetScreen";

const API = "http://visionset.test";
// The three list fields `FormatOut` declares with a default. A default means the
// server serializes them every time, which is why the contract types them as always
// present rather than optional.
const FORMAT_REST = { geometries: [], modalities: [], degraded_geometries: [] } as const;

const PROJECT = "11111111-1111-4111-8111-111111111111";
const DATASET = "22222222-2222-4222-8222-222222222222";
const RELEASE = "33333333-3333-4333-8333-333333333333";

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
  on("GET", /\/formats$/, {
    status: 200,
    body: { items: [{ name: "dummy", lossy: false, ...FORMAT_REST }, { name: "yolo", lossy: true, ...FORMAT_REST }], total: 2 },
  });
}

describe("the dataset view", () => {
  it("reports annotations and assets per class, because the two are different questions", async () => {
    baseline();
    render(mount(<DatasetScreen projectId={PROJECT} />));

    await screen.findByTestId("dataset-stats");
    const row = await screen.findByTestId("class-count-vehicle");
    // A thousand labels over a thousand images and the same thousand over ten are
    // the same total and a very different dataset.
    expect(row.textContent).toContain("31");
    expect(row.textContent).toContain("8");
  });
});

describe("publishing", () => {
  it("sends the tag alone when nobody asked for folds", async () => {
    baseline();
    on("POST", /\/releases$/, { status: 201, body: RELEASE_ROW });

    render(mount(<DatasetScreen projectId={PROJECT} />));
    await userEvent.click(await screen.findByTestId("publish-release"));
    await userEvent.type(screen.getByTestId("release-tag"), "v2");
    await userEvent.click(screen.getByTestId("publish-submit"));

    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    expect(JSON.parse(bodies.get(sent.find((r) => r.method === "POST") as Request) ?? "{}")).toEqual({
      tag: "v2",
    });
  });

  it("refuses a split whose fractions do not sum to one, as the kernel does", async () => {
    baseline();
    render(mount(<DatasetScreen projectId={PROJECT} />));
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

    render(mount(<DatasetScreen projectId={PROJECT} />));
    await screen.findByTestId("release-v1");
    expect(sent.some((r) => r.url.endsWith("/verify"))).toBe(false);

    await userEvent.click(screen.getByTestId("verify-v1"));
    expect((await screen.findByTestId("verified-v1")).textContent).toContain("12 blobs");
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

    render(mount(<DatasetScreen projectId={PROJECT} />));
    await userEvent.click(await screen.findByTestId("verify-v1"));
    // `checked: 0` — every other number would be about a document that is not the
    // one its hash names.
    expect((await screen.findByTestId("verified-v1")).textContent).toContain(
      "does not match its hash",
    );
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

    render(mount(<DatasetScreen projectId={PROJECT} />));
    await userEvent.click(await screen.findByTestId("verify-v1"));

    const said = (await screen.findByTestId("verify-error-v1")).textContent ?? "";
    expect(said).toContain("busy");
    expect(said).not.toContain("WORKSPACE_BUSY");
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
    render(mount(<DatasetScreen projectId={PROJECT} />));
    await userEvent.click(await screen.findByTestId("verify-v1"));
    await screen.findByTestId("verified-v1");

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
    expect(screen.queryByTestId("verified-v1")).toBeNull();
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

    render(mount(<DatasetScreen projectId={PROJECT} />));
    await userEvent.click(await screen.findByTestId("manifest-v1"));

    const said = (await screen.findByTestId("manifest-error-v1")).textContent ?? "";
    expect(said).toContain("no longer on record");
    expect(said).not.toContain("RELEASE_NOT_FOUND");
  });
});

describe("export, and the third gate word", () => {
  it("exports cleanly without any consent when the format loses nothing", async () => {
    baseline();
    handlers.push((request) =>
      request.method === "POST" && request.url.includes("/export")
        ? { status: 200, body: {} }
        : undefined,
    );

    render(mount(<DatasetScreen projectId={PROJECT} />));
    await userEvent.click(await screen.findByTestId("export-v1"));
    await userEvent.click(screen.getByTestId("export-format"));
    await userEvent.click(await screen.findByRole("option", { name: /dummy/ }));
    await userEvent.click(screen.getByTestId("export-submit"));

    await waitFor(() => expect(sent.some((r) => r.url.includes("/export"))).toBe(true));
    const request = sent.find((r) => r.url.includes("/export"));
    expect(new URL(request?.url ?? "").searchParams.get("format")).toBe("dummy");
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
              message: "yolo cannot express polygon annotations.",
            },
          };
    });

    render(mount(<DatasetScreen projectId={PROJECT} />));
    await userEvent.click(await screen.findByTestId("export-v1"));
    await userEvent.click(screen.getByTestId("export-format"));
    await userEvent.click(await screen.findByRole("option", { name: /yolo/ }));
    // The format declares it, so the warning is there before anything is attempted.
    expect(screen.getByTestId("lossy-hint")).not.toBeNull();

    await userEvent.click(screen.getByTestId("export-submit"));

    const consent = await screen.findByTestId("lossy-consent");
    expect(consent.textContent).toContain("cannot express polygon");
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
});
