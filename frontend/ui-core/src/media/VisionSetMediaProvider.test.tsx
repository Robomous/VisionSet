/**
 * The one invariant the media seam owes a host: absence is a normal, renderable
 * state, never a throw.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JSX } from "react";

import { useMediaRuntime, VisionSetMediaProvider } from "./VisionSetMediaProvider";
import type { VisionSetMediaRuntime } from "./port";

function fakeRuntime(): VisionSetMediaRuntime {
  return {
    materializer: {
      name: "fake/1.0.0",
      inspect: () => Promise.reject(new Error("not used")),
      materialize: () => Promise.reject(new Error("not used")),
    },
    createFrameSink: () => ({ append: () => Promise.resolve() }),
  };
}

function Reporter(): JSX.Element {
  const runtime = useMediaRuntime();
  return <span data-testid="runtime">{runtime === null ? "absent" : "present"}</span>;
}

describe("useMediaRuntime", () => {
  it("answers null, not a throw, with no provider mounted", () => {
    render(<Reporter />);
    expect(screen.getByTestId("runtime").textContent).toBe("absent");
  });

  it("answers null when the provider is given no runtime", () => {
    render(
      <VisionSetMediaProvider>
        <Reporter />
      </VisionSetMediaProvider>,
    );
    expect(screen.getByTestId("runtime").textContent).toBe("absent");
  });

  it("answers the supplied runtime", () => {
    render(
      <VisionSetMediaProvider runtime={fakeRuntime()}>
        <Reporter />
      </VisionSetMediaProvider>,
    );
    expect(screen.getByTestId("runtime").textContent).toBe("present");
  });
});
