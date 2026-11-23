import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { clearPrefs, readPref } from "../data/prefs";
import { DetailPane } from "./DetailPane";

function Pane({ open, expanded = false }: { readonly open: boolean; readonly expanded?: boolean }) {
  return (
    <div style={{ display: "flex", width: 1200 }}>
      <main style={{ flex: 1 }}>content</main>
      <DetailPane id="test" open={open} label="Batch" expanded={expanded} defaultWidth={400} minWidth={320} maxWidth={720} testId="pane">
        <p>batch facts</p>
      </DetailPane>
    </div>
  );
}

afterEach(() => clearPrefs());

describe("the detail pane", () => {
  it("is a labelled panel beside the content, never a dialog, at the width the screen gives it", () => {
    render(<Pane open />);
    const pane = screen.getByTestId("pane");
    expect(pane.tagName).toBe("ASIDE");
    expect(screen.getByRole("complementary", { name: "Batch" })).toBe(pane);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pane.style.width).toBe("400px");
    expect(pane.getAttribute("data-state")).toBe("open");
  });

  it("resizes from its handle with the keyboard, as a window splitter, and remembers the width", async () => {
    render(<Pane open />);
    const handle = screen.getByRole("separator", { name: "Resize the details" });
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("400");

    handle.focus();
    // Leftward widens: the panel grows from its left edge.
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByTestId("pane").style.width).toBe("416px");
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(screen.getByTestId("pane").style.width).toBe("352px");
    expect(readPref("detail-width:test")).toBe("352");

    // Never under the floor; Enter puts the screen's width back.
    await userEvent.keyboard("{Home}");
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    await userEvent.keyboard("{Enter}");
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
  });

  it("opens at the width it was left at", () => {
    render(<Pane open />);
    screen.getByRole("separator").focus();
    return userEvent.keyboard("{ArrowLeft}{ArrowLeft}").then(() => {
      render(<Pane open />);
      expect(screen.getAllByTestId("pane")[1]?.style.width).toBe("432px");
    });
  });

  it("slides out with what it held, inert, then leaves", async () => {
    const { rerender } = render(<Pane open />);
    rerender(<Pane open={false} />);
    const pane = screen.getByTestId("pane");
    expect(pane.getAttribute("data-state")).toBe("closed");
    expect(pane.hasAttribute("inert")).toBe(true);
    expect(pane.textContent).toContain("batch facts");
    await waitFor(() => expect(screen.queryByTestId("pane")).toBeNull());
  });

  it("takes the whole row when expanded, and offers no handle then", () => {
    render(<Pane open expanded />);
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByTestId("pane").style.width).toBe("");
  });
});
