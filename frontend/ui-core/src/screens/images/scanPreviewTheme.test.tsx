/**
 * The scan preview's legend and swatches say what the canvas draws, in the
 * theme the page is in now: `.dark` on `<html>` switches both together.
 */

import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { RAMPS, type RampTheme } from "@visionset/annotator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithData } from "../../testing/dataHarness";
import { installFakeGl, type FakeGl } from "../../testing/fakeGl";
import { ScanPreview } from "./ScanPreview";
import { RAMP_GRADIENT } from "./scanSample";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function scan(): ArrayBuffer {
  const count = 4;
  const out = new ArrayBuffer(16 + count * 16);
  const view = new DataView(out);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, "VSPC".charCodeAt(i));
  view.setUint32(4, 1, true);
  view.setUint32(8, count, true);
  view.setUint32(12, 1, true);
  for (let i = 0; i < count; i += 1) view.setFloat32(16 + i * 12 + 8, i, true);
  for (let i = 0; i < count; i += 1) view.setFloat32(16 + count * 12 + i * 4, i / 3, true);
  return out;
}

let gl: FakeGl;

beforeEach(() => {
  gl = installFakeGl();
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/points")) return new Response(scan(), { status: 200, headers: { "content-type": "application/octet-stream" } });
    return Response.json({ code: "NO_STUB", message: path }, { status: 500 });
  });
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** `css` as the DOM serialises it back from an inline style. */
function styled(css: string): string {
  const probe = document.createElement("span");
  probe.style.backgroundImage = css;
  return probe.style.backgroundImage;
}

const gradient = (theme: RampTheme): string =>
  styled(`linear-gradient(to right, ${RAMPS[theme].height.map(([r, g, b]) => `rgb(${r} ${g} ${b})`).join(", ")})`);

async function openScan(): Promise<HTMLElement> {
  renderWithData(
    <ScanPreview
      projectId={PROJECT}
      asset={{ id: "scan0", source_id: null, point_cloud: { format: "pcd", point_count: 4, fields: ["x", "y", "z", "intensity"], bounds: { minimum: [0, 0, 0], maximum: [0, 0, 3] } } }}
      alt="A scan"
      open
      onOpenChange={() => {}}
      focus={false}
    />,
  );
  await screen.findByTestId("point-cloud-gl");
  return screen.getByTestId("scan-legend");
}

const ramp = (legend: HTMLElement): string => (legend.querySelector("[aria-hidden='true']") as HTMLElement).style.backgroundImage;

async function setDark(on: boolean): Promise<void> {
  await act(async () => {
    document.documentElement.classList.toggle("dark", on);
  });
}

describe("the scan legend and the page theme", () => {
  it("draws the light ramp with no dark class, as before themes", async () => {
    const legend = await openScan();
    expect(styled(RAMP_GRADIENT.light.height)).toBe(gradient("light"));
    expect(ramp(legend)).toBe(gradient("light"));
  });

  it("switches the legend and the canvas together when the page turns dark, and back", async () => {
    const legend = await openScan();
    const light = gl.lastColors();
    await setDark(true);
    expect(ramp(legend)).toBe(gradient("dark"));
    await waitFor(() => expect(gl.lastColors()).not.toEqual(light));
    await setDark(false);
    expect(ramp(legend)).toBe(gradient("light"));
    await waitFor(() => expect(gl.lastColors()).toEqual(light));
  });

  it("gives the colour pick's swatches the same theme", async () => {
    await openScan();
    await setDark(true);
    await userEvent.click(screen.getByTestId("scan-colour"));
    const pick = await screen.findByRole("radiogroup", { name: "Colour points by" });
    const swatches = [...within(pick).getAllByText((_, element) => element?.getAttribute("aria-hidden") === "true" && element.classList.contains("vs-image-outline"))];
    expect(swatches.map((one) => one.style.backgroundImage)).toEqual([RAMP_GRADIENT.dark.height, RAMP_GRADIENT.dark.intensity, RAMP_GRADIENT.dark.rgb].map(styled));
  });
});
