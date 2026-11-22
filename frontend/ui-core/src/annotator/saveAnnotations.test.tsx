/**
 * A scan's save plan travels through the same three job-scoped calls as an
 * image's: deletes, then a whole-replacement PATCH, then creates.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ScanAnnotation } from "@visionset/annotator";
import { afterEach, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { HARNESS_BASE_URL, renderWithData } from "../testing/dataHarness";
import { useSaveAnnotations, type SavePlan } from "./jobQueries";

const BOX: ScanAnnotation = {
  id: "stored-1",
  asset_id: "scan-1",
  label_class: "car",
  schema_version: 2,
  geometry: { type: "cuboid_3d", center: [11, 0, 0.8], size: [4.2, 1.8, 1.5], yaw: -0.5 },
  attributes: {},
  provenance: "import",
  model_ref: null,
  confidence: null,
  job_id: "job-1",
};

const PLAN: SavePlan<ScanAnnotation> = {
  created: [{ ...BOX, id: "local-1", provenance: "human", job_id: null }],
  updated: [BOX],
  deleted: ["stored-2"],
};

function Saver({ plan }: { readonly plan: SavePlan<ScanAnnotation> }): JSX.Element {
  const save = useSaveAnnotations("job-1", "scan-1");
  return (
    <button type="button" onClick={() => save.mutate(plan)}>
      {save.isSuccess ? "saved" : save.isError ? "failed" : "save"}
    </button>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("sends a scan plan as DELETE, PATCH and POST on the job's annotations", async () => {
  const sent: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    const text = await request.text();
    sent.push({ method: request.method, url: request.url, body: text === "" ? null : JSON.parse(text) });
    return request.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ items: [], total: 0 }), {
          status: request.method === "POST" ? 201 : 200,
          headers: { "content-type": "application/json" },
        });
  });

  renderWithData(<Saver plan={PLAN} />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(screen.getByRole("button").textContent).toBe("saved"));

  const base = `${HARNESS_BASE_URL}/jobs/job-1/annotations`;
  expect(sent.map(({ method, url }) => [method, url])).toEqual([
    ["DELETE", `${base}?id=stored-2`],
    ["PATCH", base],
    ["POST", base],
  ]);
  expect(sent[1].body).toEqual([
    {
      id: "stored-1",
      label_class: "car",
      geometry: BOX.geometry,
      attributes: {},
      provenance: "import",
      model_ref: null,
      confidence: null,
    },
  ]);
  expect(sent[2].body).toEqual([
    {
      asset_id: "scan-1",
      label_class: "car",
      geometry: BOX.geometry,
      attributes: {},
      provenance: "human",
      model_ref: null,
      confidence: null,
    },
  ]);
});
